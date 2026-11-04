import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveConversationCapabilityPolicy } from "./conversation-capability-profile.js";
import { markProducerSurfaceToolCap } from "./session-event-producer-surface.js";
import {
  isProducerSurfaceToolAllowlist,
  markToolAllowlistAsProducerSurface,
} from "./tool-policy.js";

useSessionStoreTempDirs(afterAll, "openclaw-producer-surface-");

let registry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
beforeEach(() => {
  registry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createTestRegistry());
});
afterEach(() => restoreActivePluginRegistrySnapshot(registry));

type ProducerSurfacePolicy = Parameters<
  typeof markProducerSurfaceToolCap
>[0]["capabilityProfile"]["policy"];

const unrestrictedPolicy: ProducerSurfacePolicy = {
  delegatedToolPolicy: undefined,
  groupPolicy: undefined,
  inheritedToolPolicy: undefined,
  runtimeToolPolicyForInheritance: undefined,
  sandboxPolicy: undefined,
  senderPolicy: undefined,
  subagentPolicy: undefined,
};

type CapParams = {
  options?: Parameters<typeof markProducerSurfaceToolCap>[0]["options"];
  policy?: Partial<ProducerSurfacePolicy>;
  names?: string[];
  withheld?: string[];
};

function cap(params: CapParams = {}) {
  const names = params.names ?? ["read", "exec", "message"];
  const withheld = new Set(params.withheld ?? []);
  return markProducerSurfaceToolCap({
    toolsAllow: [...names],
    options: params.options,
    capabilityProfile: { policy: { ...unrestrictedPolicy, ...params.policy } },
    turnAuthorized: (tool) => !withheld.has(tool.name),
    tools: names.map((name) => ({ name })),
  });
}

/** Projects the real conversation policy so the decision reads production-resolved facts. */
function resolvePolicy(params: {
  config?: OpenClawConfig;
  runtimeToolAllowlist?: string[];
  inheritRuntimeToolAllowlist?: boolean;
}) {
  return resolveConversationCapabilityPolicy({
    sessionKey: "agent:qa:producer-surface",
    chatType: "direct",
    senderId: "qa-operator",
    messageProvider: "qa-channel",
    ...params,
  });
}

/** Caps from a real projected policy, the way a repeated wake's own turn does. */
function capFromResolvedPolicy(params: CapParams & { policy: ProducerSurfacePolicy }) {
  const { policy, ...rest } = params;
  const names = rest.names ?? ["read", "exec", "message"];
  const withheld = new Set(rest.withheld ?? []);
  return markProducerSurfaceToolCap({
    toolsAllow: [...names],
    options: rest.options,
    capabilityProfile: { policy },
    turnAuthorized: (tool) => !withheld.has(tool.name),
    tools: names.map((name) => ({ name })),
  });
}

describe("markProducerSurfaceToolCap", () => {
  it("records an unrestricted run's own surface as a ceiling, not a narrowing", () => {
    const toolsAllow = cap();
    expect(isProducerSurfaceToolAllowlist(toolsAllow)).toBe(true);
    // The ceiling itself is unchanged: the wake still cannot exceed the producer.
    expect([...toolsAllow]).toEqual(["read", "exec", "message"]);
  });

  it.each([
    ["a runtime allowlist", { options: { runtimeToolAllowlist: ["read"] } }],
    ["a turn-scoped plugin grant", { options: { runtimePluginToolGrant: {} as never } }],
    ["a collector contract", { options: { swarmCollector: true } }],
    ["delegated authority", { policy: { delegatedToolPolicy: {} as never } }],
    ["a sender restriction", { policy: { senderPolicy: { allow: ["read"] } } }],
    ["a group restriction", { policy: { groupPolicy: { deny: ["exec"] } } }],
    ["a sandbox restriction", { policy: { sandboxPolicy: { allow: ["read"] } } }],
    ["a subagent restriction", { policy: { subagentPolicy: { allow: ["read"] } } }],
    ["an inherited restriction", { policy: { inheritedToolPolicy: { allow: ["read"] } } }],
    ["a withheld tool", { withheld: ["exec"] }],
    ["an empty surface", { names: [] }],
  ])("keeps the minimal prompt for %s", (_label, params) => {
    expect(isProducerSurfaceToolAllowlist(cap(params))).toBe(false);
  });

  it("keeps a configured allow/deny policy out of the decision", () => {
    // tools.allow/tools.deny are re-resolved by the woken turn from the same config, so the
    // cap adds nothing to them and the wake keeps the conversation prompt.
    const policy = resolvePolicy({
      config: { tools: { allow: ["read", "exec"], deny: ["browser"] } },
    });
    expect(isProducerSurfaceToolAllowlist(capFromResolvedPolicy({ policy }))).toBe(true);
  });

  it("carries the fact through the runtime inheritance projection into the next wake", () => {
    // A wake that starts its own background work prepares this projection from its own cap.
    const inherited = markToolAllowlistAsProducerSurface(["read", "exec"]);
    const policy = resolvePolicy({
      runtimeToolAllowlist: inherited,
      inheritRuntimeToolAllowlist: true,
    });
    expect(policy.runtimeToolPolicyForInheritance?.allow).toBe(inherited);
    expect(
      isProducerSurfaceToolAllowlist(
        capFromResolvedPolicy({ policy, options: { runtimeToolAllowlist: inherited } }),
      ),
    ).toBe(true);

    const explicit = ["read", "exec"];
    const explicitPolicy = resolvePolicy({
      runtimeToolAllowlist: explicit,
      inheritRuntimeToolAllowlist: true,
    });
    expect(
      isProducerSurfaceToolAllowlist(
        capFromResolvedPolicy({
          policy: explicitPolicy,
          options: { runtimeToolAllowlist: explicit },
        }),
      ),
    ).toBe(false);
  });
});
