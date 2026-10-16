import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import {
  ControlUiReplyCorrelation,
  controlUiRequestSettled,
  type ControlUiRequestMeasurement,
} from "./gateway-bench-control-ui-correlation.ts";
import { createControlUiJournalWriter } from "./gateway-bench-control-ui-journal.ts";
import { createGatewayWsClient } from "./gateway-ws-client.ts";

export type ControlUiDriverSetup = {
  type: "setup";
  port: number;
  protocolVersion: number;
  token: string;
  clientIndices: number[];
  activeClients: number;
  requestTimeoutMs: number;
  journalPath: string;
};
export type ControlUiDriverResult = {
  type: "result";
  pid: number;
  requests: ControlUiRequestMeasurement[];
  error: string | null;
  startLagMs: number;
  counts: { connected: number; subscribed: number; active: number };
  clientIndices: number[];
  forcedClientClose: number;
  partial: boolean;
};
type Start = { type: "start"; startNs: string; durationMs: number };
type Client = Awaited<ReturnType<typeof connectClient>>;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const correlation = new ControlUiReplyCorrelation();
const clients: Client[] = [];
const cancelConnections: Array<() => void> = [];
const sockets: ReturnType<typeof createGatewayWsClient>["ws"][] = [];
const cancellation = new AbortController();
const measured: ControlUiRequestMeasurement[] = [];
let setup: ControlUiDriverSetup | undefined;
let phase: "initial" | "setup" | "ready" | "running" | "drained" | "finishing" | "done" = "initial";
let stopping = false;
let closing = false;
let fatalError: string | null = null;
let connected = 0,
  subscribed = 0,
  forcedClientClose = 0;
let startMs = 0,
  durationMs = 1,
  startLagMs = 0;
let work = Promise.resolve();
let finalization: Promise<void> | undefined;
let journal = Promise.resolve();
let journalFile: FileHandle | undefined;
const appendJournal = createControlUiJournalWriter(
  (text) => journalFile!.appendFile(text),
  (error) => {
    fatalError ??= `Driver journal failed: ${errorText(error)}`;
  },
);
const cohort = () => ({
  clientIndices: setup?.clientIndices ?? [],
  counts: {
    connected,
    subscribed,
    active: setup?.clientIndices.filter((index) => index < setup!.activeClients).length ?? 0,
  },
});
function record(data: Record<string, unknown>) {
  const file = journalFile;
  if (!file) {
    return journal;
  }
  const line = `${JSON.stringify({ ...data, phase, atMs: now() })}\n`;
  journal = appendJournal(line);
  return journal;
}
const send = (message: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Control UI driver requires parent IPC"));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });

async function connectClient(options: ControlUiDriverSetup, index: number) {
  const sessionKey = `agent:main:control-ui-${index}`;
  const challenge = Promise.withResolvers<Record<string, unknown>>();
  let pending: { row: ControlUiRequestMeasurement; resolve: () => void } | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: unknown) => {
    fatalError ??= errorText(error);
    void record({ type: "error", error: fatalError });
    if (pending) {
      pending.row.error ??= fatalError;
      pending.resolve();
    }
  };
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${options.port}`,
    origin: `http://127.0.0.1:${options.port}`,
    onEvent: (event) => {
      if (event.event === "connect.challenge" && isRecord(event.payload)) {
        challenge.resolve(event.payload);
      }
      if (
        event.event === "chat" &&
        isRecord(event.payload) &&
        event.payload.sessionKey === sessionKey
      ) {
        try {
          const row = correlation.observe(event.payload, now());
          if (row) {
            void record(
              "kind" in row
                ? { type: "delta", ...row }
                : { type: "request", stage: "observed", request: row },
            );
          }
          if (pending && controlUiRequestSettled(pending.row)) {
            pending.resolve();
          }
        } catch (error) {
          fail(error);
        }
      }
    },
  });
  sockets.push(client.ws);
  cancelConnections.push(() => {
    challenge.reject(new Error("Control UI driver stopped"));
    clearTimeout(requestTimer);
    if (pending) {
      pending.row.error ??= "Control UI driver stopped";
      pending.resolve();
    }
    client.close();
  });
  client.ws.on("error", fail);
  client.ws.on("close", () => {
    if (!closing) {
      fail(new Error(`Control UI client ${index} closed unexpectedly`));
    }
  });
  const rpc = async (method: string, params: unknown) => {
    const response = await client.request(method, params, options.requestTimeoutMs);
    if (!response.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    }
    return response.payload;
  };
  const challengeTimer = setTimeout(
    () => challenge.reject(new Error("Control UI challenge timed out")),
    options.requestTimeoutMs,
  );
  // Observe rejection immediately even if transport opening fails before the challenge arrives.
  void challenge.promise.catch(() => {});
  try {
    await client.waitOpen();
    const { nonce, ts } = await challenge.promise;
    if (typeof nonce !== "string" || typeof ts !== "number") {
      throw new Error("Malformed Control UI challenge");
    }
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const scopes = ["operator.read", "operator.write", "operator.admin"];
    const identity = {
      id: "openclaw-control-ui",
      mode: "webchat",
      platform: "web",
      version: "benchmark",
      instanceId: `bench-${index}`,
    };
    const payload = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: identity.id,
      clientMode: identity.mode,
      platform: identity.platform,
      role: "operator",
      scopes,
      signedAtMs: ts,
      token: options.token,
      nonce,
    });
    await rpc("connect", {
      minProtocol: options.protocolVersion,
      maxProtocol: options.protocolVersion,
      client: identity,
      role: "operator",
      scopes,
      auth: { token: options.token },
      device: {
        id: deviceId,
        publicKey,
        signedAt: ts,
        nonce,
        signature: signEd25519Payload(
          keys.privateKey.export({ type: "pkcs8", format: "pem" }),
          payload,
        ),
      },
      caps: [
        "agent-kind",
        "approvals",
        "task-suggestions",
        "terminal-offset-seq",
        "terminal-session-metadata",
        "terminal-upload-path-style",
        "tool-events",
        "chat-only-assistant-text",
        "session-scoped-events",
        "inline-widgets",
        "model-selection-policy",
        "ui-commands",
        "ultrafast",
        "usage-refreshing",
      ],
    });
    connected += 1;
    await rpc("sessions.create", { key: sessionKey, agentId: "main" });
    const sessionSubscription = await rpc("sessions.subscribe", {});
    await rpc("sessions.observer.visibility", { visible: true });
    const messages = await rpc("sessions.messages.subscribe", {
      key: sessionKey,
      subscriptionId: `bench-${index}`,
    });
    if (
      !isRecord(sessionSubscription) ||
      sessionSubscription.subscribed !== true ||
      !isRecord(messages) ||
      messages.subscribed !== true
    ) {
      throw new Error("Control UI session subscription was not activated");
    }
    subscribed += 1;
  } catch (error) {
    client.ws.terminate();
    throw error;
  } finally {
    clearTimeout(challengeTimer);
  }
  let ordinal = 0;
  return {
    index,
    async turn() {
      const requestId = `bench-${index}-${ordinal++}`;
      const token = `OPENCLAW_E2E_CONTROLUI_${index}_${ordinal}`;
      const row = correlation.register({
        clientIndex: index,
        requestId,
        sessionKey,
        token,
        sentMs: now(),
      });
      if (phase === "running") {
        measured.push(row);
      }
      void record({ type: "request", stage: "registered", request: row });
      const completion = Promise.withResolvers<void>();
      pending = { row, resolve: completion.resolve };
      requestTimer = setTimeout(() => {
        row.error ??= "Control UI reply timed out";
        completion.resolve();
      }, options.requestTimeoutMs);
      try {
        const ack = await rpc("chat.send", {
          sessionKey,
          message: `Reply with exactly ${token}.`,
          deliver: false,
          idempotencyKey: requestId,
        });
        correlation.acknowledge(requestId, ack, now());
        void record({ type: "request", stage: "ack", request: row });
        if (!controlUiRequestSettled(row)) {
          await completion.promise;
        }
      } catch (error) {
        row.error ??= errorText(error);
      } finally {
        clearTimeout(requestTimer);
        pending = undefined;
      }
      void record({ type: "request", stage: "complete", request: row });
      return row;
    },
  };
}

async function handle(message: ControlUiDriverSetup | Start) {
  if (message.type === "setup" && phase === "initial") {
    phase = "setup";
    setup = message;
    journalFile = await open(setup.journalPath, "ax");
    await record({ type: "setup", ...cohort() });
    // Four serial connection lanes avoid a 100-client admission burst before load begins.
    for (const index of setup.clientIndices) {
      if (stopping) {
        return;
      }
      clients.push(await connectClient(setup, index));
    }
    if (stopping) {
      return;
    }
    const warmup = await Promise.all(
      clients
        .filter((client) => client.index < message.activeClients)
        .map((client) => client.turn()),
    );
    await journal;
    if (fatalError || warmup.some((row) => row.error)) {
      throw new Error(fatalError ?? warmup.find((row) => row.error)!.error!);
    }
    phase = "ready";
    const affinity =
      process.platform === "linux"
        ? readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]
        : undefined;
    await send({
      type: "ready",
      pid: process.pid,
      affinity,
      warmupReplies: warmup.length,
      ...cohort(),
    });
  } else if (message.type === "start" && phase === "ready" && setup) {
    phase = "running";
    startMs = Number(BigInt(message.startNs)) / 1e6;
    durationMs = message.durationMs;
    const deadline = startMs + durationMs;
    void record({ type: "start", startNs: message.startNs, durationMs });
    while (now() < startMs) {
      if (stopping) {
        break;
      }
      await delay(Math.max(1, startMs - now()), undefined, { signal: cancellation.signal });
    }
    startLagMs = now() - startMs;
    await Promise.all(
      clients
        .filter((client) => client.index < setup!.activeClients)
        .map(async (client) => {
          while (now() < deadline) {
            if (stopping || fatalError) {
              break;
            }
            const row = await client.turn();
            if (row.error) {
              break;
            }
          }
        }),
    );
    if (now() < deadline) {
      await delay(deadline - now(), undefined, { signal: cancellation.signal });
    }
    if (stopping) {
      return;
    }
    phase = "drained";
    void record({ type: "drained", ...cohort() });
    await send({ type: "drained", pid: process.pid, ...cohort() });
  } else {
    throw new Error(`Unexpected Control UI driver message in ${phase}`);
  }
}

function finish(partial: boolean, emitResult = true): Promise<void> {
  if (finalization) {
    return finalization;
  }
  if (partial) {
    closing = true;
    stopping = true;
    fatalError ??= "Control UI driver stopped before completion";
    cancellation.abort();
    for (const cancel of cancelConnections) {
      cancel();
    }
  }
  finalization = (async () => {
    await work.catch(() => {});
    if (!partial && sockets.some((socket) => socket.readyState !== socket.OPEN)) {
      fatalError ??= "Control UI connection closed before finalization";
    }
    closing = true;
    phase = "finishing";
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === socket.CLOSED) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              forcedClientClose += 1;
              socket.terminate();
            }, 2_000);
            socket.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            socket.close();
          }),
      ),
    );
    const requests = measured.map((row) =>
      Object.assign({}, row, {
        sentMs: row.sentMs - startMs,
        ackMs: row.ackMs === null ? null : row.ackMs - startMs,
        firstDeltaMs: row.firstDeltaMs === null ? null : row.firstDeltaMs - startMs,
        finalMs: row.finalMs === null ? null : row.finalMs - startMs,
      }),
    );
    await record({ type: "finish", partial, forcedClientClose, error: fatalError, ...cohort() });
    phase = "done";
    try {
      if (emitResult && process.connected) {
        await send({
          type: "result",
          pid: process.pid,
          requests,
          error: fatalError,
          startLagMs,
          ...cohort(),
          forcedClientClose,
          partial,
        } satisfies ControlUiDriverResult);
      }
    } catch (error) {
      process.exitCode = 1;
      await record({ type: "error", error: `Final IPC failed: ${errorText(error)}` });
    } finally {
      await journalFile?.close();
      if (process.connected) {
        process.disconnect?.();
      }
    }
  })();
  return finalization;
}

async function reportFailure(error: unknown) {
  if (stopping) {
    return;
  }
  process.exitCode = 1;
  fatalError ??= errorText(error);
  try {
    await record({ type: "error", error: fatalError });
    if (process.connected) {
      await send({ type: "error", error: fatalError, ...cohort() });
    }
  } finally {
    await finish(true, false);
  }
}

process.on("message", (message: Parameters<typeof handle>[0] | { type: "finish" | "stop" }) => {
  if (message.type === "stop") {
    void finish(true);
    return;
  }
  if (message.type === "finish" && phase === "drained") {
    void finish(false);
    return;
  }
  if (
    !(
      (message.type === "setup" && phase === "initial") ||
      (message.type === "start" && phase === "ready")
    )
  ) {
    void reportFailure(new Error(`Unexpected ${message.type} in ${phase}`));
    return;
  }
  work = handle(message);
  void work.catch(reportFailure);
});
process.on("disconnect", () => {
  void finish(true, false);
});
