import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export const PLUGIN_ID = "velanir-participation-gate";
export const PARTICIPATION_CONTEXT_SCOPE = "participation-context:read";
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 20;
const DEFAULT_MAX_MESSAGES = 5;
const DEFAULT_REFRESH_MS = 5 * 60 * 1_000;
const DEFAULT_PLATFORM_ENDPOINT_PATH = "/v1/runtime/coworkers/{coworkerId}/participation-context";
const TOKEN_REFRESH_SKEW_MS = 30_000;
const RUNTIME_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const CONTEXT_FETCH_TIMEOUT_MS = 5_000;
const ASSERTION_TTL_SECONDS = 60;
const PRIVATE_KEY_FILE = "private-key.jwk";

type ParticipationMode = "shadow" | "enforce";
type ParticipationContextSource = "platform" | "static";
type PlatformContextAuthMode = "runtime" | "static-token";

type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type CoworkerParticipationIdentity = {
  id: string;
  names: string[];
  roleSummary?: string;
};

type ParticipationContext = {
  self: CoworkerParticipationIdentity;
  coworkers: CoworkerParticipationIdentity[];
};

type ClassifierConfig = {
  provider?: string;
  model?: string;
  authProfileId?: string;
  timeoutMs: number;
  maxOutputTokens: number;
};

type PlatformContextConfig = {
  authMode: PlatformContextAuthMode;
  baseUrl?: string;
  coworkerId?: string;
  token?: string;
  endpointPath: string;
};

type ParticipationGateConfig = {
  mode: ParticipationMode;
  classifier: ClassifierConfig;
  context: {
    source: ParticipationContextSource;
    maxMessages: number;
    refreshMs: number;
  };
  platform: PlatformContextConfig;
  staticContext?: ParticipationContext;
  logging: {
    decisions: boolean;
    includeContent: boolean;
  };
};

type BeforeDispatchEvent = {
  content?: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  isGroup?: boolean;
  timestamp?: number;
};

type BeforeDispatchContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
};

type ParticipationDecisionReason =
  | "dm"
  | "out_of_scope"
  | "empty_message"
  | "context_unavailable"
  | "direct_address_self"
  | "direct_address_other_coworker"
  | "classifier_true"
  | "classifier_false"
  | "classifier_error";

type ParticipationDecision = {
  shouldRespond: boolean;
  reason: ParticipationDecisionReason;
  source: "rule" | "classifier" | "fallback";
  latencyMs?: number;
  error?: string;
};

type HistoryMessage = {
  senderId?: string;
  content: string;
};

type RuntimeApi = OpenClawPluginApi & {
  pluginConfig?: unknown;
  logger?: PluginLogger;
  runtime?: {
    agent?: {
      runEmbeddedAgent?: (params: Record<string, unknown>) => Promise<unknown>;
      runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<unknown>;
      resolveAgentWorkspaceDir?: (config: unknown) => string;
    };
  };
};

type RuntimeSecretsEnv = {
  apiUrl: string;
  tokenIssuer: string;
  runtimeIdentityId: string;
  stateDir: string;
  keyId?: string;
};

type PrivateRuntimeJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  d: string;
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

type PublicRuntimeJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  alg: "ES256";
  use: "sig";
};

type RuntimeKeyState = {
  keyId: string;
  privateKey: KeyObject;
  publicKeyJwk: PublicRuntimeJwk;
};

type ParticipationContextProvider = {
  load: () => Promise<ParticipationContext>;
};

type ParticipationContextAuthClient = {
  authorizationHeaders: (requestUrl: string) => Promise<Record<string, string>>;
};

type RuntimeTokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{8,160}$/;
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function normalizeMode(value: unknown): ParticipationMode {
  return value === "enforce" ? "enforce" : "shadow";
}

function normalizeContextSource(value: unknown): ParticipationContextSource {
  return value === "static" ? "static" : "platform";
}

function normalizePlatformAuthMode(value: unknown): PlatformContextAuthMode {
  return value === "static-token" ? "static-token" : "runtime";
}

function normalizeClassifier(value: unknown): ClassifierConfig {
  const record = isRecord(value) ? value : {};
  return {
    provider: readString(record.provider),
    model: readString(record.model),
    authProfileId: readString(record.authProfileId),
    timeoutMs: readPositiveInteger(record.timeoutMs, DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxOutputTokens:
      readPositiveInteger(record.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS) ||
      DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function normalizePlatform(value: unknown, env: NodeJS.ProcessEnv): PlatformContextConfig {
  const record = isRecord(value) ? value : {};
  const authMode = normalizePlatformAuthMode(record.authMode);
  return {
    authMode,
    baseUrl: readString(record.baseUrl) ?? readString(env.OCT8_API_URL),
    coworkerId: readString(record.coworkerId) ?? readString(env.OCT8_COWORKER_ID),
    token:
      authMode === "static-token"
        ? (readString(record.token) ?? readString(env.OCT8_PARTICIPATION_CONTEXT_TOKEN))
        : undefined,
    endpointPath: readString(record.endpointPath) ?? DEFAULT_PLATFORM_ENDPOINT_PATH,
  };
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value.map(readString).filter((entry): entry is string => Boolean(entry));
  return [...new Set(names)];
}

function normalizeIdentity(value: unknown): CoworkerParticipationIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  const names = normalizeNames(value.names);
  if (!id || names.length === 0) {
    return undefined;
  }
  const roleSummary = readString(value.roleSummary);
  return {
    id,
    names,
    ...(roleSummary ? { roleSummary } : {}),
  };
}

function normalizeStaticContext(value: unknown): ParticipationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const self = normalizeIdentity(value.self);
  if (!self) {
    return undefined;
  }
  const coworkers = Array.isArray(value.coworkers)
    ? value.coworkers
        .map(normalizeIdentity)
        .filter((entry): entry is CoworkerParticipationIdentity => Boolean(entry))
        .filter((entry) => entry.id !== self.id)
    : [];
  return { self, coworkers };
}

export function normalizeConfig(
  pluginConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ParticipationGateConfig {
  const record = isRecord(pluginConfig) ? pluginConfig : {};
  const contextRecord = isRecord(record.context) ? record.context : {};
  const loggingRecord = isRecord(record.logging) ? record.logging : {};

  return {
    mode: normalizeMode(record.mode),
    classifier: normalizeClassifier(record.classifier),
    context: {
      source: normalizeContextSource(contextRecord.source),
      maxMessages: readPositiveInteger(contextRecord.maxMessages, DEFAULT_MAX_MESSAGES),
      refreshMs:
        readPositiveInteger(contextRecord.refreshMs, DEFAULT_REFRESH_MS) || DEFAULT_REFRESH_MS,
    },
    platform: normalizePlatform(record.platform, env),
    staticContext: normalizeStaticContext(record.staticContext),
    logging: {
      decisions: loggingRecord.decisions !== false,
      includeContent: loggingRecord.includeContent === true,
    },
  };
}

function normalizeBaseUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${key} must use https outside local development.`);
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function requiredEnvString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readRuntimeSecretsEnv(env: NodeJS.ProcessEnv = process.env): RuntimeSecretsEnv {
  const mode = env.OCT8_SECRETS_MODE?.trim();
  if (mode && mode !== "runtime") {
    throw new Error("Runtime participation auth only supports OCT8_SECRETS_MODE=runtime.");
  }

  const apiUrl = normalizeBaseUrl(requiredEnvString(env, "OCT8_API_URL"), "OCT8_API_URL");
  const tokenIssuer = normalizeBaseUrl(
    env.OCT8_RUNTIME_TOKEN_ISSUER?.trim() || apiUrl,
    "OCT8_RUNTIME_TOKEN_ISSUER",
  );
  const runtimeIdentityId = requiredEnvString(env, "OCT8_RUNTIME_IDENTITY_ID");
  if (!UUID_RE.test(runtimeIdentityId)) {
    throw new Error("OCT8_RUNTIME_IDENTITY_ID must be a runtime identity UUID.");
  }

  const keyId = env.OCT8_RUNTIME_KEY_ID?.trim();
  if (keyId && !KEY_ID_RE.test(keyId)) {
    throw new Error(
      "OCT8_RUNTIME_KEY_ID must be 8-160 characters using letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }

  return {
    apiUrl,
    tokenIssuer,
    runtimeIdentityId,
    stateDir: requiredEnvString(env, "OCT8_RUNTIME_STATE_DIR"),
    ...(keyId ? { keyId } : {}),
  };
}

function runtimeUrl(baseUrl: string, pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${baseUrl.replace(/\/+$/, "")}${normalizedPath}`;
}

function runtimeStatePaths(stateDir: string) {
  const root = path.join(stateDir, "oct8-secrets");
  return {
    root,
    privateKeyPath: path.join(root, PRIVATE_KEY_FILE),
  };
}

async function ensureStateRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
}

async function readJsonFile(pathname: string): Promise<JsonValue | undefined> {
  try {
    return JSON.parse(await fs.readFile(pathname, "utf8")) as JsonValue;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read runtime state file ${path.basename(pathname)}.`, {
      cause: error,
    });
  }
}

async function createJsonFileExclusive(
  pathname: string,
  value: unknown,
): Promise<"created" | "exists"> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(pathname, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return "exists";
    }
    throw new Error(`Failed to create runtime state file ${path.basename(pathname)}.`, {
      cause: error,
    });
  }

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await fs.chmod(pathname, 0o600).catch(() => undefined);
  return "created";
}

function publicJwkFromPrivate(privateJwk: PrivateRuntimeJwk): PublicRuntimeJwk {
  const publicJwk = Object.fromEntries(
    Object.entries(privateJwk).filter(([key]) => !PRIVATE_JWK_FIELDS.has(key)),
  ) as PublicRuntimeJwk;

  return {
    ...publicJwk,
    kty: "EC",
    crv: "P-256",
    kid: privateJwk.kid,
    alg: "ES256",
    use: "sig",
  };
}

function assertPrivateRuntimeJwk(value: unknown): PrivateRuntimeJwk {
  if (!isRecord(value)) {
    throw new Error("Runtime private key state must be a JSON object.");
  }
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    value.alg !== "ES256" ||
    value.use !== "sig" ||
    typeof value.kid !== "string" ||
    typeof value.d !== "string" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new Error("Runtime private key state is not an ES256 private JWK.");
  }
  return value as unknown as PrivateRuntimeJwk;
}

function generatePrivateRuntimeJwk(keyId: string): PrivateRuntimeJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = privateKey.export({ format: "jwk" });
  return {
    ...exported,
    kty: "EC",
    crv: "P-256",
    kid: keyId,
    alg: "ES256",
    use: "sig",
  } as PrivateRuntimeJwk;
}

async function loadRuntimeKey(env: RuntimeSecretsEnv): Promise<RuntimeKeyState> {
  const paths = runtimeStatePaths(env.stateDir);
  await ensureStateRoot(paths.root);

  const stored = await readJsonFile(paths.privateKeyPath);
  let privateJwk: PrivateRuntimeJwk;
  if (stored === undefined) {
    privateJwk = generatePrivateRuntimeJwk(env.keyId ?? `oct8-runtime-${randomUUID()}`);
    const result = await createJsonFileExclusive(paths.privateKeyPath, privateJwk);
    if (result === "exists") {
      privateJwk = assertPrivateRuntimeJwk(await readJsonFile(paths.privateKeyPath));
    }
  } else {
    privateJwk = assertPrivateRuntimeJwk(stored);
  }

  if (env.keyId && privateJwk.kid !== env.keyId) {
    throw new Error("OCT8_RUNTIME_KEY_ID does not match the stored runtime key.");
  }

  return {
    keyId: privateJwk.kid,
    privateKey: createPrivateKey({ key: privateJwk, format: "jwk" }),
    publicKeyJwk: publicJwkFromPrivate(privateJwk),
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toBase64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJwtPayload(params: {
  key: RuntimeKeyState;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}): string {
  const header = toBase64UrlJson(params.header);
  const payload = toBase64UrlJson(params.payload);
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: params.key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function signRuntimeAssertion(params: {
  key: RuntimeKeyState;
  runtimeIdentityId: string;
  audience: string;
}): string {
  const now = nowSeconds();
  return signJwtPayload({
    key: params.key,
    header: { alg: "ES256", kid: params.key.keyId },
    payload: {
      jti: randomUUID(),
      iss: params.runtimeIdentityId,
      sub: params.runtimeIdentityId,
      aud: params.audience,
      iat: now,
      exp: now + ASSERTION_TTL_SECONDS,
    },
  });
}

function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

function signDpopProof(params: {
  key: RuntimeKeyState;
  method: "GET" | "POST";
  htu: string;
  accessToken?: string;
}): string {
  const payload: Record<string, unknown> = {
    htm: params.method,
    htu: params.htu,
    jti: randomUUID(),
    iat: nowSeconds(),
  };
  if (params.accessToken) {
    payload.ath = accessTokenHash(params.accessToken);
  }
  return signJwtPayload({
    key: params.key,
    header: {
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: params.key.publicKeyJwk,
    },
    payload,
  });
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function participationContextHtu(tokenIssuer: string, requestUrl: string): string {
  const parsed = new URL(requestUrl);
  return runtimeUrl(tokenIssuer, parsed.pathname);
}

export class RuntimeParticipationContextAuthClient implements ParticipationContextAuthClient {
  private runtimeEnv: RuntimeSecretsEnv | undefined;
  private keyPromise: Promise<RuntimeKeyState> | undefined;
  private token: RuntimeTokenCache | undefined;

  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {},
  ) {}

  async authorizationHeaders(requestUrl: string): Promise<Record<string, string>> {
    const accessToken = await this.accessToken();
    const env = this.env();
    const key = await this.key();
    const dpopProof = signDpopProof({
      key,
      method: "GET",
      htu: participationContextHtu(env.tokenIssuer, requestUrl),
      accessToken,
    });

    return {
      Authorization: `DPoP ${accessToken}`,
      DPoP: dpopProof,
    };
  }

  private env(): RuntimeSecretsEnv {
    this.runtimeEnv ??= readRuntimeSecretsEnv(this.options.env);
    return this.runtimeEnv;
  }

  private key(): Promise<RuntimeKeyState> {
    this.keyPromise ??= loadRuntimeKey(this.env());
    return this.keyPromise;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.token.accessToken;
    }

    const env = this.env();
    const key = await this.key();
    const endpoint = runtimeUrl(env.apiUrl, "/v1/runtime/token");
    const audience = runtimeUrl(env.tokenIssuer, "/v1/runtime/token");
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.runtimeIdentityId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: signRuntimeAssertion({
        key,
        runtimeIdentityId: env.runtimeIdentityId,
        audience,
      }),
      scope: PARTICIPATION_CONTEXT_SCOPE,
    });

    const response = await fetchWithTimeout(
      this.options.fetchImpl ?? fetch,
      endpoint,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          DPoP: signDpopProof({ key, method: "POST", htu: audience }),
        },
        body: form.toString(),
      },
      RUNTIME_TOKEN_REQUEST_TIMEOUT_MS,
    );
    const payload = await parseJson(response);
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      throw new Error(`Runtime token request failed with ${response.status}${statusText}.`);
    }
    if (
      !isRecord(payload) ||
      typeof payload.access_token !== "string" ||
      payload.token_type !== "DPoP" ||
      payload.scope !== PARTICIPATION_CONTEXT_SCOPE ||
      typeof payload.expires_in !== "number" ||
      !Number.isFinite(payload.expires_in) ||
      payload.expires_in <= 0
    ) {
      throw new Error("Runtime token response was invalid.");
    }

    this.token = {
      accessToken: payload.access_token,
      expiresAtMs: now + payload.expires_in * 1_000,
    };
    return payload.access_token;
  }
}

function createRuntimeParticipationContextAuthClient(): RuntimeParticipationContextAuthClient {
  return new RuntimeParticipationContextAuthClient();
}

function parseIdentity(value: unknown): CoworkerParticipationIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  const names = normalizeNames(value.names);
  if (!id || names.length === 0) {
    return undefined;
  }
  const roleSummary = readString(value.roleSummary);
  return {
    id,
    names,
    ...(roleSummary ? { roleSummary } : {}),
  };
}

export function parseParticipationContext(payload: unknown): ParticipationContext {
  const candidate = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(candidate)) {
    throw new Error("participation context response must be an object");
  }

  const self = parseIdentity(candidate.self);
  if (!self) {
    throw new Error("participation context response is missing self identity");
  }

  const coworkers = Array.isArray(candidate.coworkers)
    ? candidate.coworkers
        .map(parseIdentity)
        .filter((entry): entry is CoworkerParticipationIdentity => Boolean(entry))
        .filter((entry) => entry.id !== self.id)
    : [];

  return { self, coworkers };
}

function buildParticipationContextUrl(config: PlatformContextConfig): string {
  if (!config.baseUrl) {
    throw new Error("platform context baseUrl is not configured");
  }
  if (!config.coworkerId) {
    throw new Error("platform context coworkerId is not configured");
  }

  const endpointPath = config.endpointPath.replace(
    "{coworkerId}",
    encodeURIComponent(config.coworkerId),
  );
  return new URL(endpointPath, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`)
    .href;
}

function createStaticParticipationContextProvider(
  context: ParticipationContext | undefined,
): ParticipationContextProvider {
  return {
    async load() {
      if (!context) {
        throw new Error("static participation context is not configured");
      }
      return context;
    },
  };
}

function createPlatformParticipationContextProvider(
  config: ParticipationGateConfig,
  options: {
    fetchImpl?: typeof fetch;
    runtimeAuthClient?: ParticipationContextAuthClient;
  } = {},
): ParticipationContextProvider {
  let cached: { expiresAt: number; context: ParticipationContext } | undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runtimeAuthClient =
    options.runtimeAuthClient ?? createRuntimeParticipationContextAuthClient();

  return {
    async load() {
      const now = Date.now();
      if (cached && cached.expiresAt > now) {
        return cached.context;
      }

      const url = buildParticipationContextUrl(config.platform);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (config.platform.authMode === "static-token") {
        if (!config.platform.token) {
          throw new Error("static platform context token is not configured");
        }
        headers.Authorization = `Bearer ${config.platform.token}`;
        if (config.platform.coworkerId) {
          headers["X-Velanir-Coworker-Id"] = config.platform.coworkerId;
        }
      } else {
        Object.assign(headers, await runtimeAuthClient.authorizationHeaders(url));
      }

      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        { method: "GET", headers },
        CONTEXT_FETCH_TIMEOUT_MS,
      );
      if (!response.ok) {
        throw new Error(`platform context request failed with ${response.status}`);
      }
      const context = parseParticipationContext(await response.json());
      cached = {
        context,
        expiresAt: now + config.context.refreshMs,
      };
      return context;
    },
  };
}

function createParticipationContextProvider(
  config: ParticipationGateConfig,
): ParticipationContextProvider {
  if (config.context.source === "static") {
    return createStaticParticipationContextProvider(config.staticContext);
  }
  return createPlatformParticipationContextProvider(config);
}

function messageText(event: BeforeDispatchEvent): string {
  return (event.body ?? event.content ?? "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  return escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildDirectAddressPatterns(name: string): RegExp[] {
  const pattern = namePattern(name);
  if (!pattern) {
    return [];
  }
  const left = "(^|[^A-Za-z0-9_])";
  const right = "(?=$|[^A-Za-z0-9_])";
  return [
    new RegExp(`${left}@${pattern}${right}`, "i"),
    new RegExp(`(^|[\\s\\n])${pattern}\\s*[:,]`, "i"),
    new RegExp(`${left}(hey|hi|hello|yo)\\s+${pattern}${right}`, "i"),
    new RegExp(
      `${left}${pattern}\\s+(can|could|would|will|please|do|take|help|look|check|own|handle|review|summarize|find|send|create|update)${right}`,
      "i",
    ),
    new RegExp(`${left}(can|could|would|will)\\s+${pattern}\\s+`, "i"),
  ];
}

export function messageClearlyAddressesIdentity(
  content: string,
  identity: CoworkerParticipationIdentity,
): boolean {
  if (!content.trim()) {
    return false;
  }
  return identity.names.some((name) =>
    matchesAnyPattern(content, buildDirectAddressPatterns(name)),
  );
}

function messageClearlyAddressesAnotherCoworker(
  content: string,
  context: ParticipationContext,
): boolean {
  return context.coworkers.some((coworker) => messageClearlyAddressesIdentity(content, coworker));
}

function conversationKey(event: BeforeDispatchEvent, ctx: BeforeDispatchContext): string {
  return (
    ctx.conversationId ??
    ctx.sessionKey ??
    event.sessionKey ??
    event.channel ??
    ctx.channelId ??
    "unknown"
  );
}

function createParticipationHistoryStore() {
  const messagesByConversation = new Map<string, HistoryMessage[]>();

  return {
    recent(event: BeforeDispatchEvent, ctx: BeforeDispatchContext, maxMessages: number) {
      if (maxMessages <= 0) {
        return [];
      }
      const messages = messagesByConversation.get(conversationKey(event, ctx)) ?? [];
      return messages.slice(-maxMessages);
    },

    record(event: BeforeDispatchEvent, ctx: BeforeDispatchContext, maxMessages: number) {
      if (maxMessages <= 0) {
        return;
      }
      const content = messageText(event);
      if (!content) {
        return;
      }
      const key = conversationKey(event, ctx);
      const current = messagesByConversation.get(key) ?? [];
      current.push({
        senderId: event.senderId ?? ctx.senderId,
        content,
      });
      if (current.length > maxMessages) {
        current.splice(0, current.length - maxMessages);
      }
      messagesByConversation.set(key, current);
    },
  };
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

function formatIdentity(identity: CoworkerParticipationIdentity): string {
  const role = identity.roleSummary ? ` Role: ${identity.roleSummary}` : "";
  return `- ${identity.names.join(", ")}.${role}`;
}

function buildClassifierPrompt(input: {
  context: ParticipationContext;
  recentMessages: HistoryMessage[];
  currentMessage: HistoryMessage;
}): string {
  const coworkers = input.context.coworkers.length
    ? input.context.coworkers.map(formatIdentity).join("\n")
    : "- None known.";
  const recentMessages =
    input.recentMessages.length > 0
      ? input.recentMessages
          .map((message) => {
            const sender = message.senderId ? `${message.senderId}: ` : "";
            return `- ${sender}${message.content}`;
          })
          .join("\n")
      : "- No recent messages available.";
  const currentSender = input.currentMessage.senderId ? `${input.currentMessage.senderId}: ` : "";

  return [
    "You decide whether a digital coworker should respond in a group or channel conversation.",
    "Answer only whether it is this coworker's turn to respond.",
    "",
    "This coworker:",
    formatIdentity(input.context.self),
    "",
    "Other digital coworkers in this organization:",
    coworkers,
    "",
    "Recent conversation:",
    recentMessages,
    "",
    "Current message:",
    `${currentSender}${input.currentMessage.content}`,
    "",
    "Return only valid JSON with this exact shape:",
    '{ "shouldRespond": true }',
    "or",
    '{ "shouldRespond": false }',
    "",
    "Return true when:",
    "- the message directly addresses this coworker",
    "- the message asks this coworker to do something",
    "- the message is a follow-up to this coworker",
    "- this coworker is clearly the responsible person for the request",
    "",
    "Return false when:",
    "- the message is ambient team conversation",
    "- the message is clearly for another person or coworker",
    "- the coworker would be interrupting",
    "- no response is expected from this coworker",
    "",
    "Do not include confidence scores, prose, markdown, or explanations.",
  ].join("\n");
}

export function parseClassifierShouldRespond(output: string): boolean {
  try {
    const parsed = JSON.parse(stripCodeFences(output));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { shouldRespond?: unknown }).shouldRespond === "boolean"
    ) {
      return (parsed as { shouldRespond: boolean }).shouldRespond;
    }
  } catch {
    return true;
  }
  return true;
}

function collectAssistantText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!isRecord(result) || !Array.isArray(result.payloads)) {
    return "";
  }
  return result.payloads
    .map((payload) => {
      if (!isRecord(payload)) {
        return "";
      }
      return payload.isError === true || typeof payload.text !== "string" ? "" : payload.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function runEmbeddedClassifierModel(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  prompt: string;
}): Promise<string> {
  const agentRuntime = params.api.runtime?.agent;
  const runEmbeddedAgent = agentRuntime?.runEmbeddedAgent ?? agentRuntime?.runEmbeddedPiAgent;
  if (typeof runEmbeddedAgent !== "function") {
    throw new Error("OpenClaw embedded agent runtime is unavailable");
  }

  const provider = params.config.classifier.provider;
  const model = params.config.classifier.model;
  if (!provider || !model) {
    throw new Error("classifier provider/model is not configured");
  }

  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "velanir-participation-gate-"),
    );
    const runId = `participation-gate-${randomUUID()}`;
    const result = await runEmbeddedAgent({
      sessionId: runId,
      sessionFile: path.join(tmpDir, "session.json"),
      workspaceDir: agentRuntime?.resolveAgentWorkspaceDir?.(params.api.config) ?? process.cwd(),
      config: params.api.config,
      prompt: params.prompt,
      timeoutMs: params.config.classifier.timeoutMs,
      runId,
      modelRun: true,
      provider,
      model,
      authProfileId: params.config.classifier.authProfileId,
      authProfileIdSource: params.config.classifier.authProfileId ? "user" : "auto",
      streamParams: {
        maxTokens: params.config.classifier.maxOutputTokens,
      },
      disableTools: true,
      disableMessageTool: true,
    });
    const text = collectAssistantText(result);
    if (!text) {
      throw new Error("classifier returned empty output");
    }
    return text;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function classifyShouldRespond(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  input: {
    context: ParticipationContext;
    recentMessages: HistoryMessage[];
    currentMessage: HistoryMessage;
  };
}): Promise<boolean> {
  const output = await runEmbeddedClassifierModel({
    api: params.api,
    config: params.config,
    prompt: buildClassifierPrompt(params.input),
  });
  return parseClassifierShouldRespond(output);
}

function decision(
  shouldRespond: boolean,
  reason: ParticipationDecision["reason"],
  source: ParticipationDecision["source"],
  startedAt: number,
  error?: unknown,
): ParticipationDecision {
  const message = errorMessage(error);
  return {
    shouldRespond,
    reason,
    source,
    latencyMs: Date.now() - startedAt,
    ...(message ? { error: message } : {}),
  };
}

async function decideParticipation(params: {
  api: RuntimeApi;
  config: ParticipationGateConfig;
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
  contextProvider: ParticipationContextProvider;
  history: ReturnType<typeof createParticipationHistoryStore>;
}): Promise<ParticipationDecision> {
  const startedAt = Date.now();

  if (params.event.isGroup !== true) {
    return decision(true, "dm", "rule", startedAt);
  }

  const content = messageText(params.event);
  if (!content) {
    return decision(true, "empty_message", "rule", startedAt);
  }

  const recentMessages = params.history.recent(
    params.event,
    params.ctx,
    params.config.context.maxMessages,
  );

  let context: ParticipationContext;
  try {
    context = await params.contextProvider.load();
  } catch (error) {
    params.history.record(params.event, params.ctx, params.config.context.maxMessages);
    return decision(true, "context_unavailable", "fallback", startedAt, error);
  }

  try {
    if (messageClearlyAddressesIdentity(content, context.self)) {
      return decision(true, "direct_address_self", "rule", startedAt);
    }

    if (messageClearlyAddressesAnotherCoworker(content, context)) {
      return decision(false, "direct_address_other_coworker", "rule", startedAt);
    }

    const shouldRespond = await classifyShouldRespond({
      api: params.api,
      config: params.config,
      input: {
        context,
        recentMessages,
        currentMessage: {
          senderId: params.event.senderId ?? params.ctx.senderId,
          content,
        },
      },
    });

    return decision(
      shouldRespond,
      shouldRespond ? "classifier_true" : "classifier_false",
      "classifier",
      startedAt,
    );
  } catch (error) {
    return decision(true, "classifier_error", "fallback", startedAt, error);
  } finally {
    params.history.record(params.event, params.ctx, params.config.context.maxMessages);
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return error.toString();
  }
  return "unknown error";
}

function eventContent(event: BeforeDispatchEvent): string {
  return (event.body ?? event.content ?? "").trim();
}

function field(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    return `${name}=${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${name}=${value.toString()}`;
  }
  return `${name}=${JSON.stringify(value) ?? "unknown"}`;
}

function logParticipationDecision(params: {
  logger?: PluginLogger;
  config: ParticipationGateConfig;
  decision: ParticipationDecision;
  event: BeforeDispatchEvent;
  ctx: BeforeDispatchContext;
}): void {
  if (!params.config.logging.decisions) {
    return;
  }
  const outcome = params.decision.shouldRespond
    ? "respond"
    : params.config.mode === "enforce"
      ? "skip"
      : "would_skip";
  const parts = [
    "velanir-participation-gate:",
    field("mode", params.config.mode),
    field("outcome", outcome),
    field("reason", params.decision.reason),
    field("source", params.decision.source),
    field("channel", params.ctx.channelId ?? params.event.channel),
    field("conversation", params.ctx.conversationId),
    field("session", params.ctx.sessionKey ?? params.event.sessionKey),
    field("sender", params.event.senderId ?? params.ctx.senderId),
    field("latencyMs", params.decision.latencyMs),
    field("model", params.config.classifier.model),
    field("error", params.decision.error),
    params.config.logging.includeContent
      ? field("content", JSON.stringify(eventContent(params.event)))
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  params.logger?.info?.(parts.join(" "));
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Velanir Participation Gate",
  description:
    "Decides whether a digital coworker should respond in group and channel conversations before the main agent runs.",
  register(api: OpenClawPluginApi) {
    const runtimeApi = api as RuntimeApi;
    const config = normalizeConfig(runtimeApi.pluginConfig);
    const contextProvider = createParticipationContextProvider(config);
    const history = createParticipationHistoryStore();

    api.on(
      "before_dispatch",
      async (event, ctx) => {
        const decisionResult = await decideParticipation({
          api: runtimeApi,
          config,
          event,
          ctx,
          contextProvider,
          history,
        });

        logParticipationDecision({
          logger: runtimeApi.logger,
          config,
          decision: decisionResult,
          event,
          ctx,
        });

        if (!decisionResult.shouldRespond && config.mode === "enforce") {
          return { handled: true };
        }
        return undefined;
      },
      { timeoutMs: config.classifier.timeoutMs + 2_000 },
    );
  },
});
