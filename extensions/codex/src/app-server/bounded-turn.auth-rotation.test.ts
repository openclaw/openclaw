import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { createClientFactory } from "./bounded-turn.test-harness.js";
import type { JsonValue } from "./protocol.js";

const markAuthProfileBlockedUntil = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    markAuthProfileBlockedUntil,
  };
});

const PRIMARY_PROFILE = "openai:primary";
const BACKUP_PROFILE = "openai:backup";

function authStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PRIMARY_PROFILE]: {
        type: "api_key",
        provider: "openai",
        key: "bounded-turn-fixture-primary",
      },
      [BACKUP_PROFILE]: {
        type: "api_key",
        provider: "openai",
        key: "bounded-turn-fixture-backup",
      },
    },
  };
}

function authConfig(): OpenClawConfig {
  return {
    auth: {
      order: {
        openai: [PRIMARY_PROFILE, BACKUP_PROFILE],
      },
    },
  } as OpenClawConfig;
}

function usageLimitRateLimits(nowMs = Date.now()): JsonValue {
  return {
    primary: {
      usedPercent: 100,
      resetsAt: Math.floor(nowMs / 1000) + 86_400,
      windowDurationMins: 10_080,
    },
    limitId: "codex",
  };
}

function turnDefaults() {
  return {
    model: { mode: "required" as const, id: "gpt-5.4" },
    timeoutMs: 5_000,
    taskLabel: "hosted search",
    developerInstructions: "Answer only.",
    input: [{ type: "text" as const, text: "Find the backup profile.", text_elements: [] }],
    requiredModalities: ["text"],
    config: authConfig(),
    authProfileStore: authStore(),
    agentDir: "/home/synth/Projects/forks/openclaw-wt/pr-168231/.tmp-bounded-auth",
  };
}

beforeEach(() => {
  markAuthProfileBlockedUntil.mockReset();
});

describe("bounded Codex turn auth profile rotation", () => {
  it("rotates an automatic profile after a structured usage limit and records the reset", async () => {
    const limited = createClientFactory({
      terminalStatus: "failed",
      terminalError: {
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
      },
      rateLimits: usageLimitRateLimits(),
    });
    const healthy = createClientFactory();
    const factory = vi.fn(async (options: { authProfileId?: string | null }) => {
      if (options.authProfileId === BACKUP_PROFILE) {
        return await healthy.factory(options);
      }
      return await limited.factory(options);
    });

    const result = await runBoundedCodexAppServerTurn({
      ...turnDefaults(),
      isolation: "private-stdio",
      options: {
        clientFactory: factory,
        pluginConfig: { appServer: { homeScope: "user" } },
      },
    });

    expect(result.text).toBe("The message was sent successfully.");
    expect(factory.mock.calls.map((call) => call[0]?.authProfileId)).toEqual([
      PRIMARY_PROFILE,
      BACKUP_PROFILE,
    ]);
    expect(markAuthProfileBlockedUntil).toHaveBeenCalledTimes(1);
    expect(markAuthProfileBlockedUntil).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: PRIMARY_PROFILE,
        source: "codex_rate_limits",
        blockedUntil: expect.any(Number),
      }),
    );
    const blockedUntil = markAuthProfileBlockedUntil.mock.calls[0]?.[0]?.blockedUntil as number;
    expect(blockedUntil).toBeGreaterThan(Date.now());
    expect(healthy.factory).toHaveBeenCalledOnce();
  });

  it("rotates a structured rate limit without rotating credential failures", async () => {
    const limited = createClientFactory({
      terminalStatus: "failed",
      terminalError: { message: "slow down", codexErrorInfo: "rateLimitExceeded" },
    });
    const healthy = createClientFactory();
    const profiles: Array<string | null | undefined> = [];
    const factory = vi.fn(async (options: { authProfileId?: string | null }) => {
      profiles.push(options.authProfileId);
      if (options.authProfileId === BACKUP_PROFILE) {
        return await healthy.factory(options);
      }
      return await limited.factory(options);
    });

    await expect(
      runBoundedCodexAppServerTurn({
        ...turnDefaults(),
        isolation: "configured-transport",
        options: { clientFactory: factory },
      }),
    ).resolves.toMatchObject({ text: "The message was sent successfully." });

    expect(profiles).toEqual([PRIMARY_PROFILE, BACKUP_PROFILE]);
    expect(markAuthProfileBlockedUntil).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "auth failure",
      terminalError: { message: "authentication failed" },
      status: undefined,
    },
    {
      label: "unauthorized",
      terminalError: { message: "unauthorized", codexErrorInfo: "unauthorized" as const },
      status: undefined,
    },
    {
      label: "overload",
      terminalError: { message: "busy", codexErrorInfo: "serverOverloaded" as const },
      status: 503,
    },
  ])("does not rotate after a structured $label", async ({ terminalError, status }) => {
    const failing = createClientFactory({
      terminalStatus: "failed",
      terminalError,
    });
    const factory = vi.fn(failing.factory);

    const rejected = runBoundedCodexAppServerTurn({
      ...turnDefaults(),
      isolation: "configured-transport",
      options: { clientFactory: factory },
    });
    await expect(rejected).rejects.toThrow(terminalError.message);
    if (status !== undefined) {
      await expect(rejected).rejects.toMatchObject({ status });
    }
    expect(factory).toHaveBeenCalledOnce();
    expect(markAuthProfileBlockedUntil).not.toHaveBeenCalled();
  });

  it("keeps an explicitly pinned profile fail-closed", async () => {
    const failing = createClientFactory({
      terminalStatus: "failed",
      terminalError: {
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
      },
      rateLimits: usageLimitRateLimits(),
    });
    const factory = vi.fn(failing.factory);

    await expect(
      runBoundedCodexAppServerTurn({
        ...turnDefaults(),
        profile: PRIMARY_PROFILE,
        isolation: "private-stdio",
        options: {
          clientFactory: factory,
          pluginConfig: { appServer: { homeScope: "user" } },
        },
      }),
    ).rejects.toThrow(/usage limit/i);

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[0]?.authProfileId).toBe(PRIMARY_PROFILE);
    expect(markAuthProfileBlockedUntil).not.toHaveBeenCalled();
  });

  it("does not grant a rotated profile a fresh timeout budget", async () => {
    let now = 10_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const timeouts: number[] = [];
    try {
      const limited = createClientFactory({
        terminalStatus: "failed",
        terminalError: {
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
        },
      });
      const healthy = createClientFactory();
      const factory = vi.fn(
        async (options: { authProfileId?: string | null; timeoutMs?: number }) => {
          timeouts.push(options.timeoutMs ?? -1);
          if (options.authProfileId === BACKUP_PROFILE) {
            return await healthy.factory(options);
          }
          now += 4_000;
          return await limited.factory(options);
        },
      );

      await expect(
        runBoundedCodexAppServerTurn({
          ...turnDefaults(),
          timeoutMs: 5_000,
          isolation: "configured-transport",
          options: { clientFactory: factory },
        }),
      ).resolves.toMatchObject({ text: "The message was sent successfully." });

      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toBeGreaterThan(4_500);
      expect(timeouts[1]).toBeLessThan(1_500);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not rotate when startup auth fails closed", async () => {
    const profiles: Array<string | null | undefined> = [];
    const factory = vi.fn(async (options: { authProfileId?: string | null }) => {
      profiles.push(options.authProfileId);
      throw Object.assign(new Error("authentication failed"), { status: 401 });
    });

    await expect(
      runBoundedCodexAppServerTurn({
        ...turnDefaults(),
        isolation: "configured-transport",
        options: { clientFactory: factory },
      }),
    ).rejects.toThrow("authentication failed");

    expect(profiles).toEqual([PRIMARY_PROFILE]);
    expect(markAuthProfileBlockedUntil).not.toHaveBeenCalled();
  });
});
