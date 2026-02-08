import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the openclaw/plugin-sdk module
const mockResolveToolPackageFile = vi.fn();
vi.mock("openclaw/plugin-sdk", () => ({
  resolveToolPackageFile: (...args: unknown[]) => mockResolveToolPackageFile(...args),
}));

// Mock readFileSync from node:fs
const mockReadFileSync = vi.fn();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => mockReadFileSync(...args),
  };
});

describe("extractGeminiCliCredentials", () => {
  const FAKE_CLIENT_ID = "123456789-abcdef.apps.googleusercontent.com";
  const FAKE_CLIENT_SECRET = "GOCSPX-FakeSecretValue123";
  const FAKE_OAUTH2_CONTENT = `
    const clientId = "${FAKE_CLIENT_ID}";
    const clientSecret = "${FAKE_CLIENT_SECRET}";
  `;
  const FAKE_RESOLVED_PATH = "/mock/path/to/oauth2.js";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns null when resolveToolPackageFile returns null", async () => {
    mockResolveToolPackageFile.mockReturnValue(null);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("extracts credentials when file is resolved", async () => {
    mockResolveToolPackageFile.mockReturnValue(FAKE_RESOLVED_PATH);
    mockReadFileSync.mockReturnValue(FAKE_OAUTH2_CONTENT);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    const result = extractGeminiCliCredentials();

    expect(result).toEqual({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
    });
    expect(mockResolveToolPackageFile).toHaveBeenCalledWith(
      "gemini",
      "@google/gemini-cli-core",
      expect.stringMatching(/oauth2\.js$/), // Matches both possible paths
      "@google/gemini-cli",
    );
    expect(mockReadFileSync).toHaveBeenCalledWith(FAKE_RESOLVED_PATH, "utf8");
  });

  it("returns null when file read fails", async () => {
    mockResolveToolPackageFile.mockReturnValue(FAKE_RESOLVED_PATH);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("File not found");
    });

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("returns null when file content lacks credentials", async () => {
    mockResolveToolPackageFile.mockReturnValue(FAKE_RESOLVED_PATH);
    mockReadFileSync.mockReturnValue("// no credentials here");

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();
    expect(extractGeminiCliCredentials()).toBeNull();
  });

  it("caches credentials after first extraction", async () => {
    mockResolveToolPackageFile.mockReturnValue(FAKE_RESOLVED_PATH);
    mockReadFileSync.mockReturnValue(FAKE_OAUTH2_CONTENT);

    const { extractGeminiCliCredentials, clearCredentialsCache } = await import("./oauth.js");
    clearCredentialsCache();

    // First call
    const result1 = extractGeminiCliCredentials();
    expect(result1).not.toBeNull();

    // Second call should use cache (resolveToolPackageFile and readFileSync not called again)
    const resolveCount = mockResolveToolPackageFile.mock.calls.length;
    const readCount = mockReadFileSync.mock.calls.length;

    const result2 = extractGeminiCliCredentials();
    expect(result2).toEqual(result1);
    expect(mockResolveToolPackageFile.mock.calls.length).toBe(resolveCount);
    expect(mockReadFileSync.mock.calls.length).toBe(readCount);
  });
});
