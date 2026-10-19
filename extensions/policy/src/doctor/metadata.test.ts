import { describe, expect, it } from "vitest";
import { scanPolicyDataHandling } from "../policy-state-data.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import { POLICY_RULE_METADATA } from "./metadata.js";

const POLICY_FIX_METADATA = [...POLICY_FIX_METADATA_BY_CHECK_ID.values()];

function checkIds(names: string) {
  return names
    .trim()
    .split(/\s+/)
    .map((name) => `policy/${name}`);
}

describe("policy doctor metadata", () => {
  it("describes strictness for agent-scoped policy fields", () => {
    expect(
      POLICY_RULE_METADATA.filter(
        (rule) =>
          rule.scopeSelectors?.includes("agentIds") || rule.scopeSelectors?.includes("channelIds"),
      ).map((rule) => [
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
    const grouped = new Map<string, string[]>();
    for (const rule of POLICY_FIX_METADATA) {
      const ids = grouped.get(rule.fixClass) ?? [];
      ids.push(rule.checkId);
      grouped.set(rule.fixClass, ids);
    }
    expect(Object.fromEntries([...grouped].map(([kind, ids]) => [kind, ids.toSorted()]))).toEqual({
      automatic: checkIds(`
        agents-tool-not-denied channels-denied-provider
        data-handling-telemetry-content-capture gateway-control-ui-insecure
        gateway-http-endpoint-enabled gateway-remote-enabled
        ingress-group-mention-required ingress-open-groups-denied
        tools-elevated-enabled tools-required-deny-missing
      `),
      manual: checkIds(`
        attestation-hash-mismatch auth-profile-invalid-metadata auth-profile-unapproved-mode
        exec-approvals-agent-security-unapproved exec-approvals-allowlist-missing
        exec-approvals-allowlist-unexpected exec-approvals-default-security-unapproved
        exec-approvals-invalid exec-approvals-missing gateway-auth-disabled
        gateway-http-url-fetch-unrestricted policy-hash-mismatch policy-jsonc-invalid
        policy-jsonc-missing sandbox-browser-cdp-source-range-missing secrets-unmanaged-provider
        tools-md-migration-required tools-missing-owner tools-missing-risk-level
        tools-missing-sensitivity-token tools-unknown-risk-level tools-unknown-sensitivity-token
      `),
      reviewRequired: checkIds(`
        agents-workspace-access-denied data-handling-session-retention-not-enforced
        data-handling-session-transcript-memory-enabled exec-approvals-auto-allow-skills-enabled
        gateway-node-command-denied gateway-non-loopback-bind gateway-rate-limit-missing
        gateway-tailscale-funnel ingress-dm-policy-unapproved ingress-dm-scope-unapproved
        mcp-denied-server mcp-unapproved-server models-denied-provider models-unapproved-provider
        network-private-access-enabled routing-agent-mismatch routing-binding-channel-unconfigured
        routing-bindings-required routing-match-kind-mismatch sandbox-backend-unapproved
        sandbox-container-host-network-denied sandbox-container-mount-mode-required
        sandbox-container-namespace-join-denied sandbox-container-runtime-socket-mount
        sandbox-container-unconfined-profile sandbox-mode-unapproved secrets-denied-provider-source
        secrets-insecure-provider tools-also-allow-missing tools-also-allow-unexpected
        tools-exec-ask-unapproved tools-exec-host-unapproved tools-exec-security-unapproved
        tools-fs-workspace-only-required tools-profile-unapproved
      `),
      unsupported: checkIds("sandbox-container-posture-unobservable"),
    });
  });

  it("declares how every policy rule is enforced", () => {
    const rules = POLICY_RULE_METADATA;
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
