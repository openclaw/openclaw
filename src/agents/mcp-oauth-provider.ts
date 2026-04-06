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

function toSafeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
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
export function createMcpOAuthProvider(options: McpOAuthProviderOptions): OAuthClientProvider {
  let state: McpOAuthPersistedState = {};
  let stateLoaded = false;

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

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<html><body><h1>Authorization successful</h1>" +
          "<p>You can close this tab and return to OpenClaw.</p></body></html>",
      );
      finish(code);
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
