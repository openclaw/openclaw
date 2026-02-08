import { Attachment, EncryptedAttachment } from "@matrix-org/matrix-sdk-crypto-nodejs";
import {
  ClientEvent,
  MatrixEventEvent,
  createClient as createMatrixJsClient,
  type MatrixClient as MatrixJsClient,
  type MatrixEvent,
} from "matrix-js-sdk";
import { EventEmitter } from "node:events";

type Logger = {
  trace: (module: string, ...messageOrObject: unknown[]) => void;
  debug: (module: string, ...messageOrObject: unknown[]) => void;
  info: (module: string, ...messageOrObject: unknown[]) => void;
  warn: (module: string, ...messageOrObject: unknown[]) => void;
  error: (module: string, ...messageOrObject: unknown[]) => void;
};

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;

type QueryParams = Record<string, QueryValue> | null | undefined;

type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
  state_key?: string;
};

type MatrixClientEventMap = {
  "room.event": [roomId: string, event: MatrixRawEvent];
  "room.message": [roomId: string, event: MatrixRawEvent];
  "room.encrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.decrypted_event": [roomId: string, event: MatrixRawEvent];
  "room.failed_decryption": [roomId: string, event: MatrixRawEvent, error: Error];
  "room.invite": [roomId: string, event: MatrixRawEvent];
  "room.join": [roomId: string, event: MatrixRawEvent];
};

function noop(): void {
  // no-op
}

export class ConsoleLogger {
  trace(module: string, ...messageOrObject: unknown[]): void {
    console.debug(`[${module}]`, ...messageOrObject);
  }

  debug(module: string, ...messageOrObject: unknown[]): void {
    console.debug(`[${module}]`, ...messageOrObject);
  }

  info(module: string, ...messageOrObject: unknown[]): void {
    console.info(`[${module}]`, ...messageOrObject);
  }

  warn(module: string, ...messageOrObject: unknown[]): void {
    console.warn(`[${module}]`, ...messageOrObject);
  }

  error(module: string, ...messageOrObject: unknown[]): void {
    console.error(`[${module}]`, ...messageOrObject);
  }
}

const defaultLogger = new ConsoleLogger();
let activeLogger: Logger = defaultLogger;

export const LogService = {
  setLogger(logger: Logger): void {
    activeLogger = logger;
  },
  trace(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.trace(module, ...messageOrObject);
  },
  debug(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.debug(module, ...messageOrObject);
  },
  info(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.info(module, ...messageOrObject);
  },
  warn(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.warn(module, ...messageOrObject);
  },
  error(module: string, ...messageOrObject: unknown[]): void {
    activeLogger.error(module, ...messageOrObject);
  },
};

export type EncryptedFile = {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
};

export type FileWithThumbnailInfo = {
  size?: number;
  mimetype?: string;
  thumbnail_url?: string;
  thumbnail_info?: {
    w?: number;
    h?: number;
    mimetype?: string;
    size?: number;
  };
};

export type DimensionalFileInfo = FileWithThumbnailInfo & {
  w?: number;
  h?: number;
};

export type TimedFileInfo = FileWithThumbnailInfo & {
  duration?: number;
};

export type VideoFileInfo = DimensionalFileInfo &
  TimedFileInfo & {
    duration?: number;
  };

export type MessageEventContent = {
  msgtype?: string;
  body?: string;
  format?: string;
  formatted_body?: string;
  filename?: string;
  url?: string;
  file?: EncryptedFile;
  info?: Record<string, unknown>;
  "m.relates_to"?: Record<string, unknown>;
  "m.new_content"?: unknown;
  "m.mentions"?: {
    user_ids?: string[];
    room?: boolean;
  };
  [key: string]: unknown;
};

export type TextualMessageEventContent = MessageEventContent & {
  msgtype: string;
  body: string;
};

export type LocationMessageEventContent = MessageEventContent & {
  msgtype?: string;
  geo_uri?: string;
};

type MatrixCryptoFacade = {
  prepare: (joinedRooms: string[]) => Promise<void>;
  updateSyncData: (
    toDeviceMessages: unknown,
    otkCounts: unknown,
    unusedFallbackKeyAlgs: unknown,
    changedDeviceLists: unknown,
    leftDeviceLists: unknown,
  ) => Promise<void>;
  isRoomEncrypted: (roomId: string) => Promise<boolean>;
  requestOwnUserVerification: () => Promise<unknown | null>;
  encryptMedia: (buffer: Buffer) => Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }>;
  decryptMedia: (file: EncryptedFile) => Promise<Buffer>;
};

export class MatrixClient {
  private readonly client: MatrixJsClient;
  private readonly emitter = new EventEmitter();
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly localTimeoutMs: number;
  private readonly initialSyncLimit?: number;
  private readonly encryptionEnabled: boolean;
  private bridgeRegistered = false;
  private started = false;
  private selfUserId: string | null;
  private readonly dmRoomIds = new Set<string>();
  private cryptoInitialized = false;
  private readonly decryptedMessageDedupe = new Map<string, number>();

  readonly dms = {
    update: async (): Promise<void> => {
      await this.refreshDmCache();
    },
    isDm: (roomId: string): boolean => this.dmRoomIds.has(roomId),
  };

  crypto?: MatrixCryptoFacade;

  constructor(
    homeserver: string,
    accessToken: string,
    _storage?: unknown,
    _cryptoStorage?: unknown,
    opts: {
      userId?: string;
      deviceId?: string;
      localTimeoutMs?: number;
      encryption?: boolean;
      initialSyncLimit?: number;
    } = {},
  ) {
    this.homeserver = homeserver;
    this.accessToken = accessToken;
    this.localTimeoutMs = Math.max(1, opts.localTimeoutMs ?? 60_000);
    this.initialSyncLimit = opts.initialSyncLimit;
    this.encryptionEnabled = opts.encryption === true;
    this.selfUserId = opts.userId?.trim() || null;
    this.client = createMatrixJsClient({
      baseUrl: homeserver,
      accessToken,
      userId: opts.userId,
      deviceId: opts.deviceId,
      localTimeoutMs: this.localTimeoutMs,
    });

    if (this.encryptionEnabled) {
      this.crypto = this.createCryptoFacade();
    }
  }

  on<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this;
  on(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  off<TEvent extends keyof MatrixClientEventMap>(
    eventName: TEvent,
    listener: (...args: MatrixClientEventMap[TEvent]) => void,
  ): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this;
  off(eventName: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(eventName, listener as (...args: unknown[]) => void);
    return this;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.registerBridge();

    if (this.encryptionEnabled && !this.cryptoInitialized) {
      try {
        await this.client.initRustCrypto();
        this.cryptoInitialized = true;
      } catch (err) {
        LogService.warn("MatrixClientLite", "Failed to initialize rust crypto:", err);
      }
    }

    await this.client.startClient({
      initialSyncLimit: this.initialSyncLimit,
    });
    this.started = true;
    await this.refreshDmCache().catch(noop);
  }

  stop(): void {
    this.client.stopClient();
    this.started = false;
  }

  async getUserId(): Promise<string> {
    const fromClient = this.client.getUserId();
    if (fromClient) {
      this.selfUserId = fromClient;
      return fromClient;
    }
    if (this.selfUserId) {
      return this.selfUserId;
    }
    const whoami = (await this.doRequest("GET", "/_matrix/client/v3/account/whoami")) as {
      user_id?: string;
    };
    const resolved = whoami.user_id?.trim();
    if (!resolved) {
      throw new Error("Matrix whoami did not return user_id");
    }
    this.selfUserId = resolved;
    return resolved;
  }

  async getJoinedRooms(): Promise<string[]> {
    const joined = await this.client.getJoinedRooms();
    return Array.isArray(joined.joined_rooms) ? joined.joined_rooms : [];
  }

  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    const members = await this.client.getJoinedRoomMembers(roomId);
    const joined = members?.joined;
    if (!joined || typeof joined !== "object") {
      return [];
    }
    return Object.keys(joined);
  }

  async getRoomStateEvent(
    roomId: string,
    eventType: string,
    stateKey = "",
  ): Promise<Record<string, unknown>> {
    const state = await this.client.getStateEvent(roomId, eventType, stateKey);
    return (state ?? {}) as Record<string, unknown>;
  }

  async getAccountData(eventType: string): Promise<Record<string, unknown> | undefined> {
    const event = this.client.getAccountData(eventType);
    return (event?.getContent() as Record<string, unknown> | undefined) ?? undefined;
  }

  async setAccountData(eventType: string, content: Record<string, unknown>): Promise<void> {
    await this.client.setAccountData(eventType as never, content as never);
    await this.refreshDmCache().catch(noop);
  }

  async resolveRoom(aliasOrRoomId: string): Promise<string | null> {
    if (aliasOrRoomId.startsWith("!")) {
      return aliasOrRoomId;
    }
    if (!aliasOrRoomId.startsWith("#")) {
      return aliasOrRoomId;
    }
    try {
      const resolved = await this.client.getRoomIdForAlias(aliasOrRoomId);
      return resolved.room_id ?? null;
    } catch {
      return null;
    }
  }

  async sendMessage(roomId: string, content: MessageEventContent): Promise<string> {
    const sent = await this.client.sendMessage(roomId, content as never);
    return sent.event_id;
  }

  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const sent = await this.client.sendEvent(roomId, eventType as never, content as never);
    return sent.event_id;
  }

  async sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const sent = await this.client.sendStateEvent(
      roomId,
      eventType as never,
      content as never,
      stateKey,
    );
    return sent.event_id;
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const sent = await this.client.redactEvent(
      roomId,
      eventId,
      undefined,
      reason?.trim() ? { reason } : undefined,
    );
    return sent.event_id;
  }

  async doRequest(
    method: HttpMethod,
    endpoint: string,
    qs?: QueryParams,
    body?: unknown,
  ): Promise<unknown> {
    return await this.requestJson({
      method,
      endpoint,
      qs,
      body,
      timeoutMs: this.localTimeoutMs,
    });
  }

  async getUserProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return await this.client.getProfileInfo(userId);
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.client.joinRoom(roomId);
  }

  mxcToHttp(mxcUrl: string): string | null {
    return this.client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, true, false, true);
  }

  async downloadContent(mxcUrl: string, allowRemote = true): Promise<Buffer> {
    const parsed = parseMxc(mxcUrl);
    if (!parsed) {
      throw new Error(`Invalid Matrix content URI: ${mxcUrl}`);
    }
    const endpoint = `/_matrix/media/v3/download/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    const response = await this.requestRaw({
      method: "GET",
      endpoint,
      qs: { allow_remote: allowRemote },
      timeoutMs: this.localTimeoutMs,
    });
    return response;
  }

  async uploadContent(file: Buffer, contentType?: string, filename?: string): Promise<string> {
    const uploaded = await this.client.uploadContent(file, {
      type: contentType || "application/octet-stream",
      name: filename,
      includeFilename: Boolean(filename),
    });
    return uploaded.content_uri;
  }

  async getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>> {
    return (await this.client.fetchRoomEvent(roomId, eventId)) as Record<string, unknown>;
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs: number): Promise<void> {
    await this.client.sendTyping(roomId, typing, timeoutMs);
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.requestJson({
      method: "POST",
      endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(
        eventId,
      )}`,
      body: {},
      timeoutMs: this.localTimeoutMs,
    });
  }

  private registerBridge(): void {
    if (this.bridgeRegistered) {
      return;
    }
    this.bridgeRegistered = true;

    this.client.on(ClientEvent.Event, (event: MatrixEvent) => {
      const roomId = event.getRoomId();
      if (!roomId) {
        return;
      }

      const raw = matrixEventToRaw(event);
      const isEncryptedEvent = raw.type === "m.room.encrypted";
      this.emitter.emit("room.event", roomId, raw);
      if (isEncryptedEvent) {
        this.emitter.emit("room.encrypted_event", roomId, raw);
      } else {
        if (!this.isDuplicateDecryptedMessage(roomId, raw.event_id)) {
          this.emitter.emit("room.message", roomId, raw);
        }
      }

      const stateKey = raw.state_key ?? "";
      const selfUserId = this.client.getUserId() ?? this.selfUserId ?? "";
      const membership =
        raw.type === "m.room.member"
          ? (raw.content as { membership?: string }).membership
          : undefined;
      if (stateKey && selfUserId && stateKey === selfUserId) {
        if (membership === "invite") {
          this.emitter.emit("room.invite", roomId, raw);
        } else if (membership === "join") {
          this.emitter.emit("room.join", roomId, raw);
        }
      }

      if (isEncryptedEvent) {
        event.on(MatrixEventEvent.Decrypted, (decryptedEvent: MatrixEvent, err?: Error) => {
          const decryptedRoomId = decryptedEvent.getRoomId() || roomId;
          const decryptedRaw = matrixEventToRaw(decryptedEvent);
          if (err) {
            this.emitter.emit("room.failed_decryption", decryptedRoomId, decryptedRaw, err);
            return;
          }
          const failed =
            typeof (decryptedEvent as { isDecryptionFailure?: () => boolean })
              .isDecryptionFailure === "function" &&
            (decryptedEvent as { isDecryptionFailure: () => boolean }).isDecryptionFailure();
          if (failed) {
            this.emitter.emit(
              "room.failed_decryption",
              decryptedRoomId,
              decryptedRaw,
              new Error("Matrix event failed to decrypt"),
            );
            return;
          }
          this.emitter.emit("room.decrypted_event", decryptedRoomId, decryptedRaw);
          this.rememberDecryptedMessage(decryptedRoomId, decryptedRaw.event_id);
          this.emitter.emit("room.message", decryptedRoomId, decryptedRaw);
        });
      }
    });
  }

  private rememberDecryptedMessage(roomId: string, eventId: string): void {
    if (!eventId) {
      return;
    }
    const now = Date.now();
    this.pruneDecryptedMessageDedupe(now);
    this.decryptedMessageDedupe.set(`${roomId}|${eventId}`, now);
  }

  private isDuplicateDecryptedMessage(roomId: string, eventId: string): boolean {
    if (!eventId) {
      return false;
    }
    const key = `${roomId}|${eventId}`;
    const createdAt = this.decryptedMessageDedupe.get(key);
    if (createdAt === undefined) {
      return false;
    }
    this.decryptedMessageDedupe.delete(key);
    return true;
  }

  private pruneDecryptedMessageDedupe(now: number): void {
    const ttlMs = 30_000;
    for (const [key, createdAt] of this.decryptedMessageDedupe) {
      if (now - createdAt > ttlMs) {
        this.decryptedMessageDedupe.delete(key);
      }
    }
    const maxEntries = 2048;
    while (this.decryptedMessageDedupe.size > maxEntries) {
      const oldest = this.decryptedMessageDedupe.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.decryptedMessageDedupe.delete(oldest);
    }
  }

  private createCryptoFacade(): MatrixCryptoFacade {
    return {
      prepare: async (_joinedRooms: string[]) => {
        // matrix-js-sdk performs crypto prep during startup; no extra work required here.
      },
      updateSyncData: async (
        _toDeviceMessages: unknown,
        _otkCounts: unknown,
        _unusedFallbackKeyAlgs: unknown,
        _changedDeviceLists: unknown,
        _leftDeviceLists: unknown,
      ) => {
        // compatibility no-op
      },
      isRoomEncrypted: async (roomId: string): Promise<boolean> => {
        const room = this.client.getRoom(roomId);
        if (room?.hasEncryptionStateEvent()) {
          return true;
        }
        try {
          const event = await this.getRoomStateEvent(roomId, "m.room.encryption", "");
          return typeof event.algorithm === "string" && event.algorithm.length > 0;
        } catch {
          return false;
        }
      },
      requestOwnUserVerification: async (): Promise<unknown | null> => {
        const crypto = this.client.getCrypto();
        if (!crypto) {
          return null;
        }
        return await crypto.requestOwnUserVerification();
      },
      encryptMedia: async (
        buffer: Buffer,
      ): Promise<{ buffer: Buffer; file: Omit<EncryptedFile, "url"> }> => {
        const encrypted = Attachment.encrypt(new Uint8Array(buffer));
        const mediaInfoJson = encrypted.mediaEncryptionInfo;
        if (!mediaInfoJson) {
          throw new Error("Matrix media encryption failed: missing media encryption info");
        }
        const parsed = JSON.parse(mediaInfoJson) as EncryptedFile;
        return {
          buffer: Buffer.from(encrypted.encryptedData),
          file: {
            key: parsed.key,
            iv: parsed.iv,
            hashes: parsed.hashes,
            v: parsed.v,
          },
        };
      },
      decryptMedia: async (file: EncryptedFile): Promise<Buffer> => {
        const encrypted = await this.downloadContent(file.url);
        const metadata: EncryptedFile = {
          url: file.url,
          key: file.key,
          iv: file.iv,
          hashes: file.hashes,
          v: file.v,
        };
        const attachment = new EncryptedAttachment(
          new Uint8Array(encrypted),
          JSON.stringify(metadata),
        );
        const decrypted = Attachment.decrypt(attachment);
        return Buffer.from(decrypted);
      },
    };
  }

  private async refreshDmCache(): Promise<void> {
    const direct = await this.getAccountData("m.direct");
    this.dmRoomIds.clear();
    if (!direct || typeof direct !== "object") {
      return;
    }
    for (const value of Object.values(direct)) {
      if (!Array.isArray(value)) {
        continue;
      }
      for (const roomId of value) {
        if (typeof roomId === "string" && roomId.trim()) {
          this.dmRoomIds.add(roomId);
        }
      }
    }
  }

  private async requestJson(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
  }): Promise<unknown> {
    const { response, text } = await this.performRequest({
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      body: params.body,
      timeoutMs: params.timeoutMs,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, text);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      if (!text.trim()) {
        return {};
      }
      return JSON.parse(text);
    }
    return text;
  }

  private async requestRaw(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    timeoutMs: number;
  }): Promise<Buffer> {
    const { response, buffer } = await this.performRequest({
      method: params.method,
      endpoint: params.endpoint,
      qs: params.qs,
      timeoutMs: params.timeoutMs,
      raw: true,
    });
    if (!response.ok) {
      throw buildHttpError(response.status, buffer.toString("utf8"));
    }
    return buffer;
  }

  private async performRequest(params: {
    method: HttpMethod;
    endpoint: string;
    qs?: QueryParams;
    body?: unknown;
    timeoutMs: number;
    raw?: boolean;
  }): Promise<{ response: Response; text: string; buffer: Buffer }> {
    const baseUrl =
      params.endpoint.startsWith("http://") || params.endpoint.startsWith("https://")
        ? new URL(params.endpoint)
        : new URL(normalizeEndpoint(params.endpoint), this.homeserver);
    applyQuery(baseUrl, params.qs);

    const headers = new Headers();
    headers.set("Accept", params.raw ? "*/*" : "application/json");
    if (this.accessToken) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }

    let body: BodyInit | undefined;
    if (params.body !== undefined) {
      if (
        params.body instanceof Uint8Array ||
        params.body instanceof ArrayBuffer ||
        typeof params.body === "string"
      ) {
        body = params.body as BodyInit;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(params.body);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const response = await fetchWithSafeRedirects(baseUrl, {
        method: params.method,
        headers,
        body,
        signal: controller.signal,
      });
      if (params.raw) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
          response,
          text: bytes.toString("utf8"),
          buffer: bytes,
        };
      }
      const text = await response.text();
      return {
        response,
        text,
        buffer: Buffer.from(text, "utf8"),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function matrixEventToRaw(event: MatrixEvent): MatrixRawEvent {
  const unsigned = (event.getUnsigned?.() ?? {}) as {
    age?: number;
    redacted_because?: unknown;
  };
  const raw: MatrixRawEvent = {
    event_id: event.getId() ?? "",
    sender: event.getSender() ?? "",
    type: event.getType() ?? "",
    origin_server_ts: event.getTs() ?? 0,
    content: ((event.getContent?.() ?? {}) as Record<string, unknown>) || {},
    unsigned,
  };
  const stateKey = resolveMatrixStateKey(event);
  if (typeof stateKey === "string") {
    raw.state_key = stateKey;
  }
  return raw;
}

function resolveMatrixStateKey(event: MatrixEvent): string | undefined {
  const direct = event.getStateKey?.();
  if (typeof direct === "string") {
    return direct;
  }
  const wireContent = (
    event as { getWireContent?: () => { state_key?: unknown } }
  ).getWireContent?.();
  if (wireContent && typeof wireContent.state_key === "string") {
    return wireContent.state_key;
  }
  const rawEvent = (event as { event?: { state_key?: unknown } }).event;
  if (rawEvent && typeof rawEvent.state_key === "string") {
    return rawEvent.state_key;
  }
  return undefined;
}

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) {
    return "/";
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function applyQuery(url: URL, qs: QueryParams): void {
  if (!qs) {
    return;
  }
  for (const [key, rawValue] of Object.entries(qs)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item === undefined || item === null) {
          continue;
        }
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(rawValue));
  }
}

function parseMxc(url: string): { server: string; mediaId: string } | null {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(url.trim());
  if (!match) {
    return null;
  }
  return {
    server: match[1],
    mediaId: match[2],
  };
}

function buildHttpError(statusCode: number, bodyText: string): Error & { statusCode: number } {
  let message = `Matrix HTTP ${statusCode}`;
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        message = parsed.error.trim();
      } else {
        message = bodyText.slice(0, 500);
      }
    } catch {
      message = bodyText.slice(0, 500);
    }
  }
  return Object.assign(new Error(message), { statusCode });
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

async function fetchWithSafeRedirects(url: URL, init: RequestInit): Promise<Response> {
  let currentUrl = new URL(url.toString());
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers ?? {});
  const maxRedirects = 5;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Matrix redirect missing location header (${currentUrl.toString()})`);
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== currentUrl.protocol) {
      throw new Error(
        `Blocked cross-protocol redirect (${currentUrl.protocol} -> ${nextUrl.protocol})`,
      );
    }

    if (nextUrl.origin !== currentUrl.origin) {
      headers = new Headers(headers);
      headers.delete("authorization");
    }

    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method !== "GET" &&
        method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("content-type");
      headers.delete("content-length");
    }

    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects while requesting ${url.toString()}`);
}
