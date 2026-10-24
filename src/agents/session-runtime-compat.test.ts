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

describe("resolvePersistedSessionRuntimeId", () => {
  it.each([
    ["locked harness outranks override", lockedCodex, "codex"],
    ["plugin owns override", { ...lockedCodex, pluginOwnerId: "model-owner" }, "openclaw"],
    [
      "default falls back to harness",
      { agentHarnessId: "codex-app-server", agentRuntimeOverride: "default" },
      "codex",
    ],
  ] as const)("%s", (_name, entry, expected) => {
    expect(resolvePersistedSessionRuntimeId(entry)).toBe(expected);
  });
});

describe("resolveSessionRuntimeOverrideForProvider", () => {
  it("keeps a locked harness across a conflicting provider runtime alias", () => {
    expect(
      resolveSessionRuntimeOverrideForProvider({
        provider: "anthropic",
        entry: { ...lockedCodex, agentRuntimeOverride: "claude-cli" },
      }),
    ).toBe("codex");
  });

  it("retains a plugin-owned runtime request after another harness reports usage", () => {
    const entry = {
      agentRuntimeOverride: "openclaw",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    };
    for (const agentHarnessId of [undefined, "codex", "claude-cli"]) {
      expect(
        resolveSessionRuntimeOverrideForProvider({
          provider: "openai",
          entry: { ...entry, agentHarnessId },
        }),
      ).toBe("openclaw");
    }
  });
});

describe("resolveManualCompactionCliTarget", () => {
  const compact = (
    entry: Parameters<typeof resolveManualCompactionCliTarget>[0]["entry"],
    provider = "anthropic",
    cfg?: Parameters<typeof resolveManualCompactionCliTarget>[0]["cfg"],
  ) => resolveManualCompactionCliTarget({ provider, entry, cfg });
  const useSetupBackend = (expectedConfig?: Parameters<typeof compact>[2]) => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && (!expectedConfig || config === expectedConfig)
          ? ({ pluginId: "anthropic", backend: cliBackend() } as never)
          : undefined,
    });
  };
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [cliBackend()] as never,
    });
  });

  afterEach(cliBackendsTesting.resetDepsForTest);

  it("uses setup metadata for claude-cli", () => {
    useSetupBackend();
    expect(compact({ cliSessionBindings: nativeBinding }, "claude-cli", {})).toEqual(nativeTarget);
  });

  it("passes config when resolving an explicit setup-registered runtime binding", () => {
    const cfg = { plugins: { entries: { anthropic: { enabled: true } } } };
    useSetupBackend(cfg);

    expect(
      compact(
        { agentRuntimeOverride: "claude-cli", cliSessionBindings: nativeBinding },
        "anthropic",
        cfg,
      ),
    ).toEqual(nativeTarget);
  });

  it("does not infer a CLI runtime without its native binding", () => {
    expect(compact({})).toEqual({});
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

  it("does not reuse an unlocked historical harness binding after a provider switch", () => {
    expect(
      compact(
        {
          agentHarnessId: "claude-cli",
          modelSelectionLocked: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "stale-claude-session" },
          },
        },
        "openai",
      ),
    ).toEqual({});
  });
});
