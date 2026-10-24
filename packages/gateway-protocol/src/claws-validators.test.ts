import { describe, expect, it } from "vitest";
import {
  validateClawLifecyclePlanResult,
  validateClawsAddApplyParams,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailParams,
  validateClawsCatalogDetailResult,
  validateClawsCatalogPreviewParams,
  validateClawsCatalogPreviewResult,
  validateClawsCatalogSearchParams,
  validateClawsCatalogSearchResult,
  validateClawsRemoveApplyParams,
  validateClawsUpdateApplyParams,
} from "./index.js";

const coordinate = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };
const catalogEntry = {
  packageName: coordinate.packageName,
  displayName: "Workflow Operator",
  channel: "official",
  official: true,
  downloads: 0,
  installs: 0,
  updatedAtMs: 0,
};
const basePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "add",
  planIntegrity: "sha256:reviewed-plan",
  target: { agentId: "workflow-operator" },
  actions: [],
  capabilities: [],
  pluginReviews: [],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};
const checkPlan = (plan: unknown) => expect(validateClawLifecyclePlanResult(plan)).toBe(true);
const rejectPlan = (plan: unknown) => expect(validateClawLifecyclePlanResult(plan)).toBe(false);

describe("Claws Gateway contract", () => {
  it("allows the public catalog and exact publisher Add coordinates", () => {
    expect(validateClawsCatalogSearchParams({})).toBe(true);
    expect(validateClawsCatalogSearchParams({ query: "workflow", limit: 30 })).toBe(true);
    expect(validateClawsCatalogSearchParams({ sourceRoot: "/private/claw" })).toBe(false);
    expect(validateClawsCatalogSearchResult({ entries: [catalogEntry] })).toBe(true);
    expect(validateClawsCatalogDetailParams(coordinate)).toBe(true);
    const preview = { kind: "instruction", name: "AGENTS.md" };
    expect(validateClawsCatalogPreviewParams({ ...coordinate, ...preview })).toBe(true);
    expect(
      validateClawsCatalogSearchResult({
        entries: [
          {
            packageName: "@openclaw/workflow-operator",
            displayName: "Workflow Operator",
            channel: "official",
            official: true,
            downloads: 0,
            installs: 0,
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
      validateClawsCatalogPreviewParams({
        packageName: "@openclaw/workflow-operator",
        version: "1.0.0",
        kind: "instruction",
        name: "AGENTS.md",
      }),
    ).toBe(true);
    expect(
      validateClawsCatalogPreviewResult({
        preview: { kind: "instruction", name: "AGENTS.md", content: "# Instructions" },
      }),
    ).toBe(true);
    expect(
      validateClawsCatalogDetailResult({
        detail: {
          ...catalogEntry,
          version: coordinate.version,
          workspaceFiles: 2,
          skills: 0,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
          contents: {
            instructions: [
              { name: "AGENTS.md", source: "workspace/AGENTS.md", excerpt: "Purpose" },
            ],
            skills: [{ name: "@openclaw/research", version: "1.0.0", excerpt: "Research skill" }],
            integrations: [{ name: "@openclaw/lobster", kind: "plugin", version: "1.0.0" }],
            automations: [],
          },
        },
      }),
    ).toBe(true);
    expect(validateClawsAddPlanParams({ source: coordinate })).toBe(true);

    const apply = (acknowledgeRiskWarning: boolean) => ({
      source: coordinate,
      planIntegrity: "sha256:reviewed-plan",
      acknowledgeSkillWarnings: [
        {
          actionId: "skill:@community/triage",
          ref: "@community/triage",
          reviewToken: "sha256:reviewed-skill",
          acknowledgeRiskWarning,
        },
      ],
    });
    expect(validateClawsAddApplyParams(apply(true))).toBe(true);
    expect(validateClawsAddApplyParams(apply(false))).toBe(false);
    expect(
      validateClawsAddApplyParams({
        source: { packageName: "@someone-else/workflow-operator", version: "1.0.0" },
        planIntegrity: "sha256:reviewed-plan",
      }),
    ).toBe(true);
    expect(
      validateClawsCatalogSearchResult({
        entries: [
          {
            packageName: "@alice/workflow-operator",
            displayName: "Workflow Operator",
            channel: "community",
            official: false,
            ownerHandle: "alice",
            downloads: 0,
            installs: 0,
            updatedAtMs: 0,
          },
        ],
      }),
    ).toBe(true);
    for (const packageName of [
      "../local",
      "https://registry.example/claw",
      "@alice/claw@latest",
      "@Alice/claw",
      "@alice/claw ",
    ]) {
      expect(validateClawsAddApplyParams({ source: { packageName, version: "1.0.0" } })).toBe(
        false,
      );
    }
    expect(
      validateClawsUpdateApplyParams({
        agentId: "workflow-operator",
        source: { ...coordinate, version: "1.0.1" },
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
      ...basePlan,
      target: { agentId: "workflow-operator", name: "@openclaw/workflow-operator" },
      manifestDisclosure: {
        source: {
          packageName: "@openclaw/workflow-operator",
          version: "1.0.0",
          integrity: `sha256:${"a".repeat(64)}`,
          byteLength: 123,
        },
        manifestJson: '{"schemaVersion":1}',
      },
    };
    checkPlan(plan);
    rejectPlan({ ...plan, sourceRoot: "/private/claw" });
    rejectPlan({ ...plan, answers: { token: "secret" } });
    rejectPlan({
      ...plan,
      manifestDisclosure: {
        ...plan.manifestDisclosure,
        source: { ...plan.manifestDisclosure.source, packageRoot: "/private/claw" },
      },
    });
  });

  it("requires exact plugin artifact integrity in an install review", () => {
    const grants = {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: false },
      },
    };
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
      capabilityGrants: grants,
      capabilityGrantsByPluginId: { lobster: grants },
      reviewToken: "sha256:reviewed-surface",
    };
    const plan = { ...basePlan, pluginReviews: [pluginReview] };

    checkPlan(plan);
    const { integrity: _integrity, ...withoutIntegrity } = pluginReview;
    rejectPlan({ ...plan, pluginReviews: [withoutIntegrity] });
    rejectPlan({
      ...plan,
      pluginReviews: [{ ...pluginReview, integrity: "sha256-not-a-digest" }],
    });
  });

  it("admits bounded access and schedule disclosures without cron prompts", () => {
    const scheduledJob = {
      id: "daily",
      action: "schedule",
      blocked: false,
      proposed: {
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated",
        delivery: "last-channel",
        message: "Prepare the daily brief",
        messageDigest: "sha256:proposed-task",
      },
    };
    const plan = {
      ...basePlan,
      target: { agentId: "worker" },
      configuredAccess: {
        coverage: "configuration-only",
        desired: {
          tools: {
            allowed: ["read"],
            excluded: ["exec"],
            explicitAllow: ["read"],
            explicitDeny: [],
          },
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
        jobs: [scheduledJob],
      },
    };
    const withJob = (base: typeof plan, job: unknown) => ({
      ...base,
      scheduledJobs: { ...base.scheduledJobs, jobs: [job] },
    });
    checkPlan(plan);
    checkPlan({
      ...plan,
      configuredAccess: {
        ...plan.configuredAccess,
        desired: { ...plan.configuredAccess.desired, memorySearch: { state: "unresolved" } },
      },
    });
    rejectPlan({
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
    });
    checkPlan(
      withJob(plan, {
        ...scheduledJob,
        proposed: { ...scheduledJob.proposed, message: "Updated scheduled task" },
      }),
    );

    rejectPlan(
      withJob(plan, {
        ...scheduledJob,
        proposed: { ...scheduledJob.proposed, message: undefined },
      }),
    );

    const updatedJob = {
      id: "daily",
      action: "change",
      blocked: false,
      current: {
        schedule: { cron: "0 8 * * *", timezone: "UTC" },
        session: "main",
        delivery: "none",
        messageDigest: "sha256:current-task",
      },
      proposed: scheduledJob.proposed,
    };
    const updatePlan = {
      ...plan,
      operation: "update",
      configuredAccess: {
        ...plan.configuredAccess,
        current: plan.configuredAccess.desired,
      },
      scheduledJobs: {
        ...plan.scheduledJobs,
        jobs: [updatedJob],
      },
    };
    checkPlan(updatePlan);
    for (const field of ["current", "proposed"] as const) {
      for (const [schedule, delivery, valid] of [
        [{ cron: "0 9 * * *", timezone: "UTC" }, "none", true],
        [{ cron: "0 9 * * *", timezone: "UTC" }, "last-channel", true],
        [{ cron: "0 9 * * *", timezone: "UTC" }, "owner", true],
        [{ everyMs: 1 }, "none", true],
        [{ everyMs: 60_000 }, "last-channel", true],
        [{ everyMs: 1_800_000 }, "owner", true],
        [{ everyMs: 0 }, "owner", false],
        [{ everyMs: -1 }, "owner", false],
        [{ everyMs: 0.5 }, "owner", false],
        [{ cron: "0 9 * * *", timezone: "UTC", everyMs: 60_000 }, "owner", false],
      ] as const) {
        expect(
          validateClawLifecyclePlanResult(
            withJob(updatePlan, {
              ...updatedJob,
              [field]: { ...updatedJob[field], schedule, delivery },
            }),
          ),
        ).toBe(valid);
      }
    }
    rejectPlan(
      withJob(updatePlan, {
        ...updatedJob,
        current: { ...updatedJob.current, message: "private prompt" },
      }),
    );
  });
});
