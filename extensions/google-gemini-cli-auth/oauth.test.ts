import { join, parse } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  isWSL2Sync: () => false,
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  }) => {
    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(params.url, params.init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {},
    };
  },
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

  function installNpmShimLayout(params: { oauth2Exists?: boolean; oauth2Content?: string }) {
    const binDir = join(rootDir, "fake", "npm-bin");
    const geminiPath = join(binDir, "gemini");
    const resolvedPath = geminiPath;
    const oauth2Path = join(
      binDir,
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
    process.env.PATH = binDir;

    mockExistsSync.mockImplementation((p: string) => {
      const normalized = normalizePath(p);
      if (normalized === normalizePath(geminiPath)) {
        return true;
      }
      if (params.oauth2Exists && normalized === normalizePath(oauth2Path)) {
        return true;
      }
      return false;
    });
    mockRealpathSync.mockReturnValue(resolvedPath);
    if (params.oauth2Content !== undefined) {
      mockReadFileSync.mockReturnValue(params.oauth2Content);
    }
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

  it("extracts credentials when PATH entry is an npm global shim", async () => {
    installNpmShimLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });

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

describe("loginGeminiCliOAuth", () => {
  const TOKEN_URL = "https://oauth2.googleapis.com/token";
  const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
  const LOAD_PROD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
  const LOAD_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";
  const LOAD_AUTOPUSH =
    "https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist";

  const ENV_KEYS = [
    "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
    "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
    "GEMINI_CLI_OAUTH_CLIENT_ID",
    "GEMINI_CLI_OAUTH_CLIENT_SECRET",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
  ] as const;

  function getExpectedPlatform(): "WINDOWS" | "MACOS" | "LINUX" {
    if (process.platform === "win32") {
      return "WINDOWS";
    }
    if (process.platform === "linux") {
      return "LINUX";
    }
    return "MACOS";
  }

  function getRequestUrl(input: string | URL | Request): string {
    return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  }

  function getHeaderValue(headers: HeadersInit | undefined, name: string): string | undefined {
    if (!headers) {
      return undefined;
    }
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    if (Array.isArray(headers)) {
      return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    }
    return (headers as Record<string, string>)[name];
  }

  function responseJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET = "GOCSPX-test-client-secret";
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_ID;
    delete process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.unstubAllGlobals();
  });

  it("falls back across loadCodeAssist endpoints with aligned headers and metadata", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = getRequestUrl(input);
      requests.push({ url, init });

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      if (url === LOAD_PROD) {
        return responseJson({ error: { message: "temporary failure" } }, 503);
      }
      if (url === LOAD_DAILY) {
        return responseJson({
          currentTier: { id: "standard-tier" },
          cloudaicompanionProject: { id: "daily-project" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let authUrl = "";
    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const result = await loginGeminiCliOAuth({
      isRemote: true,
      openUrl: async () => {},
      log: (msg) => {
        const found = msg.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/);
        if (found?.[0]) {
          authUrl = found[0];
        }
      },
      note: async () => {},
      prompt: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `${"http://localhost:8085/oauth2callback"}?code=oauth-code&state=${state}`;
      },
      progress: { update: () => {}, stop: () => {} },
    });

    expect(result.projectId).toBe("daily-project");
    const loadRequests = requests.filter((request) =>
      request.url.includes("v1internal:loadCodeAssist"),
    );
    expect(loadRequests.map((request) => request.url)).toEqual([LOAD_PROD, LOAD_DAILY]);

    const firstHeaders = loadRequests[0]?.init?.headers;
    expect(getHeaderValue(firstHeaders, "X-Goog-Api-Client")).toBe(
      `gl-node/${process.versions.node}`,
    );

    const clientMetadata = getHeaderValue(firstHeaders, "Client-Metadata");
    expect(clientMetadata).toBeDefined();
    expect(JSON.parse(clientMetadata as string)).toEqual({
      ideType: "ANTIGRAVITY",
      platform: getExpectedPlatform(),
      pluginType: "GEMINI",
    });

    const body = JSON.parse(String(loadRequests[0]?.init?.body));
    expect(body).toEqual({
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: getExpectedPlatform(),
        pluginType: "GEMINI",
      },
    });
  });

  it("falls back to GOOGLE_CLOUD_PROJECT when all loadCodeAssist endpoints fail", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "env-project";

    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = getRequestUrl(input);
      requests.push(url);

      if (url === TOKEN_URL) {
        return responseJson({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      if (url === USERINFO_URL) {
        return responseJson({ email: "lobster@openclaw.ai" });
      }
      if ([LOAD_PROD, LOAD_DAILY, LOAD_AUTOPUSH].includes(url)) {
        return responseJson({ error: { message: "unavailable" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let authUrl = "";
    const { loginGeminiCliOAuth } = await import("./oauth.js");
    const result = await loginGeminiCliOAuth({
      isRemote: true,
      openUrl: async () => {},
      log: (msg) => {
        const found = msg.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+/);
        if (found?.[0]) {
          authUrl = found[0];
        }
      },
      note: async () => {},
      prompt: async () => {
        const state = new URL(authUrl).searchParams.get("state");
        return `${"http://localhost:8085/oauth2callback"}?code=oauth-code&state=${state}`;
      },
      progress: { update: () => {}, stop: () => {} },
    });

    expect(result.projectId).toBe("env-project");
    expect(requests.filter((url) => url.includes("v1internal:loadCodeAssist"))).toHaveLength(3);
    expect(requests.some((url) => url.includes("v1internal:onboardUser"))).toBe(false);
  });
});
