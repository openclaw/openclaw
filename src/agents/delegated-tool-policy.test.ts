import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { preserveSessionInheritedToolPolicy } from "../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  prepareDelegatedToolDenyFloor as prepareFloor,
  resolveConversationCapabilityProfile as resolveProfile,
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
const parent = "agent:front:subagent:parent";
function ancestor(extra: { inheritedToolAllow?: string[]; inheritedToolDeny?: string[] }) {
  return {
    sessionKey: parent,
    preparedSessionCapabilityStore: {
      [parent]: {
        sessionId: "parent",
        spawnedBy: requester,
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1 as const,
        ...extra,
      },
    },
  };
}
function config(tools?: OpenClawConfig["tools"], allow?: string[]): OpenClawConfig {
  const front = {
    tools: { deny: fullDeny, ...(allow ? { allow } : {}) },
    subagents: { allowAgents: ["worker"], delegateToolsTo: ["worker"] },
  };
  return { tools, agents: { entries: { front, worker: {} } } };
}
function profile(cfg = config(), extra: Partial<Parameters<typeof resolveProfile>[0]> = {}) {
  return resolveProfile({ config: cfg, agentId: "front", sessionKey: requester, ...extra });
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
type RequesterParams = Parameters<typeof resolveRequesterToolPolicies>[0];
function resolve(
  cfg = config(),
  extra: Partial<RequesterParams> = {},
  patch: Partial<ReturnType<typeof entry>> = {},
) {
  return resolveRequesterToolPolicies({
    config: cfg,
    agentId: "worker",
    sessionKey: child,
    preparedSessionCapabilityStore: { [child]: { ...entry(), ...patch } },
    ...extra,
  });
}
function select(overrides: Partial<Parameters<typeof selectDelegatedToolPolicy>[0]> = {}) {
  return selectDelegatedToolPolicy({
    config: config(),
    requesterAgentId: "front",
    requesterSessionKey: requester,
    targetAgentId: "worker",
    ...overrides,
  });
}
function childProfile(cfg = config(), extra: Parameters<typeof profile>[1] = {}) {
  return profile(cfg, {
    agentId: "worker",
    sessionKey: child,
    preparedSessionCapabilityStore: { [child]: entry() },
    ...extra,
  });
}
function selectChild(
  cfg: OpenClawConfig,
  floor: NonNullable<Parameters<typeof select>[0]>["floor"],
  extra: Parameters<typeof select>[0] = {},
) {
  return select({
    config: cfg,
    requesterSessionKey: child,
    requesterAgentId: "worker",
    floor,
    ...extra,
  });
}
function project(p: ReturnType<typeof profile>, toolNames: string[]) {
  return projectConversationToolNames({ capabilityProfile: p, toolNames, warn: () => {} });
}
function descendantStore(
  sessionKey: string,
  delegatedToolPolicy: ReturnType<typeof select>,
  extra: { spawnDepth?: number; inheritedToolAllow?: string[] } = {},
) {
  return {
    [child]: entry(),
    [sessionKey]: { ...entry(), spawnedBy: child, delegatedToolPolicy, ...extra },
  };
}
function completionPolicy(
  cfg: OpenClawConfig,
  source: string,
  target: string,
  sessionId: string,
  store: RequesterParams["preparedSessionCapabilityStore"],
) {
  return resolveRequesterToolPolicies({
    config: cfg,
    sessionKey: target,
    sessionId,
    modelProvider: "test",
    modelId: "model",
    preparedSessionCapabilityStore: store,
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: source,
      sourceTool: "subagent_announce",
    },
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: source,
      targetSessionKey: target,
      targetSessionId: sessionId,
      provider: "test",
      model: "model",
    },
  });
}

describe("deny-only native tool delegation", () => {
  afterEach(() => clearRuntimeConfigSnapshot());
  it("prepares a floor without changing the requester's callable tools", () => {
    const p = profile();
    expect(prepareFloor(p)).toEqual({ policyAgentId: "front", deny: [] });
    expect(project(p, ["read", "exec", "edit"])).toEqual(["read"]);
    expect(select({ floor: { policyAgentId: "front", deny: [] } })).toEqual({
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
      select({
        config: cfg,
        requesterAgentId: "runner",
        requesterSessionKey: "agent:runner:main",
        floor: prepareFloor(profile(cfg, { runSessionKey: "agent:runner:main" })),
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
      ...ancestor({ inheritedToolDeny: ["browser"] }),
    });
    expect(prepareFloor(p, ["sessions"])?.deny).toEqual(
      expect.arrayContaining([...fullDeny, "browser", "sessions", "message"]),
    );
  });

  it.each([
    ["profile", config({ profile: "coding" })],
    ["global", config({ allow: ["read", "sessions_spawn"] })],
    ["agent", config(undefined, ["read", "sessions_spawn"])],
    [
      "runtime",
      config(),
      { runtimeToolAllowlist: ["sessions_spawn"], inheritRuntimeToolAllowlist: true },
    ],
    ["sandbox", config(), { sandboxToolPolicy: { allow: ["read", "sessions_spawn"] } }],
    ["ancestor", config(), ancestor({ inheritedToolAllow: ["read", "sessions_spawn"] })],
  ] satisfies Array<[string, OpenClawConfig, Parameters<typeof profile>[1]?]>)(
    "keeps restrictive %s allow ceilings conservative",
    (_kind, cfg, extra?: Parameters<typeof profile>[1]) => {
      expect(prepareFloor(profile(cfg, extra))).toBeUndefined();
    },
  );

  it("retains sender restrictions even for an owner invocation", () => {
    expect(
      prepareFloor(
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
        select({
          config: cfg,
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
    const p = childProfile();
    expect(project(p, ["exec", "write", "browser", "message"])).toEqual(["exec", "write"]);
    expect(p.policy.inheritedToolPolicyForSpawn).toEqual({ deny: fullDeny });
  });

  it("revocation and legacy or mismatched lineage restore the original snapshot", () => {
    const cfg = config();
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect(resolve(cfg).inheritedToolPolicy).toEqual({ deny: fullDeny });
    expect(resolve(config(), {}, { delegatedToolPolicy: undefined }).inheritedToolPolicy).toEqual({
      deny: fullDeny,
    });
    expect(resolve(config(), {}, { spawnedBy: "agent:other:main" }).inheritedToolPolicy).toEqual({
      deny: fullDeny,
    });
  });

  it("completion restores the full requester snapshot even after its local policy changes", () => {
    const cfg = config();
    cfg.agents!.entries!.front!.tools = {};
    const result = completionPolicy(cfg, child, requester, "parent-id", { [child]: entry() });
    expect(result.requesterPolicySource).toBe("completion-handoff");
    expect(result.inheritedToolPolicy).toEqual({ deny: fullDeny });
  });

  it("does not apply the floor to external child requests or ACP lineage", () => {
    const external = resolve(config(), { senderId: "visitor" });
    expect(external.inheritedToolPolicy).toEqual({ deny: fullDeny });
    const acp = "agent:worker:acp:task";
    const result = resolve(config(), {
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
    const floor = prepareFloor(childProfile(cfg));
    const delegatedToolPolicy = selectChild(cfg, floor, {
      requesterToolDenylist: ["browser", "message"],
    });
    expect(delegatedToolPolicy).toMatchObject({
      requesterSessionKey: requester,
      targetAgentId: "worker",
      requesterDeny: ["browser", "message"],
    });
    expect(selectChild(cfg, floor, { targetAgentId: "third" })).toBeUndefined();
    const store = descendantStore(grandchild, delegatedToolPolicy, { spawnDepth: 2 });
    const childPolicy = () =>
      resolve(cfg, {
        sessionKey: grandchild,
        preparedSessionCapabilityStore: store,
      });
    expect(childPolicy().inheritedToolPolicy?.deny).not.toContain("exec");
    const completion = () => completionPolicy(cfg, grandchild, child, "child-id", store);
    expect(completion().inheritedToolPolicy?.deny).not.toContain("exec");
    cfg.agents!.entries!.front!.subagents!.delegateToolsTo = [];
    expect(childPolicy().inheritedToolPolicy?.deny).toContain("exec");
    expect(completion().inheritedToolPolicy?.deny).toContain("exec");
  });

  it("keeps a grantee helper's new allow ceiling while preserving its root exception", () => {
    const cfg = config();
    const grandchild = "agent:worker:subagent:capped";
    const p = childProfile(cfg, {
      runtimeToolAllowlist: ["sessions_spawn", "read", "exec"],
      inheritRuntimeToolAllowlist: true,
    });
    const floor = prepareFloor(p);
    const delegatedToolPolicy = selectChild(cfg, floor, {
      inheritedToolAllowlist: ["sessions_spawn", "read", "exec"],
      requesterToolDenylist: ["browser"],
    });
    const result = resolve(cfg, {
      sessionKey: grandchild,
      preparedSessionCapabilityStore: descendantStore(grandchild, delegatedToolPolicy, {
        inheritedToolAllow: ["read", "exec"],
      }),
    });
    expect(result.inheritedToolPolicy).toMatchObject({ allow: ["read", "exec"] });
    expect(result.inheritedToolPolicy?.deny).not.toContain("exec");
    expect(result.inheritedToolPolicy?.deny).toContain("browser");
  });

  it("refuses an explicit target when its producer cannot safely project the floor", () => {
    expect(() => select()).toThrow("host-prepared deny-only policy");
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
