import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";
import { privateKeyToAccount } from "viem/accounts";

const PROVIDER_ID = "x402";
const PROVIDER_LABEL = "Daydreams Router (x402)";
const PLUGIN_ID = "daydreams-x402-auth";

const DEFAULT_ROUTER_URL = "https://ai.xgate.run";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_PERMIT_CAP_USD = 10;
const AUTO_MODEL_ID = "auto";
const DEFAULT_MODEL_ID = "kimi-k2.5";
const DEFAULT_MODEL_REF = `x402/${DEFAULT_MODEL_ID}`;
const OPUS_MODEL_ID = "claude-opus-4-6";
const OPUS_MODEL_REF = `x402/${OPUS_MODEL_ID}`;
const SONNET_MODEL_ID = "claude-sonnet-4-6";
const SONNET_MODEL_REF = `x402/${SONNET_MODEL_ID}`;
const GPT5_MODEL_ID = "gpt-5";
const GPT5_MODEL_REF = `x402/${GPT5_MODEL_ID}`;
const CODEX_MODEL_ID = "gpt-5.3-codex";
const CODEX_MODEL_REF = `x402/${CODEX_MODEL_ID}`;
const DEFAULT_AUTO_REF = `x402/${AUTO_MODEL_ID}`;
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 8192;

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_SAW_SOCKET = process.env.SAW_SOCKET || "/run/saw/saw.sock";
const DEFAULT_SAW_WALLET = "main";
const TASKMARKET_SENTINEL_PREFIX = "taskmarket:";
const TASKMARKET_SENTINEL_VERSION = 1 as const;
const FALLBACK_TASKMARKET_API_URL = "https://api-market.daydreams.systems";
const DEFAULT_TASKMARKET_API_URL = process.env.TASKMARKET_API_URL || FALLBACK_TASKMARKET_API_URL;
const DEFAULT_TASKMARKET_KEYSTORE_PATH = "~/.taskmarket/keystore.json";

type X402ModelDefinition = {
  id: string;
  name: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

const X402_MODELS: X402ModelDefinition[] = [
  {
    id: AUTO_MODEL_ID,
    name: "Auto (Smart Routing)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    // Router selects the final provider/model at request time.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (latest)",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: OPUS_MODEL_ID,
    name: "Claude Opus 4.6 (latest)",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: SONNET_MODEL_ID,
    name: "Claude Sonnet 4.6 (latest)",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: DEFAULT_MODEL_ID,
    name: "Kimi K2.5",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: GPT5_MODEL_ID,
    name: "GPT-5",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5-pro",
    name: "GPT-5 Pro",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 120, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 272000,
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: CODEX_MODEL_ID,
    name: "GPT-5.3 Codex",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  },
  {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude Haiku 3.5",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "anthropic/claude-3.7-sonnet",
    name: "Claude Sonnet 3.7",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
];

const MODEL_ALIAS_BY_ID: Record<string, string | undefined> = {
  [AUTO_MODEL_ID]: "Auto",
  [DEFAULT_MODEL_ID]: "Kimi",
  [OPUS_MODEL_ID]: "Opus",
  [SONNET_MODEL_ID]: "Sonnet",
  [GPT5_MODEL_ID]: "GPT-5",
  [CODEX_MODEL_ID]: "Codex",
};

function buildDefaultModelOptions() {
  return X402_MODELS.map((model) => {
    const value = `x402/${model.id}`;
    return {
      value,
      label: model.name,
      hint: value === DEFAULT_AUTO_REF ? "Router chooses the model automatically" : value,
    };
  });
}

async function promptDefaultModelRef(ctx: ProviderAuthContext): Promise<string> {
  const options = buildDefaultModelOptions();
  if (options.length === 0) {
    return DEFAULT_AUTO_REF;
  }
  if (options.length === 1) {
    return options[0]?.value ?? DEFAULT_AUTO_REF;
  }

  const selected = String(
    await ctx.prompter.select({
      message: "Default Daydreams model",
      options,
      initialValue: DEFAULT_AUTO_REF,
    }),
  ).trim();

  return options.some((option) => option.value === selected) ? selected : DEFAULT_AUTO_REF;
}

function buildDefaultAllowlistedModels(): Record<string, { alias?: string }> {
  const entries: Record<string, { alias?: string }> = {};
  for (const model of X402_MODELS) {
    const key = `x402/${model.id}`;
    const alias = MODEL_ALIAS_BY_ID[model.id];
    entries[key] = alias ? { alias } : {};
  }
  return entries;
}

function cloneX402Models() {
  return X402_MODELS.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }));
}

function normalizePrivateKey(value: string): string | null {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("0X") ? `0x${trimmed.slice(2)}` : trimmed;
  return PRIVATE_KEY_REGEX.test(normalized) ? normalized : null;
}

function normalizeTaskmarketApiUrl(value: string): string {
  const raw = value.trim() || DEFAULT_TASKMARKET_API_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

function resolveHomePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type TaskmarketKeystore = {
  encryptedKey: string;
  walletAddress: string;
  deviceId: string;
  apiToken: string;
};

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function buildTaskmarketSentinel(payload: { keystorePath: string; apiUrl?: string }): string {
  const record: Record<string, unknown> = {
    v: TASKMARKET_SENTINEL_VERSION,
    keystorePath: payload.keystorePath,
  };
  const apiUrl = payload.apiUrl ? normalizeTaskmarketApiUrl(payload.apiUrl) : "";
  if (apiUrl && apiUrl !== FALLBACK_TASKMARKET_API_URL) {
    record.apiUrl = apiUrl;
  }
  return `${TASKMARKET_SENTINEL_PREFIX}${toBase64Url(JSON.stringify(record))}`;
}

function buildSawSentinel(walletName: string, socketPath: string): string {
  return `saw:${walletName}@${socketPath}`;
}

async function loadTaskmarketKeystore(keystorePath: string): Promise<TaskmarketKeystore> {
  const resolvedPath = resolveHomePath(keystorePath);
  if (!resolvedPath) {
    throw new Error("Taskmarket keystore path is required");
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `Taskmarket keystore not found at ${resolvedPath}. Run taskmarket init first.`,
      );
    }
    throw new Error(
      `Taskmarket keystore at ${resolvedPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Taskmarket keystore at ${resolvedPath} is not valid JSON.`);
  }

  const record = parsed as Record<string, unknown>;
  const encryptedKey =
    typeof record.encryptedKey === "string" ? record.encryptedKey.trim() : undefined;
  const walletAddress =
    typeof record.walletAddress === "string" ? record.walletAddress.trim() : undefined;
  const deviceId = typeof record.deviceId === "string" ? record.deviceId.trim() : undefined;
  const apiToken = typeof record.apiToken === "string" ? record.apiToken.trim() : undefined;
  const normalizedWalletAddress = normalizeAddress(walletAddress);

  if (!encryptedKey || !deviceId || !apiToken || !normalizedWalletAddress) {
    throw new Error(
      `Taskmarket keystore at ${resolvedPath} is missing required fields (encryptedKey, walletAddress, deviceId, apiToken).`,
    );
  }

  return {
    encryptedKey,
    walletAddress: normalizedWalletAddress,
    deviceId,
    apiToken,
  };
}

async function verifyTaskmarketDeviceKeyAccess(
  apiUrl: string,
  keystore: TaskmarketKeystore,
): Promise<string> {
  const normalizedUrl = normalizeTaskmarketApiUrl(apiUrl);
  const endpoint = `${normalizedUrl}/api/devices/${encodeURIComponent(keystore.deviceId)}/key`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: keystore.deviceId, apiToken: keystore.apiToken }),
    });
  } catch (error) {
    throw new Error(
      `Could not contact Taskmarket API at ${normalizedUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Taskmarket device token was rejected. Reprovision wallet via taskmarket init and rerun onboarding.",
      );
    }
    if (response.status === 404) {
      throw new Error(
        `Taskmarket device ${keystore.deviceId} was not found. Reprovision wallet via taskmarket init and rerun onboarding.`,
      );
    }
    throw new Error(
      `Taskmarket device key probe failed (${response.status}). ${detail.slice(0, 180)} Reprovision your wallet with taskmarket init if needed.`,
    );
  }

  const parsed = (await response.json().catch(() => null)) as {
    deviceEncryptionKey?: unknown;
  } | null;
  const dek =
    parsed && typeof parsed.deviceEncryptionKey === "string"
      ? parsed.deviceEncryptionKey.trim()
      : "";
  if (!/^[0-9a-fA-F]{64}$/.test(dek)) {
    throw new Error(
      "Taskmarket device key probe returned an invalid key payload. Reprovision wallet via taskmarket init.",
    );
  }
  return dek;
}

function decodeTaskmarketEncryptedKey(encryptedHex: string): {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  const data = Buffer.from(encryptedHex, "hex");
  if (data.length <= 28) {
    throw new Error("Taskmarket encrypted keystore payload is too short.");
  }
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  if (ciphertext.length === 0) {
    throw new Error("Taskmarket encrypted keystore payload is empty.");
  }
  return { iv, tag, ciphertext };
}

function decryptTaskmarketPrivateKey(deviceEncryptionKeyHex: string, encryptedHex: string): string {
  const key = Buffer.from(deviceEncryptionKeyHex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "Taskmarket device key payload is invalid. Reprovision wallet via taskmarket init.",
    );
  }

  const { iv, tag, ciphertext } = decodeTaskmarketEncryptedKey(encryptedHex);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const normalized = decrypted.trim().startsWith("0X")
      ? `0x${decrypted.trim().slice(2)}`
      : decrypted.trim();
    if (!PRIVATE_KEY_REGEX.test(normalized)) {
      throw new Error("Decrypted Taskmarket key is not a valid private key.");
    }
    return normalized;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Decrypted Taskmarket key is not a valid private key."
    ) {
      throw error;
    }
    throw new Error(
      "Taskmarket keystore could not be decrypted with the fetched device key. Reprovision wallet via taskmarket init.",
    );
  }
}

function verifyTaskmarketWalletIntegrity(
  keystore: TaskmarketKeystore,
  deviceEncryptionKey: string,
): void {
  const privateKey = decryptTaskmarketPrivateKey(deviceEncryptionKey, keystore.encryptedKey);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  if (account.address.toLowerCase() !== keystore.walletAddress.toLowerCase()) {
    throw new Error(
      "Taskmarket keystore address mismatch after decryption. Reprovision wallet via taskmarket init and rerun onboarding.",
    );
  }
}

function ensureTaskmarketCliAvailable(): void {
  const probe = spawnSync("taskmarket", ["--help"], {
    stdio: "ignore",
    encoding: "utf8",
  });
  if (!probe.error) {
    return;
  }
  throw new Error(
    `Taskmarket CLI is required for this auth method but was not found in PATH (${probe.error.message}). Install it first, then run \`taskmarket init\` and re-run onboarding.`,
  );
}

async function ensureTaskmarketWalletProvisioned(
  ctx: ProviderAuthContext,
  keystorePath: string,
): Promise<void> {
  const resolvedPath = resolveHomePath(keystorePath);
  if (!resolvedPath) {
    throw new Error("Taskmarket keystore path is required");
  }

  try {
    await fs.access(resolvedPath);
    return;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw new Error(
        `Taskmarket keystore at ${resolvedPath} could not be accessed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const shouldProvision = await ctx.prompter.confirm({
    message: `No Taskmarket keystore found at ${resolvedPath}. Run taskmarket init now?`,
    initialValue: true,
  });
  if (!shouldProvision) {
    throw new Error(
      `Taskmarket keystore not found at ${resolvedPath}. Run taskmarket init, then re-run onboarding.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("taskmarket", ["init"], {
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", (error) => {
      reject(
        new Error(
          `Could not start taskmarket init: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `taskmarket init failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });

  try {
    await fs.access(resolvedPath);
  } catch (error) {
    throw new Error(
      getErrorCode(error) === "ENOENT"
        ? `taskmarket init completed, but no keystore was found at ${resolvedPath}. Re-run taskmarket init or check your Taskmarket config.`
        : `taskmarket init completed, but the keystore at ${resolvedPath} could not be accessed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolveSawAddress(walletName: string, socketPath: string): Promise<string | null> {
  try {
    const { createSawClient } = await import("@daydreamsai/saw");
    const client = createSawClient({ wallet: walletName, socketPath });
    const address = await client.getAddress();
    return normalizeAddress(address);
  } catch {
    return null;
  }
}

function normalizeRouterUrl(value: string): string {
  const raw = value.trim() || DEFAULT_ROUTER_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  // Store the bare origin — SDKs and the payment wrapper add paths as needed
  return withProtocol.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
}

function normalizePermitCap(value: string): number | null {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeNetwork(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : null;
}

async function resolveKeyAddress(privateKey: string): Promise<string | null> {
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    return normalizeAddress(privateKeyToAccount(privateKey as `0x${string}`).address);
  } catch {
    return null;
  }
}

function buildFundingNote(address: string | null, network: string): string {
  const networkHint =
    network === "eip155:8453" ? "USDC on Base (eip155:8453)" : `USDC on ${network}`;
  if (address) {
    return [
      `This is your address: ${address}`,
      `Fill it with ${networkHint} to start making requests.`,
    ].join("\n");
  }
  return `Fill your x402 wallet with ${networkHint} to start making requests.`;
}

async function showFundingStep(
  ctx: ProviderAuthContext,
  address: string | null,
  network: string,
): Promise<void> {
  await ctx.prompter.note(buildFundingNote(address, network), "Fund wallet");
  const continueSetup = await ctx.prompter.confirm({
    message: "Continue setup after saving this address?",
    initialValue: true,
  });
  if (!continueSetup) {
    throw new Error("Setup cancelled. Fund the wallet, then run onboarding again.");
  }
}

const x402Plugin = {
  id: PLUGIN_ID,
  name: "Daydreams Router (x402) Auth",
  description: "Permit-signed auth for Daydreams Router (x402)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/x402",
      auth: [
        {
          id: "saw",
          label: "Secure Agent Wallet (SAW)",
          hint: "Signs permits via SAW daemon",
          kind: "api_key",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            await ctx.prompter.note(
              [
                "SAW keeps private keys in a separate daemon process,",
                "preventing prompt injection from exfiltrating them.",
                "The SAW daemon must be running before use.",
              ].join("\n"),
              "SAW",
            );

            const socketInput = await ctx.prompter.text({
              message: "SAW daemon socket path",
              initialValue: DEFAULT_SAW_SOCKET,
              validate: (value: string) => (value.trim() ? undefined : "Socket path required"),
            });
            const socketPath = String(socketInput).trim();

            const walletInput = await ctx.prompter.text({
              message: "SAW wallet name",
              initialValue: DEFAULT_SAW_WALLET,
              validate: (value: string) => (value.trim() ? undefined : "Wallet name required"),
            });
            const walletName = String(walletInput).trim();

            const routerInput = await ctx.prompter.text({
              message: "Daydreams Router URL",
              initialValue: DEFAULT_ROUTER_URL,
              validate: (value: string) => {
                try {
                  // eslint-disable-next-line no-new
                  new URL(value);
                  return undefined;
                } catch {
                  return "Invalid URL";
                }
              },
            });
            const routerUrl = normalizeRouterUrl(String(routerInput));

            const capInput = await ctx.prompter.text({
              message: "Permit cap (USD)",
              initialValue: String(DEFAULT_PERMIT_CAP_USD),
              validate: (value: string) =>
                normalizePermitCap(value) ? undefined : "Invalid amount",
            });
            const permitCap = normalizePermitCap(String(capInput)) ?? DEFAULT_PERMIT_CAP_USD;

            const networkInput = await ctx.prompter.text({
              message: "Network (CAIP-2)",
              initialValue: DEFAULT_NETWORK,
              validate: (value: string) => (normalizeNetwork(value) ? undefined : "Required"),
            });
            const network = normalizeNetwork(String(networkInput)) ?? DEFAULT_NETWORK;
            const selectedDefaultModelRef = await promptDefaultModelRef(ctx);
            const fundingAddress = await resolveSawAddress(walletName, socketPath);
            if (!fundingAddress) {
              throw new Error(
                `Could not resolve SAW wallet address for "${walletName}" via socket "${socketPath}". Ensure the SAW daemon is running and the wallet exists, then re-run onboarding.`,
              );
            }
            await showFundingStep(ctx, fundingAddress, network);

            const existingPluginConfig =
              ctx.config.plugins?.entries?.[PLUGIN_ID]?.config &&
              typeof ctx.config.plugins.entries[PLUGIN_ID]?.config === "object"
                ? (ctx.config.plugins.entries[PLUGIN_ID]?.config as Record<string, unknown>)
                : {};

            const pluginConfigPatch: Record<string, unknown> = { ...existingPluginConfig };
            if (existingPluginConfig.permitCap === undefined) {
              pluginConfigPatch.permitCap = permitCap;
            }
            if (!existingPluginConfig.network) {
              pluginConfigPatch.network = network;
            }

            return {
              profiles: [
                {
                  profileId: "x402:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: buildSawSentinel(walletName, socketPath),
                  },
                },
              ],
              configPatch: {
                plugins: {
                  entries: {
                    [PLUGIN_ID]: {
                      config: pluginConfigPatch,
                    },
                  },
                },
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: routerUrl,
                      apiKey: "x402-wallet",
                      api: "anthropic-messages",
                      authHeader: false,
                      models: cloneX402Models(),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: buildDefaultAllowlistedModels(),
                  },
                },
              },
              defaultModel: selectedDefaultModelRef,
              notes: [
                `Daydreams Router base URL set to ${routerUrl}.`,
                `SAW signing via wallet "${walletName}" at ${socketPath}.`,
                "Permit caps apply per signed session; update plugins.entries.daydreams-x402-auth.config to change.",
              ],
            };
          },
        },
        {
          id: "taskmarket",
          label: "Taskmarket wallet keystore",
          hint: "Signs permits using Taskmarket encrypted keystore + device key",
          kind: "api_key",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const keystorePath = DEFAULT_TASKMARKET_KEYSTORE_PATH;
            await ctx.prompter.note(
              [
                "This mode uses a Taskmarket encrypted keystore and per-device token.",
                "If no wallet is provisioned yet, OpenClaw can run `taskmarket init` during onboarding.",
                "OpenClaw will fetch a Taskmarket device key on demand to sign permits.",
              ].join("\n"),
              "Taskmarket wallet",
            );
            ensureTaskmarketCliAvailable();
            await ensureTaskmarketWalletProvisioned(ctx, keystorePath);
            const keystore = await loadTaskmarketKeystore(keystorePath);
            const deviceEncryptionKey = await verifyTaskmarketDeviceKeyAccess(
              DEFAULT_TASKMARKET_API_URL,
              keystore,
            );
            verifyTaskmarketWalletIntegrity(keystore, deviceEncryptionKey);

            const routerInput = await ctx.prompter.text({
              message: "Daydreams Router URL",
              initialValue: DEFAULT_ROUTER_URL,
              validate: (value: string) => {
                try {
                  // eslint-disable-next-line no-new
                  new URL(value);
                  return undefined;
                } catch {
                  return "Invalid URL";
                }
              },
            });
            const routerUrl = normalizeRouterUrl(String(routerInput));

            const capInput = await ctx.prompter.text({
              message: "Permit cap (USD)",
              initialValue: String(DEFAULT_PERMIT_CAP_USD),
              validate: (value: string) =>
                normalizePermitCap(value) ? undefined : "Invalid amount",
            });
            const permitCap = normalizePermitCap(String(capInput)) ?? DEFAULT_PERMIT_CAP_USD;

            const networkInput = await ctx.prompter.text({
              message: "Network (CAIP-2)",
              initialValue: DEFAULT_NETWORK,
              validate: (value: string) => (normalizeNetwork(value) ? undefined : "Required"),
            });
            const network = normalizeNetwork(String(networkInput)) ?? DEFAULT_NETWORK;
            const selectedDefaultModelRef = await promptDefaultModelRef(ctx);
            await showFundingStep(ctx, keystore.walletAddress, network);

            const existingPluginConfig =
              ctx.config.plugins?.entries?.[PLUGIN_ID]?.config &&
              typeof ctx.config.plugins.entries[PLUGIN_ID]?.config === "object"
                ? (ctx.config.plugins.entries[PLUGIN_ID]?.config as Record<string, unknown>)
                : {};

            const pluginConfigPatch: Record<string, unknown> = { ...existingPluginConfig };
            if (existingPluginConfig.permitCap === undefined) {
              pluginConfigPatch.permitCap = permitCap;
            }
            if (!existingPluginConfig.network) {
              pluginConfigPatch.network = network;
            }

            return {
              profiles: [
                {
                  profileId: "x402:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: buildTaskmarketSentinel({
                      keystorePath,
                      apiUrl: DEFAULT_TASKMARKET_API_URL,
                    }),
                  },
                },
              ],
              configPatch: {
                plugins: {
                  entries: {
                    [PLUGIN_ID]: {
                      config: pluginConfigPatch,
                    },
                  },
                },
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: routerUrl,
                      apiKey: "x402-wallet",
                      api: "anthropic-messages",
                      authHeader: false,
                      models: cloneX402Models(),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: buildDefaultAllowlistedModels(),
                  },
                },
              },
              defaultModel: selectedDefaultModelRef,
              notes: [
                `Daydreams Router base URL set to ${routerUrl}.`,
                `Taskmarket keystore path: ${keystorePath}.`,
                `Taskmarket API URL: ${DEFAULT_TASKMARKET_API_URL}.`,
                "Permit caps apply per signed session; update plugins.entries.daydreams-x402-auth.config to change.",
              ],
            };
          },
        },
        {
          id: "wallet",
          label: "Wallet private key",
          hint: "Signs ERC-2612 permits per request",
          kind: "api_key",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            await ctx.prompter.note(
              [
                "Daydreams Router uses wallet-signed ERC-2612 permits for payment in USDC.",
                "Use a dedicated wallet for AI spend; keys are stored locally.",
              ].join("\n"),
              "x402",
            );

            const keyInput = await ctx.prompter.text({
              message: "Wallet private key (0x + 64 hex chars)",
              validate: (value: string) =>
                normalizePrivateKey(value) ? undefined : "Invalid private key format",
            });
            const normalizedKey = normalizePrivateKey(String(keyInput));
            if (!normalizedKey) throw new Error("Invalid private key format");

            const routerInput = await ctx.prompter.text({
              message: "Daydreams Router URL",
              initialValue: DEFAULT_ROUTER_URL,
              validate: (value: string) => {
                try {
                  // eslint-disable-next-line no-new
                  new URL(value);
                  return undefined;
                } catch {
                  return "Invalid URL";
                }
              },
            });
            const routerUrl = normalizeRouterUrl(String(routerInput));

            const capInput = await ctx.prompter.text({
              message: "Permit cap (USD)",
              initialValue: String(DEFAULT_PERMIT_CAP_USD),
              validate: (value: string) =>
                normalizePermitCap(value) ? undefined : "Invalid amount",
            });
            const permitCap = normalizePermitCap(String(capInput)) ?? DEFAULT_PERMIT_CAP_USD;

            const networkInput = await ctx.prompter.text({
              message: "Network (CAIP-2)",
              initialValue: DEFAULT_NETWORK,
              validate: (value: string) => (normalizeNetwork(value) ? undefined : "Required"),
            });
            const network = normalizeNetwork(String(networkInput)) ?? DEFAULT_NETWORK;
            const selectedDefaultModelRef = await promptDefaultModelRef(ctx);
            const fundingAddress = await resolveKeyAddress(normalizedKey);
            await showFundingStep(ctx, fundingAddress, network);

            const existingPluginConfig =
              ctx.config.plugins?.entries?.[PLUGIN_ID]?.config &&
              typeof ctx.config.plugins.entries[PLUGIN_ID]?.config === "object"
                ? (ctx.config.plugins.entries[PLUGIN_ID]?.config as Record<string, unknown>)
                : {};

            const pluginConfigPatch: Record<string, unknown> = { ...existingPluginConfig };
            if (existingPluginConfig.permitCap === undefined) {
              pluginConfigPatch.permitCap = permitCap;
            }
            if (!existingPluginConfig.network) {
              pluginConfigPatch.network = network;
            }

            return {
              profiles: [
                {
                  profileId: "x402:default",
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: normalizedKey,
                  },
                },
              ],
              configPatch: {
                plugins: {
                  entries: {
                    [PLUGIN_ID]: {
                      config: pluginConfigPatch,
                    },
                  },
                },
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: routerUrl,
                      apiKey: "x402-wallet",
                      api: "anthropic-messages",
                      authHeader: false,
                      models: cloneX402Models(),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: buildDefaultAllowlistedModels(),
                  },
                },
              },
              defaultModel: selectedDefaultModelRef,
              notes: [
                `Daydreams Router base URL set to ${routerUrl}.`,
                "Permit caps apply per signed session; update plugins.entries.daydreams-x402-auth.config to change.",
              ],
            };
          },
        },
      ],
    });
  },
};

export default x402Plugin;
