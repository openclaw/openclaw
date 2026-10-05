import { createHash } from "node:crypto";
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/speech-provider";
import {
  asDialogueRecord,
  MessageBuffer,
  readDialogueAudioChunk,
  throwIfDialogueServerError,
} from "./dialogue-messages.js";
import { isValidElevenLabsVoiceId, normalizeElevenLabsRealtimeBaseUrl } from "./shared.js";
import { WebSocket } from "./ws-runtime.js";

const DIALOGUE_SOCKET_OPEN = 1;
const DIALOGUE_KEEPALIVE_MS = 15_000;
const DIALOGUE_SESSION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_POOLED_SESSIONS = 64;
const MAX_DIALOGUE_MESSAGES = 10_000;
const DIALOGUE_PATH = "/v1/text-to-dialogue/stream-input";

const DIALOGUE_MODELS = new Set(["eleven_v4", "eleven_v4_turbo", "eleven_v3_conversational"]);

const DIALOGUE_VOICE_LIMITS: Record<string, number> = {
  eleven_v4: 10,
  eleven_v4_turbo: 1,
  eleven_v3_conversational: 1,
};

export type ElevenLabsDialogueSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: () => void): void;
};

export type ElevenLabsDialogueSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => ElevenLabsDialogueSocket;

export type ElevenLabsDialogueRequest = {
  text: string;
  apiKey: string;
  baseUrl?: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  seed?: number;
  applyTextNormalization?: string;
  languageCode?: string;
  voiceSettings?: {
    stability?: number;
  };
  timeoutMs: number;
  conversationId?: string;
  signal?: AbortSignal;
  /** Test override. Production callers omit this and use the plugin audio cap. */
  maxAudioBytes?: number;
  /** Test override. Production callers omit this. */
  keepaliveMs?: number;
  /** Test override. Production callers omit this. */
  sessionIdleMs?: number;
};

type DialogueEndpoint = {
  modelId: string;
  url: string;
  voiceId: string;
  text: string;
  stability?: number;
  conversationId?: string;
  maxAudioBytes: number;
  keepaliveMs: number;
  sessionIdleMs: number;
  timeoutMs: number;
};

type ActiveConnection = {
  socket: ElevenLabsDialogueSocket;
  buffer: MessageBuffer;
};

type PooledSession = {
  key: string;
  connection?: ActiveConnection;
  voicesSent: boolean;
  inflight: number;
  epoch: number;
  tail: Promise<void>;
  keepaliveMs: number;
  sessionIdleMs: number;
  keepaliveTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

const sessions = new Map<string, PooledSession>();
let maxPooledSessions = DEFAULT_MAX_POOLED_SESSIONS;
let socketFactory: ElevenLabsDialogueSocketFactory = createDefaultDialogueSocket;

export function resolveElevenLabsDialogueModelId(modelId: string | undefined): string | undefined {
  const normalized = modelId?.trim().toLowerCase();
  if (!normalized || !DIALOGUE_MODELS.has(normalized)) {
    return undefined;
  }
  return normalized;
}

export function isElevenLabsDialogueModel(modelId: string | undefined): boolean {
  return resolveElevenLabsDialogueModelId(modelId) !== undefined;
}

export function elevenLabsDialogueVoiceLimit(modelId: string): number {
  const resolved = resolveElevenLabsDialogueModelId(modelId);
  if (!resolved) {
    throw new Error(`ElevenLabs model "${modelId ?? ""}" does not use the dialogue WebSocket`);
  }
  return DIALOGUE_VOICE_LIMITS[resolved] ?? 1;
}

export function assertElevenLabsDialogueVoices(modelId: string, voiceIds: readonly string[]): void {
  const limit = elevenLabsDialogueVoiceLimit(modelId);
  if (voiceIds.length === 0) {
    throw new Error("ElevenLabs dialogue requires a voice id");
  }
  if (voiceIds.length > limit) {
    throw new Error(
      limit === 1
        ? `ElevenLabs ${resolveElevenLabsDialogueModelId(modelId)} accepts one voice on a dialogue connection`
        : `ElevenLabs ${resolveElevenLabsDialogueModelId(modelId)} accepts at most ${limit} voices on a dialogue connection`,
    );
  }
}

export function buildElevenLabsDialogueWebSocketUrl(params: {
  baseUrl?: string;
  modelId: string;
  outputFormat?: string;
  languageCode?: string;
  seed?: number;
  applyTextNormalization?: string;
}): string {
  const base = normalizeElevenLabsRealtimeBaseUrl(params.baseUrl);
  const url = new URL(`${base}${DIALOGUE_PATH}`);
  url.searchParams.set("model_id", params.modelId);
  if (params.outputFormat) {
    url.searchParams.set("output_format", params.outputFormat);
  }
  if (params.languageCode) {
    url.searchParams.set("language_code", params.languageCode);
  }
  if (params.seed !== undefined) {
    url.searchParams.set("seed", String(params.seed));
  }
  if (params.applyTextNormalization) {
    url.searchParams.set("apply_text_normalization", params.applyTextNormalization);
  }
  return url.toString();
}

export function setElevenLabsDialogueSocketFactoryForTests(
  factory: ElevenLabsDialogueSocketFactory | undefined,
): void {
  socketFactory = factory ?? createDefaultDialogueSocket;
}

export function setElevenLabsDialoguePoolLimitForTests(limit: number | undefined): void {
  maxPooledSessions = limit ?? DEFAULT_MAX_POOLED_SESSIONS;
}

export function resetElevenLabsDialogueSessionsForTests(): void {
  for (const session of [...sessions.values()]) {
    retireSession(session);
  }
  sessions.clear();
  socketFactory = createDefaultDialogueSocket;
  maxPooledSessions = DEFAULT_MAX_POOLED_SESSIONS;
}

export async function synthesizeElevenLabsDialogue(
  params: ElevenLabsDialogueRequest,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await runDialogueTurn(params, (chunk) => {
    chunks.push(chunk);
  });
  const audio = Buffer.concat(chunks);
  if (audio.byteLength === 0) {
    throw new Error("ElevenLabs dialogue produced no audio");
  }
  return audio;
}

export async function streamElevenLabsDialogue(params: ElevenLabsDialogueRequest): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const controller = new AbortController();
  const external = params.signal;
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason);
    } else {
      external.addEventListener("abort", () => controller.abort(external.reason), { once: true });
    }
  }
  let releaseTurn: (() => void) | undefined;
  let settled = false;
  const audioStream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      try {
        await runDialogueTurn(
          { ...params, signal: controller.signal },
          (chunk) => {
            if (!settled) {
              streamController.enqueue(new Uint8Array(chunk));
            }
          },
          (cancel) => {
            releaseTurn = cancel;
          },
        );
        if (!settled) {
          settled = true;
          streamController.close();
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          streamController.error(error);
        }
      }
    },
    cancel() {
      controller.abort(new Error("ElevenLabs dialogue stream released"));
      releaseTurn?.();
    },
  });
  return {
    audioStream,
    release: async () => {
      controller.abort(new Error("ElevenLabs dialogue stream released"));
      releaseTurn?.();
    },
  };
}

function createDefaultDialogueSocket(
  url: string,
  options: { headers: Record<string, string> },
): ElevenLabsDialogueSocket {
  const ws = new WebSocket(url, {
    headers: options.headers,
    maxPayload: MAX_AUDIO_BYTES,
    handshakeTimeout: 10_000,
  });
  return {
    get readyState() {
      return ws.readyState;
    },
    send(data: string) {
      ws.send(data);
    },
    close() {
      ws.close();
    },
    onOpen(listener) {
      ws.on("open", listener);
    },
    onMessage(listener) {
      ws.on("message", (data) => listener(data));
    },
    onError(listener) {
      ws.on("error", (error) => {
        listener(
          error instanceof Error ? error : new Error("ElevenLabs dialogue connection failed"),
        );
      });
    },
    onClose(listener) {
      ws.on("close", listener);
    },
  };
}

function prepareDialogueEndpoint(params: ElevenLabsDialogueRequest): DialogueEndpoint {
  const modelId = resolveElevenLabsDialogueModelId(params.modelId);
  if (!modelId) {
    throw new Error(`ElevenLabs model "${params.modelId}" does not use the dialogue WebSocket`);
  }
  if (!params.apiKey.trim()) {
    throw new Error("ElevenLabs API key missing");
  }
  if (!isValidElevenLabsVoiceId(params.voiceId)) {
    throw new Error("Invalid voiceId format");
  }
  assertElevenLabsDialogueVoices(modelId, [params.voiceId]);
  if (!params.text.trim()) {
    throw new Error("ElevenLabs dialogue requires text");
  }
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error("ElevenLabs dialogue timeout must be greater than 0");
  }
  const conversationId = normalizeConversationId(params.conversationId);
  const stability = dialogueStability(params.voiceSettings?.stability);
  return {
    modelId,
    url: buildElevenLabsDialogueWebSocketUrl({
      baseUrl: params.baseUrl,
      modelId,
      outputFormat: params.outputFormat,
      languageCode: params.languageCode,
      seed: params.seed,
      applyTextNormalization: params.applyTextNormalization,
    }),
    voiceId: params.voiceId,
    text: params.text,
    ...(stability === undefined ? {} : { stability }),
    ...(conversationId ? { conversationId } : {}),
    maxAudioBytes: params.maxAudioBytes ?? MAX_AUDIO_BYTES,
    keepaliveMs: params.keepaliveMs ?? DIALOGUE_KEEPALIVE_MS,
    sessionIdleMs: params.sessionIdleMs ?? DIALOGUE_SESSION_IDLE_MS,
    timeoutMs: params.timeoutMs,
  };
}

function normalizeConversationId(conversationId: string | undefined): string | undefined {
  const trimmed = conversationId?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[\w.:-]{1,200}$/.test(trimmed)) {
    throw new Error("Invalid ElevenLabs dialogue conversation id");
  }
  return trimmed;
}

function dialogueStability(stability: number | undefined): number | undefined {
  if (typeof stability !== "number" || !Number.isFinite(stability)) {
    return undefined;
  }
  if (stability < 0 || stability > 1) {
    return undefined;
  }
  return stability;
}

async function runDialogueTurn(
  params: ElevenLabsDialogueRequest,
  onAudio: (chunk: Buffer) => void,
  onReady?: (cancel: () => void) => void,
): Promise<void> {
  const endpoint = prepareDialogueEndpoint(params);
  const signal = params.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw abortError(signal);
  }
  if (!endpoint.conversationId) {
    const deadlineAt = Date.now() + endpoint.timeoutMs;
    const connection = await openDialogueConnection(endpoint, params.apiKey, signal, deadlineAt);
    onReady?.(() => {
      connection.buffer.fail(abortError(signal));
      connection.socket.close();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = armDialogueDeadline(msUntilDeadline(deadlineAt, endpoint.timeoutMs), () => {
        connection.buffer.fail(dialogueTimeout(endpoint.timeoutMs));
        connection.socket.close();
      });
      await speakTurn(connection, endpoint, onAudio, true);
    } finally {
      clearTimeout(timer);
      connection.socket.close();
    }
    return;
  }

  const session = acquireSession(endpoint, params.apiKey);
  const epoch = beginTurn(session);
  onReady?.(() => {
    interruptConnection(session, abortError(signal));
  });
  session.inflight += 1;
  const run = session.tail.then(async () => {
    if (session.closed || session.epoch !== epoch) {
      throw new Error("ElevenLabs dialogue interrupted by a new turn");
    }
    await executePooledTurn(session, endpoint, params.apiKey, signal, onAudio, epoch);
  });
  session.tail = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    await run;
  } finally {
    session.inflight -= 1;
  }
}

function beginTurn(session: PooledSession): number {
  if (session.inflight > 0) {
    interruptConnection(session, new Error("ElevenLabs dialogue interrupted by a new turn"));
  }
  return session.epoch;
}

async function executePooledTurn(
  session: PooledSession,
  endpoint: DialogueEndpoint,
  apiKey: string,
  signal: AbortSignal,
  onAudio: (chunk: Buffer) => void,
  epoch: number,
): Promise<void> {
  const onAbort = () => {
    interruptConnection(session, abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) {
      throw abortError(signal);
    }
    if (session.closed || session.epoch !== epoch) {
      throw new Error("ElevenLabs dialogue interrupted by a new turn");
    }
    const deadlineAt = Date.now() + endpoint.timeoutMs;
    let connection = session.connection;
    if (!connection || connection.socket.readyState !== DIALOGUE_SOCKET_OPEN) {
      connection = await openDialogueConnection(endpoint, apiKey, signal, deadlineAt);
      if (session.epoch !== epoch) {
        connection.socket.close();
        throw new Error("ElevenLabs dialogue interrupted by a new turn");
      }
      session.connection = connection;
      session.voicesSent = false;
    }
    timer = armDialogueDeadline(msUntilDeadline(deadlineAt, endpoint.timeoutMs), () => {
      interruptConnection(session, dialogueTimeout(endpoint.timeoutMs));
    });
    const outcome = await speakTurn(connection, endpoint, onAudio, !session.voicesSent, session);
    if (session.epoch !== epoch) {
      throw new Error("ElevenLabs dialogue interrupted by a new turn");
    }
    if (outcome === "socket") {
      retireConnection(session);
    } else {
      armIdle(session);
    }
  } catch (error) {
    if (session.epoch === epoch) {
      retireConnection(session);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function dialogueTimeout(timeoutMs: number): Error {
  return new Error(`ElevenLabs dialogue timed out after ${timeoutMs}ms`);
}

function msUntilDeadline(deadlineAt: number, timeoutMs: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw dialogueTimeout(timeoutMs);
  }
  return remaining;
}

function acquireSession(endpoint: DialogueEndpoint, apiKey: string): PooledSession {
  const key = dialogueSessionKey(apiKey, endpoint);
  const existing = sessions.get(key);
  if (existing && !existing.closed) {
    sessions.delete(key);
    sessions.set(key, existing);
    return existing;
  }
  while (sessions.size >= maxPooledSessions) {
    const oldest = sessions.values().next().value;
    if (!oldest) {
      break;
    }
    retireSession(oldest);
  }
  const session: PooledSession = {
    key,
    voicesSent: false,
    inflight: 0,
    epoch: 0,
    tail: Promise.resolve(),
    keepaliveMs: endpoint.keepaliveMs,
    sessionIdleMs: endpoint.sessionIdleMs,
    closed: false,
  };
  sessions.set(key, session);
  return session;
}

function dialogueSessionKey(apiKey: string, endpoint: DialogueEndpoint): string {
  const auth = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return `${auth}\0${endpoint.url}\0${endpoint.voiceId}\0${endpoint.conversationId ?? ""}`;
}

function interruptConnection(session: PooledSession, error: Error): void {
  if (session.closed) {
    return;
  }
  session.epoch += 1;
  session.voicesSent = false;
  const connection = session.connection;
  session.connection = undefined;
  clearSessionTimers(session);
  connection?.buffer.fail(error);
  connection?.socket.close();
}

function failSession(session: PooledSession, error: Error): void {
  interruptConnection(session, error);
  session.closed = true;
  sessions.delete(session.key);
}

function retireConnection(session: PooledSession): void {
  const connection = session.connection;
  session.connection = undefined;
  session.voicesSent = false;
  connection?.socket.close();
  clearSessionTimers(session);
}

function retireSession(session: PooledSession): void {
  if (session.closed) {
    sessions.delete(session.key);
    return;
  }
  failSession(session, new Error("ElevenLabs dialogue session closed"));
}

function clearSessionTimers(session: PooledSession): void {
  clearTimeout(session.keepaliveTimer);
  clearTimeout(session.idleTimer);
  session.keepaliveTimer = undefined;
  session.idleTimer = undefined;
}

function armKeepalive(session: PooledSession): void {
  clearTimeout(session.keepaliveTimer);
  const timer = setTimeout(() => {
    if (session.closed) {
      return;
    }
    const socket = session.connection?.socket;
    if (!socket || socket.readyState !== DIALOGUE_SOCKET_OPEN || !session.voicesSent) {
      if (!session.closed && socket?.readyState === DIALOGUE_SOCKET_OPEN) {
        armKeepalive(session);
      }
      return;
    }
    try {
      socket.send(JSON.stringify({ keep_alive: true }));
    } catch {
      retireSession(session);
      return;
    }
    armKeepalive(session);
  }, session.keepaliveMs);
  timer.unref?.();
  session.keepaliveTimer = timer;
}

function armIdle(session: PooledSession): void {
  clearTimeout(session.idleTimer);
  const timer = setTimeout(() => {
    retireSession(session);
  }, session.sessionIdleMs);
  timer.unref?.();
  session.idleTimer = timer;
}

async function openDialogueConnection(
  endpoint: DialogueEndpoint,
  apiKey: string,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<ActiveConnection> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  const socket = socketFactory(endpoint.url, {
    headers: { "xi-api-key": apiKey },
  });
  const buffer = new MessageBuffer(socket);
  const timer = setTimeout(
    () => {
      buffer.fail(dialogueTimeout(endpoint.timeoutMs));
      socket.close();
    },
    msUntilDeadline(deadlineAt, endpoint.timeoutMs),
  );
  timer.unref?.();
  try {
    await waitForDialogueOpen(socket, signal);
  } catch (error) {
    clearTimeout(timer);
    socket.close();
    throw error;
  }
  clearTimeout(timer);
  return { socket, buffer };
}

function armDialogueDeadline(
  timeoutMs: number,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.();
  return timer;
}

async function speakTurn(
  connection: ActiveConnection,
  endpoint: DialogueEndpoint,
  onAudio: (chunk: Buffer) => void,
  sendVoices: boolean,
  session?: PooledSession,
): Promise<"turn" | "socket"> {
  if (sendVoices) {
    if (session) {
      session.voicesSent = true;
    }
    sendDialogueJson(
      connection.socket,
      {
        voices: [endpoint.voiceId],
        ...(endpoint.stability === undefined
          ? {}
          : { voice_settings: { stability: endpoint.stability } }),
      },
      session,
    );
  }
  sendDialogueJson(
    connection.socket,
    {
      inputs: [{ text: endpoint.text, voice_id: endpoint.voiceId, new_turn: true }],
      flush: true,
    },
    session,
  );
  return await readDialogueAudio(connection.buffer, onAudio, endpoint.maxAudioBytes);
}

function sendDialogueJson(
  socket: ElevenLabsDialogueSocket,
  payload: unknown,
  session?: PooledSession,
): void {
  if (socket.readyState !== DIALOGUE_SOCKET_OPEN) {
    throw new Error("ElevenLabs dialogue connection is not open");
  }
  socket.send(JSON.stringify(payload));
  if (session && !session.closed) {
    armKeepalive(session);
  }
}

async function readDialogueAudio(
  buffer: MessageBuffer,
  onAudio: (chunk: Buffer) => void,
  maxAudioBytes: number,
): Promise<"turn" | "socket"> {
  let total = 0;
  for (let count = 0; count < MAX_DIALOGUE_MESSAGES; count += 1) {
    const message = asDialogueRecord(await buffer.next());
    throwIfDialogueServerError(message);
    const audio = readDialogueAudioChunk(message);
    if (audio) {
      total += audio.byteLength;
      if (total > maxAudioBytes) {
        throw new Error(`ElevenLabs dialogue audio exceeds ${maxAudioBytes} bytes`);
      }
      onAudio(audio);
    }
    if (message.is_final === true) {
      return "socket";
    }
    if (message.is_final_audio_for_turn === true) {
      return "turn";
    }
  }
  throw new Error("ElevenLabs dialogue exceeded the message limit");
}

function waitForDialogueOpen(socket: ElevenLabsDialogueSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  if (socket.readyState === DIALOGUE_SOCKET_OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      settle();
    };
    socket.onOpen(() => finish(resolve));
    socket.onError((error) => {
      finish(() => reject(error));
    });
    socket.onClose(() => {
      finish(() => reject(new Error("ElevenLabs dialogue connection closed before it was ready")));
    });
    signal.addEventListener(
      "abort",
      () => {
        finish(() => reject(abortError(signal)));
      },
      { once: true },
    );
    if (socket.readyState === DIALOGUE_SOCKET_OPEN) {
      finish(resolve);
    }
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error("ElevenLabs dialogue aborted");
}
