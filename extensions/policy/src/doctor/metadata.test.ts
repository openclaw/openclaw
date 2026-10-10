// Policy doctor metadata tests cover rule metadata.
import { describe, expect, it } from "vitest";
import { scanPolicyDataHandling } from "../policy-state-data.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./metadata.js";

const POLICY_FIX_METADATA = [...POLICY_FIX_METADATA_BY_CHECK_ID.values()];
type PolicyFixMetadata = (typeof POLICY_FIX_METADATA)[number];

describe("policy doctor metadata", () => {
  it("describes strictness for agent-scoped policy fields", () => {
    expect(
      (POLICY_RULE_METADATA as readonly PolicyRuleMetadata[])
        .filter(
          (rule) =>
            rule.scopeSelectors?.includes("agentIds") ||
            rule.scopeSelectors?.includes("channelIds"),
        )
        .map((rule) => [
          rule.policyPath.join("."),
          rule.strictness,
          rule.emptyList,
          rule.scopeSelectors,
        ]),
    ).toEqual([
      ["agents.workspace.allowedAccess", "allowlist-subset", "disabled", ["agentIds"]],
      ["agents.workspace.denyTools", "denylist-superset", undefined, ["agentIds"]],
      ["tools.profiles.allow", "allowlist-subset", "disabled", ["agentIds"]],
      ["tools.fs.requireWorkspaceOnly", "requires-true", undefined, ["agentIds"]],
      ["tools.exec.allowSecurity", "allowlist-subset", "disabled", ["agentIds"]],
      ["tools.exec.requireAsk", "allowlist-subset", "disabled", ["agentIds"]],
      ["tools.exec.allowHosts", "allowlist-subset", "disabled", ["agentIds"]],
      ["tools.elevated.allow", "requires-false", undefined, ["agentIds"]],
      ["tools.alsoAllow.expected", "exact-list", "meaningful", ["agentIds"]],
      ["tools.denyTools", "denylist-superset", undefined, ["agentIds"]],
      ["sandbox.requireMode", "allowlist-subset", "disabled", ["agentIds"]],
      ["sandbox.allowBackends", "allowlist-subset", "disabled", ["agentIds"]],
      ["sandbox.containers.denyHostNetwork", "requires-true", undefined, ["agentIds"]],
      ["sandbox.containers.denyContainerNamespaceJoin", "requires-true", undefined, ["agentIds"]],
      ["sandbox.containers.requireReadOnlyMounts", "requires-true", undefined, ["agentIds"]],
      [
        "sandbox.containers.denyContainerRuntimeSocketMounts",
        "requires-true",
        undefined,
        ["agentIds"],
      ],
      ["sandbox.containers.denyUnconfinedProfiles", "requires-true", undefined, ["agentIds"]],
      ["sandbox.browser.requireCdpSourceRange", "requires-true", undefined, ["agentIds"]],
      ["ingress.channels.allowDmPolicies", "allowlist-subset", "disabled", ["channelIds"]],
      ["ingress.channels.denyOpenGroups", "requires-true", undefined, ["channelIds"]],
      ["ingress.channels.requireMentionInGroups", "requires-true", undefined, ["channelIds"]],
      [
        "dataHandling.memory.denySessionTranscriptIndexing",
        "requires-true",
        undefined,
        ["agentIds"],
      ],
      ["execApprovals.agents.allowSecurity", "allowlist-subset", "disabled", ["agentIds"]],
      ["execApprovals.agents.allowAutoAllowSkills", "requires-false", undefined, ["agentIds"]],
      ["execApprovals.agents.allowlist.expected", "exact-list", "meaningful", ["agentIds"]],
    ]);
  });

  it("classifies every policy finding for fix recommendation coverage", () => {
    expect([...POLICY_FIX_METADATA_BY_CHECK_ID.keys()].toSorted()).toEqual(
      [...POLICY_CHECK_IDS].toSorted(),
    );
  });

  it("points required-deny repair metadata at OpenClaw deny config paths", () => {
    expect(
      POLICY_FIX_METADATA_BY_CHECK_ID.get(CHECK_IDS.policyToolsRequiredDenyMissing)?.configTargets,
    ).toEqual(["tools.deny", "agents.entries.<id>.tools.deny"]);
  });

  it("keeps policy fix class assignments explicit", () => {
    const grouped = new Map<PolicyFixMetadata["fixClass"], PolicyFixMetadata[]>();
    for (const rule of POLICY_FIX_METADATA) {
      const rules = grouped.get(rule.fixClass);
      if (rules) {
        rules.push(rule);
      } else {
        grouped.set(rule.fixClass, [rule]);
      }
    }

    expect({
      automatic: grouped
        .get("automatic")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      manual: grouped
        .get("manual")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      reviewRequired: grouped
        .get("reviewRequired")
        ?.map((rule) => rule.checkId)
        .toSorted(),
      unsupported: grouped
        .get("unsupported")
        ?.map((rule) => rule.checkId)
        .toSorted(),
    }).toEqual({
      automatic: [
        "policy/agents-tool-not-denied",
        "policy/channels-denied-provider",
        "policy/data-handling-telemetry-content-capture",
        "policy/gateway-control-ui-insecure",
        "policy/gateway-http-endpoint-enabled",
        "policy/gateway-remote-enabled",
        "policy/ingress-group-mention-required",
        "policy/ingress-open-groups-denied",
        "policy/tools-elevated-enabled",
        "policy/tools-required-deny-missing",
      ],
      manual: [
        "policy/attestation-hash-mismatch",
        "policy/auth-profile-invalid-metadata",
        "policy/auth-profile-unapproved-mode",
        "policy/exec-approvals-agent-security-unapproved",
        "policy/exec-approvals-allowlist-missing",
        "policy/exec-approvals-allowlist-unexpected",
        "policy/exec-approvals-default-security-unapproved",
        "policy/exec-approvals-invalid",
        "policy/exec-approvals-missing",
        "policy/gateway-auth-disabled",
        "policy/gateway-http-url-fetch-unrestricted",
        "policy/policy-hash-mismatch",
        "policy/policy-jsonc-invalid",
        "policy/policy-jsonc-missing",
        "policy/sandbox-browser-cdp-source-range-missing",
        "policy/secrets-unmanaged-provider",
        "policy/tools-md-migration-required",
        "policy/tools-missing-owner",
        "policy/tools-missing-risk-level",
        "policy/tools-missing-sensitivity-token",
        "policy/tools-unknown-risk-level",
        "policy/tools-unknown-sensitivity-token",
      ],
      reviewRequired: [
        "policy/agents-workspace-access-denied",
        "policy/data-handling-session-retention-not-enforced",
        "policy/data-handling-session-transcript-memory-enabled",
        "policy/exec-approvals-auto-allow-skills-enabled",
        "policy/gateway-node-command-denied",
        "policy/gateway-non-loopback-bind",
        "policy/gateway-rate-limit-missing",
        "policy/gateway-tailscale-funnel",
        "policy/ingress-dm-policy-unapproved",
        "policy/ingress-dm-scope-unapproved",
        "policy/mcp-denied-server",
        "policy/mcp-unapproved-server",
        "policy/models-denied-provider",
        "policy/models-unapproved-provider",
        "policy/network-private-access-enabled",
        "policy/routing-agent-mismatch",
        "policy/routing-binding-channel-unconfigured",
        "policy/routing-bindings-required",
        "policy/routing-match-kind-mismatch",
        "policy/sandbox-backend-unapproved",
        "policy/sandbox-container-host-network-denied",
        "policy/sandbox-container-mount-mode-required",
        "policy/sandbox-container-namespace-join-denied",
        "policy/sandbox-container-runtime-socket-mount",
        "policy/sandbox-container-unconfined-profile",
        "policy/sandbox-mode-unapproved",
        "policy/secrets-denied-provider-source",
        "policy/secrets-insecure-provider",
        "policy/tools-also-allow-missing",
        "policy/tools-also-allow-unexpected",
        "policy/tools-exec-ask-unapproved",
        "policy/tools-exec-host-unapproved",
        "policy/tools-exec-security-unapproved",
        "policy/tools-fs-workspace-only-required",
        "policy/tools-profile-unapproved",
      ],
      unsupported: ["policy/sandbox-container-posture-unobservable"],
    });
  });

  it("declares how every policy rule is enforced", () => {
    const rules = POLICY_RULE_METADATA as readonly PolicyRuleMetadata[];
    // Every rule names either its doctor checks or the invariant that satisfies it, never
    // both and never neither, so an accepted policy key cannot enforce nothing in silence.
    expect(
      rules
        .filter((rule) => rule.checkIds.length > 0 === (rule.satisfiedByInvariant !== undefined))
        .map((rule) => rule.policyPath.join(".")),
    ).toEqual([]);
    const invariantSources = new Set(scanPolicyDataHandling({}).map((entry) => entry.source));
    expect(
      rules
        .filter((rule) => rule.satisfiedByInvariant !== undefined)
        .map((rule) => [
          rule.policyPath.join("."),
          rule.satisfiedByInvariant,
          invariantSources.has(rule.satisfiedByInvariant ?? ""),
        ]),
    ).toEqual([
      [
        "dataHandling.sensitiveLogging.requireRedaction",
        "oc://openclaw.invariant/logging/redaction",
        true,
      ],
    ]);
  });
});
