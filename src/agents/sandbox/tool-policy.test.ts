import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { ToolAllowDenyPolicyConfig } from "../../config/types.tools.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveSandboxConfigForAgent as resolveSandboxConfigForAgentBase } from "./config.js";
import {
  formatSandboxToolPolicyBlockedMessage as formatSandboxToolPolicyBlockedMessageBase,
  resolvePreparedSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusAsync,
} from "./runtime-status.js";
import {
  isToolAllowed,
  resolveSandboxToolPolicyForAgent as resolveSandboxToolPolicyForAgentBase,
} from "./tool-policy.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-required-sandbox-");

function policyConfig(
  tools?: ToolAllowDenyPolicyConfig,
  agentTools?: ToolAllowDenyPolicyConfig,
): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { mode: "all", scope: "agent" } },
      ...(agentTools === undefined
        ? {}
        : { entries: { tavern: { tools: { sandbox: { tools: agentTools } } } } }),
    },
    ...(tools === undefined ? {} : { tools: { sandbox: { tools } } }),
  };
}

function loadedConfig(config: OpenClawConfig | undefined): OpenClawConfig {
  return createCanonicalAgentConfigFixture(config).config;
}

function resolveSandboxConfigForAgent(config: OpenClawConfig, agentId: string) {
  return resolveSandboxConfigForAgentBase(loadedConfig(config), agentId);
}

function resolveSandboxToolPolicyForAgent(config: OpenClawConfig, agentId: string) {
  return resolveSandboxToolPolicyForAgentBase(loadedConfig(config), agentId);
}

function resolveSandboxRuntimeStatus(
  params: Omit<Parameters<typeof resolvePreparedSandboxRuntimeStatus>[0], "preparedSessionEntry">,
) {
  return resolvePreparedSandboxRuntimeStatus({
    ...params,
    cfg: loadedConfig(params.cfg),
    preparedSessionEntry: null,
  });
}

function formatSandboxToolPolicyBlockedMessage(
  params: Omit<
    Parameters<typeof formatSandboxToolPolicyBlockedMessageBase>[0],
    "preparedRuntimeStatus"
  > & { preparedRuntimeStatus?: ReturnType<typeof resolvePreparedSandboxRuntimeStatus> },
) {
  return formatSandboxToolPolicyBlockedMessageBase({
    ...params,
    cfg: loadedConfig(params.cfg),
    preparedRuntimeStatus: params.preparedRuntimeStatus ?? resolveSandboxRuntimeStatus(params),
  });
}

function guidanceMessage(sessionKey: string, deny = "browser", toolName = "browser") {
  return formatSandboxToolPolicyBlockedMessage({
    cfg: policyConfig({ deny: [deny] }),
    sessionKey,
    toolName,
  });
}

function explicitAgents(entries: NonNullable<OpenClawConfig["agents"]>["entries"]): OpenClawConfig {
  return { agents: { ownership: "explicit", entries } };
}

describe("sandbox/tool-policy", () => {
  it("merges sandbox alsoAllow into the default sandbox allowlist", () => {
    const cfg = policyConfig(undefined, { alsoAllow: ["message", "tts"] });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "tavern");
    expect(resolved.allow).toEqual(expect.arrayContaining(["message", "tts"]));
    expect(resolved.sources.allow).toEqual({
      source: "agent",
      key: "agents.entries.*.tools.sandbox.tools.alsoAllow",
    });
  });

  it.each([["image"], ["image*"]] as const)(
    "keeps legacy %s denies fail-closed for view_image until Doctor migrates them",
    (legacyDeny) => {
      const cfg = policyConfig({ allow: ["read"], deny: [legacyDeny] });

      const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
      expect(resolved.deny).toContain("view_image");
      expect(isToolAllowed(resolved, "view_image")).toBe(false);
    },
  );

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    const cfg = policyConfig({ allow: [], alsoAllow: ["browser"] });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toStrictEqual([]);
    expect(resolved.deny).not.toContain("browser");
    expect(["read", "browser"].map((name) => isToolAllowed(resolved, name))).toEqual([true, true]);
    expect(resolved.deny).toContain("computer");
    expect(isToolAllowed(resolved, "computer")).toBe(false);
  });

  it("keeps canonical sandbox config and runtime status aligned with the effective resolver", () => {
    const cfg = policyConfig({ allow: ["browser"] }, { alsoAllow: ["message", "tts"] });

    const sessionKey = "agent:tavern:main";
    const runtime = resolveSandboxRuntimeStatus({ cfg, sessionKey });
    for (const policy of [resolveSandboxConfigForAgent(cfg, "tavern").tools, runtime.toolPolicy]) {
      expect(policy.allow).toEqual(expect.arrayContaining(["browser", "message", "tts"]));
      expect(policy.deny).not.toContain("browser");
      expect(isToolAllowed(policy, "browser")).toBe(true);
    }
    expect(
      formatSandboxToolPolicyBlockedMessage({
        cfg,
        sessionKey,
        toolName: "message",
        preparedRuntimeStatus: runtime,
      }),
    ).toBeUndefined();
  });

  it("forces a persisted sandbox requirement even when the agent sandbox mode is off", async () => {
    const sessionKey = "agent:main:guest";
    const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
    const entry = {
      sessionId: "guest-session",
      updatedAt: 1,
      sandbox: "required" as const,
      createdActor: { type: "human" as const, source: "unknown" as const, id: "guest-principal" },
    };
    await replaceSessionEntry({ sessionKey, storePath }, entry);
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        defaults: { sandbox: { mode: "off", scope: "session", workspaceAccess: "rw" } },
        entries: { main: {} },
      },
    };

    const runtime = await resolveSandboxRuntimeStatusAsync({ cfg: loadedConfig(cfg), sessionKey });
    expect(runtime).toMatchObject({
      sandboxRequired: true,
      isolationSubject: { kind: "session", sessionKey },
      sandboxed: true,
      workspaceAccess: "ro",
    });
    const blockedMessage = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "browser",
      preparedRuntimeStatus: runtime,
    });
    expect(blockedMessage).toContain("create a new session under an authorized role");
    expect(blockedMessage).not.toContain("sandbox.mode=off");
  });

  it("classifies a borrowed runtime key under its own sandbox agent", () => {
    const cfg = explicitAgents({
      main: {},
      worker: {
        sandbox: { mode: "non-main", scope: "agent" },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      },
    });

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      classificationSessionKey: "agent:worker:discord:default:direct:peer-42",
      classificationAgentId: "worker",
    });

    expect(runtime).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
      classificationAgentId: "worker",
      classificationSessionKey: "agent:worker:discord:default:direct:peer-42",
      sandboxed: true,
    });
    expect(runtime.toolPolicy.deny).toContain("sessions_list");
  });

  it("recognizes the classification agent's main session in non-main mode", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: { sandbox: { mode: "non-main", scope: "agent" } },
        },
      },
    } satisfies OpenClawConfig;

    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      classificationSessionKey: "agent:worker:main",
      classificationAgentId: "worker",
    });

    expect(runtime.agentId).toBe("main");
    expect(runtime.classificationAgentId).toBe("worker");
    expect(runtime.sandboxed).toBe(false);
  });

  it.each([
    { classificationSessionKey: "agent:worker:main", classificationAgentId: "main" },
    { classificationSessionKey: "global", classificationAgentId: undefined },
  ])(
    "rejects ambiguous or conflicting independent classification: $classificationSessionKey",
    (classification) => {
      expect(() =>
        resolveSandboxRuntimeStatus({
          cfg: explicitAgents({ main: {}, worker: {} }),
          sessionKey: "agent:main:main",
          agentId: "main",
          ...classification,
        }),
      ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    },
  );

  it.each(["agent:work:telegram:default:direct:42", "global"])(
    "keeps %s ownership as the sandbox classification when none is supplied",
    (sessionKey) => {
      const cfg = {
        session: {
          store: path.join(sessionDirs.make(), "{agentId}", "sessions.json"),
        },
        ...explicitAgents({
          main: { sandbox: { mode: "off" } },
          work: { sandbox: { mode: "all", scope: "agent" } },
        }),
      } satisfies OpenClawConfig;

      const params = { cfg, sessionKey, agentId: "work" };
      const runtime = resolveSandboxRuntimeStatus(params);

      expect(runtime).toMatchObject({
        agentId: "work",
        sessionKey,
        classificationAgentId: "work",
        classificationSessionKey: sessionKey,
        sandboxed: true,
      });
      expect(() =>
        resolveSandboxRuntimeStatus({
          ...params,
          classificationSessionKey: "other-bare-session",
        }),
      ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    },
  );

  it("keeps explicit sandbox deny precedence over allow and alsoAllow", () => {
    const cfg = policyConfig({
      allow: ["browser"],
      alsoAllow: ["message"],
      deny: ["browser", "message"],
    });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.deny).toEqual(expect.arrayContaining(["browser", "message"]));
    expect(["browser", "message"].map((name) => isToolAllowed(resolved, name))).toEqual([
      false,
      false,
    ]);
  });

  it("keeps blocked-tool guidance glob-aware and shell-safe", () => {
    const sessionKey = "agent:main:weird session;rm -rf /";
    const message = guidanceMessage(sessionKey, "WEB_*", "web_fetch");

    expect(message).toContain('Tool "web_fetch" blocked by sandbox tool policy');
    expect(message).toContain("tools.sandbox.tools.deny");
    expect(message).not.toContain(`Session: ${sessionKey}`);
    expect(message).toContain("Session: agent:… -rf /");
    expect(message).toContain(
      "openclaw sandbox explain --session 'agent:main:weird session;rm -rf /'",
    );
  });

  it.each([
    ["prefix", `abcde\u{1f600}middle123456`, "abcde…123456"],
    ["suffix", `abcdefmiddle\u{1f600}12345`, "abcdef…12345"],
    ["both", `abcde\u{1f600}middle\u{1f600}12345`, "abcde…12345"],
  ])(
    "keeps redacted session keys UTF-16 safe at the %s boundary",
    (_boundary, sessionKey, expectedLabel) => {
      const message = guidanceMessage(sessionKey);

      const sessionLine = message?.split("\n").find((line) => line.startsWith("Session: "));
      const sessionLabel = sessionLine?.slice("Session: ".length);
      expect(sessionLabel).toBe(expectedLabel);
      expect(sessionLabel?.length).toBeLessThanOrEqual(13);
      expect(sessionLabel).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
      expect(message).toContain(`openclaw sandbox explain --session '${sessionKey}'`);
    },
  );

  it("avoids terminal injection for control-character session keys", () => {
    const sessionKey = "agent:main:abcde\n12345";
    const message = guidanceMessage(sessionKey);

    const sessionLine = message?.split("\n").find((line) => line.startsWith("Session: "));
    expect(sessionLine).toBe("Session: agent:…\\n12345");
    expect(sessionLine).not.toContain(sessionKey);
    expect(sessionLine).toContain("\\n");
    expect(message).toContain("openclaw sandbox explain --agent main");
    expect(message).not.toContain("--session");
  });
});
