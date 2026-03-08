import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { RuntimeLogger } from "openclaw/plugin-sdk";
import type { MatrixAuth } from "./client.js";
import { resolveMatrixStoragePaths } from "./client/storage.js";

type OwnUserDevice = {
  device_id: string;
  display_name?: string;
  last_seen_ip?: string;
  last_seen_ts?: number;
};

type KeysQueryResponse = {
  device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>>;
  master_keys?: Record<string, { keys?: Record<string, string> }>;
  self_signing_keys?: Record<string, { keys?: Record<string, string> }>;
  user_signing_keys?: Record<string, { keys?: Record<string, string> }>;
};

type ToDeviceDecryptedEvent = {
  type?: string;
  sender?: string;
  content?: Record<string, unknown>;
};

type VerificationStateFile = {
  verified: boolean;
  verifiedAt?: string;
  verifiedWith?: { userId: string; deviceId: string };
};

type SasStartContent = {
  from_device: string;
  method: "m.sas.v1";
  key_agreement_protocols: string[];
  hashes: string[];
  message_authentication_codes: string[];
  short_authentication_string: string[];
  transaction_id: string;
};

type SasAcceptContent = {
  method: "m.sas.v1";
  commitment: string;
  key_agreement_protocol: string;
  hash: string;
  message_authentication_code: string;
  short_authentication_string: string[];
  transaction_id: string;
};

type SasReadyContent = {
  from_device: string;
  methods: string[];
  transaction_id: string;
};

type SasRequestContent = SasReadyContent & {
  timestamp: number;
};

type SasKeyContent = {
  transaction_id: string;
  key: string;
};

type SasMacContent = {
  transaction_id: string;
  mac: Record<string, string>;
  keys: string;
};

type SasDoneContent = {
  transaction_id: string;
};

type SasCancelContent = {
  transaction_id: string;
  code?: string;
  reason?: string;
};

type NegotiatedSas = {
  keyAgreement: "curve25519-hkdf-sha256";
  hash: "sha256";
  mac: "hkdf-hmac-sha256.v2" | "hkdf-hmac-sha256";
  sasMethods: string[];
};

type X25519Ephemeral = {
  privateKey: crypto.KeyObject;
  publicKeyBase64: string;
};

type VerificationSession = {
  transactionId: string;
  otherUserId: string;
  otherDeviceId: string;
  role: "initiator" | "responder";
  state:
    | "requested"
    | "ready_sent"
    | "ready_received"
    | "start_sent"
    | "start_received"
    | "accept_sent"
    | "accept_received"
    | "key_sent"
    | "key_received"
    | "sas_ready"
    | "mac_sent"
    | "mac_received"
    | "done_sent"
    | "done_received"
    | "verified"
    | "cancelled";
  createdAtMs: number;
  negotiated?: NegotiatedSas;
  startContent?: SasStartContent;
  acceptContent?: SasAcceptContent;
  ourEphemeral?: X25519Ephemeral;
  theirEphemeralPublicBase64?: string;
  sharedSecret?: Buffer;
  macSent?: boolean;
  macReceived?: boolean;
  doneSent?: boolean;
  doneReceived?: boolean;
  queue: Promise<void>;
  timeout: NodeJS.Timeout;
};

const EVENT = {
  Request: "m.key.verification.request",
  Ready: "m.key.verification.ready",
  Start: "m.key.verification.start",
  Accept: "m.key.verification.accept",
  Key: "m.key.verification.key",
  Mac: "m.key.verification.mac",
  Done: "m.key.verification.done",
  Cancel: "m.key.verification.cancel",
} as const;

const SUPPORTED_METHODS = ["m.sas.v1"] as const;
const SUPPORTED_KEY_AGREEMENT = ["curve25519-hkdf-sha256"] as const;
const SUPPORTED_HASHES = ["sha256"] as const;
const SUPPORTED_MACS = ["hkdf-hmac-sha256.v2", "hkdf-hmac-sha256"] as const;
const SUPPORTED_SAS = ["emoji", "decimal"] as const;

const SAS_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFICATION_STATE_FILENAME = "verification-state.json";

const SAS_EMOJI: Array<{ emoji: string; description: string }> = [
  { emoji: "🐶", description: "Dog" },
  { emoji: "🐱", description: "Cat" },
  { emoji: "🦁", description: "Lion" },
  { emoji: "🐎", description: "Horse" },
  { emoji: "🦄", description: "Unicorn" },
  { emoji: "🐷", description: "Pig" },
  { emoji: "🐘", description: "Elephant" },
  { emoji: "🐰", description: "Rabbit" },
  { emoji: "🐼", description: "Panda" },
  { emoji: "🐓", description: "Rooster" },
  { emoji: "🐧", description: "Penguin" },
  { emoji: "🐢", description: "Turtle" },
  { emoji: "🐟", description: "Fish" },
  { emoji: "🐙", description: "Octopus" },
  { emoji: "🦋", description: "Butterfly" },
  { emoji: "🌷", description: "Flower" },
  { emoji: "🌳", description: "Tree" },
  { emoji: "🌵", description: "Cactus" },
  { emoji: "🍄", description: "Mushroom" },
  { emoji: "🌏", description: "Globe" },
  { emoji: "🌙", description: "Moon" },
  { emoji: "☁️", description: "Cloud" },
  { emoji: "🔥", description: "Fire" },
  { emoji: "🍌", description: "Banana" },
  { emoji: "🍎", description: "Apple" },
  { emoji: "🍓", description: "Strawberry" },
  { emoji: "🌽", description: "Corn" },
  { emoji: "🍕", description: "Pizza" },
  { emoji: "🎂", description: "Cake" },
  { emoji: "❤️", description: "Heart" },
  { emoji: "😀", description: "Smile" },
  { emoji: "🤖", description: "Robot" },
  { emoji: "🎩", description: "Hat" },
  { emoji: "👓", description: "Glasses" },
  { emoji: "🔧", description: "Spanner" },
  { emoji: "🎅", description: "Santa" },
  { emoji: "👍", description: "Thumbs up" },
  { emoji: "☂️", description: "Umbrella" },
  { emoji: "⌛", description: "Hourglass" },
  { emoji: "⏰", description: "Clock" },
  { emoji: "🎁", description: "Gift" },
  { emoji: "💡", description: "Light bulb" },
  { emoji: "📕", description: "Book" },
  { emoji: "✏️", description: "Pencil" },
  { emoji: "📎", description: "Paperclip" },
  { emoji: "✂️", description: "Scissors" },
  { emoji: "🔒", description: "Lock" },
  { emoji: "🔑", description: "Key" },
  { emoji: "🔨", description: "Hammer" },
  { emoji: "☎️", description: "Telephone" },
  { emoji: "🏁", description: "Flag" },
  { emoji: "🚂", description: "Train" },
  { emoji: "🚲", description: "Bicycle" },
  { emoji: "✈️", description: "Aeroplane" },
  { emoji: "🚀", description: "Rocket" },
  { emoji: "🏆", description: "Trophy" },
  { emoji: "⚽", description: "Ball" },
  { emoji: "🎸", description: "Guitar" },
  { emoji: "🎺", description: "Trumpet" },
  { emoji: "🔔", description: "Bell" },
  { emoji: "⚓", description: "Anchor" },
  { emoji: "🎧", description: "Headphones" },
  { emoji: "📁", description: "Folder" },
  { emoji: "📌", description: "Pin" },
];

function base64Unpadded(input: Buffer): string {
  return input.toString("base64").replace(/=+$/g, "");
}

function ensureBase64Padding(input: string): string {
  const trimmed = input.trim();
  const mod = trimmed.length % 4;
  if (mod === 0) {
    return trimmed;
  }
  return trimmed + "=".repeat(4 - mod);
}

function decodeUnpaddedBase64(input: string): Buffer {
  return Buffer.from(ensureBase64Padding(input), "base64");
}

function stableSortStrings(values: string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = stableSortStrings(Object.keys(record));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256Base64UnpaddedUtf8(input: string): string {
  return base64Unpadded(crypto.createHash("sha256").update(input, "utf8").digest());
}

function computeCommitment(params: {
  acceptorKeyBase64: string;
  startContent: SasStartContent;
}): string {
  return sha256Base64UnpaddedUtf8(params.acceptorKeyBase64 + canonicalJson(params.startContent));
}

function createX25519Ephemeral(): X25519Ephemeral {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { format: "jwk" },
    privateKeyEncoding: { format: "jwk" },
  });
  const publicJwk = publicKey as JsonWebKey;
  const privateJwk = privateKey as JsonWebKey;
  if (!publicJwk.x || !privateJwk.d) {
    throw new Error("Failed to generate X25519 keypair");
  }
  const privateObj = crypto.createPrivateKey({ key: privateJwk, format: "jwk" });
  const publicKeyBytes = Buffer.from(publicJwk.x, "base64url");
  return {
    privateKey: privateObj,
    publicKeyBase64: base64Unpadded(publicKeyBytes),
  };
}

function createX25519PublicKeyFromBase64(keyBase64: string): crypto.KeyObject {
  const publicKeyBytes = decodeUnpaddedBase64(keyBase64);
  const jwk: JsonWebKey = {
    kty: "OKP",
    crv: "X25519",
    x: publicKeyBytes.toString("base64url"),
  };
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

function deriveSasInfo(params: {
  startUserId: string;
  startDeviceId: string;
  acceptUserId: string;
  acceptDeviceId: string;
  startPublicKeyBase64: string;
  acceptPublicKeyBase64: string;
  transactionId: string;
}): string {
  return [
    "MATRIX_KEY_VERIFICATION_SAS",
    params.startUserId,
    params.startDeviceId,
    params.startPublicKeyBase64,
    params.acceptUserId,
    params.acceptDeviceId,
    params.acceptPublicKeyBase64,
    params.transactionId,
  ].join("|");
}

function normalizeBytes(input: Buffer | ArrayBuffer | ArrayBufferView): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(input);
}

function deriveSasBytes(sharedSecret: Buffer, info: string, length: number): Buffer {
  return normalizeBytes(
    crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from(info, "utf8"), length),
  );
}

function formatDecimalSas(bytes: Buffer | ArrayBuffer | ArrayBufferView): string {
  const normalized = normalizeBytes(bytes);
  if (normalized.length < 5) {
    throw new Error("Decimal SAS requires 5 bytes");
  }
  const b0 = normalized[0] ?? 0;
  const b1 = normalized[1] ?? 0;
  const b2 = normalized[2] ?? 0;
  const b3 = normalized[3] ?? 0;
  const b4 = normalized[4] ?? 0;

  const n1 = ((b0 << 5) | (b1 >> 3)) + 1000;
  const n2 = (((b1 & 0x7) << 10) | (b2 << 2) | (b3 >> 6)) + 1000;
  const n3 = (((b3 & 0x3f) << 7) | (b4 >> 1)) + 1000;
  return [n1, n2, n3].map((n) => String(n).padStart(4, "0")).join(" ");
}

function formatEmojiSas(bytes: Buffer | ArrayBuffer | ArrayBufferView): string {
  const normalized = normalizeBytes(bytes);
  if (normalized.length < 6) {
    throw new Error("Emoji SAS requires 6 bytes");
  }
  let num = 0n;
  for (const byte of normalized.subarray(0, 6)) {
    num = (num << 8n) | BigInt(byte);
  }
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    const index = Number((num >> BigInt(48 - 6 * (i + 1))) & 0x3fn);
    const entry = SAS_EMOJI[index];
    parts.push(entry ? `${entry.emoji} ${entry.description}` : "�");
  }
  return parts.join(" | ");
}

function negotiateSas(startContent: SasStartContent): NegotiatedSas | null {
  const keyAgreement = startContent.key_agreement_protocols.find((alg) =>
    (SUPPORTED_KEY_AGREEMENT as readonly string[]).includes(alg),
  );
  const hash = startContent.hashes.find((alg) =>
    (SUPPORTED_HASHES as readonly string[]).includes(alg),
  );
  const mac = SUPPORTED_MACS.find((alg) => startContent.message_authentication_codes.includes(alg));
  const sasMethods = SUPPORTED_SAS.filter((method) =>
    startContent.short_authentication_string.includes(method),
  );

  if (
    keyAgreement !== "curve25519-hkdf-sha256" ||
    hash !== "sha256" ||
    (mac !== "hkdf-hmac-sha256.v2" && mac !== "hkdf-hmac-sha256") ||
    sasMethods.length === 0
  ) {
    return null;
  }
  return {
    keyAgreement,
    hash,
    mac,
    sasMethods: [...sasMethods],
  };
}

function deriveMacKey(params: {
  sharedSecret: Buffer;
  myUserId: string;
  myDeviceId: string;
  otherUserId: string;
  otherDeviceId: string;
  transactionId: string;
  keyId: string;
}): Buffer {
  const info = [
    "MATRIX_KEY_VERIFICATION_MAC",
    params.myUserId,
    params.myDeviceId,
    params.otherUserId,
    params.otherDeviceId,
    params.transactionId,
    params.keyId,
  ].join("");
  return normalizeBytes(
    crypto.hkdfSync("sha256", params.sharedSecret, Buffer.alloc(0), Buffer.from(info, "utf8"), 32),
  );
}

function hmacSha256Base64(params: { key: Buffer; value: string; unpadded: boolean }): string {
  const digest = crypto
    .createHmac("sha256", params.key)
    .update(params.value, "utf8")
    .digest("base64");
  return params.unpadded ? digest.replace(/=+$/g, "") : digest;
}

function readVerificationState(filePath: string): VerificationStateFile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as VerificationStateFile;
    if (typeof parsed?.verified === "boolean") {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeVerificationState(filePath: string, state: VerificationStateFile): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // ignore
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function pickMostLikelyOtherDevice(
  devices: OwnUserDevice[],
  selfDeviceId: string,
): OwnUserDevice | null {
  const candidates = devices.filter(
    (device) => device.device_id && device.device_id !== selfDeviceId,
  );
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0));
  return candidates[0] ?? null;
}

class MatrixDeviceVerificationManager {
  private readonly sessions = new Map<string, VerificationSession>();
  private readonly transactionQueues = new Map<string, Promise<void>>();
  private readonly stateFilePath: string;
  private selfUserId = "";
  private selfDeviceId = "";
  private disposed = false;
  private onToDeviceListener: ((msg: ToDeviceDecryptedEvent) => void) | null = null;

  public constructor(
    private readonly params: {
      client: MatrixClient;
      auth: MatrixAuth;
      logger: RuntimeLogger;
      storageRootDir: string;
    },
  ) {
    this.stateFilePath = path.join(params.storageRootDir, VERIFICATION_STATE_FILENAME);
  }

  public async start(): Promise<void> {
    const whoami = await this.params.client.getWhoAmI();
    this.selfUserId = whoami.user_id || this.params.auth.userId;
    this.selfDeviceId = whoami.device_id ?? "";
    if (!this.selfDeviceId) {
      this.params.logger.warn(
        "matrix: crypto enabled but device_id missing from /whoami; cannot verify device",
      );
      return;
    }
    this.params.logger.info(
      `matrix: device verification handler active (user=${this.selfUserId} device=${this.selfDeviceId})`,
    );

    const onToDevice = (msg: ToDeviceDecryptedEvent) => {
      void this.enqueueGlobal(() => this.handleToDevice(msg));
    };
    this.onToDeviceListener = onToDevice;
    (
      this.params.client as unknown as {
        on: (event: string, cb: (msg: ToDeviceDecryptedEvent) => void) => void;
      }
    ).on("to_device.decrypted", onToDevice);

    await this.maybeRequestOnStartup();
  }

  public dispose(): void {
    this.disposed = true;
    const listener = this.onToDeviceListener;
    this.onToDeviceListener = null;
    if (listener) {
      try {
        const client = this.params.client as unknown as {
          off?: (event: string, cb: (msg: ToDeviceDecryptedEvent) => void) => void;
          removeListener?: (event: string, cb: (msg: ToDeviceDecryptedEvent) => void) => void;
        };
        if (typeof client.off === "function") {
          client.off("to_device.decrypted", listener);
        } else if (typeof client.removeListener === "function") {
          client.removeListener("to_device.decrypted", listener);
        }
      } catch {
        // ignore
      }
    }
    for (const session of this.sessions.values()) {
      clearTimeout(session.timeout);
    }
    this.sessions.clear();
    this.transactionQueues.clear();
  }

  private async maybeRequestOnStartup(): Promise<void> {
    const existing = readVerificationState(this.stateFilePath);
    if (existing?.verified) {
      this.params.logger.debug?.("matrix: device already verified (local flag set)");
      return;
    }

    let devices: OwnUserDevice[];
    try {
      devices = await this.params.client.getOwnDevices();
    } catch (err) {
      this.params.logger.debug?.("matrix: failed to list devices for verification request", {
        error: String(err),
      });
      return;
    }

    const target = pickMostLikelyOtherDevice(devices, this.selfDeviceId);
    if (!target?.device_id) {
      this.params.logger.info(
        "matrix: encryption enabled but no other sessions found to verify against (open Element and verify manually)",
      );
      return;
    }

    const transactionId = `oc_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
    const session = this.createSession({
      transactionId,
      otherUserId: this.selfUserId,
      otherDeviceId: target.device_id,
      role: "initiator",
    });

    const request: SasRequestContent = {
      from_device: this.selfDeviceId,
      methods: [...SUPPORTED_METHODS],
      transaction_id: transactionId,
      timestamp: Date.now(),
    };

    try {
      await this.sendToDevice({
        otherUserId: session.otherUserId,
        otherDeviceId: session.otherDeviceId,
        type: EVENT.Request,
        content: request,
      });
      session.state = "requested";
      this.params.logger.info(
        `matrix: device verification requested (txn=${transactionId} targetDevice=${target.device_id}); accept in Element to verify this session`,
      );
    } catch (err) {
      this.params.logger.debug?.("matrix: failed to send verification request", {
        error: String(err),
      });
      this.deleteSession(transactionId);
    }
  }

  private createSession(params: {
    transactionId: string;
    otherUserId: string;
    otherDeviceId: string;
    role: "initiator" | "responder";
  }): VerificationSession {
    const existing = this.sessions.get(params.transactionId);
    if (existing) {
      const mismatch =
        existing.role !== params.role ||
        existing.otherUserId !== params.otherUserId ||
        existing.otherDeviceId !== params.otherDeviceId;
      if (!mismatch) {
        return existing;
      }

      // `m.key.verification.request` / `m.key.verification.start` are inbound events.
      // If we somehow created a session with conflicting role/peer for this txn id,
      // recreate it so the protocol state machine can't run with mismatched state.
      if (params.role === "responder") {
        this.params.logger.warn(
          `matrix: resetting verification session (txn=${params.transactionId} fromDevice=${params.otherDeviceId} existingRole=${existing.role} existingDevice=${existing.otherDeviceId} state=${existing.state})`,
        );
      } else {
        this.params.logger.warn(
          `matrix: resetting verification session (txn=${params.transactionId} otherDevice=${params.otherDeviceId} existingRole=${existing.role} existingDevice=${existing.otherDeviceId} state=${existing.state})`,
        );
      }
      this.deleteSession(params.transactionId);
    }
    const timeout = setTimeout(() => {
      void this.enqueueSession(params.transactionId, async () => {
        const session = this.sessions.get(params.transactionId);
        if (!session || session.state === "verified" || session.state === "cancelled") {
          return;
        }
        await this.cancelSession(params.transactionId, "m.timeout", "Verification timed out");
      });
    }, SAS_TIMEOUT_MS);
    timeout.unref();

    const session: VerificationSession = {
      transactionId: params.transactionId,
      otherUserId: params.otherUserId,
      otherDeviceId: params.otherDeviceId,
      role: params.role,
      state: params.role === "initiator" ? "requested" : "ready_sent",
      createdAtMs: Date.now(),
      queue: Promise.resolve(),
      timeout,
    };
    this.sessions.set(params.transactionId, session);
    return session;
  }

  private deleteSession(transactionId: string): void {
    const session = this.sessions.get(transactionId);
    if (session) {
      clearTimeout(session.timeout);
      this.sessions.delete(transactionId);
    }
  }

  private async enqueueGlobal(fn: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await fn();
    } catch (err) {
      this.params.logger.warn(`matrix: verification handler error: ${String(err)}`);
    }
  }

  private async enqueueSession(transactionId: string, fn: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return;
    }

    const prev = this.transactionQueues.get(transactionId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => {
      this.params.logger.warn(`matrix: verification session error: ${String(err)}`);
    });
    this.transactionQueues.set(transactionId, next);

    const session = this.sessions.get(transactionId);
    if (session) {
      session.queue = next;
    }

    await next;

    // If nothing created a session for this transaction, drop the queue entry once drained.
    if (!this.sessions.get(transactionId) && this.transactionQueues.get(transactionId) === next) {
      this.transactionQueues.delete(transactionId);
    }
  }

  private async handleToDevice(msg: ToDeviceDecryptedEvent): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!msg || typeof msg !== "object") {
      return;
    }
    const type = msg.type;
    if (typeof type !== "string" || !type.startsWith("m.key.verification.")) {
      return;
    }
    if (msg.sender !== this.selfUserId) {
      return;
    }
    const content = msg.content;
    if (!isObjectRecord(content)) {
      return;
    }
    const transactionId = String(content.transaction_id ?? "");
    if (!transactionId) {
      return;
    }

    switch (type) {
      case EVENT.Request:
        await this.handleRequest(transactionId, content);
        break;
      case EVENT.Ready:
        await this.handleReady(transactionId, content);
        break;
      case EVENT.Start:
        await this.handleStart(transactionId, content);
        break;
      case EVENT.Accept:
        await this.handleAccept(transactionId, content);
        break;
      case EVENT.Key:
        await this.handleKey(transactionId, content);
        break;
      case EVENT.Mac:
        await this.handleMac(transactionId, content);
        break;
      case EVENT.Done:
        await this.handleDone(transactionId, content);
        break;
      case EVENT.Cancel:
        await this.handleCancel(transactionId, content);
        break;
      default:
        break;
    }
  }

  private async handleRequest(
    transactionId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const fromDevice = String(content.from_device ?? "");
      if (!fromDevice || fromDevice === this.selfDeviceId) {
        return;
      }

      const methods = Array.isArray(content.methods) ? content.methods.map(String) : [];
      if (
        !methods.some((m) => SUPPORTED_METHODS.includes(m as (typeof SUPPORTED_METHODS)[number]))
      ) {
        try {
          await this.sendToDevice({
            otherUserId: this.selfUserId,
            otherDeviceId: fromDevice,
            type: EVENT.Cancel,
            content: {
              transaction_id: transactionId,
              code: "m.unknown_method",
              reason: "No supported verification methods",
            },
          });
        } catch {
          // ignore send failures
        }
        this.params.logger.warn(
          `matrix: verification request rejected (txn=${transactionId} fromDevice=${fromDevice})`,
        );
        return;
      }

      const session = this.createSession({
        transactionId,
        otherUserId: this.selfUserId,
        otherDeviceId: fromDevice,
        role: "responder",
      });

      const ready: SasReadyContent = {
        from_device: this.selfDeviceId,
        methods: [...SUPPORTED_METHODS],
        transaction_id: transactionId,
      };

      await this.sendToDevice({
        otherUserId: session.otherUserId,
        otherDeviceId: session.otherDeviceId,
        type: EVENT.Ready,
        content: ready,
      });
      session.state = "ready_sent";
      this.params.logger.info(
        `matrix: verification request received (txn=${transactionId} fromDevice=${fromDevice}); waiting for SAS start`,
      );
    });
  }

  private async handleReady(
    transactionId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session || session.role !== "initiator") {
        return;
      }
      if (session.state !== "requested") {
        return;
      }
      const fromDevice = String(content.from_device ?? "");
      if (fromDevice && fromDevice !== session.otherDeviceId) {
        return;
      }

      session.state = "ready_received";
      await this.sendStart(session);
    });
  }

  private async sendStart(session: VerificationSession): Promise<void> {
    const start: SasStartContent = {
      from_device: this.selfDeviceId,
      method: "m.sas.v1",
      key_agreement_protocols: [...SUPPORTED_KEY_AGREEMENT],
      hashes: [...SUPPORTED_HASHES],
      message_authentication_codes: [...SUPPORTED_MACS],
      short_authentication_string: [...SUPPORTED_SAS],
      transaction_id: session.transactionId,
    };
    session.startContent = start;

    await this.sendToDevice({
      otherUserId: session.otherUserId,
      otherDeviceId: session.otherDeviceId,
      type: EVENT.Start,
      content: start,
    });
    session.state = "start_sent";
    this.params.logger.info(
      `matrix: SAS verification started (txn=${session.transactionId} device=${session.otherDeviceId}); accept in Element`,
    );
  }

  private async handleStart(
    transactionId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const fromDevice = String(content.from_device ?? "");
      if (!fromDevice || fromDevice === this.selfDeviceId) {
        return;
      }

      const existing = this.sessions.get(transactionId);
      if (existing?.role === "initiator" && existing.state === "start_sent") {
        const incomingMethod = typeof content.method === "string" ? content.method : "";
        const existingMethod = existing.startContent?.method;
        if (incomingMethod && existingMethod && incomingMethod !== existingMethod) {
          await this.cancelSession(
            transactionId,
            "m.unexpected_message",
            "Verification start collision (method mismatch)",
          );
          return;
        }

        // Spec collision handling: if both sides send `m.key.verification.start`, keep the start
        // from the lexicographically smaller (user_id, device_id) tuple.
        const selfId = `${this.selfUserId}|${this.selfDeviceId}`;
        const otherId = `${this.selfUserId}|${fromDevice}`;
        if (selfId < otherId) {
          return;
        }
      }

      const start = this.parseStartContent(content);
      if (!start) {
        try {
          await this.sendToDevice({
            otherUserId: this.selfUserId,
            otherDeviceId: fromDevice,
            type: EVENT.Cancel,
            content: {
              transaction_id: transactionId,
              code: "m.invalid_message",
              reason: "Invalid SAS start message",
            },
          });
        } catch {
          // ignore send failures
        }
        return;
      }

      const negotiated = negotiateSas(start);
      if (!negotiated) {
        try {
          await this.sendToDevice({
            otherUserId: this.selfUserId,
            otherDeviceId: fromDevice,
            type: EVENT.Cancel,
            content: {
              transaction_id: transactionId,
              code: "m.unknown_method",
              reason: "Unsupported SAS parameters",
            },
          });
        } catch {
          // ignore send failures
        }
        return;
      }

      const session = this.createSession({
        transactionId,
        otherUserId: this.selfUserId,
        otherDeviceId: fromDevice,
        role: "responder",
      });
      session.startContent = start;
      session.negotiated = negotiated;
      session.state = "start_received";

      session.ourEphemeral = createX25519Ephemeral();
      const commitment = computeCommitment({
        acceptorKeyBase64: session.ourEphemeral.publicKeyBase64,
        startContent: start,
      });

      const accept: SasAcceptContent = {
        method: "m.sas.v1",
        commitment,
        key_agreement_protocol: negotiated.keyAgreement,
        hash: negotiated.hash,
        message_authentication_code: negotiated.mac,
        short_authentication_string: negotiated.sasMethods,
        transaction_id: transactionId,
      };
      session.acceptContent = accept;

      await this.sendToDevice({
        otherUserId: session.otherUserId,
        otherDeviceId: session.otherDeviceId,
        type: EVENT.Accept,
        content: accept,
      });
      session.state = "accept_sent";
      this.params.logger.info(
        `matrix: SAS accept sent (txn=${transactionId} device=${fromDevice}); waiting for other device key`,
      );
    });
  }

  private async handleAccept(
    transactionId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session || session.role !== "initiator") {
        return;
      }
      if (session.state !== "start_sent" && session.state !== "ready_received") {
        return;
      }
      const accept = this.parseAcceptContent(content);
      if (!accept) {
        await this.cancelSession(transactionId, "m.invalid_message", "Invalid SAS accept message");
        return;
      }

      if (!session.startContent) {
        await this.cancelSession(
          transactionId,
          "m.invalid_message",
          "Missing start content for SAS accept",
        );
        return;
      }

      if (accept.method !== "m.sas.v1") {
        await this.cancelSession(
          transactionId,
          "m.unknown_method",
          "Unsupported verification method",
        );
        return;
      }
      if (accept.key_agreement_protocol !== "curve25519-hkdf-sha256" || accept.hash !== "sha256") {
        await this.cancelSession(transactionId, "m.unknown_method", "Unsupported SAS algorithms");
        return;
      }
      if (
        accept.message_authentication_code !== "hkdf-hmac-sha256.v2" &&
        accept.message_authentication_code !== "hkdf-hmac-sha256"
      ) {
        await this.cancelSession(transactionId, "m.unknown_method", "Unsupported MAC algorithm");
        return;
      }

      session.negotiated = {
        keyAgreement: "curve25519-hkdf-sha256",
        hash: "sha256",
        mac: accept.message_authentication_code,
        sasMethods: accept.short_authentication_string.filter((method) =>
          (SUPPORTED_SAS as readonly string[]).includes(method),
        ),
      };
      session.acceptContent = accept;
      session.state = "accept_received";

      if (!session.ourEphemeral) {
        session.ourEphemeral = createX25519Ephemeral();
      }

      await this.sendKey(session);
    });
  }

  private async sendKey(session: VerificationSession): Promise<void> {
    if (!session.ourEphemeral) {
      throw new Error("Missing ephemeral keypair");
    }
    const key: SasKeyContent = {
      transaction_id: session.transactionId,
      key: session.ourEphemeral.publicKeyBase64,
    };
    await this.sendToDevice({
      otherUserId: session.otherUserId,
      otherDeviceId: session.otherDeviceId,
      type: EVENT.Key,
      content: key,
    });
    session.state = "key_sent";
  }

  private async handleKey(transactionId: string, content: Record<string, unknown>): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session || session.state === "cancelled") {
        return;
      }
      const keyBase64 = String(content.key ?? "");
      if (!keyBase64) {
        await this.cancelSession(transactionId, "m.invalid_message", "Missing SAS key");
        return;
      }
      session.theirEphemeralPublicBase64 = keyBase64;

      if (session.role === "responder") {
        if (!session.ourEphemeral) {
          await this.cancelSession(
            transactionId,
            "m.invalid_message",
            "Missing local ephemeral key",
          );
          return;
        }
        if (!session.startContent || !session.negotiated) {
          await this.cancelSession(
            transactionId,
            "m.invalid_message",
            "Missing SAS negotiation state",
          );
          return;
        }
        if (session.state === "accept_sent" || session.state === "start_received") {
          await this.sendKey(session);
        }
      }

      await this.maybeFinalizeSas(session);
    });
  }

  private async maybeFinalizeSas(session: VerificationSession): Promise<void> {
    if (!session.ourEphemeral || !session.theirEphemeralPublicBase64 || !session.negotiated) {
      return;
    }

    if (!session.sharedSecret) {
      const otherPublic = createX25519PublicKeyFromBase64(session.theirEphemeralPublicBase64);
      session.sharedSecret = crypto.diffieHellman({
        privateKey: session.ourEphemeral.privateKey,
        publicKey: otherPublic,
      });
    }

    if (session.role === "initiator") {
      if (!session.acceptContent || !session.startContent) {
        return;
      }
      const expected = computeCommitment({
        acceptorKeyBase64: session.theirEphemeralPublicBase64,
        startContent: session.startContent,
      });
      if (expected !== session.acceptContent.commitment) {
        await this.cancelSession(
          session.transactionId,
          "m.mismatched_commitment",
          "Commitment mismatch",
        );
        return;
      }
    }

    const startUserId = session.role === "initiator" ? this.selfUserId : session.otherUserId;
    const startDeviceId = session.role === "initiator" ? this.selfDeviceId : session.otherDeviceId;
    const acceptUserId = session.role === "initiator" ? session.otherUserId : this.selfUserId;
    const acceptDeviceId = session.role === "initiator" ? session.otherDeviceId : this.selfDeviceId;
    const startPublicKeyBase64 =
      session.role === "initiator"
        ? session.ourEphemeral.publicKeyBase64
        : session.theirEphemeralPublicBase64;
    const acceptPublicKeyBase64 =
      session.role === "initiator"
        ? session.theirEphemeralPublicBase64
        : session.ourEphemeral.publicKeyBase64;

    const info = deriveSasInfo({
      startUserId,
      startDeviceId,
      acceptUserId,
      acceptDeviceId,
      startPublicKeyBase64,
      acceptPublicKeyBase64,
      transactionId: session.transactionId,
    });

    const emojiBytes = deriveSasBytes(session.sharedSecret, info, 6);
    const decimalBytes = deriveSasBytes(session.sharedSecret, info, 5);
    const emoji = formatEmojiSas(emojiBytes);
    const decimal = formatDecimalSas(decimalBytes);

    session.state = "sas_ready";
    this.params.logger.info(
      `matrix: SAS ready (txn=${session.transactionId} device=${session.otherDeviceId})\n` +
        `matrix: SAS emojis: ${emoji}\n` +
        `matrix: SAS decimals: ${decimal}`,
    );

    if (!session.macSent) {
      await this.sendMac(session);
    }
  }

  private async sendMac(session: VerificationSession): Promise<void> {
    if (!session.sharedSecret || !session.negotiated) {
      return;
    }

    const keyEntries = await this.getKeysToMac({
      userId: this.selfUserId,
      deviceId: this.selfDeviceId,
    });
    if (keyEntries.length === 0) {
      this.params.logger.warn("matrix: cannot MAC keys for verification (missing device keys)");
      return;
    }

    const unpadded = session.negotiated.mac === "hkdf-hmac-sha256.v2";
    const macMap: Record<string, string> = {};
    for (const { keyId, value } of keyEntries) {
      const hmacKey = deriveMacKey({
        sharedSecret: session.sharedSecret,
        myUserId: this.selfUserId,
        myDeviceId: this.selfDeviceId,
        otherUserId: session.otherUserId,
        otherDeviceId: session.otherDeviceId,
        transactionId: session.transactionId,
        keyId,
      });
      macMap[keyId] = hmacSha256Base64({ key: hmacKey, value, unpadded });
    }
    const keyIds = stableSortStrings(Object.keys(macMap));
    const keyIdList = keyIds.join(",");
    const keysHmacKey = deriveMacKey({
      sharedSecret: session.sharedSecret,
      myUserId: this.selfUserId,
      myDeviceId: this.selfDeviceId,
      otherUserId: session.otherUserId,
      otherDeviceId: session.otherDeviceId,
      transactionId: session.transactionId,
      keyId: "KEY_IDS",
    });
    const keysMac = hmacSha256Base64({ key: keysHmacKey, value: keyIdList, unpadded });

    const macContent: SasMacContent = {
      transaction_id: session.transactionId,
      mac: macMap,
      keys: keysMac,
    };
    await this.sendToDevice({
      otherUserId: session.otherUserId,
      otherDeviceId: session.otherDeviceId,
      type: EVENT.Mac,
      content: macContent,
    });
    session.macSent = true;
    session.state = "mac_sent";
  }

  private async handleMac(transactionId: string, content: Record<string, unknown>): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session || !session.sharedSecret || !session.negotiated) {
        return;
      }
      const mac = isObjectRecord(content.mac) ? (content.mac as Record<string, unknown>) : null;
      const keysMac = String(content.keys ?? "");
      if (!mac || !keysMac) {
        await this.cancelSession(transactionId, "m.invalid_message", "Invalid MAC content");
        return;
      }

      const otherEntries = await this.getKeyValuesForIds({
        userId: session.otherUserId,
        deviceId: session.otherDeviceId,
        keyIds: Object.keys(mac),
      });
      const missing = Object.keys(mac).filter((keyId) => otherEntries[keyId] == null);
      if (missing.length > 0) {
        await this.cancelSession(
          transactionId,
          "m.key_mismatch",
          `Missing keys: ${missing.join(", ")}`,
        );
        return;
      }

      const unpadded = session.negotiated.mac === "hkdf-hmac-sha256.v2";

      const keyIds = stableSortStrings(Object.keys(mac).map(String));
      const keyIdList = keyIds.join(",");
      const keysHmacKey = deriveMacKey({
        sharedSecret: session.sharedSecret,
        myUserId: session.otherUserId,
        myDeviceId: session.otherDeviceId,
        otherUserId: this.selfUserId,
        otherDeviceId: this.selfDeviceId,
        transactionId: session.transactionId,
        keyId: "KEY_IDS",
      });
      const expectedKeysMac = hmacSha256Base64({ key: keysHmacKey, value: keyIdList, unpadded });
      if (expectedKeysMac !== keysMac) {
        await this.cancelSession(transactionId, "m.key_mismatch", "KEY_IDS MAC mismatch");
        return;
      }

      for (const keyId of keyIds) {
        const value = otherEntries[keyId] ?? "";
        const hmacKey = deriveMacKey({
          sharedSecret: session.sharedSecret,
          myUserId: session.otherUserId,
          myDeviceId: session.otherDeviceId,
          otherUserId: this.selfUserId,
          otherDeviceId: this.selfDeviceId,
          transactionId: session.transactionId,
          keyId,
        });
        const expected = hmacSha256Base64({ key: hmacKey, value, unpadded });
        const actual = String(mac[keyId] ?? "");
        if (expected !== actual) {
          await this.cancelSession(transactionId, "m.key_mismatch", `MAC mismatch for ${keyId}`);
          return;
        }
      }

      session.macReceived = true;
      session.state = "mac_received";

      if (!session.doneSent) {
        await this.sendDone(session);
      }
      this.maybeFinalizeVerificationComplete(session);
    });
  }

  private async sendDone(session: VerificationSession): Promise<void> {
    const done: SasDoneContent = {
      transaction_id: session.transactionId,
    };
    await this.sendToDevice({
      otherUserId: session.otherUserId,
      otherDeviceId: session.otherDeviceId,
      type: EVENT.Done,
      content: done,
    });
    session.doneSent = true;
    session.state = "done_sent";
    this.maybeFinalizeVerificationComplete(session);
  }

  private async handleDone(
    transactionId: string,
    _content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session) {
        return;
      }
      session.doneReceived = true;
      session.state = "done_received";
      this.maybeFinalizeVerificationComplete(session);
    });
  }

  private maybeFinalizeVerificationComplete(session: VerificationSession): void {
    if (!session.macSent || !session.macReceived || !session.doneSent || !session.doneReceived) {
      return;
    }
    if (session.state === "verified") {
      return;
    }
    session.state = "verified";
    writeVerificationState(this.stateFilePath, {
      verified: true,
      verifiedAt: new Date().toISOString(),
      verifiedWith: { userId: session.otherUserId, deviceId: session.otherDeviceId },
    });
    this.params.logger.info(
      `matrix: verification complete (txn=${session.transactionId} device=${session.otherDeviceId})`,
    );
    this.deleteSession(session.transactionId);
  }

  private async handleCancel(
    transactionId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.enqueueSession(transactionId, async () => {
      const session = this.sessions.get(transactionId);
      if (!session) {
        return;
      }
      const cancel = this.parseCancelContent(content);
      const code = cancel?.code ?? "unknown";
      const reason = cancel?.reason;
      this.params.logger.warn(
        `matrix: verification cancelled (txn=${transactionId} device=${session.otherDeviceId} code=${code}${reason ? ` reason=${reason}` : ""})`,
      );
      session.state = "cancelled";
      this.deleteSession(transactionId);
    });
  }

  private parseStartContent(content: Record<string, unknown>): SasStartContent | null {
    const fromDevice = String(content.from_device ?? "");
    const method = String(content.method ?? "");
    const transactionId = String(content.transaction_id ?? "");
    if (!fromDevice || !transactionId || method !== "m.sas.v1") {
      return null;
    }
    const keyAgreements = Array.isArray(content.key_agreement_protocols)
      ? content.key_agreement_protocols.map(String)
      : [];
    const hashes = Array.isArray(content.hashes) ? content.hashes.map(String) : [];
    const macs = Array.isArray(content.message_authentication_codes)
      ? content.message_authentication_codes.map(String)
      : [];
    const sas = Array.isArray(content.short_authentication_string)
      ? content.short_authentication_string.map(String)
      : [];
    return {
      from_device: fromDevice,
      method: "m.sas.v1",
      key_agreement_protocols: keyAgreements,
      hashes,
      message_authentication_codes: macs,
      short_authentication_string: sas,
      transaction_id: transactionId,
    };
  }

  private parseAcceptContent(content: Record<string, unknown>): SasAcceptContent | null {
    const transactionId = String(content.transaction_id ?? "");
    const method = String(content.method ?? "");
    const commitment = String(content.commitment ?? "");
    const keyAgreement = String(content.key_agreement_protocol ?? "");
    const hash = String(content.hash ?? "");
    const mac = String(content.message_authentication_code ?? "");
    const sas = Array.isArray(content.short_authentication_string)
      ? content.short_authentication_string.map(String)
      : [];
    if (
      !transactionId ||
      method !== "m.sas.v1" ||
      !commitment ||
      !keyAgreement ||
      !hash ||
      !mac ||
      sas.length === 0
    ) {
      return null;
    }
    return {
      method: "m.sas.v1",
      commitment,
      key_agreement_protocol: keyAgreement,
      hash,
      message_authentication_code: mac,
      short_authentication_string: sas,
      transaction_id: transactionId,
    };
  }

  private parseCancelContent(content: Record<string, unknown>): SasCancelContent | null {
    const transactionId = String(content.transaction_id ?? "");
    if (!transactionId) {
      return null;
    }
    const code = typeof content.code === "string" ? content.code : undefined;
    const reason = typeof content.reason === "string" ? content.reason : undefined;
    return { transaction_id: transactionId, code, reason };
  }

  private async cancelSession(transactionId: string, code: string, reason: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      return;
    }
    try {
      const cancel: SasCancelContent = {
        transaction_id: transactionId,
        code,
        reason,
      };
      await this.sendToDevice({
        otherUserId: session.otherUserId,
        otherDeviceId: session.otherDeviceId,
        type: EVENT.Cancel,
        content: cancel,
      });
    } catch {
      // ignore send failures
    } finally {
      session.state = "cancelled";
      this.deleteSession(transactionId);
    }
  }

  private async sendToDevice(params: {
    otherUserId: string;
    otherDeviceId: string;
    type: string;
    content: Record<string, unknown>;
  }): Promise<void> {
    await this.params.client.sendToDevices(params.type, {
      [params.otherUserId]: {
        [params.otherDeviceId]: params.content,
      },
    });
  }

  private async getKeysToMac(params: {
    userId: string;
    deviceId: string;
  }): Promise<Array<{ keyId: string; value: string }>> {
    const response = await this.queryKeys(params.userId);
    const deviceKeys = response?.device_keys?.[params.userId]?.[params.deviceId]?.keys as
      | Record<string, string>
      | undefined;
    const entries: Array<{ keyId: string; value: string }> = [];

    if (deviceKeys) {
      const edKeyId = `ed25519:${params.deviceId}`;
      const edValue = deviceKeys[edKeyId];
      if (typeof edValue === "string" && edValue) {
        entries.push({ keyId: edKeyId, value: edValue });
      }
    }

    const masterKeys = (response?.master_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;
    const selfSigningKeys = (response?.self_signing_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;
    const userSigningKeys = (response?.user_signing_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;

    for (const map of [masterKeys, selfSigningKeys, userSigningKeys]) {
      for (const [keyId, value] of Object.entries(map)) {
        if (typeof value === "string" && value) {
          entries.push({ keyId, value });
        }
      }
    }

    return entries;
  }

  private async getKeyValuesForIds(params: {
    userId: string;
    deviceId: string;
    keyIds: string[];
  }): Promise<Record<string, string | null>> {
    const response = await this.queryKeys(params.userId);
    const deviceKeys = response?.device_keys?.[params.userId]?.[params.deviceId]?.keys as
      | Record<string, string>
      | undefined;
    const masterKeys = (response?.master_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;
    const selfSigningKeys = (response?.self_signing_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;
    const userSigningKeys = (response?.user_signing_keys?.[params.userId]?.keys ?? {}) as Record<
      string,
      string
    >;

    const out: Record<string, string | null> = {};
    for (const keyId of params.keyIds) {
      if (deviceKeys && typeof deviceKeys[keyId] === "string") {
        out[keyId] = deviceKeys[keyId] ?? null;
        continue;
      }
      if (typeof masterKeys[keyId] === "string") {
        out[keyId] = masterKeys[keyId] ?? null;
        continue;
      }
      if (typeof selfSigningKeys[keyId] === "string") {
        out[keyId] = selfSigningKeys[keyId] ?? null;
        continue;
      }
      if (typeof userSigningKeys[keyId] === "string") {
        out[keyId] = userSigningKeys[keyId] ?? null;
        continue;
      }
      out[keyId] = null;
    }
    return out;
  }

  private keysQueryCache: { atMs: number; response: KeysQueryResponse } | null = null;

  private async queryKeys(userId: string): Promise<KeysQueryResponse> {
    const now = Date.now();
    if (this.keysQueryCache && now - this.keysQueryCache.atMs < 30_000) {
      return this.keysQueryCache.response;
    }
    const response = (await this.params.client.getUserDevices([
      userId,
    ])) as unknown as KeysQueryResponse;
    this.keysQueryCache = { atMs: now, response };
    return response;
  }
}

const managers = new WeakMap<MatrixClient, MatrixDeviceVerificationManager>();
const startingManagers = new WeakMap<MatrixClient, Promise<void>>();

export const __testing = {
  base64Unpadded,
  canonicalJson,
  computeCommitment,
  decodeUnpaddedBase64,
  deriveMacKey,
  deriveSasInfo,
  deriveSasBytes,
  formatDecimalSas,
  formatEmojiSas,
  hmacSha256Base64,
  stableSortStrings,
} as const;

export async function startMatrixDeviceVerification(params: {
  client: MatrixClient;
  auth: MatrixAuth;
  logger: RuntimeLogger;
  accountId?: string | null;
}): Promise<void> {
  if (!params.auth.encryption || !params.client.crypto) {
    return;
  }
  const existing = managers.get(params.client);
  if (existing) {
    return;
  }
  const starting = startingManagers.get(params.client);
  if (starting) {
    await starting;
    return;
  }

  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.accountId,
  });
  const startPromise = (async () => {
    const manager = new MatrixDeviceVerificationManager({
      client: params.client,
      auth: params.auth,
      logger: params.logger,
      storageRootDir: storagePaths.rootDir,
    });
    try {
      await manager.start();
      managers.set(params.client, manager);
    } catch (err) {
      manager.dispose();
      throw err;
    }
  })().finally(() => {
    startingManagers.delete(params.client);
  });
  startingManagers.set(params.client, startPromise);
  await startPromise;
}

export function stopMatrixDeviceVerification(client: MatrixClient): void {
  const manager = managers.get(client);
  if (manager) {
    manager.dispose();
    managers.delete(client);
  }
}
