import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
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

it.each([
  ["timeout", true],
  ["unreadable", true],
  ["missing", false],
  ["not-installed", false],
])("auth probe: %s", async (status, authenticated) => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status });
  const input = capture();
  const auth = await prepare(input);
  expect(Boolean(auth?.apiKey)).toBe(authenticated);
  if (!authenticated) {
    expect(
      await provider.catalog!.run({
        ...input,
        resolveProviderAuth: () => ({
          apiKey: undefined,
          mode: "none" as const,
          source: "none" as const,
        }),
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).toBeNull();
    expect(discoverClaudeCliModels).not.toHaveBeenCalled();
  }
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
  const row = { id: "claude-new-native" };
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

// POSIX executable fixture; cli-auth-seam.test.ts separately covers Windows shim parsing.
it.skipIf(process.platform === "win32").each([
  ["claude.ai", "max", { kind: "subscription", plan: "Max" }],
  ["claude.ai", "redacted", { kind: "subscription" }],
  ["claude.ai", { token: "synthetic-private-token" }, { kind: "subscription" }],
  ["api_key", "max", { kind: "api" }],
  ["api_key_helper", null, { kind: "api" }],
  ["third_party", null, { kind: "api" }],
  ["oauth_token", "max", { kind: "native" }],
  ["future-method", "max", { kind: "native" }],
])(
  "projects native CLI status without guessing billing: %s / %s",
  async (authMethod, subscriptionType, display) => {
    await withTempDir("claude-native-status-", async (dir) => {
      const command = path.join(dir, "claude");
      const payload = {
        loggedIn: true,
        authMethod,
        subscriptionType,
        apiProvider: "firstParty",
        storedClaudeAiLogin: true,
        planTier: "other",
        email: "synthetic@example.test",
        accessToken: "synthetic-private-token",
        orgId: "synthetic-private-org",
      };
      await fs.writeFile(
        command,
        "#!" +
          process.execPath +
          "\n" +
          "require('node:assert/strict').deepEqual(process.argv.slice(2), ['auth', 'status', '--json']);\n" +
          "process.stdout.write(" +
          JSON.stringify(JSON.stringify(payload)) +
          ");\n",
        { mode: 0o755 },
      );
      const actual =
        await vi.importActual<typeof import("./cli-auth-seam.js")>("./cli-auth-seam.js");
      probeClaudeCliAuthStatus.mockImplementation(actual.probeClaudeCliAuthStatus);
      const auth = await prepare({ config: {}, env: { PATH: dir, HOME: dir }, signal: undefined });
      expect(auth?.nativeAuth).toEqual({ runtime: "claude-cli", mode: "oauth", display });
      expect(JSON.stringify(auth)).not.toMatch(/synthetic@example|private|other|redacted/);
    });
  },
);
