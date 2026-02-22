import { join, parse } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockExistsSync, mockReadFileSync, mockRealpathSync, mockReaddirSync } = vi.hoisted(() => {
  return {
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockRealpathSync: vi.fn(),
    mockReaddirSync: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk", () => ({
  isWSL2Sync: () => false,
}));

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
    const OAUTH_CLIENT_ID = "${FAKE_CLIENT_ID}";
    const OAUTH_CLIENT_SECRET = "${FAKE_CLIENT_SECRET}";
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

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    originalPath = process.env.PATH;
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns null when oauth2.js cannot be found and GitHub fetch fails", async () => {
    installGeminiLayout({ oauth2Exists: false, readdir: [] });
    fetchSpy.mockResolvedValue({ ok: false } as Response);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();

    const result = await extractGeminiCliCredentials();

    expect(result).toBeNull();
  });

  it("returns credentials from GitHub when local oauth2.js lacks credentials", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: "// no credentials here" });
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          `const OAUTH_CLIENT_ID = "${FAKE_CLIENT_ID}";\nconst OAUTH_CLIENT_SECRET = "${FAKE_CLIENT_SECRET}";`,
        ),
    } as unknown as Response);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    const result = await extractGeminiCliCredentials();
    expect(result).not.toBeNull();
    expect(result?.clientId).toBe(FAKE_CLIENT_ID);
    expect(result?.clientSecret).toBe(FAKE_CLIENT_SECRET);
  });

  it("caches credentials after first extraction", async () => {
    installGeminiLayout({ oauth2Exists: true, oauth2Content: FAKE_OAUTH2_CONTENT });
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("// empty"),
    } as unknown as Response);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();

    const result1 = await extractGeminiCliCredentials();
    expect(result1).not.toBeNull();

    const readCount = mockReadFileSync.mock.calls.length;
    const result2 = await extractGeminiCliCredentials();
    expect(result2).toEqual(result1);
    expect(mockReadFileSync.mock.calls.length).toBe(readCount);
  });
});
