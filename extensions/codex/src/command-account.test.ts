import { describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  authMocks.resolveProfileUnusableUntilForDisplay.mockImplementation(
    actual.resolveProfileUnusableUntilForDisplay,
  );
  return {
    ...actual,
    ensureAuthProfileStore: authMocks.ensureAuthProfileStore,
    resolveProfileUnusableUntilForDisplay: authMocks.resolveProfileUnusableUntilForDisplay,
  };
});

import { readCodexAccountAuthOverview } from "./command-account.js";

describe("Codex account workspace identity", () => {
  it("attributes a shared-email ChatGPT account to its active workspace", async () => {
    authMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:personal": {
          type: "oauth",
          provider: "openai",
          access: "personal-access",
          refresh: "personal-refresh",
          expires: Date.now() + 60_000,
          email: "operator@example.test",
          accountId: "workspace-personal",
          displayName: "Personal",
        },
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "work-access",
          refresh: "work-refresh",
          expires: Date.now() + 60_000,
          email: "operator@example.test",
          accountId: "workspace-work",
          displayName: "Work",
        },
      },
      order: { openai: ["openai:personal", "openai:work"] },
      lastGood: { openai: "openai:work" },
    });
    const safeCodexControlRequest = vi.fn();

    const overview = await readCodexAccountAuthOverview({
      ctx: { config: {} } as never,
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: {},
      safeCodexControlRequest,
      account: {
        ok: true,
        value: {
          account: { type: "chatgpt", email: "operator@example.test" },
        },
      },
      limits: { ok: true, value: {} },
    });

    expect(overview?.rows.find((row) => row.active)).toMatchObject({
      profileId: "openai:work",
      label: "Work",
    });
    expect(overview?.subscriptionLabel).toBe("Work");
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });
});

describe("Codex account inactive profile status", () => {
  const now = Date.now();
  const blockedStore = {
    version: 1,
    profiles: {
      "openai:personal": {
        type: "oauth",
        provider: "openai",
        access: "personal-access",
        refresh: "personal-refresh",
        expires: now + 60_000,
        email: "personal@example.test",
        displayName: "Personal",
      },
      "openai:work": {
        type: "oauth",
        provider: "openai",
        access: "work-access",
        refresh: "work-refresh",
        expires: now + 60_000,
        email: "work@example.test",
        displayName: "Work",
      },
    },
    order: { openai: ["openai:personal", "openai:work"] },
    lastGood: { openai: "openai:work" },
    usageStats: {
      "openai:personal": { blockedUntil: now + 30 * 60_000 },
    },
  };

  async function readInactiveStatus() {
    authMocks.ensureAuthProfileStore.mockReturnValue(structuredClone(blockedStore));
    const overview = await readCodexAccountAuthOverview({
      ctx: { config: {} } as never,
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: {},
      safeCodexControlRequest: vi.fn(),
      account: {
        ok: true,
        value: { account: { type: "chatgpt", email: "work@example.test" } },
      },
      limits: { ok: true, value: {} },
    });
    return overview?.rows.find((row) => row.profileId === "openai:personal")?.status;
  }

  it("reports a stored rate-limit block for a provider that keeps cooldowns", async () => {
    await expect(readInactiveStatus()).resolves.toMatch(/^rate-limited - resets /);
  });

  it("follows the display resolver when it reports the blocked profile usable", async () => {
    // A provider that manages its own availability makes the resolver return
    // null; the status must agree with routing rather than read the raw block.
    authMocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);
    try {
      await expect(readInactiveStatus()).resolves.toBe("available if needed");
    } finally {
      authMocks.resolveProfileUnusableUntilForDisplay.mockReset();
    }
  });
});
