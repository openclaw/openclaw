import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { preserveSessionInheritedToolPolicy } from "../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareDelegatedToolDenyFloor,
  resolveConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { projectConversationToolNames } from "./conversation-tool-policy-pipeline.js";
import {
  captureDelegatedToolPolicyAssertion,
  readDelegatedToolPolicy,
  selectDelegatedToolPolicy,
} from "./delegated-tool-policy.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";

const requester = "agent:front:main";
const child = "agent:worker:dashboard:task";
const fullDeny = ["exec", "write", "edit", "apply_patch"];
function config(): OpenClawConfig {
  return {
    agents: {
      entries: {
        front: {
          tools: { deny: fullDeny },
          subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] },
        },
        worker: {},
      },
    },
  };
}
function profile(
  cfg = config(),
  extra: Partial<Parameters<typeof resolveConversationCapabilityProfile>[0]> = {},
) {
  return resolveConversationCapabilityProfile({
    config: cfg,
    agentId: "front",
    sessionKey: requester,
    ...extra,
  });
}
function entry() {
  return {
    sessionId: "child-id",
    spawnedBy: requester,
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1 as const,
    inheritedToolDeny: fullDeny,
    delegatedToolPolicy: {
      requesterSessionKey: requester,
      targetAgentId: "worker",
      deny: ["browser"],
      requesterDeny: fullDeny,
    },
  };
}
function resolve(cfg = config(), patch: Partial<ReturnType<typeof entry>> = {}) {
  return resolveRequesterToolPolicies({
    config: cfg,
    agentId: "worker",
    sessionKey: child,
    preparedSessionCapabilityStore: { [child]: { ...entry(), ...patch } },
  });
}

describe("deny-only native tool delegation", () => {
  afterEach(() => clearRuntimeConfigSnapshot());
  it("prepares a floor without changing the requester's callable tools", () => {
    const p = profile();
    expect(prepareDelegatedToolDenyFloor(p)).toEqual({ policyAgentId: "front", deny: [] });
    expect(
      projectConversationToolNames({
        capabilityProfile: p,
        toolNames: ["read", "exec", "edit"],
        warn: () => {},
      }),
    ).toEqual(["read"]);
    expect(
      selectDelegatedToolPolicy({
        config: config(),
        requesterAgentId: "front",
        requesterSessionKey: requester,
        targetAgentId: "worker",
        floor: { policyAgentId: "front", deny: [] },
      }),
    ).toEqual({
      requesterSessionKey: requester,
      targetAgentId: "worker",
      deny: [],
      requesterDeny: [],
    });
  });

  it("cannot waive a borrowed agent policy using the execution agent grant", () => {
    const cfg = config();
    cfg.agents!.entries!.runner = {
      subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] },
    };
    expect(() =>
      selectDelegatedToolPolicy({
        config: cfg,
        requesterAgentId: "runner",
        requesterSessionKey: "agent:runner:main",
        targetAgentId: "worker",
        floor: prepareDelegatedToolDenyFloor(profile(cfg, { runSessionKey: "agent:runner:main" })),
      }),
    ).toThrow("policy owner differs");
  });

  it("preserves duplicate global, provider, sandbox, ancestor and owner denies", () => {
    const cfg = config();
    cfg.tools = { deny: ["exec"], byProvider: { test: { deny: ["write"] } } };
    cfg.agents!.entries!.front!.tools!.byProvider = { test: { deny: ["edit"] } };
    const p = profile(cfg, {
      modelProvider: "test",
      sandboxToolPolicy: { deny: ["apply_patch"] },
      sessionKey: "agent:front:subagent:parent",
      preparedSessionCapabilityStore: {
        "agent:front:subagent:parent": {
          sessionId: "ancestor",
          spawnedBy: requester,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny: ["browser"],
        },
      },
    });
    expect(prepareDelegatedToolDenyFloor(p, ["sessions"])?.deny).toEqual(
      expect.arrayContaining([...fullDeny, "browser", "sessions", "message"]),
    );
  });

  it.each(["profile", "global", "agent", "runtime", "sandbox", "ancestor"])(
    "keeps restrictive %s allow ceilings conservative",
    (kind) => {
      const cfg = config();
      const extra: Parameters<typeof profile>[1] = {};
      if (kind === "profile") {
        cfg.tools = { profile: "coding" };
      }
      if (kind === "global") {
        cfg.tools = { allow: ["read", "sessions_spawn"] };
      }
      if (kind === "agent") {
        cfg.agents!.entries!.front!.tools!.allow = ["read", "sessions_spawn"];
      }
      if (kind === "runtime") {
        extra.runtimeToolAllowlist = ["sessions_spawn"];
        extra.inheritRuntimeToolAllowlist = true;
      }
      if (kind === "sandbox") {
        extra.sandboxToolPolicy = { allow: ["read", "sessions_spawn"] };
      }
      if (kind === "ancestor") {
        extra.sessionKey = "agent:front:subagent:parent";
        extra.preparedSessionCapabilityStore = {
          "agent:front:subagent:parent": {
            sessionId: "parent",
            spawnedBy: requester,
            spawnDepth: 1,
            inheritedToolPolicyVersion: 1,
            inheritedToolAllow: ["read", "sessions_spawn"],
          },
        };
      }
      expect(prepareDelegatedToolDenyFloor(profile(cfg, extra))).toBeUndefined();
    },
  );

  it("retains sender restrictions even for an owner invocation", () => {
    expect(
      prepareDelegatedToolDenyFloor(
        profile(config(), { senderIsOwner: true, conversationToolPolicy: { deny: ["exec"] } }),
      ),
    ).toBeUndefined();
  });

  it.each(["missing grant", "missing allowAgents", "missing target", "same agent"])(
    "requires exact independent authorization: %s",
    (kind) => {
      const cfg = config();
      if (kind === "missing grant") {
        cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
      }
      if (kind === "missing allowAgents") {
        cfg.agents!.entries!.front!.subagents!.allowAgents = [];
      }
      if (kind === "missing target") {
        delete cfg.agents!.entries!.worker;
      }
      expect(
        selectDelegatedToolPolicy({
          config: cfg,
          requesterAgentId: "front",
          requesterSessionKey: requester,
          targetAgentId: kind === "same agent" ? "front" : "worker",
          floor: { policyAgentId: "front", deny: [] },
        }),
      ).toBeUndefined();
    },
  );

  it("uses the floor only for the verified child and preserves the full ceiling for descendants", () => {
    const result = resolve();
    expect(result.inheritedToolPolicy).toEqual({ deny: ["browser"] });
    expect(result.inheritedToolPolicyForSpawn).toEqual({ deny: fullDeny });
    const p = resolveConversationCapabilityProfile({
      config: config(),
      agentId: "worker",
      sessionKey: child,
      preparedSessionCapabilityStore: { [child]: entry() },
    });
    expect(
      projectConversationToolNames({
        capabilityProfile: p,
        toolNames: ["exec", "write", "browser", "message"],
        warn: () => {},
      }),
    ).toEqual(["exec", "write"]);
    expect(p.policy.inheritedToolPolicyForSpawn).toEqual({ deny: fullDeny });
  });

  it("revocation and legacy or mismatched lineage restore the original snapshot", () => {
    const cfg = config();
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect(resolve(cfg).inheritedToolPolicy).toEqual({ deny: fullDeny });
    expect(resolve(config(), { delegatedToolPolicy: undefined }).inheritedToolPolicy).toEqual({
      deny: fullDeny,
    });
    expect(resolve(config(), { spawnedBy: "agent:other:main" }).inheritedToolPolicy).toEqual({
      deny: fullDeny,
    });
  });

  it("completion restores the full requester snapshot even after its local policy changes", () => {
    const cfg = config();
    cfg.agents!.entries!.front!.tools = {};
    const result = resolveRequesterToolPolicies({
      config: cfg,
      sessionKey: requester,
      sessionId: "parent-id",
      modelProvider: "test",
      modelId: "model",
      preparedSessionCapabilityStore: { [child]: entry() },
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: child,
        sourceTool: "subagent_announce",
      },
      trustedInternalHandoff: {
        kind: "subagent-completion",
        sourceSessionKey: child,
        targetSessionKey: requester,
        targetSessionId: "parent-id",
        provider: "test",
        model: "model",
      },
    });
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.inheritedToolPolicy).toEqual({ deny: fullDeny });
  });

  it("does not apply the floor to external child requests or ACP lineage", () => {
    const external = resolveRequesterToolPolicies({
      config: config(),
      sessionKey: child,
      senderId: "visitor",
      preparedSessionCapabilityStore: { [child]: entry() },
    });
    expect(external.inheritedToolPolicy).toEqual({ deny: fullDeny });
    const acp = "agent:worker:acp:task";
    const result = resolveRequesterToolPolicies({
      config: config(),
      sessionKey: acp,
      preparedSessionCapabilityStore: { [acp]: { ...entry(), subagentRole: "leaf" } },
    });
    expect(result.inheritedToolPolicy).toEqual({ deny: fullDeny });
  });

  it("preserves both facts on reset and rejects malformed exception metadata", () => {
    const original = entry();
    const preserved = preserveSessionInheritedToolPolicy(original);
    expect(preserved).toMatchObject({
      inheritedToolDeny: fullDeny,
      delegatedToolPolicy: original.delegatedToolPolicy,
    });
    expect(preserved.delegatedToolPolicy).not.toBe(original.delegatedToolPolicy);
    expect(
      readDelegatedToolPolicy({
        requesterAgentId: "front",
        requesterSessionKey: requester,
        targetAgentId: "worker",
        deny: [2],
      }),
    ).toBeUndefined();
  });
  it("propagates only within the grantee and revokes the whole native descendant chain", () => {
    const cfg = config();
    const grandchild = "agent:worker:subagent:grandchild";
    const p = resolveConversationCapabilityProfile({
      config: cfg,
      agentId: "worker",
      sessionKey: child,
      preparedSessionCapabilityStore: { [child]: entry() },
    });
    const floor = prepareDelegatedToolDenyFloor(p);
    const delegatedToolPolicy = selectDelegatedToolPolicy({
      config: cfg,
      requesterSessionKey: child,
      requesterAgentId: "worker",
      targetAgentId: "worker",
      floor,
      requesterToolDenylist: ["browser", "message"],
    });
    expect(delegatedToolPolicy).toMatchObject({
      requesterSessionKey: requester,
      targetAgentId: "worker",
      requesterDeny: ["browser", "message"],
    });
    expect(
      selectDelegatedToolPolicy({
        config: cfg,
        requesterSessionKey: child,
        requesterAgentId: "worker",
        targetAgentId: "third",
        floor,
      }),
    ).toBeUndefined();
    const store = {
      [child]: entry(),
      [grandchild]: { ...entry(), spawnedBy: child, spawnDepth: 2, delegatedToolPolicy },
    };
    const childPolicy = () =>
      resolveRequesterToolPolicies({
        config: cfg,
        sessionKey: grandchild,
        preparedSessionCapabilityStore: store,
      });
    expect(childPolicy().inheritedToolPolicy?.deny).not.toContain("exec");
    const completion = () =>
      resolveRequesterToolPolicies({
        config: cfg,
        sessionKey: child,
        sessionId: "child-id",
        modelProvider: "test",
        modelId: "model",
        preparedSessionCapabilityStore: store,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: grandchild,
          sourceTool: "subagent_announce",
        },
        trustedInternalHandoff: {
          kind: "subagent-completion",
          sourceSessionKey: grandchild,
          targetSessionKey: child,
          targetSessionId: "child-id",
          provider: "test",
          model: "model",
        },
      });
    expect(completion().inheritedToolPolicy?.deny).not.toContain("exec");
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect(childPolicy().inheritedToolPolicy?.deny).toContain("exec");
    expect(completion().inheritedToolPolicy?.deny).toContain("exec");
  });

  it("keeps a grantee helper's new allow ceiling while preserving its root exception", () => {
    const cfg = config();
    const grandchild = "agent:worker:subagent:capped";
    const p = resolveConversationCapabilityProfile({
      config: cfg,
      agentId: "worker",
      sessionKey: child,
      runtimeToolAllowlist: ["sessions_spawn", "read", "exec"],
      inheritRuntimeToolAllowlist: true,
      preparedSessionCapabilityStore: { [child]: entry() },
    });
    const floor = prepareDelegatedToolDenyFloor(p);
    const delegatedToolPolicy = selectDelegatedToolPolicy({
      config: cfg,
      requesterSessionKey: child,
      requesterAgentId: "worker",
      targetAgentId: "worker",
      floor,
      inheritedToolAllowlist: ["sessions_spawn", "read", "exec"],
      requesterToolDenylist: ["browser"],
    });
    const result = resolveRequesterToolPolicies({
      config: cfg,
      sessionKey: grandchild,
      preparedSessionCapabilityStore: {
        [child]: entry(),
        [grandchild]: {
          ...entry(),
          spawnedBy: child,
          inheritedToolAllow: ["read", "exec"],
          delegatedToolPolicy,
        },
      },
    });
    expect(result.inheritedToolPolicy).toMatchObject({ allow: ["read", "exec"] });
    expect(result.inheritedToolPolicy?.deny).not.toContain("exec");
    expect(result.inheritedToolPolicy?.deny).toContain("browser");
  });

  it("refuses an explicit target when its producer cannot safely project the floor", () => {
    expect(() =>
      selectDelegatedToolPolicy({
        config: config(),
        requesterSessionKey: requester,
        requesterAgentId: "front",
        targetAgentId: "worker",
      }),
    ).toThrow("host-prepared deny-only policy");
  });

  it("rechecks runtime-owned configuration after asynchronous preparation", async () => {
    const cfg = config();
    setRuntimeConfigSnapshot(cfg);
    const assertCurrent = captureDelegatedToolPolicyAssertion(cfg, entry().delegatedToolPolicy)!;
    assertCurrent();
    await Promise.resolve();
    const revoked = config();
    revoked.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    setRuntimeConfigSnapshot(revoked);
    expect(assertCurrent).toThrow("authorization changed");
  });
});
