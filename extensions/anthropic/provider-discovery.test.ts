import { afterEach, expect, it, vi } from "vitest";

const { probeClaudeCliAuthStatus, discoverClaudeCliModels } = vi.hoisted(() => ({
  probeClaudeCliAuthStatus: vi.fn(),
  discoverClaudeCliModels: vi.fn(),
}));
vi.mock("./cli-auth-seam.js", () => ({ probeClaudeCliAuthStatus }));
// mock-isolation: Generation tests must not spawn the installed Claude CLI or read native login.
vi.mock("./cli-model-discovery.js", () => ({ discoverClaudeCliModels }));

import provider from "./provider-discovery.js";

const capture = (signal?: AbortSignal) => ({ config: {}, env: {}, signal });
const prepare = (input = capture()) =>
  provider.prepareSyntheticAuth!({ ...input, provider: "claude-cli" });

afterEach(() => {
  vi.useRealTimers();
  probeClaudeCliAuthStatus.mockReset();
  discoverClaudeCliModels.mockReset();
});

it("prepares native availability once for a 632-workspace roster", async () => {
  const entries = Object.fromEntries(
    Array.from({ length: 632 }, (_, i) => [String(i), { workspace: String(i) }]),
  );
  const input = { config: { agents: { entries } }, env: {}, signal: undefined };
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  const prepared = new Set<string>();
  for (const agentId of Object.keys(entries)) {
    await prepare(input);
    prepared.add(agentId);
  }
  expect(prepared.size).toBe(632);
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledOnce();
});

it.each(["config", "env", "signal"] as const)(
  "reobserves native availability after a changed %s",
  async (changed) => {
    const input = capture(new AbortController().signal);
    probeClaudeCliAuthStatus
      .mockResolvedValueOnce({ status: "available" })
      .mockResolvedValueOnce({ status: "missing" });
    expect(await prepare(input)).toMatchObject({ mode: "oauth" });
    const replacement = changed === "signal" ? new AbortController().signal : {};
    expect(await prepare({ ...input, [changed]: replacement })).toBeUndefined();
    expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
  },
);

it("expires a negative capture so a recovered login is observed", async () => {
  vi.useFakeTimers();
  const input = capture();
  probeClaudeCliAuthStatus
    .mockResolvedValueOnce({ status: "missing" })
    .mockResolvedValueOnce({ status: "available" });
  expect(await prepare(input)).toBeUndefined();
  expect(await prepare(input)).toBeUndefined();
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await prepare(input)).toMatchObject({ mode: "oauth" });
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
});

it.each(["timeout", "unreadable", "missing"])("auth probe: %s", async (status) => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status });
  const auth = await prepare();
  expect(Boolean(auth?.apiKey)).toBe(status !== "missing");
});

it("joins one probe per cancellation scope and preserves a surviving capture", async () => {
  const input = capture();
  const cancelled = new AbortController();
  const surviving = new AbortController();
  const reason = new Error("native preparation retired");
  const probe = Promise.withResolvers<{ status: string }>();
  probeClaudeCliAuthStatus
    .mockResolvedValue({ status: "available" })
    .mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        }),
    )
    .mockReturnValueOnce(probe.promise);
  const prepareSignal = (signal: AbortSignal) => prepare({ ...input, signal });
  const retired = prepareSignal(cancelled.signal);
  const rejection = expect(retired).rejects.toBe(reason);
  const survivor = prepareSignal(surviving.signal);
  const follower = prepareSignal(surviving.signal);
  cancelled.abort(reason);
  probe.resolve({ status: "available" });
  await rejection;
  await expect(survivor).resolves.toMatchObject({ mode: "oauth" });
  await expect(follower).resolves.toMatchObject({ mode: "oauth" });
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
  await expect(prepareSignal(cancelled.signal)).rejects.toBe(reason);
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
});

it("publishes the native menu once per discovery generation, never static membership", async () => {
  const ctx = {
    ...capture(new AbortController().signal),
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
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "available" });
  discoverClaudeCliModels.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
  const first = await provider.catalog!.run(ctx);
  expect(first).toMatchObject({
    providers: { "claude-cli": { models: [row] } },
    outcomes: [{ provider: "claude-cli", status: "ready", listedModelIds: [row.id] }],
  });
  expect(await provider.catalog!.run(ctx)).toEqual(first);
  expect(discoverClaudeCliModels).toHaveBeenCalledOnce();
  const next = await provider.catalog!.run({ ...ctx, signal: new AbortController().signal });
  expect(next).toMatchObject({
    providers: { "claude-cli": { models: [] } },
    outcomes: [{ status: "ready", listedModelIds: [] }],
  });
  expect(discoverClaudeCliModels).toHaveBeenCalledTimes(2);
});
