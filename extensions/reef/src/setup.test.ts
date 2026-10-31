import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setReefRuntime } from "./runtime.js";
import { reefSetupWizard } from "./setup.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  reserveReefIdentityBinding,
} from "./state.js";
import { createRuntime } from "./state.test-support.js";
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

function configure(cfg: OpenClawConfig = {}, prompter = createPrompter()) {
  return reefSetupWizard.configureInteractive({ cfg, prompter: prompter as never });
}

type RuntimeId = "codex" | "openclaw";
function modelRuntime(id: RuntimeId) {
  return { "openai/gpt-5.6-terra": { agentRuntime: { id } } };
}

function explicitRuntime(main: RuntimeId, owner: RuntimeId, shared = false): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: {
        systemAgent: { agentId: "guard-owner" },
        ...(shared ? { models: modelRuntime("openclaw") } : {}),
      },
      entries: {
        main: { models: modelRuntime(main) },
        "guard-owner": { models: modelRuntime(owner) },
      },
    },
  };
}

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
  const runtime = createRuntime(stateDir);
  runtime.state.resolveStateDir = () => stateDir;
  setReefRuntime(runtime);
  return runtime;
}

async function oauthFixture(accepted = false) {
  const runtime = installRuntime();
  await generateAndStoreKeys(runtime);
  vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
    handle: "molty",
    key_epoch: 1,
  });
  return { runtime, prompter: createPrompter("molty", "oauth", accepted) };
}

it("rejects a different handle before reusing the stored identity keys", async () => {
  const runtime = installRuntime();
  const reservation = await reserveReefIdentityBinding(runtime, {
    handle: "existing",
    relayUrl: "https://reefwire.ai",
  });
  await finalizeReefIdentityBinding(runtime, reservation);
  const prompter = createPrompter("replacement");

  await expect(configure({}, prompter)).rejects.toThrow(
    "already holds the Reef identity @existing",
  );
});

const runtimeCases: Array<{
  name: string;
  cfg: OpenClawConfig;
  outcome: "default" | "preserve" | "reject" | "confirm";
  rejection?: string;
}> = [
  { name: "unconfigured runtime", cfg: {}, outcome: "default" },
  {
    name: "system agent Codex ahead of shared policy",
    cfg: explicitRuntime("openclaw", "codex", true),
    outcome: "preserve",
  },
  {
    name: "system agent exact model",
    cfg: explicitRuntime("codex", "openclaw"),
    outcome: "reject",
    rejection: "agent-specific runtime policy",
  },
  {
    name: "explicit fleet without a system owner",
    outcome: "reject",
    rejection: "Multiple agents are configured",
    cfg: { agents: { ownership: "explicit", entries: { main: {}, "guard-owner": {} } } },
  },
  {
    name: "wildcard default ahead of provider policy",
    outcome: "confirm",
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
  runtimeCases.flatMap(({ name, cfg, outcome, rejection }) =>
    (outcome === "confirm" ? [false, true] : [false]).map((accepted) => ({
      name,
      cfg,
      outcome,
      rejection,
      accepted,
    })),
  ),
)(
  "configures OAuth with $name (accepted: $accepted)",
  async ({ cfg: original, outcome, rejection, accepted }) => {
    const { runtime, prompter } = await oauthFixture(accepted);
    const cfg = structuredClone(original);
    const configuring = configure(cfg, prompter);
    if (outcome === "reject" || (outcome === "confirm" && !accepted)) {
      await expect(configuring).rejects.toThrow(
        rejection ?? "left openai/gpt-5.6-terra on the openclaw agent runtime",
      );
    } else {
      const { cfg: result } = await configuring;
      expect(result.channels?.reef?.guard).toEqual({
        provider: "openai",
        authMode: "oauth",
        authProfileId: "openai:work",
        pinnedModel: "gpt-5.6-terra",
        policyVersion: "reef-v1",
        timeoutMs: 120_000,
      });
      expect(result.plugins?.entries?.reef?.llm).toEqual({
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.6-terra"],
        allowedCompletionModels: ["openai/gpt-5.6-terra"],
      });
      if (outcome === "preserve") {
        expect({ agents: result.agents, models: result.models }).toEqual({
          agents: original.agents,
          models: original.models,
        });
      } else if (outcome === "default") {
        expect(result.agents?.defaults?.models?.["openai/gpt-5.6-terra"]).toEqual({
          agentRuntime: { id: "codex" },
        });
      } else {
        expect(
          runtime.modelConfig.resolveModelRuntimePolicy({
            config: result,
            provider: "openai",
            modelId: "gpt-5.6-terra",
            agentId: result.agents?.defaults?.systemAgent?.agentId,
          }).policy?.id,
        ).toBe("codex");
        expect(result.agents).toEqual({
          ...original.agents,
          defaults: {
            ...original.agents?.defaults,
            models: { ...original.agents?.defaults?.models, ...modelRuntime("codex") },
          },
        });
        expect(result.models).toEqual(original.models);
      }
      expect(JSON.stringify(result)).not.toContain("apiKeyEnv");
    }
    expect(cfg).toEqual(original);
    if (outcome === "confirm") {
      expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
        message:
          "openai/gpt-5.6-terra currently uses the openclaw agent runtime. Reef OAuth requires codex; change this shared model runtime?",
        initialValue: false,
      });
    } else {
      expect(prompter.confirm).not.toHaveBeenCalled();
    }
  },
);

it.each([
  [
    "releases a definitively rejected claim",
    new ReefRelayError(409, "handle_unavailable"),
    "unknown_handle",
    false,
  ],
  ["keeps an ambiguous claim", new TypeError("connection reset"), undefined, true],
  [
    "keeps an inconclusively probed claim",
    new ReefRelayError(409, "handle_unavailable"),
    "invalid_signature",
    true,
  ],
] as const)("%s", async (_name, claim, probe, bound) => {
  const runtime = installRuntime();
  await generateAndStoreKeys(runtime);
  vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(claim);
  if (probe) {
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
      new ReefRelayError(401, probe),
    );
  }
  await expect(configure()).rejects.toThrow(probe === "invalid_signature" ? probe : claim.message);
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
