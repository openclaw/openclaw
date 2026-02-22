import { join, parse } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { GeminiCliOAuthContext } from "./oauth.js";

vi.mock("openclaw/plugin-sdk", () => ({
  isWSL2Sync: () => false,
}));

// Mock fs module before importing the module under test
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockRealpathSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => mockExistsSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => mockReadFileSync(...args),
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => mockRealpathSync(...args),
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => mockReaddirSync(...args),
  };
});

describe("extractGeminiCliCredentials", () => {
  const normalizePath = (value: string) =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rootDir = parse(process.cwd()).root || "/";
  const FAKE_CLIENT_ID = "123456789-abcdef.apps.googleusercontent.com";
  const FAKE_CLIENT_SECRET = "GOCSPX-FakeSecretValue123";
  const FAKE_OAUTH2_CONTENT = `
    const clientId = "${FAKE_CLIENT_ID}";
    const clientSecret = "${FAKE_CLIENT_SECRET}";
  `;

  let originalPath: string | undefined;

  function makeFakeLayout() {
    const binDir = join(rootDir, "fake", "bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "dist",
      "index.js",
    );
    const oauth2Path = join(
      rootDir,
      "fake",
      "lib",
      "node_modules",
      "@google",
      "gemini-cli",
      "node_modules",
      "@google",
      "gemini-cli-core",
      "dist",
      "src",
      "code_assist",
      "oauth2.js",
    );

    return { binDir, geminiPath, resolvedPath, oauth2Path };
  }

  function installGeminiLayout(params: {
    oauth2Exists?: boolean;
    oauth2Content?: string;
    readdir?: string[];
  }) {
    const layout = makeFakeLayout();
    process.env.PATH = layout.binDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(layout.geminiPath)) {
        return true;
      }
      if (params.oauth2Exists && normalized === normalizePath(layout.oauth2Path)) {
        return true;
      }
      return false;
    });
    mockRealpathSync.mockReturnValue(layout.resolvedPath);
    if (params.oauth2Content !== undefined) {
      mockReadFileSync.mockReturnValue(params.oauth2Content);
    }
    if (params.readdir) {
      mockReaddirSync.mockReturnValue(params.readdir);
    }

    return layout;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns null when gemini binary is not in PATH", async () => {
    process.env.PATH = "/nonexistent";
    mockExistsSync.mockReturnValue(false);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("extracts credentials from oauth2.js in known path", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expect(result).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
    });
  });

  it("returns null when oauth2.js cannot be found", async () => {
    installGeminiLayout({ oauth2Exists: false, readdir: [] });

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("returns null when oauth2.js lacks credentials", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: "// no credentials here" });

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("caches credentials after first extraction", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();

    // First call
    const result1 = extractGeminiCliCredentials();
    expect(result1).not.toBeNull();

    // Second call should use cache (readFileSync not called again)
    const readCount = mockReadFileSync.mock.calls.length;
    const result2 = extractGeminiCliCredentials();
    expect(result2).toEqual(result1);
    expect(mockReadFileSync.mock.calls.length).toBe(readCount);
  });
});

describe("loginGeminiCliOAuth cross-process PKCE fallback", () => {
  const FAKE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  const FAKE_CLIENT_SECRET = "GOCSPX-TestSecret";
  const FAKE_ACCESS_TOKEN = "ya29.test-access-token";
  const FAKE_REFRESH_TOKEN = "1//test-refresh-token";
  const FAKE_PROJECT_ID = "test-project-123";

  let savedEnv: Record<string, string | undefined>;

  function makeCtx(promptResponse: string): GeminiCliOAuthContext & { logs: string[] } {
    const logs: string[] = [];
    return {
      isRemote: true,
      openUrl: vi.fn(),
      log: (msg: string) => logs.push(msg),
      note: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(promptResponse),
      progress: { update: vi.fn(), stop: vi.fn() },
      logs,
    };
  }

  function mockTokenExchangeFetch() {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("oauth2.googleapis.com/token")) {
          calls.push({ url: urlStr, body: String(init?.body ?? "") });
          return new Response(
            JSON.stringify({
              access_token: FAKE_ACCESS_TOKEN,
              refresh_token: FAKE_REFRESH_TOKEN,
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("googleapis.com/oauth2/v1/userinfo")) {
          return new Response(JSON.stringify({ email: "test@example.com" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("loadCodeAssist") || urlStr.includes("onboardUser")) {
          return new Response(
            JSON.stringify({
              currentTier: { id: "free-tier" },
              cloudaicompanionProject: FAKE_PROJECT_ID,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      }),
    );
    return calls;
  }

  function extractVerifierFromAuthUrl(logs: string[]): string {
    const urlLog = logs.find((l) => l.includes("accounts.google.com"));
    if (!urlLog) throw new Error("Auth URL not found in logs");
    const match = urlLog.match(/https:\/\/accounts\.google\.com[^\s]+/);
    if (!match) throw new Error("Could not parse auth URL from log");
    const url = new URL(match[0]);
    const state = url.searchParams.get("state");
    if (!state) throw new Error("No state parameter in auth URL");
    return state;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = {
      OPENCLAW_GEMINI_OAUTH_CLIENT_ID: process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID,
      OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET: process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    };
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID = FAKE_CLIENT_ID;
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET = FAKE_CLIENT_SECRET;
    process.env.GOOGLE_CLOUD_PROJECT = FAKE_PROJECT_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses local verifier when state matches (same-process flow)", async () => {
    const fetchCalls = mockTokenExchangeFetch();
    // We need to capture the verifier from the auth URL, then construct a matching callback
    const ctx = makeCtx("PLACEHOLDER");
    // Override prompt to build the correct callback URL after we see the auth URL
    let authUrlVerifier: string | undefined;
    ctx.log = (msg: string) => {
      ctx.logs.push(msg);
      if (msg.includes("accounts.google.com") && !authUrlVerifier) {
        authUrlVerifier = extractVerifierFromAuthUrl([msg]);
        // Now set prompt to return a URL with the SAME state (same-process scenario)
        (ctx.prompt as ReturnType<typeof vi.fn>).mockResolvedValue(
          `http://localhost:8085/oauth2callback?code=test-auth-code&state=${authUrlVerifier}`,
        );
      }
    };

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const result = await loginGeminiCliOAuth(ctx);

    expect(result.access).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refresh).toBe(FAKE_REFRESH_TOKEN);

    // Verify the token exchange used the local verifier
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const tokenCall = fetchCalls[0];
    const params = new URLSearchParams(tokenCall.body);
    expect(params.get("code_verifier")).toBe(authUrlVerifier);
    // No cross-process log message should appear
    expect(ctx.logs.some((l) => l.includes("cross-process"))).toBe(false);
  });

  it("falls back to parsed.state when state mismatches (cross-process flow)", async () => {
    const FOREIGN_VERIFIER = "foreign-verifier-from-another-process-run-abc123";
    const fetchCalls = mockTokenExchangeFetch();

    // Simulate pasting a redirect URL from a different CLI run with a foreign state
    const ctx = makeCtx(
      `http://localhost:8085/oauth2callback?code=test-auth-code&state=${FOREIGN_VERIFIER}`,
    );

    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const result = await loginGeminiCliOAuth(ctx);

    expect(result.access).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refresh).toBe(FAKE_REFRESH_TOKEN);

    // Verify the token exchange used the FOREIGN verifier (from parsed.state)
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    const tokenCall = fetchCalls[0];
    const params = new URLSearchParams(tokenCall.body);
    expect(params.get("code_verifier")).toBe(FOREIGN_VERIFIER);
    // Cross-process log message should appear
    expect(ctx.logs.some((l) => l.includes("cross-process"))).toBe(true);
  });
});
