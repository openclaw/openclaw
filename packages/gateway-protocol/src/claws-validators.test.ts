import { describe, expect, it } from "vitest";
import {
  validateClawLifecyclePlanResult,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailParams,
  validateClawsCatalogDetailResult,
  validateClawsCatalogSearchParams,
  validateClawsCatalogSearchResult,
  validateClawsRemoveApplyParams,
  validateClawsUpdateApplyParams,
} from "./index.js";

describe("Claws Gateway contract", () => {
  it("allows the starter catalog before a search query and only official Add coordinates", () => {
    expect(validateClawsCatalogSearchParams({})).toBe(true);
    expect(validateClawsCatalogSearchParams({ query: "workflow", limit: 30 })).toBe(true);
    expect(validateClawsCatalogSearchParams({ sourceRoot: "/private/claw" })).toBe(false);
    expect(
      validateClawsCatalogSearchResult({
        entries: [
          {
            packageName: "@openclaw/workflow-operator",
            displayName: "Workflow Operator",
            channel: "official",
            official: true,
            downloads: 0,
            updatedAtMs: 0,
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateClawsCatalogDetailParams({
        packageName: "@openclaw/workflow-operator",
        version: "1.0.0",
      }),
    ).toBe(true);
    expect(
      validateClawsCatalogDetailResult({
        detail: {
          packageName: "@openclaw/workflow-operator",
          displayName: "Workflow Operator",
          channel: "official",
          official: true,
          downloads: 0,
          updatedAtMs: 0,
          version: "1.0.0",
          workspaceFiles: 2,
          skills: 0,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
        },
      }),
    ).toBe(true);
    expect(
      validateClawsAddPlanParams({
        source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
      }),
    ).toBe(true);

    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeSkillWarnings: [
          {
            actionId: "skill:@community/triage",
            ref: "@community/triage",
            reviewToken: "sha256:reviewed-skill",
            acknowledgeRiskWarning: true,
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@openclaw/workflow-operator", version: "1.0.0" },
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeSkillWarnings: [
          {
            actionId: "skill:@community/triage",
            ref: "@community/triage",
            reviewToken: "sha256:reviewed-skill",
            acknowledgeRiskWarning: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@someone-else/workflow-operator", version: "1.0.0" },
        planIntegrity: "sha256:reviewed-plan",
      }),
    ).toBe(false);
    expect(
      validateClawsUpdateApplyParams({
        agentId: "workflow-operator",
        source: { packageName: "@openclaw/workflow-operator", version: "1.0.1" },
        planIntegrity: "sha256:reviewed-update",
      }),
    ).toBe(true);
    expect(
      validateClawsRemoveApplyParams({
        agentId: "workflow-operator",
        planIntegrity: "sha256:reviewed-remove",
      }),
    ).toBe(true);
  });

  it("rejects source paths and setup answers in the browser's reviewed plan", () => {
    const plan = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "add",
      planIntegrity: "sha256:reviewed-plan",
      target: { agentId: "workflow-operator", name: "Workflow Operator" },
      actions: [],
      capabilities: [],
      pluginReviews: [],
      skillReviews: [],
      blockers: [],
      riskAcknowledgementRequired: false,
    };
    expect(validateClawLifecyclePlanResult(plan)).toBe(true);
    expect(validateClawLifecyclePlanResult({ ...plan, sourceRoot: "/private/claw" })).toBe(false);
    expect(validateClawLifecyclePlanResult({ ...plan, answers: { token: "secret" } })).toBe(false);
  });

  it("requires exact plugin artifact integrity in an install review", () => {
    const pluginReview = {
      actionId: "plugin:@openclaw/lobster",
      pluginId: "lobster",
      ref: "@openclaw/lobster",
      version: "2026.9.7",
      ownerAction: "install",
      integrity: `sha256-${"A".repeat(43)}=`,
      declaredCapabilities: {
        channels: [],
        providers: [],
        tools: ["lobster"],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      capabilityGrants: {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: false },
        },
      },
      reviewToken: "sha256:reviewed-surface",
    };
    const plan = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "add",
      planIntegrity: "sha256:reviewed-plan",
      target: { agentId: "workflow-operator" },
      actions: [],
      capabilities: [],
      pluginReviews: [pluginReview],
      blockers: [],
      riskAcknowledgementRequired: false,
    };

    expect(validateClawLifecyclePlanResult(plan)).toBe(true);
    const { integrity: _integrity, ...withoutIntegrity } = pluginReview;
    expect(validateClawLifecyclePlanResult({ ...plan, pluginReviews: [withoutIntegrity] })).toBe(
      false,
    );
    expect(
      validateClawLifecyclePlanResult({
        ...plan,
        pluginReviews: [{ ...pluginReview, integrity: "sha256-not-a-digest" }],
      }),
    ).toBe(false);
  });

  it("admits bounded access and schedule disclosures without cron prompts", () => {
    const plan = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "add",
      planIntegrity: "sha256:reviewed-plan",
      target: { agentId: "worker" },
      actions: [],
      capabilities: [],
      pluginReviews: [],
      skillReviews: [],
      blockers: [],
      riskAcknowledgementRequired: false,
      configuredAccess: {
        coverage: "configuration-only",
        desired: {
          tools: { allowed: ["read"], excluded: ["exec"] },
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceAccess: "ro",
            backend: "docker",
          },
          filesystem: { workspaceOnly: true },
          heartbeat: { enabled: true, intervalMs: 1_800_000 },
          memorySearch: { state: "disabled" },
          subagentTargets: {
            allowedAgentIds: ["worker"],
            allowAnyConfiguredAgent: false,
            implicitSelfAllowed: true,
            requireAgentId: false,
          },
        },
        unresolved: ["runtime-tools", "sandbox-runtime", "subagent-runtime"],
      },
      scheduledJobs: {
        coverage: "package-declarations",
        jobs: [
          {
            id: "daily",
            action: "schedule",
            blocked: false,
            proposed: {
              schedule: { cron: "0 9 * * *", timezone: "UTC" },
              session: "isolated",
              delivery: "last-channel",
            },
          },
        ],
      },
    };
    expect(validateClawLifecyclePlanResult(plan)).toBe(true);
    expect(
      validateClawLifecyclePlanResult({
        ...plan,
        configuredAccess: {
          ...plan.configuredAccess,
          desired: { ...plan.configuredAccess.desired, memorySearch: { state: "unresolved" } },
        },
      }),
    ).toBe(true);
    expect(
      validateClawLifecyclePlanResult({
        ...plan,
        configuredAccess: {
          ...plan.configuredAccess,
          desired: {
            ...plan.configuredAccess.desired,
            subagentTargets: {
              ...plan.configuredAccess.desired.subagentTargets,
              privatePolicy: "never disclose",
            },
          },
        },
      }),
    ).toBe(false);
    const scheduledJob = plan.scheduledJobs.jobs[0];
    if (!scheduledJob) {
      throw new Error("expected one scheduled job fixture");
    }
    expect(
      validateClawLifecyclePlanResult({
        ...plan,
        scheduledJobs: {
          ...plan.scheduledJobs,
          jobs: [
            {
              ...scheduledJob,
              proposed: {
                ...scheduledJob.proposed,
                message: "private scheduler prompt",
              },
            },
          ],
        },
      }),
    ).toBe(false);

    const updatePlan = {
      ...plan,
      operation: "update",
      configuredAccess: {
        ...plan.configuredAccess,
        current: plan.configuredAccess.desired,
      },
      scheduledJobs: {
        ...plan.scheduledJobs,
        jobs: [
          {
            id: "daily",
            action: "change",
            blocked: false,
            current: {
              schedule: { cron: "0 8 * * *", timezone: "UTC" },
              session: "main",
              delivery: "none",
            },
            proposed: plan.scheduledJobs.jobs[0]?.proposed,
          },
        ],
      },
    };
    expect(validateClawLifecyclePlanResult(updatePlan)).toBe(true);
    expect(
      validateClawLifecyclePlanResult({
        ...updatePlan,
        scheduledJobs: {
          ...updatePlan.scheduledJobs,
          jobs: [
            {
              ...updatePlan.scheduledJobs.jobs[0],
              current: { ...updatePlan.scheduledJobs.jobs[0]?.current, message: "private prompt" },
            },
          ],
        },
      }),
    ).toBe(false);
  });
});
