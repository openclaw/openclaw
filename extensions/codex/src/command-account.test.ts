import path from "node:path";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  type SafeCodexControlRequestFn as AccountRequest,
  oauthProfile,
  runCommand,
  supervisedTestBinding,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

type Profiles = AuthProfileStore["profiles"];
const session = { kind: "session", agentId: "main", sessionId: "session-1" } as const;
const success = <T>(value: T) => ({ ok: true as const, value });
const bindProfile = (name: string) =>
  writeTestBinding(session, {
    threadId: "thread-account",
    cwd: "/repo",
    authProfileId: `openai:${name}`,
  });
function expectRequests(request: ReturnType<typeof accountRequests>, profileId: string | null) {
  expect(request.mock.calls.map((call) => call[3]?.authProfileId)).toEqual([profileId, profileId]);
}
function accountRequests(email: string) {
  return vi.fn<AccountRequest>(async (_pluginConfig, method): ReturnType<AccountRequest> => {
    if (method === CODEX_CONTROL_METHODS.account) {
      return success({ account: { type: "chatgpt", email, planType: "pro" } });
    }
    if (method === CODEX_CONTROL_METHODS.rateLimits) {
      return success({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 17, windowDurationMins: 300 },
          secondary: { usedPercent: 100, windowDurationMins: 10080 },
          rateLimitReachedType: "rate_limit_reached",
        },
      });
    }
    throw new Error(`Unexpected account request: ${method}`);
  });
}
function account(safeCodexControlRequest: AccountRequest, pluginConfig = {}) {
  return runCommand("account", { safeCodexControlRequest }, {}, { pluginConfig });
}

describe("Codex account workspace identity", () => {
  let tempDir: string;
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
  });

  function installStore(profiles: Profiles, order: string[], lastGood = order[0]) {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        store: {
          version: 1,
          profiles,
          order: { openai: order },
          ...(lastGood === undefined ? {} : { lastGood: { openai: lastGood } }),
        },
      },
    ]);
  }

  function installProfiles(includeWork = true) {
    const profiles: Profiles = {};
    for (const name of includeWork ? ["personal", "work"] : ["personal"]) {
      profiles[`openai:${name}`] = {
        ...oauthProfile("operator@example.test", Date.now()),
        accountId: `workspace-${name}`,
        displayName: name === "personal" ? "Personal" : "Work",
      };
    }
    installStore(profiles, ["openai:personal"]);
  }

  it("shows the bound workspace outside the auth order despite shared email and lastGood", async () => {
    installProfiles();
    await bindProfile("work");
    const request = accountRequests("operator@example.test");
    const { text } = await account(request);
    expect(text).toContain("Subscription  Work");
    expect(text).toContain("Weekly 100% · Short-term 17%");
    expect(text).toContain("Work   ChatGPT subscription   — active now");
    expect(text).not.toContain("Personal   ChatGPT subscription   — active now");
    expectRequests(request, "openai:work");
  });

  it.each([
    { source: "supervision", email: "operator@example.test" },
    { source: "user home", email: "native@example.test" },
  ])("keeps $source account $email separate from saved profiles", async ({ source, email }) => {
    installProfiles(false);
    const pluginConfig =
      source === "supervision"
        ? { supervision: { enabled: true } }
        : { appServer: { homeScope: "user" } };
    if (source === "supervision") {
      await writeTestBinding(session, supervisedTestBinding());
    }
    const request = accountRequests(email);
    const { text } = await account(request, pluginConfig);
    expect(text).toContain(`Account: ${email}`);
    expect(text).toContain("Your weekly Codex usage limit is reached.");
    expect(text).toContain("Auth order");
    expect(text).toContain("Personal   ChatGPT subscription   — available if needed");
    for (const absent of ["Subscription  Personal", "active now", "no working credential"]) {
      expect(text).not.toContain(absent);
    }
    expectRequests(request, null);
  });

  it("preserves deleted bound-profile failures without probing another subscription", async () => {
    installProfiles(false);
    await bindProfile("deleted");
    const selectedError = 'Codex app-server auth profile "openai:deleted" was not found.';
    const otherAccountRequests = accountRequests("operator@example.test");
    const request = vi.fn<AccountRequest>(async (...args): ReturnType<AccountRequest> => {
      if (args[3]?.authProfileId === "openai:deleted") {
        return { ok: false, error: selectedError };
      }
      return await otherAccountRequests(...args);
    });
    const result = await account(request);
    expect(result.text).toBe(`Account: ${selectedError}\n\nRate limits: ${selectedError}`);
    expect(otherAccountRequests).not.toHaveBeenCalled();
  });

  it("does not mark any profile active when all explicit-order token credentials are expired", async () => {
    const now = Date.now();
    const profiles: Profiles = {};
    for (const [index, name] of ["fresh", "stale"].entries()) {
      profiles[`openai:${name}@example.com`] = {
        type: "token",
        provider: "openai",
        token: `${name}-token`,
        expires: now - (index + 1) * 1000,
        email: `${name}@example.com`,
      };
    }
    const order = ["openai:fresh@example.com", "openai:stale@example.com"];
    installStore(profiles, order, order[1]);

    const request = vi
      .fn()
      .mockResolvedValueOnce(success({ account: { type: "unknown" }, requiresOpenaiAuth: true }))
      .mockResolvedValueOnce({ ok: false, error: "rate limits unavailable" });
    const { text } = await account(request);
    expect(text).toContain("Rate limits: rate limits unavailable");
    expect(text).toContain("\n  1. fresh@example.com   ChatGPT subscription   — sign-in expired");
    expect(text).toContain("\n  2. stale@example.com   ChatGPT subscription   — sign-in expired");
    expect(text).not.toContain("active now");
  });
});
