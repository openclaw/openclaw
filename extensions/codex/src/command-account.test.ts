import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { resetCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import type { CodexCommandDepsOverride } from "./command-handlers.js";
import { createCodexCommand } from "./commands.js";
import {
  createContext,
  createDeps,
  supervisedTestBinding,
  writeTestBinding,
} from "./commands.test-support.js";

type AccountRequest = NonNullable<CodexCommandDepsOverride["safeCodexControlRequest"]>;

describe("Codex account workspace identity", () => {
  let tempDir: string;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      clearRuntimeAuthProfileStoreSnapshots();
      clearSessionStoreCacheForTest();
      vi.unstubAllEnvs();
      cleanup();
    }),
  );

  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = tempDirs.make("openclaw-codex-account-");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  });

  function installStore(store: AuthProfileStore) {
    replaceRuntimeAuthProfileStoreSnapshots([
      { agentDir: path.join(tempDir, "agents", "main", "agent"), store },
    ]);
  }

  function installProfiles(order: string[], includeWork = true) {
    const profiles: AuthProfileStore["profiles"] = {};
    for (const name of includeWork ? ["personal", "work"] : ["personal"]) {
      profiles[`openai:${name}`] = {
        type: "oauth",
        provider: "openai",
        access: `${name}-access`,
        refresh: `${name}-refresh`,
        expires: Date.now() + 60_000,
        email: "operator@example.test",
        accountId: `workspace-${name}`,
        displayName: name === "personal" ? "Personal" : "Work",
      };
    }
    installStore({
      version: 1,
      profiles,
      order: { openai: order },
      lastGood: { openai: "openai:personal" },
    });
  }

  function accountRequests(email: string) {
    return vi.fn<AccountRequest>(async (_pluginConfig, method): ReturnType<AccountRequest> => {
      if (method === CODEX_CONTROL_METHODS.account) {
        return {
          ok: true,
          value: { account: { type: "chatgpt", email, planType: "pro" } },
        };
      }
      if (method === CODEX_CONTROL_METHODS.rateLimits) {
        return {
          ok: true,
          value: {
            rateLimits: {
              limitId: "codex",
              primary: {
                usedPercent: 17,
                windowDurationMins: 300,
                resetsAt: Math.ceil(Date.now() / 1000) + 3600,
              },
              secondary: {
                usedPercent: 100,
                windowDurationMins: 10080,
                resetsAt: Math.ceil(Date.now() / 1000) + 7200,
              },
              rateLimitReachedType: "rate_limit_reached",
            },
          },
        };
      }
      throw new Error(`Unexpected account request: ${method}`);
    });
  }

  it.each([
    { order: ["openai:personal", "openai:work"], label: "after another workspace" },
    { order: ["openai:personal"], label: "outside the current auth order" },
  ])("shows the bound workspace $label despite shared email and lastGood", async ({ order }) => {
    installProfiles(order);
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-work", cwd: "/repo", authProfileId: "openai:work" },
    );
    const safeCodexControlRequest = accountRequests("operator@example.test");

    const result = await createCodexCommand({
      deps: createDeps({ safeCodexControlRequest }),
    }).handler(createContext("account"));

    expect(result.text).toContain("Subscription  Work");
    expect(result.text).toContain("Weekly 100% · Short-term 17%");
    expect(result.text).toContain("Work   ChatGPT subscription   — active now");
    expect(result.text).not.toContain("Personal   ChatGPT subscription   — active now");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
    for (const call of safeCodexControlRequest.mock.calls) {
      expect(call[3]).toMatchObject({ authProfileId: "openai:work" });
    }
  });

  it.each([
    { source: "supervision", email: "native@example.test" },
    { source: "supervision", email: "operator@example.test" },
    { source: "user home", email: "native@example.test" },
  ])("keeps $source account $email separate from saved profiles", async ({ source, email }) => {
    installProfiles(["openai:personal"], false);
    const pluginConfig =
      source === "supervision"
        ? { supervision: { enabled: true } }
        : { appServer: { homeScope: "user" } };
    if (source === "supervision") {
      await writeTestBinding(
        { kind: "session", agentId: "main", sessionId: "session-1" },
        supervisedTestBinding(),
      );
    }
    const safeCodexControlRequest = accountRequests(email);

    const result = await createCodexCommand({
      pluginConfig,
      deps: createDeps({ safeCodexControlRequest }),
    }).handler(createContext("account"));

    expect(result.text).toContain(`Account: ${email}`);
    expect(result.text).toContain("Your weekly Codex usage limit is reached.");
    expect(result.text).toContain("Auth order");
    expect(result.text).toContain("Personal   ChatGPT subscription   — available if needed");
    expect(result.text).not.toContain("Subscription  Personal");
    expect(result.text).not.toContain("active now");
    expect(result.text).not.toContain("no working credential");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
    for (const call of safeCodexControlRequest.mock.calls) {
      expect(call[3]).toMatchObject({ authProfileId: null });
    }
  });

  it("preserves deleted bound-profile failures without probing another subscription", async () => {
    installProfiles(["openai:personal"], false);
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1" },
      { threadId: "thread-deleted-profile", cwd: "/repo", authProfileId: "openai:deleted" },
    );
    const selectedError = 'Codex app-server auth profile "openai:deleted" was not found.';
    const otherAccountRequests = accountRequests("operator@example.test");
    const safeCodexControlRequest = vi.fn<AccountRequest>(
      async (...args): ReturnType<AccountRequest> => {
        if (args[3]?.authProfileId === "openai:deleted") {
          return { ok: false, error: selectedError };
        }
        return await otherAccountRequests(...args);
      },
    );

    const result = await createCodexCommand({
      deps: createDeps({ safeCodexControlRequest }),
    }).handler(createContext("account"));

    expect(result.text).toBe(`Account: ${selectedError}\n\nRate limits: ${selectedError}`);
    expect(otherAccountRequests).not.toHaveBeenCalled();
  });

  it("does not mark any profile active when all explicit-order token credentials are expired", async () => {
    const now = Date.now();
    installStore({
      version: 1,
      profiles: {
        "openai:fresh@example.com": {
          type: "token",
          provider: "openai",
          token: "fresh-token",
          expires: now - 1000,
          email: "fresh@example.com",
        },
        "openai:stale@example.com": {
          type: "token",
          provider: "openai",
          token: "stale-token",
          expires: now - 2000,
          email: "stale@example.com",
        },
      },
      order: {
        openai: ["openai:fresh@example.com", "openai:stale@example.com"],
      },
      lastGood: {
        openai: "openai:stale@example.com",
      },
    });

    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { account: { type: "unknown" }, requiresOpenaiAuth: true },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "rate limits unavailable",
      });

    const result = await createCodexCommand({
      deps: createDeps({ safeCodexControlRequest }),
    }).handler(createContext("account"));

    expect(result.text).toContain("Rate limits: rate limits unavailable");
    expect(result.text).toContain(
      "\n  1. fresh@example.com   ChatGPT subscription   — sign-in expired",
    );
    expect(result.text).toContain(
      "\n  2. stale@example.com   ChatGPT subscription   — sign-in expired",
    );
    expect(result.text).not.toContain("active now");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });
});
