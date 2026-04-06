import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { openUrl } from "../infra/browser-open.js";
import { logDebug, logWarn } from "../logger.js";

/** Per-server OAuth state persisted to disk between sessions. */
export type McpOAuthPersistedState = {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationFull;
  discoveryState?: OAuthDiscoveryState;
  codeVerifier?: string;
  csrfState?: string;
};

export type McpOAuthProviderOptions = {
  /** Human-readable server name, used for log messages. */
  serverName: string;
  /** Load persisted OAuth state (tokens, client info, code verifier). */
  loadState: () => McpOAuthPersistedState | undefined | Promise<McpOAuthPersistedState | undefined>;
  /** Save persisted OAuth state. */
  saveState: (state: McpOAuthPersistedState) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Per-server OAuth state persistence
// ---------------------------------------------------------------------------

export type McpOAuthProvider = OAuthClientProvider & {
  getExpectedState: () => Promise<string | undefined>;
  waitForAuthorizationCode: () => Promise<string>;
};

function toSafeFilename(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${safe}_${hash}`;
}

function mcpOAuthStateDir(): string {
  return join(homedir(), ".openclaw", "mcp-auth");
}

function mcpOAuthStatePath(serverName: string): string {
  return join(mcpOAuthStateDir(), `${toSafeFilename(serverName)}.json`);
}

export function loadMcpOAuthState(serverName: string): McpOAuthPersistedState | undefined {
  const filePath = mcpOAuthStatePath(serverName);
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    return JSON.parse(readFileSync(filePath, "utf-8")) as McpOAuthPersistedState;
  } catch {
    return undefined;
  }
}

export function saveMcpOAuthState(serverName: string, state: McpOAuthPersistedState): void {
  const dir = mcpOAuthStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(mcpOAuthStatePath(serverName), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// OAuth provider + callback server
// ---------------------------------------------------------------------------

const CALLBACK_PORT = 8093;
const CALLBACK_PATH = "/mcp/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

/**
 * OAuthClientProvider implementation for remote MCP servers.
 *
 * Bridges the MCP SDK's OAuth flow to OpenClaw's persistence layer and
 * handles the browser redirect + local callback server pattern.
 */
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): McpOAuthProvider {
  let state: McpOAuthPersistedState = {};
  let stateLoaded = false;
  let pendingAuthorizationCode:
    | {
        promise: Promise<string>;
      }
    | undefined;

  async function ensureState(): Promise<McpOAuthPersistedState> {
    if (!stateLoaded) {
      state = (await options.loadState()) ?? {};
      stateLoaded = true;
    }
    return state;
  }

  async function persistState(): Promise<void> {
    await options.saveState(state);
  }

  return {
    get redirectUrl(): string {
      return REDIRECT_URI;
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "OpenClaw",
      };
    },

    async state(): Promise<string> {
      await ensureState();
      const csrfState = randomUUID();
      state.csrfState = csrfState;
      await persistState();
      return csrfState;
    },

    async clientInformation() {
      const s = await ensureState();
      return s.clientInfo;
    },

    async saveClientInformation(clientInfo: OAuthClientInformationMixed) {
      state.clientInfo = clientInfo as OAuthClientInformationFull;
      await persistState();
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const s = await ensureState();
      return s.tokens;
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      state.tokens = tokens;
      await persistState();
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      pendingAuthorizationCode ??= {
        promise: waitForOAuthCallback({
          serverName: options.serverName,
          getExpectedState: async () => (await ensureState()).csrfState,
        }).finally(() => {
          pendingAuthorizationCode = undefined;
        }),
      };
      const opened = await openUrl(authorizationUrl.toString());
      if (opened) {
        logDebug(`bundle-mcp: "${options.serverName}": opened browser for OAuth authorization`);
      } else {
        // Headless fallback: log the URL for manual copy-paste.
        logWarn(
          `bundle-mcp: "${options.serverName}": unable to open browser. ` +
            `Visit this URL to authorize:\n  ${authorizationUrl.toString()}`,
        );
      }
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      state.codeVerifier = codeVerifier;
      await persistState();
    },

    async codeVerifier(): Promise<string> {
      const s = await ensureState();
      if (!s.codeVerifier) {
        throw new Error("No code verifier saved for MCP OAuth flow");
      }
      return s.codeVerifier;
    },

    async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
      state.discoveryState = discoveryState;
      await persistState();
    },

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
      const s = await ensureState();
      return s.discoveryState;
    },

    async getExpectedState(): Promise<string | undefined> {
      const s = await ensureState();
      return s.csrfState;
    },

    async waitForAuthorizationCode(): Promise<string> {
      if (!pendingAuthorizationCode) {
        throw new Error(`MCP OAuth authorization was not started for "${options.serverName}"`);
      }
      return await pendingAuthorizationCode.promise;
    },
  };
}

/**
 * Start a local HTTP server to receive the OAuth callback redirect.
 *
 * Returns a promise that resolves with the authorization code when the
 * callback is received, or rejects on timeout or error.
 */
export function waitForOAuthCallback(params: {
  serverName: string;
  timeoutMs?: number;
  getExpectedState?: () => string | undefined | Promise<string | undefined>;
}): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 120_000;

  return new Promise<string>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let server: Server | null = null;

    function finish(result: string | Error) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (server) {
        server.close();
        server = null;
      }
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    }

    server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code")?.trim();
      const returnedState = requestUrl.searchParams.get("state")?.trim();

      if (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain");
        res.end(`Authentication failed: ${error}`);
        finish(new Error(`MCP OAuth error for "${params.serverName}": ${error}`));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain");
        res.end("Missing authorization code");
        finish(new Error(`MCP OAuth callback for "${params.serverName}" missing code`));
        return;
      }

      Promise.resolve(params.getExpectedState?.())
        .then((expectedState) => {
          if (expectedState && returnedState !== expectedState) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain");
            res.end("OAuth state mismatch");
            finish(
              new Error(`MCP OAuth callback for "${params.serverName}" failed state validation`),
            );
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(
            "<html><body><h1>Authorization successful</h1>" +
              "<p>You can close this tab and return to OpenClaw.</p></body></html>",
          );
          finish(code);
        })
        .catch((error) => {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
          res.end("OAuth state validation failed");
          finish(
            error instanceof Error
              ? error
              : new Error(`MCP OAuth callback state validation failed: ${String(error)}`),
          );
        });
    });

    server.on("error", (err) => {
      finish(
        new Error(`MCP OAuth callback server error for "${params.serverName}": ${err.message}`),
      );
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      logDebug(
        `bundle-mcp: "${params.serverName}": OAuth callback server listening on ${REDIRECT_URI}`,
      );
    });

    timeout = setTimeout(() => {
      finish(
        new Error(
          `MCP OAuth authorization timed out for "${params.serverName}" after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
}
