// Policy doctor metadata tests cover rule metadata.
import { describe, expect, it } from "vitest";
import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./metadata.js";

describe("policy doctor metadata", () => {
  it("describes strictness for agent-scoped policy fields", () => {
    expect(
      (POLICY_RULE_METADATA as readonly PolicyRuleMetadata[])
        .filter(
          (rule) =>
            rule.scopeSelectors?.includes("agentIds") ||
            rule.scopeSelectors?.includes("channelIds"),
        )
        .map((rule) => {
          const description: {
            path: string;
            strictness: PolicyRuleMetadata["strictness"];
            selectors: PolicyRuleMetadata["scopeSelectors"];
            emptyList?: PolicyRuleMetadata["emptyList"];
          } = {
            path: rule.policyPath.join("."),
            strictness: rule.strictness,
            selectors: rule.scopeSelectors,
          };
          if (rule.emptyList !== undefined) {
            description.emptyList = rule.emptyList;
          }
          return description;
        }),
    ).toEqual([
      {
        path: "agents.workspace.allowedAccess",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "agents.workspace.denyTools",
        strictness: "denylist-superset",
        selectors: ["agentIds"],
      },
      {
        path: "tools.profiles.allow",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.fs.requireWorkspaceOnly",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowSecurity",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.requireAsk",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "tools.exec.allowHosts",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      { path: "tools.elevated.allow", strictness: "requires-false", selectors: ["agentIds"] },
      {
        path: "tools.alsoAllow.expected",
        strictness: "exact-list",
        emptyList: "meaningful",
        selectors: ["agentIds"],
      },
      { path: "tools.denyTools", strictness: "denylist-superset", selectors: ["agentIds"] },
      {
        path: "sandbox.requireMode",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.allowBackends",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyHostNetwork",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerNamespaceJoin",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.requireReadOnlyMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyContainerRuntimeSocketMounts",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.containers.denyUnconfinedProfiles",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "sandbox.browser.requireCdpSourceRange",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "ingress.channels.allowDmPolicies",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.denyOpenGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "ingress.channels.requireMentionInGroups",
        strictness: "requires-true",
        selectors: ["channelIds"],
      },
      {
        path: "dataHandling.memory.denySessionTranscriptIndexing",
        strictness: "requires-true",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowSecurity",
        strictness: "allowlist-subset",
        emptyList: "disabled",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowAutoAllowSkills",
        strictness: "requires-false",
        selectors: ["agentIds"],
      },
      {
        path: "execApprovals.agents.allowlist.expected",
        strictness: "exact-list",
        emptyList: "meaningful",
        selectors: ["agentIds"],
      },
    ]);
  });
});
