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
  it("lets a locked harness outrank a conflicting persisted runtime override", () => {
    expect(resolvePersistedSessionRuntimeId(lockedCodex)).toBe("codex");
  });

  it("uses the override without native ownership", () => {
    expect(resolvePersistedSessionRuntimeId({ ...lockedCodex, pluginOwnerId: "model-owner" })).toBe(
      "openclaw",
    );
  });

  it("filters default overrides before falling back to the persisted harness", () => {
    expect(
      resolvePersistedSessionRuntimeId({
        agentHarnessId: "codex-app-server",
        agentRuntimeOverride: "default",
      }),
    ).toBe("codex");
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
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [cliBackend()] as never,
    });
  });

  afterEach(cliBackendsTesting.resetDepsForTest);

  it("uses setup metadata for claude-cli", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? ({
              pluginId: "anthropic",
              backend: cliBackend(),
            } as never)
          : undefined,
    });
    expect(
      resolveManualCompactionCliTarget({
        provider: "claude-cli",
        cfg: {},
        entry: { cliSessionBindings: nativeBinding },
      }),
    ).toEqual(nativeTarget);
  });

  it("passes config when resolving an explicit setup-registered runtime binding", () => {
    const cfg = { plugins: { entries: { anthropic: { enabled: true } } } };
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend, config }) =>
        backend === "claude-cli" && config === cfg
          ? ({
              pluginId: "anthropic",
              backend: cliBackend(),
            } as never)
          : undefined,
    });

    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        cfg,
        entry: {
          agentRuntimeOverride: "claude-cli",
          cliSessionBindings: nativeBinding,
        },
      }),
    ).toEqual(nativeTarget);
  });

  it("does not infer a CLI runtime without its native binding", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {},
      }),
    ).toEqual({});
  });

  it("does not choose between multiple compatible native bindings", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [cliBackend(), cliBackend("other-claude-cli", "other-claude")] as never,
    });
    expect(
      resolveManualCompactionCliTarget({
        provider: "anthropic",
        entry: {
          cliSessionBindings: {
            "claude-cli": { sessionId: "claude-session" },
            "other-claude-cli": { sessionId: "other-session" },
          },
        },
      }),
    ).toEqual({});
  });

  it("does not reuse an unlocked historical harness binding after a provider switch", () => {
    expect(
      resolveManualCompactionCliTarget({
        provider: "openai",
        entry: {
          agentHarnessId: "claude-cli",
          modelSelectionLocked: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "stale-claude-session" },
          },
        },
      }),
    ).toEqual({});
  });
});
