import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  resolveManualCompactionCliTarget,
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "./session-runtime-compat.js";

const lockedCodex = {
  agentHarnessId: "codex",
  agentRuntimeOverride: "openclaw",
  modelSelectionLocked: true,
};
const cliBackend = (id = "claude-cli", command = "claude") => ({
  id,
  modelProvider: "anthropic",
  config: { command },
  bundleMcp: false,
});
const nativeBinding = { "claude-cli": { sessionId: "native-claude-session" } };
const nativeTarget = {
  agentHarnessId: "claude-cli",
  cliSessionBinding: nativeBinding["claude-cli"],
  cliSessionId: "native-claude-session",
};

it.each([
  ["locked harness outranks override", lockedCodex, "codex"],
  ["plugin owns override", { ...lockedCodex, pluginOwnerId: "model-owner" }, "openclaw"],
  [
    "default falls back to harness",
    { agentHarnessId: "codex-app-server", agentRuntimeOverride: "default" },
    "codex",
  ],
] as const)("persisted runtime: %s", (_name, entry, expected) => {
  expect(resolvePersistedSessionRuntimeId(entry)).toBe(expected);
});

it.each([
  ["anthropic", { ...lockedCodex, agentRuntimeOverride: "claude-cli" }, "codex"],
  ...[undefined, "codex", "claude-cli"].map(
    (agentHarnessId) =>
      [
        "openai",
        { ...lockedCodex, agentHarnessId, pluginOwnerId: "model-owner" },
        "openclaw",
      ] as const,
  ),
] as const)("preserves runtime ownership for %s / %j", (provider, entry, expected) => {
  expect(resolveSessionRuntimeOverrideForProvider({ provider, entry })).toBe(expected);
});

describe("resolveManualCompactionCliTarget", () => {
  const compact = (
    entry: Parameters<typeof resolveManualCompactionCliTarget>[0]["entry"],
    provider = "anthropic",
    cfg?: Parameters<typeof resolveManualCompactionCliTarget>[0]["cfg"],
  ) => resolveManualCompactionCliTarget({ provider, entry, cfg });
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [cliBackend()] as never,
    });
  });

  afterEach(cliBackendsTesting.resetDepsForTest);

  it.each([false, true])("uses setup metadata (explicit runtime: %s)", (explicit) => {
    const cfg = explicit ? { plugins: { entries: { anthropic: { enabled: true } } } } : {};
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config === cfg
          ? ({ pluginId: "anthropic", backend: cliBackend() } as never)
          : undefined,
    });
    const entry = {
      cliSessionBindings: nativeBinding,
      ...(explicit ? { agentRuntimeOverride: "claude-cli" } : {}),
    };
    expect(compact(entry, explicit ? "anthropic" : "claude-cli", cfg)).toEqual(nativeTarget);
  });

  it("does not choose between multiple compatible native bindings", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [cliBackend(), cliBackend("other-claude-cli", "other-claude")] as never,
    });
    expect(
      compact({
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-session" },
          "other-claude-cli": { sessionId: "other-session" },
        },
      }),
    ).toEqual({});
  });

  it.each([
    [{}, "anthropic"],
    [
      {
        agentHarnessId: "claude-cli",
        modelSelectionLocked: false,
        cliSessionBindings: nativeBinding,
      },
      "openai",
    ],
  ] as const)("does not infer an incompatible or unbound CLI runtime: %j", (entry, provider) => {
    expect(compact(entry, provider)).toEqual({});
  });
});
