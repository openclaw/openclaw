import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABACUS_API = "https://api.abacus.ai/api/v0";
const ROUTELLM_BASE = "https://routellm.abacus.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;
const PROXY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const PROXY_START_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB safety limit for request bodies

// Models available on AbacusAI RouteLLM endpoint (OpenAI-compatible, with
// function calling support). Verified 2026-02.
const DEFAULT_MODEL_IDS = [
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5-mini",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
  "deepseek-ai/DeepSeek-V3.2",
  "deepseek-ai/DeepSeek-R1",
  "kimi-k2.5",
  "qwen3-max",
  "grok-4-1-fast-non-reasoning",
  "route-llm",
];

// ---------------------------------------------------------------------------
// Credential detection (Code Mode / env / manual)
// ---------------------------------------------------------------------------

const CODE_MODE_CREDENTIAL_PATHS = {
  win32: [
    join(homedir(), "AppData", "Roaming", "AbacusAI", "User", "globalStorage", "credentials.json"),
    join(
      homedir(),
      "AppData",
      "Roaming",
      "AbacusAI Code Mode",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
  darwin: [
    join(
      homedir(),
      "Library",
      "Application Support",
      "AbacusAI",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(
      homedir(),
      "Library",
      "Application Support",
      "AbacusAI Code Mode",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
  linux: [
    join(homedir(), ".config", "AbacusAI", "User", "globalStorage", "credentials.json"),
    join(homedir(), ".config", "AbacusAI Code Mode", "User", "globalStorage", "credentials.json"),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
};

type CredentialFile = {
  apiKey?: string;
  api_key?: string;
  token?: string;
  accessToken?: string;
  access_token?: string;
};

function tryReadLocalCredential(): string | null {
  const platform = process.platform as "win32" | "darwin" | "linux";
  const paths = CODE_MODE_CREDENTIAL_PATHS[platform] ?? CODE_MODE_CREDENTIAL_PATHS.linux;
  for (const credPath of paths) {
    try {
      const raw = readFileSync(credPath, "utf8");
      const data = JSON.parse(raw) as CredentialFile;
      const key =
        data.apiKey?.trim() ||
        data.api_key?.trim() ||
        data.token?.trim() ||
        data.accessToken?.trim() ||
        data.access_token?.trim();
      if (key) {
        return key;
      }
    } catch {
      // not found — try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Saved credential recovery (for proxy auto-restart after reboot)
// ---------------------------------------------------------------------------

function resolveOpenClawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), ".openclaw");
}

function tryRecoverApiKey(): string | null {
  const stateDir = resolveOpenClawStateDir();

  // Helper: extract abacusai API key from an auth-profiles.json file
  function extractFromAuthFile(authPath: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(authPath, "utf8")) as {
        profiles?: Record<string, { token?: string; key?: string; provider?: string }>;
      };
      if (raw.profiles) {
        for (const [id, profile] of Object.entries(raw.profiles)) {
          if (!id.startsWith("abacusai:")) {
            continue;
          }
          // Credentials may use "token" or "key" field depending on auth flow
          const secret = profile.token?.trim() || profile.key?.trim();
          if (secret) {
            return secret;
          }
        }
      }
    } catch {
      // file not found or unreadable
    }
    return null;
  }

  // Primary: search agents/*/agent/auth-profiles.json (actual storage location)
  try {
    const agentsDir = join(stateDir, "agents");
    for (const agentName of readdirSync(agentsDir)) {
      const authPath = join(agentsDir, agentName, "agent", "auth-profiles.json");
      const key = extractFromAuthFile(authPath);
      if (key) {
        return key;
      }
    }
  } catch {
    // agents dir not found
  }

  // Fallback: try root-level auth-profiles.json (legacy or future layout)
  const rootKey = extractFromAuthFile(join(stateDir, "auth-profiles.json"));
  if (rootKey) {
    return rootKey;
  }

  // Fallback: try environment variable
  const envKey = process.env.ABACUSAI_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }
  // Fallback: try local Code Mode credentials
  return tryReadLocalCredential();
}

function updateConfigBaseUrl(newBaseUrl: string): void {
  const stateDir = resolveOpenClawStateDir();
  const configPath = join(stateDir, "openclaw.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (raw?.models?.providers?.abacusai) {
      const current = raw.models.providers.abacusai.baseUrl;
      if (current === newBaseUrl) {
        return;
      }
      raw.models.providers.abacusai.baseUrl = newBaseUrl;
      writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf8");
    }
  } catch {
    // config not found or unwritable — non-fatal
  }
}

async function ensureProxy(): Promise<boolean> {
  // Fast path: proxy already running and healthy
  if (proxyState.server?.listening) {
    resetIdleTimer();
    return true;
  }

  // Clean up stale server (e.g. server exists but stopped listening)
  if (proxyState.server) {
    await stopProxy();
  }

  const apiKey = tryRecoverApiKey();
  if (!apiKey) {
    console.error(
      "[abacusai] No API key found. Run `openclaw models auth login --provider abacusai` to configure.",
    );
    return false;
  }

  // Validate API key before starting proxy — catch expired/revoked keys early
  const validation = await validateApiKey(apiKey);
  if (!validation.valid) {
    console.error(
      `[abacusai] API key validation failed: ${validation.error ?? "unknown error"}. ` +
        `Run \`openclaw models auth login --provider abacusai\` to re-authenticate.`,
    );
    return false;
  }

  try {
    // Race proxy startup against a timeout to prevent indefinite hangs
    const port = await Promise.race([
      startProxy(apiKey),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Proxy startup timed out")), PROXY_START_TIMEOUT_MS),
      ),
    ]);
    const newBaseUrl = `http://127.0.0.1:${port}/v1`;
    updateConfigBaseUrl(newBaseUrl);
    return true;
  } catch (err) {
    console.error(
      `[abacusai] Proxy startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Clean up any partially started server
    await stopProxy();
    return false;
  }
}

// ---------------------------------------------------------------------------
// AbacusAI API helpers
// ---------------------------------------------------------------------------

async function validateApiKey(
  apiKey: string,
): Promise<{ valid: boolean; email?: string; error?: string }> {
  try {
    const r = await fetch(`${ABACUS_API}/describeUser`, {
      method: "GET",
      headers: { apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return { valid: false, error: r.status === 403 ? "Invalid API key" : `HTTP ${r.status}` };
    }
    const d = (await r.json()) as { success?: boolean; result?: { email?: string } };
    if (!d.success) {
      return { valid: false, error: "API returned unsuccessful response" };
    }
    return { valid: true, email: d.result?.email?.trim() };
  } catch (err) {
    return {
      valid: false,
      error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Embedded RouteLLM forwarding proxy
//
// Transparently forwards OpenAI-compatible requests to AbacusAI's RouteLLM
// endpoint, applying minimal fixups:
//   1. Injects the Authorization header with the user's API key.
//   2. Strips the `strict` field from tool schemas (RouteLLM rejects it).
// This preserves full OpenAI function-calling support for the Agent.
// ---------------------------------------------------------------------------

type ProxyState = {
  server: ReturnType<typeof createServer> | null;
  port: number;
  apiKey: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const proxyState: ProxyState = {
  server: null,
  port: 0,
  apiKey: "",
  idleTimer: null,
};

function resetIdleTimer() {
  if (proxyState.idleTimer) {
    clearTimeout(proxyState.idleTimer);
  }
  proxyState.idleTimer = setTimeout(() => stopProxy(), PROXY_IDLE_TIMEOUT_MS);
}

function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (proxyState.idleTimer) {
      clearTimeout(proxyState.idleTimer);
      proxyState.idleTimer = null;
    }
    const server = proxyState.server;
    if (!server) {
      resolve();
      return;
    }
    proxyState.server = null;
    proxyState.port = 0;
    // Force-close all open connections to prevent process hang
    server.closeAllConnections?.();
    server.close(() => resolve());
    // Safety: resolve after 2s even if close callback never fires
    setTimeout(resolve, 2000);
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (c: Buffer) => {
      totalBytes += c.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

/** Strip `strict` from tool schemas — RouteLLM rejects this OpenAI-specific field. */
function stripStrictFromTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== "object") {
      return t;
    }
    const copy = { ...(t as Record<string, unknown>) };
    delete copy.strict;
    if (copy.function && typeof copy.function === "object") {
      copy.function = { ...(copy.function as Record<string, unknown>) };
      delete (copy.function as Record<string, unknown>).strict;
    }
    return copy;
  });
}

/**
 * Normalize finish_reason from provider-specific values to OpenAI standard.
 * RouteLLM returns Anthropic-style values for Claude models (tool_use,
 * stop_sequence, end_turn) which pi-agent does not recognize.
 */
const FINISH_REASON_MAP: Record<string, string> = {
  tool_use: "tool_calls",
  stop_sequence: "stop",
  end_turn: "stop",
};

function normalizeFinishReason(reason: unknown): string | null {
  if (reason === null || reason === undefined) {
    return null;
  }
  const s = String(reason);
  return FINISH_REASON_MAP[s] ?? s;
}

/** Normalize a single SSE chunk's choices[].finish_reason and strip native_finish_reason. */
function normalizeChunk(parsed: Record<string, unknown>): Record<string, unknown> {
  const choices = parsed.choices;
  if (!Array.isArray(choices)) {
    return parsed;
  }
  parsed.choices = choices.map((c: Record<string, unknown>) => {
    const copy = { ...c };
    if ("finish_reason" in copy) {
      copy.finish_reason = normalizeFinishReason(copy.finish_reason);
    }
    delete copy.native_finish_reason;
    return copy;
  });
  return parsed;
}

/**
 * Normalize a single SSE event payload string. If it's JSON, normalize
 * finish_reason and strip native_finish_reason. Otherwise return as-is.
 */
function normalizeSsePayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) {
    return payload;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return JSON.stringify(normalizeChunk(parsed));
  } catch {
    return payload;
  }
}

/**
 * Creates an SSE normalizer that handles RouteLLM's streaming format.
 *
 * RouteLLM may send SSE events in two ways:
 *   1. Standard: `data: {...}\n\ndata: {...}\n\n` (newline-delimited)
 *   2. Non-standard: each `data: {...}` as a separate TCP chunk with NO
 *      trailing newlines between them.
 *
 * Strategy: buffer incoming text. Extract complete events by looking for
 * balanced JSON objects after `data: ` prefixes. Emit each as a properly
 * framed SSE event (`data: ...\n\n`).
 */
function createSseNormalizer() {
  let buf = "";

  function emitEvent(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed === "data: [DONE]") {
      return "data: [DONE]\n\n";
    }
    if (trimmed.startsWith("data: ")) {
      return `data: ${normalizeSsePayload(trimmed.slice(6))}\n\n`;
    }
    return "";
  }

  function drainComplete(): string {
    let out = "";
    // Split on `data: ` boundaries. Each occurrence starts a new event.
    // We look for `data: ` at the start or after whitespace/newlines.
    for (;;) {
      // Find the start of a data event
      const match = buf.match(/^[\s\n]*(data: )/);
      if (!match) {
        // No data prefix found — discard non-event whitespace
        buf = buf.replace(/^[\s\n]+/, "");
        break;
      }
      const prefixEnd = match.index! + match[0].length;
      const afterPrefix = buf.slice(prefixEnd);

      // Special case: [DONE]
      if (afterPrefix.startsWith("[DONE]")) {
        out += "data: [DONE]\n\n";
        buf = buf.slice(prefixEnd + 6).replace(/^[\s\n]+/, "");
        continue;
      }

      // Find the end of the JSON object by counting braces
      if (!afterPrefix.startsWith("{")) {
        // Not JSON — might be incomplete, keep buffering
        break;
      }
      let depth = 0;
      let inStr = false;
      let escaped = false;
      let jsonEnd = -1;
      for (let i = 0; i < afterPrefix.length; i++) {
        const ch = afterPrefix[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (inStr) {
          continue;
        }
        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = i;
            break;
          }
        }
      }
      if (jsonEnd < 0) {
        // Incomplete JSON — keep buffering
        break;
      }
      const jsonStr = afterPrefix.slice(0, jsonEnd + 1);
      out += `data: ${normalizeSsePayload(jsonStr)}\n\n`;
      buf = buf.slice(prefixEnd + jsonEnd + 1).replace(/^[\s\n]+/, "");
    }
    return out;
  }

  return {
    feed(chunk: string): string {
      buf += chunk;
      return drainComplete();
    },
    flush(): string {
      const out = drainComplete();
      // Emit anything remaining as a final event
      const remaining = emitEvent(buf);
      buf = "";
      return out + remaining;
    },
  };
}

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  resetIdleTimer();

  // No CORS headers: the proxy is loopback-only (127.0.0.1) and called
  // exclusively by the local OpenClaw gateway, never by browsers.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Build upstream URL: strip leading /v1 since ROUTELLM_BASE already ends with /v1
  const path = (req.url ?? "/").replace(/^\/v1/, "");
  const target = `${ROUTELLM_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${proxyState.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    let body: string | undefined;
    if (req.method === "POST") {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (Array.isArray(parsed.tools)) {
        parsed.tools = stripStrictFromTools(parsed.tools);
      }
      body = JSON.stringify(parsed);
    }

    const upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers: body ? headers : { Authorization: headers.Authorization },
      body: body ?? undefined,
      signal: AbortSignal.timeout(180_000),
    });

    // Detect expired/revoked API key at runtime
    if (upstream.status === 401 || upstream.status === 403) {
      const errBody = await upstream.text().catch(() => "");
      console.error(
        `[abacusai] Upstream returned ${upstream.status} — API key may be expired or revoked. ` +
          `Run \`openclaw models auth login --provider abacusai\` to re-authenticate.`,
      );
      sendJsonResponse(res, upstream.status, {
        error: {
          message:
            `AbacusAI API key expired or invalid (HTTP ${upstream.status}). ` +
            `Run \`openclaw models auth login --provider abacusai\` to re-authenticate.`,
          type: "auth_expired",
          upstream_body: errBody.slice(0, 500),
        },
      });
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "application/json";

    if (ct.includes("text/event-stream") && upstream.body) {
      res.writeHead(upstream.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const normalizer = createSseNormalizer();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = normalizer.flush();
            if (tail) {
              res.write(tail);
            }
            res.end();
            return;
          }
          const raw = decoder.decode(value, { stream: true });
          res.write(normalizer.feed(raw));
        }
      };
      pump().catch(() => res.end());
    } else {
      const data = await upstream.text();
      // Normalize finish_reason in non-streaming JSON responses too
      let normalized = data;
      if (ct.includes("application/json")) {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          normalized = JSON.stringify(normalizeChunk(parsed));
        } catch {
          /* pass through as-is */
        }
      }
      res.writeHead(upstream.status, {
        "Content-Type": ct,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(normalized);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJsonResponse(res, 502, {
      error: { message: `AbacusAI proxy error: ${message}`, type: "api_error" },
    });
  }
}

async function startProxy(apiKey: string): Promise<number> {
  if (proxyState.server) {
    return proxyState.port;
  }

  proxyState.apiKey = apiKey;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleProxyRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendJsonResponse(res, 500, { error: { message: String(err), type: "api_error" } });
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      proxyState.server = server;
      proxyState.port = port;
      resetIdleTimer();
      resolve(port);
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModelIds(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  );
}

function buildModelDefinition(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const abacusaiPlugin = {
  id: "abacusai-auth",
  name: "AbacusAI Auth",
  description: "AbacusAI provider plugin with embedded OpenAI-compatible proxy",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    // Helper: check if abacusai provider is configured with a local proxy URL
    function isAbacusaiProxyConfigured(): boolean {
      const cfg = api.config;
      const abacusCfg = cfg?.models?.providers?.abacusai as { baseUrl?: string } | undefined;
      if (!abacusCfg?.baseUrl) {
        return false;
      }
      return abacusCfg.baseUrl.includes("127.0.0.1");
    }

    // Eagerly start the proxy when the plugin is loaded (i.e. when the
    // gateway starts and loads plugins). Fire-and-forget so we don't block
    // plugin registration.
    if (isAbacusaiProxyConfigured()) {
      ensureProxy()
        .then((ok) => {
          if (ok) {
            api.logger.info(`AbacusAI RouteLLM proxy started on port ${proxyState.port}`);
          }
        })
        .catch((err) => {
          api.logger.error(`AbacusAI proxy auto-start failed: ${String(err)}`);
        });
    }

    // Safety net: also check before each agent call in case the proxy was
    // stopped by idle timeout or an unexpected error after initial start.
    api.on("before_agent_start", async () => {
      if (!isAbacusaiProxyConfigured()) {
        return;
      }
      await ensureProxy();
    });

    api.registerProvider({
      id: "abacusai",
      label: "AbacusAI",
      docsPath: "/providers/models",
      aliases: ["abacus", "abacus-ai", "abacusai-code-mode"],
      envVars: ["ABACUSAI_API_KEY"],
      auth: [
        {
          id: "api-key",
          label: "AbacusAI API key",
          hint: "Enter your AbacusAI API key or auto-detect from Code Mode",
          kind: "custom",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Setting up AbacusAI…");

            try {
              // --- Credential resolution (3-tier) ---
              const localKey = tryReadLocalCredential();
              let apiKey = "";

              if (localKey) {
                spin.update("Found local AbacusAI credentials…");
                const useLocal = await ctx.prompter.confirm({
                  message: `Found AbacusAI credentials locally (${localKey.slice(0, 8)}…). Use them?`,
                  initialValue: true,
                });
                if (useLocal) {
                  apiKey = localKey;
                }
              }

              if (!apiKey) {
                const envKey = process.env.ABACUSAI_API_KEY?.trim();
                if (envKey) {
                  spin.update("Found ABACUSAI_API_KEY environment variable…");
                  const useEnv = await ctx.prompter.confirm({
                    message: "Found ABACUSAI_API_KEY in environment. Use it?",
                    initialValue: true,
                  });
                  if (useEnv) {
                    apiKey = envKey;
                  }
                }
              }

              if (!apiKey) {
                const input = await ctx.prompter.text({
                  message: "AbacusAI API key",
                  placeholder: "Paste your API key from https://abacus.ai/app/profile/apikey",
                  validate: (value) => {
                    const t = value.trim();
                    if (!t) {
                      return "API key is required";
                    }
                    if (t.length < 10) {
                      return "API key looks too short";
                    }
                    return undefined;
                  },
                });
                apiKey = String(input).trim();
              }

              if (!apiKey) {
                throw new Error("No API key provided");
              }

              // --- Validate ---
              spin.update("Validating API key…");
              const validation = await validateApiKey(apiKey);
              if (!validation.valid) {
                spin.stop("API key validation failed");
                const saveAnyway = await ctx.prompter.confirm({
                  message: `Validation failed: ${validation.error}\nSave this key anyway? (You can re-authenticate later)`,
                  initialValue: false,
                });
                if (!saveAnyway) {
                  throw new Error("Aborted: API key validation failed");
                }
              }

              // --- Model selection ---
              const modelInput = await ctx.prompter.text({
                message: "Model IDs (comma-separated)",
                initialValue: DEFAULT_MODEL_IDS.join(", "),
                validate: (v) =>
                  parseModelIds(v).length > 0 ? undefined : "Enter at least one model id",
              });
              const modelIds = parseModelIds(modelInput);
              const defaultModelId = modelIds[0] ?? DEFAULT_MODEL_IDS[0];
              const defaultModelRef = `abacusai/${defaultModelId}`;

              // Write a placeholder baseUrl — the proxy will be started
              // automatically by the before_agent_start hook when the gateway
              // runs. We do NOT start the proxy here because the HTTP server
              // would keep the CLI process alive after login completes.
              const proxyBaseUrl = `http://127.0.0.1:0/v1`;

              const profileId = `abacusai:${validation.email ?? "default"}`;
              spin.stop("AbacusAI configured");

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "token",
                      provider: "abacusai",
                      token: apiKey,
                      ...(validation.email ? { email: validation.email } : {}),
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      abacusai: {
                        baseUrl: proxyBaseUrl,
                        apiKey: "abacusai-proxy",
                        api: "openai-completions",
                        authHeader: false,
                        models: modelIds.map((id) => buildModelDefinition(id)),
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: Object.fromEntries(modelIds.map((id) => [`abacusai/${id}`, {}])),
                    },
                  },
                },
                defaultModel: defaultModelRef,
                notes: [
                  "AbacusAI RouteLLM proxy will start automatically when the gateway runs.",
                  "The proxy forwards to RouteLLM with strict-field stripping for tool compatibility.",
                  "Full OpenAI function-calling support is enabled.",
                  "Manage your API keys at https://abacus.ai/app/profile/apikey",
                ],
              };
            } catch (err) {
              spin.stop("AbacusAI setup failed");
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default abacusaiPlugin;
