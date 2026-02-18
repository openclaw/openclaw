import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock pi-ai's getOAuthApiKey
const mockGetOAuthApiKey = vi.fn();
vi.mock("@mariozechner/pi-ai", () => ({
  getOAuthApiKey: mockGetOAuthApiKey,
}));

describe("OAuth refresh for Google providers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "moltbot-oauth-test-"));
    vi.resetModules();
    mockGetOAuthApiKey.mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("refreshes google-gemini-cli tokens via pi-ai when expired", async () => {
    // Setup: expired google-gemini-cli credentials
    const now = Date.now();
    const expiredCreds = {
      type: "oauth" as const,
      provider: "google-gemini-cli",
      access: "old-access-token",
      refresh: "valid-refresh-token",
      expires: now - 1000, // expired
      email: "user@gmail.com",
      projectId: "test-project-123",
    };

    // Mock successful refresh
    mockGetOAuthApiKey.mockResolvedValue({
      apiKey: JSON.stringify({
        token: "new-access-token",
        projectId: "test-project-123",
      }),
      newCredentials: {
        access: "new-access-token",
        refresh: "new-refresh-token",
        expires: now + 3600_000,
        projectId: "test-project-123",
      },
    });

    const { ensureAuthProfileStore, saveAuthProfileStore } = await import("./store.js");
    const { resolveApiKeyForProfile } = await import("./oauth.js");

    // Create auth store with expired credentials
    const store = ensureAuthProfileStore(tempDir);
    store.profiles["google-gemini-cli:user@gmail.com"] = expiredCreds;
    saveAuthProfileStore(store, tempDir);

    // Attempt to resolve API key (should trigger refresh)
    const result = await resolveApiKeyForProfile({
      store,
      profileId: "google-gemini-cli:user@gmail.com",
      agentDir: tempDir,
    });

    expect(result).toBeTruthy();
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith("google-gemini-cli", {
      "google-gemini-cli": expect.objectContaining({
        refresh: "valid-refresh-token",
        projectId: "test-project-123",
      }),
    });

    // Verify credentials were updated in store
    const updatedStore = ensureAuthProfileStore(tempDir);
    const updatedCred = updatedStore.profiles["google-gemini-cli:user@gmail.com"];
    expect(updatedCred).toMatchObject({
      type: "oauth",
      access: "new-access-token",
      refresh: "new-refresh-token",
    });
    expect(updatedCred.expires).toBeGreaterThan(now);
  });

  it("refreshes google-antigravity tokens via pi-ai when expired", async () => {
    const now = Date.now();
    const expiredCreds = {
      type: "oauth" as const,
      provider: "google-antigravity",
      access: "old-access-token",
      refresh: "valid-refresh-token",
      expires: now - 1000,
      email: "user@gmail.com",
      projectId: "antigravity-project",
    };

    mockGetOAuthApiKey.mockResolvedValue({
      apiKey: JSON.stringify({
        token: "new-access-token",
        projectId: "antigravity-project",
      }),
      newCredentials: {
        access: "new-access-token",
        refresh: "new-refresh-token",
        expires: now + 3600_000,
        projectId: "antigravity-project",
      },
    });

    const { ensureAuthProfileStore, saveAuthProfileStore } = await import("./store.js");
    const { resolveApiKeyForProfile } = await import("./oauth.js");

    const store = ensureAuthProfileStore(tempDir);
    store.profiles["google-antigravity:user@gmail.com"] = expiredCreds;
    saveAuthProfileStore(store, tempDir);

    const result = await resolveApiKeyForProfile({
      store,
      profileId: "google-antigravity:user@gmail.com",
      agentDir: tempDir,
    });

    expect(result).toBeTruthy();
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith("google-antigravity", {
      "google-antigravity": expect.objectContaining({
        refresh: "valid-refresh-token",
        projectId: "antigravity-project",
      }),
    });
  });

  it("handles refresh failure and throws meaningful error", async () => {
    const now = Date.now();
    const expiredCreds = {
      type: "oauth" as const,
      provider: "google-gemini-cli",
      access: "old-access-token",
      refresh: "invalid-refresh-token",
      expires: now - 1000,
      email: "user@gmail.com",
      projectId: "test-project",
    };

    // Mock refresh failure
    mockGetOAuthApiKey.mockRejectedValue(new Error("Invalid refresh token"));

    const { ensureAuthProfileStore, saveAuthProfileStore } = await import("./store.js");
    const { resolveApiKeyForProfile } = await import("./oauth.js");

    const store = ensureAuthProfileStore(tempDir);
    store.profiles["google-gemini-cli:user@gmail.com"] = expiredCreds;
    saveAuthProfileStore(store, tempDir);

    await expect(
      resolveApiKeyForProfile({
        store,
        profileId: "google-gemini-cli:user@gmail.com",
        agentDir: tempDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for google-gemini-cli/);
  });

  it("works with multiple accounts independently", async () => {
    const now = Date.now();

    // Setup: Two expired accounts
    const account1 = {
      type: "oauth" as const,
      provider: "google-gemini-cli",
      access: "old-access-1",
      refresh: "refresh-1",
      expires: now - 1000,
      email: "user1@gmail.com",
      projectId: "project-1",
    };

    const account2 = {
      type: "oauth" as const,
      provider: "google-gemini-cli",
      access: "old-access-2",
      refresh: "refresh-2",
      expires: now - 1000,
      email: "user2@gmail.com",
      projectId: "project-2",
    };

    // Mock refresh for each account
    mockGetOAuthApiKey
      .mockResolvedValueOnce({
        apiKey: JSON.stringify({ token: "new-access-1", projectId: "project-1" }),
        newCredentials: {
          access: "new-access-1",
          refresh: "new-refresh-1",
          expires: now + 3600_000,
          projectId: "project-1",
        },
      })
      .mockResolvedValueOnce({
        apiKey: JSON.stringify({ token: "new-access-2", projectId: "project-2" }),
        newCredentials: {
          access: "new-access-2",
          refresh: "new-refresh-2",
          expires: now + 3600_000,
          projectId: "project-2",
        },
      });

    const { ensureAuthProfileStore, saveAuthProfileStore } = await import("./store.js");
    const { resolveApiKeyForProfile } = await import("./oauth.js");

    const store = ensureAuthProfileStore(tempDir);
    store.profiles["google-gemini-cli:user1@gmail.com"] = account1;
    store.profiles["google-gemini-cli:user2@gmail.com"] = account2;
    saveAuthProfileStore(store, tempDir);

    // Refresh account 1
    const result1 = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(tempDir),
      profileId: "google-gemini-cli:user1@gmail.com",
      agentDir: tempDir,
    });

    expect(result1).toBeTruthy();
    expect(mockGetOAuthApiKey).toHaveBeenNthCalledWith(1, "google-gemini-cli", {
      "google-gemini-cli": expect.objectContaining({
        refresh: "refresh-1",
        projectId: "project-1",
      }),
    });

    // Refresh account 2
    const result2 = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(tempDir),
      profileId: "google-gemini-cli:user2@gmail.com",
      agentDir: tempDir,
    });

    expect(result2).toBeTruthy();
    expect(mockGetOAuthApiKey).toHaveBeenNthCalledWith(2, "google-gemini-cli", {
      "google-gemini-cli": expect.objectContaining({
        refresh: "refresh-2",
        projectId: "project-2",
      }),
    });

    // Verify both accounts were updated independently
    const updatedStore = ensureAuthProfileStore(tempDir);
    expect(updatedStore.profiles["google-gemini-cli:user1@gmail.com"]).toMatchObject({
      access: "new-access-1",
      refresh: "new-refresh-1",
    });
    expect(updatedStore.profiles["google-gemini-cli:user2@gmail.com"]).toMatchObject({
      access: "new-access-2",
      refresh: "new-refresh-2",
    });
  });
});
