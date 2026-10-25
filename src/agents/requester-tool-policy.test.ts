import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prepareReplyToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolvePluginHarnessToolPolicies } from "./harness/execution-environment.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

describe("resolveRequesterToolPolicies", () => {
  const requester = "agent:main:discord:direct:alice";
  const runtimeDeny = { deny: ["group:runtime", "group:fs"] };
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-requester-policy-");
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
  });

  async function writeSession(sessionKey: string, patch: Partial<SessionEntry>) {
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: `${sessionKey}-session`,
      updatedAt: Date.now(),
      ...patch,
    } as SessionEntry);
  }

  function config(overrides: OpenClawConfig = {}): OpenClawConfig {
    return {
      ...overrides,
      session: { ...overrides.session, store: storePath },
      tools: {
        ...overrides.tools,
        toolsBySender: {
          "*": { deny: ["group:runtime", "group:fs"] },
          "id:alice": {},
          ...overrides.tools?.toolsBySender,
        },
      },
    };
  }

  function resolvePolicy(params: Parameters<typeof resolveRequesterToolPolicies>[0]) {
    return withPreparedSessionCapabilityRead(() =>
      resolveRequesterToolPolicies({ config: config(), agentId: "main", ...params }),
    );
  }

  function writeChild(sessionKey: string, patch: Partial<SessionEntry> = {}) {
    return writeSession(sessionKey, {
      spawnedBy: requester,
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      inheritedToolPolicyVersion: 1,
      ...patch,
    });
  }

  function expectCurrentPolicy(result: ReturnType<typeof resolveRequesterToolPolicies>) {
    expectCurrentSource(result);
    expect(result.senderPolicy).toEqual(runtimeDeny);
  }

  function expectCurrentSource(result: ReturnType<typeof resolveRequesterToolPolicies>) {
    expect(result).toMatchObject({ delegated: false, requesterPolicySource: "current-request" });
  }

  function workerConfig(overrides: OpenClawConfig = {}) {
    return config({
      agents: {
        entries: {
          front: { subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] } },
          worker: {},
        },
      },
      ...overrides,
    });
  }

  function expectInherited(
    result: ReturnType<typeof resolveRequesterToolPolicies>,
    source: "persisted-child" | "completion-handoff",
    policy: { allow?: string[]; deny?: string[] },
  ) {
    expect(result).toMatchObject({ delegated: true, requesterPolicySource: source });
    expect(result.inheritedToolPolicy).toEqual(policy);
  }

  it("retains dashboard delegation and revocation fallback without an injected capability store", async () => {
    const root = "agent:front:main";
    const visible = "agent:worker:dashboard:coding";
    const helper = "agent:worker:subagent:helper";
    const cfg = workerConfig({
      tools: { toolsBySender: { "*": {} } },
    });
    const delegatedToolPolicy = {
      requesterSessionKey: root,
      targetAgentId: "worker",
      deny: [],
      requesterDeny: ["exec"],
    };
    const visibleEntry: SessionEntry = {
      sessionId: `${visible}-session`,
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: root,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
      delegatedToolPolicy,
    };
    await writeSession(visible, visibleEntry);
    await writeSession(helper, {
      spawnDepth: 2,
      spawnedBy: visible,
      inheritedToolPolicyVersion: 1,
      inheritedToolDeny: ["exec"],
      delegatedToolPolicy: { ...delegatedToolPolicy, requesterDeny: [] },
    });
    const resolve = () =>
      resolveRequesterToolPolicies({
        config: cfg,
        sessionKey: visible,
        preparedSessionEntry: { sessionKey: visible, entry: visibleEntry },
        ...completionHandoffFacts(helper, visible),
      });
    const resolved = await withPreparedSessionCapabilityRead(resolve);
    expect(resolved.delegatedToolPolicy).toMatchObject({
      requesterSessionKey: root,
      targetAgentId: "worker",
    });
    expect(resolved.inheritedToolPolicy?.deny ?? []).not.toContain("exec");
    const harness = await withPreparedSessionCapabilityRead(() =>
      resolvePluginHarnessToolPolicies(
        {
          config: cfg,
          agentId: "worker",
          sessionKey: visible,
          preparedSessionEntry: visibleEntry,
          provider: "fixture",
          modelId: "fixture",
        },
        resolved.subagentPolicy?.deny,
      ),
    );
    expect(harness.toolPolicyRestricted).toBe(true);
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect((await withPreparedSessionCapabilityRead(resolve)).inheritedToolPolicy?.deny).toContain(
      "exec",
    );
  });

  function completionHandoffFacts(sourceSessionKey: string, targetSessionKey: string) {
    const targetSessionId = `${targetSessionKey}-session`;
    return {
      trustedInternalHandoff: {
        kind: "subagent-completion" as const,
        sourceSessionKey,
        targetSessionKey,
        targetSessionId,
        provider: "openai",
        model: "gpt-test",
      },
      sessionId: targetSessionId,
      modelProvider: "openai",
      modelId: "gpt-test",
      inputProvenance: {
        kind: "inter_session" as const,
        sourceSessionKey,
        sourceTool: "subagent_announce",
      },
    };
  }

  it("classifies sender/channel restriction provenance", () => {
    const policy = { allow: ["read", "sessions_spawn"] };
    for (const source of ["sender", "conversation"] as const) {
      const result = resolveRequesterToolPolicies({
        config: config({
          tools: {
            allow: ["read", "sessions_spawn"],
            toolsBySender: { "id:alice": source === "sender" ? policy : {} },
          },
        }),
        sessionKey: requester,
        senderId: "alice",
        ...(source === "conversation" ? { conversationPolicy: policy } : {}),
      });
      expect(result.inheritedToolPolicySource).toBe("sender");
    }
  });

  it.each([
    "current",
    "revoked",
    "stale requester",
    "external sender",
    "different allow",
    "different deny",
    "different source",
    "missing lineage",
  ])("resolves a settled batch with %s authority", async (authority) => {
    const targetSessionKey = "agent:main:main";
    const sourceSessionKeys = ["agent:main:subagent:first", "agent:main:subagent:second"] as const;
    for (const [index, sessionKey] of sourceSessionKeys.entries()) {
      await writeSession(sessionKey, {
        spawnedBy: targetSessionKey,
        spawnDepth: 1,
        inheritedToolPolicyVersion: index === 1 && authority === "missing lineage" ? undefined : 1,
        inheritedToolAllow:
          index === 0
            ? ["read", "exec"]
            : authority === "different allow"
              ? ["read"]
              : ["exec", "read"],
        inheritedToolDeny:
          index === 1 && authority === "different deny" ? ["exec", "write"] : ["write"],
        inheritedToolPolicySource:
          index === 1 && authority === "different source" ? undefined : "sender",
      });
    }
    let current = true;
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey,
      targetSessionId: "requester-session",
      idempotencyKey: "settled-batch",
      settleBatch: { sourceSessionKeys, isCurrent: () => current },
    };
    const consumption = {
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      provider: "openai",
      model: "gpt-test",
    };
    const trustedInternalHandoff = consumeSubagentCompletionToolHandoff(consumption);
    current = authority !== "revoked";
    const request = {
      config: config(),
      sessionKey: targetSessionKey,
      sessionId: registration.targetSessionId,
      inputProvenance: {
        kind: "inter_session" as const,
        sourceTool: "subagent_settle",
        sourceSessionKey: registration.sourceSessionKey,
      },
      trustedInternalHandoff,
    };
    const resolve = () =>
      resolveRequesterToolPolicies({
        ...request,
        sessionId:
          authority === "stale requester" ? "replacement-session" : registration.targetSessionId,
        ...(authority === "external sender" ? { senderId: "mallory" } : {}),
        modelProvider: consumption.provider,
        modelId: consumption.model,
        inputProvenance: {
          ...request.inputProvenance,
          kind: authority === "external sender" ? "external_user" : "inter_session",
        },
      });
    const result = await withPreparedSessionCapabilityRead(resolve);
    if (authority !== "current") {
      expect(result.delegated).toBe(false);
      expect(result.senderPolicy).toEqual(runtimeDeny);
      return;
    }
    expectInherited(result, "completion-handoff", { allow: ["read", "exec"], deny: ["write"] });
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.inheritedToolPolicySource).toBe("sender");

    const requesterOrigin = {
      sessionKey: targetSessionKey,
      messageProvider: "discord",
      senderId: "alice",
    };
    const snapshot = prepareReplyToolAuthority({
      run: {
        ...request,
        requesterOrigin,
        sessionFile: path.join(tempDir, "requester.jsonl"),
        workspaceDir: tempDir,
        provider: consumption.provider,
        model: consumption.model,
      },
    });
    try {
      const currentFingerprint = await snapshot.fingerprintAsync();
      const route = { provider: consumption.provider, model: consumption.model };
      const allowedProjection = await snapshot.projectRequesterAsync(
        { requesterOrigin, config: config() },
        route,
      );
      const deniedProjection = await snapshot.projectRequesterAsync(
        {
          requesterOrigin,
          config: config({ tools: { toolsBySender: { "id:alice": { deny: ["exec"] } } } }),
        },
        route,
      );
      expect(deniedProjection).not.toBe(allowedProjection);
      expect(snapshot.fingerprint(route)).toBe(currentFingerprint);
      current = false;
      expect(snapshot.fingerprint()).not.toBe(currentFingerprint);
    } finally {
      snapshot.close();
    }
  });

  it("uses a persisted projection for a spawn-owned dashboard child", async () => {
    const parentSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:dashboard:visible-child";
    await writeSession(childSessionKey, {
      spawnedBy: parentSessionKey,
      parentSessionKey,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["read", "sessions_spawn"],
      inheritedToolDeny: ["exec"],
    });

    const result = await resolvePolicy({
      sessionKey: childSessionKey,
      spawnedBy: parentSessionKey,
    });

    expectInherited(result, "persisted-child", {
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    });
    expect(result.senderPolicy).toBeUndefined();
    expect(result.groupPolicy).toBeUndefined();
    expect(result.subagentPolicy).toBeDefined();
  });

  it("keeps the sender snapshot while applying current non-sender restrictions", async () => {
    const childSessionKey = "agent:main:subagent:web-search";
    await writeChild(childSessionKey);
    const cfg = config({ tools: { toolsBySender: { "*": { deny: ["web_search"] } } } });

    const searchPolicy = (searchConfig: OpenClawConfig, sessionKey = childSessionKey) =>
      withPreparedSessionCapabilityRead(() =>
        resolveWebSearchToolPolicy({ config: searchConfig, agentId: "main", sessionKey }),
      );
    const denied = { allowed: false, persistentAllowed: false };
    expect(await searchPolicy(cfg)).toEqual({ allowed: true, persistentAllowed: true });
    expect(await searchPolicy({ ...cfg, tools: { ...cfg.tools, deny: ["web_search"] } })).toEqual(
      denied,
    );
    expect(await searchPolicy(cfg, "agent:main:subagent:forged")).toEqual(denied);
  });

  it("lets a session-event web_search entry pass only while current policy allows it", () => {
    const runtimeToolAllowlist = ["read", "web_search"];
    expect(resolveWebSearchToolPolicy({ runtimeToolAllowlist }).allowed).toBe(true);
    expect(resolveWebSearchToolPolicy({ runtimeToolAllowlist: [] })).toEqual({
      allowed: false,
      persistentAllowed: true,
    });
    expect(
      resolveWebSearchToolPolicy({
        runtimeToolAllowlist,
        config: { tools: { deny: ["web_search"] } },
      }).allowed,
    ).toBe(false);
  });

  it("does not re-resolve group sender policy for a verified child", async () => {
    const parentSessionKey = "agent:main:telegram:group:dev";
    const childSessionKey = "agent:main:subagent:group-child";
    await writeChild(childSessionKey, { spawnedBy: parentSessionKey });
    const group = { toolsBySender: { "*": { deny: ["read"] }, "id:alice": {} } };
    const cfg = config({ channels: { telegram: { groups: { dev: group } } } });

    const params = {
      config: cfg,
      spawnedBy: parentSessionKey,
      messageProvider: "telegram",
      groupId: "dev",
    };
    const child = await resolvePolicy({ ...params, sessionKey: childSessionKey });
    const forged = await resolvePolicy({ ...params, sessionKey: "agent:main:subagent:forged" });

    expect(child.delegated).toBe(true);
    expect(child.groupPolicy).toBeUndefined();
    expect(forged.delegated).toBe(false);
    expect(forged.groupPolicy).toEqual({ deny: ["read"] });
  });

  it.each(["partial lineage", "unversioned legacy", "sender identity", "external provenance"])(
    "applies current policy to a child with %s",
    async (kind) => {
      const childSessionKey = "agent:main:subagent:current-policy";
      const partial = kind === "partial lineage";
      const external = kind === "sender identity" || kind === "external provenance";
      if (partial) {
        await writeSession(childSessionKey, { spawnedBy: requester });
      } else {
        await writeChild(childSessionKey, {
          inheritedToolPolicyVersion: kind === "unversioned legacy" ? undefined : 1,
          inheritedToolDeny: ["message"],
          inheritedToolPolicySource: external ? "sender" : undefined,
        });
      }
      const result = await resolvePolicy({
        sessionKey: childSessionKey,
        ...(external ? { messageProvider: "discord" } : {}),
        ...(kind === "sender identity" ? { senderId: "bob" } : {}),
        ...(kind === "external provenance"
          ? { inputProvenance: { kind: "external_user" as const } }
          : {}),
      });
      expectCurrentPolicy(result);
      if (!partial) {
        expect(result.inheritedToolPolicy).toEqual({ deny: ["message"] });
      }
      if (external) {
        expect(result.inheritedToolPolicySource).toBe("sender");
      }
    },
  );

  it.each([false, true])(
    "applies current requester policy to a fresh child followup while retaining its ceiling (delegated=%s)",
    async (delegated) => {
      const requesterSessionKey = "agent:front:discord:direct:alice";
      const childSessionKey = "agent:worker:subagent:policy-admission";
      await writeChild(childSessionKey, {
        spawnedBy: requesterSessionKey,
        inheritedToolDeny: delegated ? ["message", "write"] : ["message"],
        ...(delegated
          ? {
              delegatedToolPolicy: {
                requesterSessionKey,
                targetAgentId: "worker",
                deny: ["message"],
                requesterDeny: ["message", "write"],
              },
            }
          : {}),
      });
      const cfg = workerConfig();
      const request = {
        agentId: "worker",
        sessionKey: childSessionKey,
        requesterOrigin: {
          sessionKey: requesterSessionKey,
          messageProvider: "discord",
          senderId: "alice",
        },
        inputProvenance: {
          kind: "inter_session" as const,
          sourceSessionKey: requesterSessionKey,
          sourceTool: "sessions_send",
        },
      };
      const admitted = await withPreparedSessionCapabilityRead(() =>
        resolveRequesterToolPolicies({ config: cfg, ...request }),
      );
      const nextConfig = config({
        ...cfg,
        tools: {
          ...cfg.tools,
          toolsBySender: { ...cfg.tools?.toolsBySender, "id:alice": { deny: ["exec"] } },
        },
      });
      const next = await withPreparedSessionCapabilityRead(() =>
        resolveRequesterToolPolicies({ config: nextConfig, ...request }),
      );

      expect(next.senderPolicy).toEqual({ deny: ["exec"] });
      expect(next.inheritedToolPolicy).toEqual({ deny: ["message"] });
      expect(next.inheritedToolPolicySource).toBe("sender");
      expect(admitted.senderPolicy).toBeUndefined();
      expect(admitted.inheritedToolPolicy).toEqual({ deny: ["message"] });
    },
  );

  it("fails closed when a trusted internal handoff has no configuration", () => {
    expect(() =>
      resolveRequesterToolPolicies({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        ...completionHandoffFacts("agent:ops:subagent:child", "agent:ops:main"),
      }),
    ).toThrow("Trusted internal handoff policy resolution requires configuration.");
  });

  it("restores a verified completion handoff to a distinct immutable completion owner", async () => {
    const controllerSessionKey = requester;
    const completionOwnerSessionKey = "agent:main:main";
    const childSessionKey = "agent:main:subagent:child";
    await writeChild(childSessionKey, {
      spawnedBy: controllerSessionKey,
      completionOwnerSessionKey,
      inheritedToolAllow: ["read", "exec"],
    });

    const handoff = completionHandoffFacts(childSessionKey, completionOwnerSessionKey);
    const result = await resolvePolicy({
      config: config({ tools: { toolsBySender: { "id:alice": { deny: ["exec"] } } } }),
      sessionKey: completionOwnerSessionKey,
      requesterOrigin: {
        sessionKey: controllerSessionKey,
        messageProvider: "discord",
        senderId: "alice",
      },
      ...handoff,
    });

    expectInherited(result, "completion-handoff", { allow: ["read", "exec"] });
    expect(result.senderPolicy).toBeUndefined();

    const controllerResult = await resolvePolicy({ sessionKey: controllerSessionKey, ...handoff });
    expectCurrentSource(controllerResult);
  });

  it("does not treat an ordinary dashboard key as a completion authority", async () => {
    const childSessionKey = "agent:main:dashboard:operator-thread";
    await writeSession(childSessionKey, { spawnDepth: 0 });

    const result = await resolvePolicy({
      sessionKey: "agent:main:main",
      ...completionHandoffFacts(childSessionKey, "agent:main:main"),
    });

    expectCurrentSource(result);
  });

  async function writeNestedLineage() {
    const requesterSessionKey = requester;
    const parentChildSessionKey = "agent:main:subagent:parent-child";
    const leafSessionKey = "agent:main:subagent:leaf";
    await writeChild(parentChildSessionKey, {
      spawnedBy: requesterSessionKey,
      inheritedToolDeny: ["exec"],
    });
    await writeChild(leafSessionKey, {
      spawnedBy: parentChildSessionKey,
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
      inheritedToolDeny: ["exec", "read"],
    });
    return { requesterSessionKey, parentChildSessionKey, leafSessionKey };
  }

  it.each([
    ["requester", ["exec"]],
    ["parent-child resume envelope", ["exec", "read"]],
  ] as const)("restores the nested completion projection for %s", async (target, deny) => {
    const { requesterSessionKey, parentChildSessionKey, leafSessionKey } =
      await writeNestedLineage();
    const sessionKey = target === "requester" ? requesterSessionKey : parentChildSessionKey;
    const result = await resolvePolicy({
      sessionKey,
      ...(target === "requester" ? {} : { subagentSessionKey: parentChildSessionKey }),
      ...completionHandoffFacts(leafSessionKey, sessionKey),
    });
    expectInherited(result, "completion-handoff", { deny: [...deny] });
  });

  it("fails closed for untrusted or mismatched completion handoffs", async () => {
    const childSessionKey = "agent:main:subagent:child";
    await writeChild(childSessionKey);
    const handoff = completionHandoffFacts(childSessionKey, requester);
    const resolveHandoff = (sessionKey: string, trusted = true) =>
      resolveRequesterToolPolicies({
        config: config(),
        agentId: "main",
        sessionKey,
        ...handoff,
        trustedInternalHandoff: trusted ? handoff.trustedInternalHandoff : undefined,
      });
    const untrusted = resolveHandoff(requester, false);
    const mismatched = resolveHandoff("agent:main:discord:direct:bob");
    const mismatchedCompletionOwner = resolveHandoff("agent:main:main");

    expectCurrentPolicy(untrusted);
    expectCurrentPolicy(mismatched);
    expectCurrentSource(mismatchedCompletionOwner);
  });
});
