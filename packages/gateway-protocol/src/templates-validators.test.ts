import { describe, expect, it } from "vitest";
import * as p from "./index.js";
import { validation } from "./schema/protocol-validation.test-support.js";

const search = validation(p.validateTemplatesCatalogSearchParams);
const searchResult = validation(p.validateTemplatesCatalogSearchResult);
const detail = validation(p.validateTemplatesCatalogDetailParams);
const detailResult = validation(p.validateTemplatesCatalogDetailResult);
const previewParams = validation(p.validateTemplatesCatalogPreviewParams);
const previewResult = validation(p.validateTemplatesCatalogPreviewResult);
const addPlan = validation(p.validateTemplatesAddPlanParams);
const addApply = validation(p.validateTemplatesAddApplyParams);
const updateApply = validation(p.validateTemplatesUpdateApplyParams);
const removeApply = validation(p.validateTemplatesRemoveApplyParams);
const planResult = validation(p.validateTemplateLifecyclePlanResult);

const coordinate = { packageName: "@openclaw/demo", version: "1.0.0" };
const catalogEntry = {
  packageName: coordinate.packageName,
  displayName: "Demo",
  channel: "official",
  official: true,
  downloads: 0,
  installs: 0,
  updatedAtMs: 0,
};
const basePlan = {
  schemaVersion: "openclaw.templatesGatewayPlan.v1",
  operation: "add",
  planIntegrity: "sha256:reviewed-plan",
  target: { agentId: "demo" },
  actions: [],
  capabilities: [],
  pluginReviews: [],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};
const checkPlan = planResult.accepts;
const rejectPlan = planResult.rejects;

describe("Templates Gateway contract", () => {
  it("allows the public catalog and exact publisher Add coordinates", () => {
    search.accepts({}, { query: "workflow", limit: 30 });
    search.rejects({ sourceRoot: "/private/template" });
    searchResult.accepts({ entries: [catalogEntry] });
    detail.accepts(coordinate);
    const preview = { kind: "instruction", name: "AGENTS.md" };
    previewParams.accepts({ ...coordinate, ...preview });
    previewResult.accepts({ preview: { ...preview, content: "# Instructions" } });
    detailResult.accepts({
      detail: {
        ...catalogEntry,
        version: coordinate.version,
        workspaceFiles: 2,
        skills: 0,
        plugins: 1,
        mcpServers: 0,
        scheduledJobs: 0,
        contents: {
          instructions: [{ name: "AGENTS.md", source: "AGENTS.md", excerpt: "Purpose" }],
          skills: [{ name: "research", version: "1", excerpt: "Research" }],
          integrations: [{ name: "lobster", kind: "plugin", version: "1" }],
          automations: [],
        },
      },
    });
    addPlan.accepts({ source: coordinate });

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
    addApply.accepts(apply(true));
    addApply.rejects(apply(false));
    addApply.accepts({
      source: { packageName: "@alice/demo", version: "1.0.0" },
      planIntegrity: "sha256:reviewed-plan",
    });
    searchResult.accepts({
      entries: [
        {
          ...catalogEntry,
          packageName: "@alice/demo",
          channel: "community",
          official: false,
          ownerHandle: "alice",
        },
      ],
    });
    for (const packageName of [
      "../local",
      "https://registry.example/template",
      "@alice/template@latest",
      "@Alice/template",
      "@alice/template ",
    ]) {
      addApply.rejects({ source: { packageName, version: "1.0.0" } });
    }
    updateApply.accepts({
      agentId: "demo",
      source: { ...coordinate, version: "1.0.1" },
      planIntegrity: "sha256:reviewed-update",
    });
    removeApply.accepts({ agentId: "demo", planIntegrity: "sha256:reviewed-remove" });
  });

  it("rejects source paths and setup answers in the browser's reviewed plan", () => {
    const plan = {
      ...basePlan,
      target: { agentId: "demo", name: coordinate.packageName },
      manifestDisclosure: {
        source: {
          ...coordinate,
          integrity: `sha256:${"a".repeat(64)}`,
          byteLength: 123,
        },
        manifestJson: '{"schemaVersion":1}',
      },
    };
    checkPlan(plan);
    rejectPlan({ ...plan, sourceRoot: "/private/template" });
    rejectPlan({ ...plan, answers: { token: "secret" } });
    rejectPlan({
      ...plan,
      manifestDisclosure: {
        ...plan.manifestDisclosure,
        source: { ...plan.manifestDisclosure.source, packageRoot: "/private/template" },
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
    rejectPlan({ ...plan, pluginReviews: [{ ...pluginReview, integrity: "sha256-not-a-digest" }] });
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
          sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro", backend: "docker" },
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
      scheduledJobs: { coverage: "package-declarations", jobs: [scheduledJob] },
    };
    const withAccess = (desired: object) => ({
      ...plan,
      configuredAccess: {
        ...plan.configuredAccess,
        desired: { ...plan.configuredAccess.desired, ...desired },
      },
    });
    checkPlan(plan);
    checkPlan(withAccess({ memorySearch: { state: "unresolved" } }));
    rejectPlan(
      withAccess({
        subagentTargets: {
          ...plan.configuredAccess.desired.subagentTargets,
          privatePolicy: "never disclose",
        },
      }),
    );
    const updatedJob = {
      ...scheduledJob,
      action: "change",
      current: {
        schedule: { cron: "0 8 * * *", timezone: "UTC" },
        session: "main",
        delivery: "none",
        messageDigest: "sha256:current-task",
      },
    };
    const withJob = (job: unknown) => ({
      ...updatePlan,
      scheduledJobs: { ...updatePlan.scheduledJobs, jobs: [job] },
    });
    const updatePlan = {
      ...plan,
      operation: "update",
      configuredAccess: { ...plan.configuredAccess, current: plan.configuredAccess.desired },
      scheduledJobs: { ...plan.scheduledJobs, jobs: [updatedJob] },
    };
    checkPlan(updatePlan);
    rejectPlan(
      withJob({ ...updatedJob, proposed: { ...scheduledJob.proposed, message: undefined } }),
    );
    for (const field of ["current", "proposed"] as const) {
      for (const [schedule, delivery, valid] of [
        [{ cron: "0 9 * * *", timezone: "UTC" }, "none", true],
        [{ cron: "0 9 * * *", timezone: "UTC" }, "last-channel", true],
        [{ cron: "0 9 * * *", timezone: "UTC" }, "owner", true],
        [{ everyMs: 1 }, "none", true],
        [{ everyMs: 0 }, "owner", false],
        [{ everyMs: 0.5 }, "owner", false],
        [{ cron: "0 9 * * *", timezone: "UTC", everyMs: 60_000 }, "owner", false],
      ] as const) {
        expect(
          p.validateTemplateLifecyclePlanResult(
            withJob({ ...updatedJob, [field]: { ...updatedJob[field], schedule, delivery } }),
          ),
        ).toBe(valid);
      }
    }
    rejectPlan(
      withJob({ ...updatedJob, current: { ...updatedJob.current, message: "private prompt" } }),
    );
  });
});
