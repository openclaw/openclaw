import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReefRuntime } from "./runtime.js";
import { reefSetupWizard } from "./setup.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  reserveReefIdentityBinding,
} from "./state.js";
import { ReefRelayError, ReefTransportClient } from "./transport.js";

function createPrompter(handle = "molty", complete: boolean | "oauth" = false, accepted = false) {
  const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", handle];
  if (complete) {
    textAnswers.push(
      "gpt-5.6-terra",
      complete === "oauth" ? "openai:work" : "REEF_GUARD_OPENAI_KEY",
      "reef-v1",
    );
  }
  const selectAnswers = ["code-only", "openai", complete === "oauth" ? "oauth" : "api-key"];
  return {
    note: vi.fn(async () => undefined),
    text: vi.fn(async () => textAnswers.shift() ?? ""),
    select: vi.fn(async () => (complete ? selectAnswers.shift() : "code-only")),
    confirm: vi.fn(async () => accepted),
  };
}

function modelRuntime(id: "codex" | "openclaw") {
  return { "openai/gpt-5.6-terra": { agentRuntime: { id } } };
}

describe("Reef setup wizard identity binding", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-setup-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function installRuntime() {
    const runtime = createPluginRuntimeMock();
    const stateOptions = <T extends OpenAsyncKeyedStoreOptions>(options: T) => ({
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", stateOptions(options));
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("reef", stateOptions(options));
    runtime.state.openKeyedStoreV2 = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreV2ForTests<T>("reef", stateOptions(options), {
        assertCurrent() {},
      });
    runtime.state.resolveStateDir = () => stateDir;
    setReefRuntime(runtime);
    return runtime;
  }

  async function keyedRuntime() {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    return runtime;
  }

  async function oauthFixture(accepted = false) {
    const runtime = await keyedRuntime();
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
      handle: "molty",
      key_epoch: 1,
    });
    return { runtime, prompter: createPrompter("molty", "oauth", accepted) };
  }

  async function bindIdentity(
    runtime: ReturnType<typeof installRuntime>,
    handle: string,
  ): Promise<void> {
    await finalizeReefIdentityBinding(
      runtime,
      await reserveReefIdentityBinding(runtime, { handle, relayUrl: "https://reefwire.ai" }),
    );
  }

  it("rejects a different handle before reusing the stored identity keys", async () => {
    const runtime = installRuntime();
    await bindIdentity(runtime, "existing");
    const prompter = createPrompter("replacement");

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("already holds the Reef identity @existing");
  });

  const noRuntimePromptCases: Array<{
    name: string;
    cfg: OpenClawConfig;
    runtimeConfigured: boolean;
  }> = [
    { name: "unconfigured runtime", cfg: {}, runtimeConfigured: false },
    {
      name: "explicit system agent Codex runtime ahead of shared policy",
      runtimeConfigured: true,
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "guard-owner" },
            models: modelRuntime("openclaw"),
          },
          entries: {
            main: { models: modelRuntime("openclaw") },
            "guard-owner": { models: modelRuntime("codex") },
          },
        },
      } satisfies OpenClawConfig,
    },
  ];

  it.each(noRuntimePromptCases)(
    "configures host-authorized OAuth without a runtime prompt: $name",
    async ({ cfg: input, runtimeConfigured }) => {
      const cfg: OpenClawConfig = structuredClone(input);
      const original = structuredClone(cfg);
      const { prompter } = await oauthFixture();

      const result = await reefSetupWizard.configureInteractive({
        cfg,
        prompter: prompter as never,
      });

      expect(result.cfg.channels?.reef?.guard).toEqual({
        provider: "openai",
        authMode: "oauth",
        authProfileId: "openai:work",
        pinnedModel: "gpt-5.6-terra",
        policyVersion: "reef-v1",
        timeoutMs: 120_000,
      });
      expect(result.cfg.plugins?.entries?.reef?.llm).toEqual({
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.6-terra"],
        allowedCompletionModels: ["openai/gpt-5.6-terra"],
      });
      if (runtimeConfigured) {
        expect(result.cfg.agents).toEqual(original.agents);
        expect(result.cfg.models).toEqual(original.models);
      } else {
        expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.6-terra"]).toEqual({
          agentRuntime: { id: "codex" },
        });
      }
      expect(JSON.stringify(result.cfg)).not.toContain("apiKeyEnv");
      expect(cfg).toEqual(original);
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  const runtimePolicyCases: Array<{
    name: string;
    cfg: OpenClawConfig;
    rejection?: string;
  }> = [
    {
      name: "explicit system agent exact model",
      rejection: "agent-specific runtime policy",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "guard-owner" } },
          entries: {
            main: { models: modelRuntime("codex") },
            "guard-owner": { models: modelRuntime("openclaw") },
          },
        },
      },
    },
    {
      name: "explicit fleet without a system owner",
      rejection: "Multiple agents are configured",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, "guard-owner": {} },
        },
      },
    },
    {
      name: "wildcard default model ahead of provider policy",
      cfg: {
        agents: { defaults: { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      },
    },
  ];
  it.each(
    runtimePolicyCases.flatMap(({ name, cfg, rejection }) =>
      (rejection ? [false] : [false, true]).map((accepted) => ({
        name,
        cfg,
        rejection,
        accepted,
      })),
    ),
  )(
    "preserves runtime policy from $name (accepted: $accepted)",
    async ({ cfg: input, accepted, rejection }) => {
      const { runtime, prompter } = await oauthFixture(accepted);
      const cfg = structuredClone(input);
      const original = structuredClone(cfg);
      const configuring = reefSetupWizard.configureInteractive({
        cfg,
        prompter: prompter as never,
      });

      if (rejection) {
        await expect(configuring).rejects.toThrow(rejection);
        expect(cfg).toEqual(original);
        expect(prompter.confirm).not.toHaveBeenCalled();
        return;
      }
      if (accepted) {
        const result = await configuring;
        expect(
          runtime.modelConfig.resolveModelRuntimePolicy({
            config: result.cfg,
            provider: "openai",
            modelId: "gpt-5.6-terra",
            agentId: result.cfg.agents?.defaults?.systemAgent?.agentId,
          }).policy?.id,
        ).toBe("codex");
        expect(result.cfg.agents).toEqual({
          ...original.agents,
          defaults: {
            ...original.agents?.defaults,
            models: {
              ...original.agents?.defaults?.models,
              "openai/gpt-5.6-terra": {
                ...original.agents?.defaults?.models?.["openai/gpt-5.6-terra"],
                agentRuntime: { id: "codex" },
              },
            },
          },
        });
        expect(result.cfg.models).toEqual(original.models);
      } else {
        await expect(configuring).rejects.toThrow(
          "left openai/gpt-5.6-terra on the openclaw agent runtime",
        );
      }
      expect(cfg).toEqual(original);
      expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
        message:
          "openai/gpt-5.6-terra currently uses the openclaw agent runtime. Reef OAuth requires codex; change this shared model runtime?",
        initialValue: false,
      });
    },
  );

  it.each([
    {
      name: "releases a definitively rejected claim",
      claim: new ReefRelayError(409, "handle_unavailable"),
      probe: "unknown_handle",
      error: "handle_unavailable",
      bound: false,
    },
    {
      name: "keeps an ambiguous claim",
      claim: new TypeError("connection reset"),
      probe: undefined,
      error: "connection reset",
      bound: true,
    },
    {
      name: "keeps a claim after an inconclusive ownership probe",
      claim: new ReefRelayError(409, "handle_unavailable"),
      probe: "invalid_signature",
      error: "invalid_signature",
      bound: true,
    },
  ])("$name", async ({ claim, probe, error, bound }) => {
    const runtime = await keyedRuntime();
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(claim);
    if (probe) {
      vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
        new ReefRelayError(401, probe),
      );
    }
    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: createPrompter() as never }),
    ).rejects.toThrow(error);
    const binding = await loadReefIdentityBinding(runtime);
    if (bound) {
      expect(binding).toEqual({ handle: "molty", relayUrl: "https://reefwire.ai" });
    } else {
      expect(binding).toBeUndefined();
    }
  });

  it("declares its persistence boundary before writing keys or creating the handle", async () => {
    const runtime = installRuntime();
    const beforePersistentEffect = vi.fn(async () => {
      await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    });
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockImplementation(async () => {
      expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
      return { handle: "molty", key_epoch: 1 };
    });
    const prompter = createPrompter("molty", true);

    await reefSetupWizard.configureInteractive({
      cfg: {},
      prompter: prompter as never,
      options: { beforePersistentEffect },
    });

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    await expect(loadKeys(runtime)).resolves.toBeDefined();
  });
});
