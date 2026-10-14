import { afterEach, expect, it, vi } from "vitest";

const { nativeLogin, discoverClaudeCliModels } = vi.hoisted(() => ({
  nativeLogin: vi.fn(),
  discoverClaudeCliModels: vi.fn(),
}));
vi.mock("./cli-auth-seam.js", () => ({ observeClaudeCliNativeLogin: nativeLogin }));
// mock-isolation: Generation tests must not spawn the installed Claude CLI or read native login.
vi.mock("./cli-model-discovery.js", () => ({ discoverClaudeCliModels }));

import provider from "./provider-discovery.js";

afterEach(() => {
  vi.useRealTimers();
  nativeLogin.mockReset();
  discoverClaudeCliModels.mockReset();
});

it("prepares native availability once for a 632-workspace roster", async () => {
  vi.useFakeTimers();
  const config = {
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 632 }, (_, index) => [
          `agent-${index}`,
          { workspace: `/synthetic/workspace-${index}` },
        ]),
      ),
    },
  };
  const env = { CLAUDE_CONFIG_DIR: "/synthetic/native-account" };
  nativeLogin.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ readiness: "missing" }), 250);
      }),
  );
  const prepared = new Set<string>();
  const publication = (async () => {
    for (const agentId of Object.keys(config.agents.entries)) {
      await provider.prepareSyntheticAuth!({ config, env, provider: "claude-cli" });
      prepared.add(agentId);
    }
  })();
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(prepared.size).toBe(632);
    expect(nativeLogin).toHaveBeenCalledOnce();
  } finally {
    await vi.runAllTimersAsync();
    await publication;
  }
});

it.each(["config", "environment", "login selector", "capture signal", "expired capture"])(
  "reobserves native availability after a changed %s",
  async (changed) => {
    const config = {};
    const env: NodeJS.ProcessEnv = {};
    const signal = changed === "expired capture" ? undefined : new AbortController().signal;
    const input = { config, env, signal, provider: "claude-cli" };
    nativeLogin
      .mockResolvedValueOnce({ readiness: "missing" })
      .mockResolvedValueOnce({ readiness: "configured" });
    vi.useFakeTimers();
    expect(await provider.prepareSyntheticAuth!(input)).toMatchObject({
      nativeAuth: { readiness: "missing" },
    });
    if (changed === "expired capture") {
      vi.advanceTimersByTime(60_000);
    }
    if (changed === "login selector") {
      env.CLAUDE_CONFIG_DIR = "/synthetic/changed-account";
    }
    expect(
      await provider.prepareSyntheticAuth!({
        ...input,
        ...(changed === "config" ? { config: {} } : {}),
        ...(changed === "environment" ? { env: {} } : {}),
        ...(changed === "capture signal" ? { signal: new AbortController().signal } : {}),
      }),
    ).toMatchObject({ nativeAuth: { readiness: "configured" } });
    expect(nativeLogin).toHaveBeenCalledTimes(2);
  },
);

it("joins one probe per cancellation scope and preserves a surviving capture", async () => {
  const config = {};
  const env = {};
  const cancelled = new AbortController();
  const surviving = new AbortController();
  const reason = new Error("native preparation retired");
  let releaseSurvivor: (() => void) | undefined;
  nativeLogin
    .mockResolvedValue({ readiness: "configured" })
    .mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSurvivor = () => resolve({ readiness: "configured" });
        }),
    );
  const prepare = (signal: AbortSignal) =>
    provider.prepareSyntheticAuth!({ config, env, signal, provider: "claude-cli" });
  const retired = prepare(cancelled.signal);
  const rejection = expect(retired).rejects.toBe(reason);
  const survivor = prepare(surviving.signal);
  const follower = prepare(surviving.signal);
  cancelled.abort(reason);
  releaseSurvivor!();
  await rejection;
  await expect(survivor).resolves.toMatchObject({ mode: "oauth" });
  await expect(follower).resolves.toMatchObject({ mode: "oauth" });
  expect(nativeLogin).toHaveBeenCalledTimes(2);
  await expect(prepare(cancelled.signal)).rejects.toBe(reason);
  expect(nativeLogin).toHaveBeenCalledTimes(2);
});

it("publishes the native menu once per discovery generation, never static membership", async () => {
  const config = {};
  const env = {};
  const signal = new AbortController().signal;
  const ctx = {
    config,
    env,
    signal,
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
    resolveProviderApiKey: () => ({ apiKey: undefined }),
  };
  const row = {
    id: "claude-new-native",
    name: "Native",
    reasoning: true,
    input: ["text" as const],
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: { low: "low", max: "max" },
  };
  nativeLogin.mockResolvedValue({ readiness: "configured" });
  discoverClaudeCliModels.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
  const first = await provider.catalog!.run(ctx);
  expect(first).toMatchObject({
    providers: { "claude-cli": { models: [row] } },
    outcomes: [{ provider: "claude-cli", status: "ready", listedModelIds: [row.id] }],
  });
  expect(await provider.catalog!.run(ctx)).toEqual(first);
  expect(discoverClaudeCliModels).toHaveBeenCalledOnce();
  expect(
    await provider.catalog!.run({ ...ctx, signal: new AbortController().signal }),
  ).toMatchObject({
    providers: { "claude-cli": { models: [] } },
    outcomes: [{ status: "ready", listedModelIds: [] }],
  });
  expect(discoverClaudeCliModels).toHaveBeenCalledTimes(2);
});
