// Sandbox tool policy tests cover effective allow/deny merging and blocked-tool
// guidance for sandboxed agent sessions.
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { ToolAllowDenyPolicyConfig } from "../../config/types.tools.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  formatSandboxToolPolicyBlockedMessage as formatSandboxToolPolicyBlockedMessageBase,
  resolveOwnedSessionSandboxRuntimeStatus,
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

describe("sandbox/tool-policy", () => {
  it("merges sandbox alsoAllow into the default sandbox allowlist", () => {
    const cfg = policyConfig(undefined, { alsoAllow: ["message", "tts"] });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "tavern");
    expect(resolved.allow).toContain("message");
    expect(resolved.allow).toContain("tts");
    expect(resolved.sources.allow).toEqual({
      source: "agent",
      key: "agents.entries.*.tools.sandbox.tools.alsoAllow",
    });
  });

  it("lets explicit sandbox allow remove entries from the default sandbox denylist", () => {
    const cfg = policyConfig({ allow: ["browser"] });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toContain("browser");
    expect(resolved.deny).not.toContain("browser");
    expect(isToolAllowed(resolved, "browser")).toBe(true);
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
    // An empty allowlist means allow all except denies; alsoAllow should only
    // remove matching default denies, not turn allow-all into allow-some.
    const cfg = policyConfig({ allow: [], alsoAllow: ["browser"] });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.allow).toStrictEqual([]);
    expect(resolved.deny).not.toContain("browser");
    expect(isToolAllowed(resolved, "read")).toBe(true);
    expect(isToolAllowed(resolved, "browser")).toBe(true);
    expect(resolved.deny).toContain("computer");
    expect(isToolAllowed(resolved, "computer")).toBe(false);
  });

  it("keeps canonical sandbox config and runtime status aligned with the effective resolver", () => {
    const cfg = loadedConfig(
      policyConfig({ allow: ["browser"] }, { alsoAllow: ["message", "tts"] }),
    );

    const sandbox = resolveSandboxConfigForAgent(cfg, "tavern");
    const runtime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:tavern:main",
    });
    for (const policy of [sandbox.tools, runtime.toolPolicy]) {
      expect(policy.allow).toEqual(expect.arrayContaining(["browser", "message", "tts"]));
      expect(policy.deny).not.toContain("browser");
    }
    expect(
      formatSandboxToolPolicyBlockedMessage({
        cfg,
        sessionKey: "agent:tavern:main",
        toolName: "message",
        preparedRuntimeStatus: runtime,
      }),
    ).toBeUndefined();
  });

  it("classifies a session without materializing container settings", () => {
    const cfg = loadedConfig(policyConfig({ allow: ["browser"] }));
    const sandbox = cfg.agents!.defaults!.sandbox!;
    let containerReads = 0;
    for (const key of ["docker", "browser", "prune"]) {
      Object.defineProperty(sandbox, key, {
        get: () => {
          containerReads += 1;
          return undefined;
        },
      });
    }
    const request = {
      cfg,
      sessionKey: "agent:main:guest",
      preparedSessionEntry: { sandbox: "required" as const },
    };
    const runtime = resolvePreparedSandboxRuntimeStatus(request);
    expect(runtime).toMatchObject({ sandboxed: true, workspaceAccess: "none", mode: "all" });
    expect(runtime.toolPolicy.allow).toContain("browser");
    expect(containerReads).toBe(0);
    sandbox.ssh = { workspaceRoot: "relative/path" };
    expect(() => resolvePreparedSandboxRuntimeStatus(request)).toThrow(
      "Sandbox SSH workspaceRoot must be an absolute POSIX path",
    );
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

  it.each([
    ["agent:worker:discord:default:direct:peer-42", true],
    ["agent:worker:main", false],
  ] as const)(
    "classifies borrowed %s under its own sandbox agent (sandboxed=%s)",
    (classificationSessionKey, sandboxed) => {
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: {
            main: {},
            worker: {
              sandbox: { mode: "non-main", scope: "agent" },
              tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
            },
          },
        },
      } satisfies OpenClawConfig;
      const runtime = resolveSandboxRuntimeStatus({
        cfg,
        sessionKey: "agent:main:main",
        agentId: "main",
        classificationSessionKey,
        classificationAgentId: "worker",
      });
      expect(runtime).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:main",
        classificationAgentId: "worker",
        classificationSessionKey,
        sandboxed,
      });
      expect(runtime.toolPolicy.deny).toContain("sessions_list");
    },
  );

  it.each([
    { classificationSessionKey: "agent:worker:main", classificationAgentId: "main" },
    { classificationSessionKey: "global", classificationAgentId: undefined },
  ])(
    "rejects ambiguous or conflicting independent classification: $classificationSessionKey",
    (classification) => {
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {}, worker: {} },
        },
      } satisfies OpenClawConfig;

      expect(() =>
        resolveSandboxRuntimeStatus({
          cfg,
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
        agents: {
          ownership: "explicit",
          entries: {
            main: { sandbox: { mode: "off" } },
            work: { sandbox: { mode: "all", scope: "agent" } },
          },
        },
      } satisfies OpenClawConfig;

      const runtime = resolveSandboxRuntimeStatus({
        cfg,
        sessionKey,
        agentId: "work",
      });

      expect(runtime).toMatchObject({
        agentId: "work",
        sessionKey,
        classificationAgentId: "work",
        classificationSessionKey: sessionKey,
        sandboxed: true,
      });
      expect(() =>
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey,
          agentId: "work",
          classificationSessionKey: "other-bare-session",
        }),
      ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    },
  );

  it("preserves physical legacy ownership and global-mode semantics for prepared rows", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, work: { sandbox: { mode: "non-main" } } },
      },
      session: { scope: "global", store: path.join(sessionDirs.make(), "sessions.json") },
    } satisfies OpenClawConfig;
    const params = { cfg, agentId: "work", sessionKey: "global", preparedSessionEntry: {} };
    expect(resolveOwnedSessionSandboxRuntimeStatus(params)).toMatchObject({
      agentId: "work",
      classificationAgentId: "work",
      classificationSessionKey: "global",
      sandboxed: false,
    });
    expect(
      resolveOwnedSessionSandboxRuntimeStatus({ ...params, sessionKey: "unknown" }).sandboxed,
    ).toBe(true);
    expect(
      resolveOwnedSessionSandboxRuntimeStatus({
        ...params,
        preparedSessionEntry: { sandbox: "required" },
      }).sandboxed,
    ).toBe(true);
    expect(() => resolvePreparedSandboxRuntimeStatus(params)).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
  });

  it("keeps explicit sandbox deny precedence over allow and alsoAllow", () => {
    const cfg = policyConfig({
      allow: ["browser"],
      alsoAllow: ["message"],
      deny: ["browser", "message"],
    });

    const resolved = resolveSandboxToolPolicyForAgent(cfg, "main");
    expect(resolved.deny).toContain("browser");
    expect(resolved.deny).toContain("message");
    expect(isToolAllowed(resolved, "browser")).toBe(false);
    expect(isToolAllowed(resolved, "message")).toBe(false);
  });

  it("keeps blocked-tool guidance glob-aware and shell-safe", () => {
    // The guidance embeds a copy-paste command; quote the real session key while
    // keeping the displayed session line compact and terminal-safe.
    const sessionKey = "agent:main:weird session;rm -rf /";
    const cfg = policyConfig({ deny: ["WEB_*"] });

    const message = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "web_fetch",
    });

    expect(message).toContain('Tool "web_fetch" blocked by sandbox tool policy');
    expect(message).toContain("tools.sandbox.tools.deny");
    expect(message).not.toContain(`Session: ${sessionKey}`);
    expect(message).toContain("Session: agent:… -rf /");
    expect(message).toContain(
      "openclaw sandbox explain --session 'agent:main:weird session;rm -rf /'",
    );
  });

  it.each([
    {
      boundary: "prefix",
      sessionKey: `abcde\u{1f600}middle123456`,
      expectedLabel: "abcde…123456",
    },
    {
      boundary: "suffix",
      sessionKey: `abcdefmiddle\u{1f600}12345`,
      expectedLabel: "abcdef…12345",
    },
    {
      boundary: "both",
      sessionKey: `abcde\u{1f600}middle\u{1f600}12345`,
      expectedLabel: "abcde…12345",
    },
  ])(
    "keeps redacted session keys UTF-16 safe at the $boundary boundary",
    ({ sessionKey, expectedLabel }) => {
      const cfg = policyConfig({ deny: ["browser"] });

      const message = formatSandboxToolPolicyBlockedMessage({
        cfg,
        sessionKey,
        toolName: "browser",
      });

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
    const cfg = policyConfig({ deny: ["browser"] });

    const message = formatSandboxToolPolicyBlockedMessage({
      cfg,
      sessionKey,
      toolName: "browser",
    });

    const sessionLine = message?.split("\n").find((line) => line.startsWith("Session: "));
    expect(sessionLine).toBe("Session: agent:…\\n12345");
    expect(sessionLine).not.toContain(sessionKey);
    expect(sessionLine).toContain("\\n");
    expect(message).toContain("openclaw sandbox explain --agent main");
    expect(message).not.toContain("--session");
  });
});
