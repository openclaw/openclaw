import type {
  SkillsProposalEvaluateResult,
  SkillsProposalInspectResult,
  SkillsProposalRecordResult,
  SkillsProposalsListResult,
} from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

export function buildSkillWorkshopMocks(baseTime: number) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const proposals = [
    {
      id: "prop-release-tweets",
      kind: "update",
      status: "pending",
      title: "Tighten release tweet drafting",
      description: "Capture the changelog-to-tweet flow the agent keeps re-deriving.",
      skillName: "release-tweets",
      skillKey: "release-tweets",
      createdAt: new Date(baseTime - 2 * hour).toISOString(),
      updatedAt: new Date(baseTime - hour).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-crawler-etiquette",
      kind: "create",
      status: "pending",
      title: "Add crawler etiquette skill",
      description: "Rate limits and robots.txt handling learned during the docs sweep.",
      skillName: "crawler-etiquette",
      skillKey: "crawler-etiquette",
      createdAt: new Date(baseTime - 3 * day).toISOString(),
      updatedAt: new Date(baseTime - 2 * day).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-changelog-style",
      kind: "update",
      status: "applied",
      title: "Changelog bullet style",
      description: "One bullet per entry, no hard wraps.",
      skillName: "changelog-style",
      skillKey: "changelog-style",
      createdAt: new Date(baseTime - 6 * day).toISOString(),
      updatedAt: new Date(baseTime - 5 * day).toISOString(),
      scanState: "clean",
    },
  ] satisfies SkillsProposalsListResult["proposals"];
  const revisionHash = "b".repeat(64);
  const recordFor = (proposal: (typeof proposals)[number]): SkillsProposalRecordResult => ({
    schema: "openclaw.skill-workshop.proposal.v1",
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    title: proposal.title,
    description: proposal.description,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    createdBy: "skill-workshop",
    proposedVersion: "2",
    draftFile: "PROPOSAL.md",
    draftHash: "a".repeat(64),
    target: {
      source: "openclaw-workshop",
      skillName: proposal.skillName,
      skillKey: proposal.skillKey,
      skillDir: `.agents/skills/${proposal.skillKey}`,
      skillFile: `.agents/skills/${proposal.skillKey}/SKILL.md`,
    },
    scan: {
      state: proposal.scanState,
      scannedAt: new Date(baseTime - hour).toISOString(),
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
  });
  const evaluation: SkillsProposalEvaluateResult["evaluation"] = {
    id: "evaluation-control-ui-mock",
    proposedVersion: "2",
    revisionHash,
    trigger: "manual",
    startedAt: new Date(baseTime - 20_000).toISOString(),
    completedAt: new Date(baseTime - 18_000).toISOString(),
    outcomes: [
      {
        pluginId: "fixture-quality",
        pluginVersion: "1.0.0",
        evaluatorId: "readability",
        status: "completed",
        result: {
          summary: "The workflow is bounded and includes a recovery step.",
          decision: "pass",
          decisionReason: "No blocking findings in the sanitized fixture.",
        },
      },
    ],
  };
  return {
    list: {
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date(baseTime - hour).toISOString(),
      proposals,
      installedSkills: proposals
        .filter((proposal) => proposal.status === "applied")
        .map((proposal) => ({
          name: proposal.skillName,
          skillKey: proposal.skillKey,
          description: proposal.description,
        })),
    },
    inspect: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          record: {
            ...recordFor(proposal),
            ...(proposal.id === "prop-release-tweets" ? { evaluation } : {}),
          },
          revisionHash,
          content: [
            `# ${proposal.title}`,
            "",
            proposal.description,
            "",
            "## Steps",
            "1. Gather the source material.",
            "2. Apply the documented workflow.",
          ].join("\n"),
          supportFiles: [],
        },
      })),
    },
    evaluation,
    requestRevision: { runId: "skill-workshop-revision-mock", status: "started" },
  };
}

/** Each agent's proposal records own both mutation replies and subsequent reads. */
function installSkillWorkshopMock(seed: ReturnType<typeof buildSkillWorkshopMocks>): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const scopes = new Map<
    string,
    {
      list: SkillsProposalsListResult;
      details: Map<string, SkillsProposalInspectResult>;
    }
  >();
  for (const method of [
    "list",
    "inspect",
    "evaluate",
    "apply",
    "reject",
    "historyStatus",
    "historyScan",
    "read",
  ]) {
    gateway.setRequestHandler(
      method === "read" ? "skills.workshop.read" : `skills.proposals.${method}`,
      ({ params: input, respond }) => {
        if (method === "historyStatus" || method === "historyScan") {
          respond({
            __mockError: {
              code: "INVALID_REQUEST",
              message:
                "Historical batch scans are retired. Start a learning session from Workshop to review past conversations.",
            },
          });
          return;
        }
        const params = (input ?? {}) as {
          agentId?: string;
          proposalId?: string;
          expectedRevisionHash?: string;
          name?: string;
        };
        const agentId = params.agentId ?? "main";
        let scope = scopes.get(agentId);
        if (!scope) {
          scope = {
            list: {
              ...structuredClone(seed.list),
              schema: "openclaw.skill-workshop.proposals-manifest.v1",
            },
            details: new Map(
              seed.inspect.cases.map((entry) => [
                entry.match.proposalId,
                structuredClone(entry.response),
              ]),
            ),
          };
          scopes.set(agentId, scope);
        }
        if (method === "list") {
          respond(scope.list);
          return;
        }
        if (method === "read") {
          const installed = scope.list.installedSkills.find((skill) => skill.name === params.name);
          const detail =
            installed &&
            Array.from(scope.details.values()).find(
              (candidate) =>
                candidate.record.status === "applied" &&
                candidate.record.target.skillKey === installed.skillKey,
            );
          respond(
            installed && detail
              ? { ...installed, content: detail.content }
              : {
                  __mockError: {
                    code: "INVALID_REQUEST",
                    message: "Mock Workshop skill not found.",
                  },
                },
          );
          return;
        }
        const detail = params.proposalId ? scope.details.get(params.proposalId) : undefined;
        const reject = (message: string) =>
          respond({ __mockError: { code: "INVALID_REQUEST", message } });
        if (!detail) {
          reject("Unknown mock proposal; refresh the Workshop.");
          return;
        }
        if (method === "inspect") {
          respond(detail);
          return;
        }
        if (detail.record.status !== "pending") {
          reject("Only pending proposals can be evaluated, applied, or rejected.");
          return;
        }
        if (params.expectedRevisionHash && params.expectedRevisionHash !== detail.revisionHash) {
          reject("The proposal revision changed; refresh the proposal before retrying.");
          return;
        }
        const now = new Date().toISOString();
        detail.record.updatedAt = now;
        if (method === "evaluate") {
          const evaluation = structuredClone(seed.evaluation);
          evaluation.startedAt = now;
          evaluation.completedAt = now;
          detail.record.evaluation = evaluation;
        } else if (method === "apply") {
          detail.record.status = "applied";
          detail.record.appliedAt = now;
          const skillKey = detail.record.target.skillKey;
          const installed = {
            name: detail.record.kind === "create" ? skillKey : detail.record.target.skillName,
            skillKey,
            description: detail.record.description,
          };
          scope.list.installedSkills = [
            ...scope.list.installedSkills.filter((skill) => skill.skillKey !== skillKey),
            installed,
          ];
        } else {
          detail.record.status = "rejected";
          detail.record.rejectedAt = now;
        }
        const entry = scope.list.proposals.find((proposal) => proposal.id === detail.record.id);
        if (entry) {
          entry.status = detail.record.status;
          entry.updatedAt = now;
          entry.revisionHash = detail.revisionHash;
        }
        scope.list.updatedAt = now;
        if (method === "evaluate") {
          respond({ record: detail.record, evaluation: detail.record.evaluation });
        } else if (method === "apply") {
          respond({
            record: detail.record,
            targetSkillFile: `.agents/skills/${detail.record.target.skillKey}/SKILL.md`,
          });
        } else {
          respond(detail.record);
        }
      },
    );
  }
}

export function skillWorkshopMockInitScript(baseTime: number): string {
  return `(() => { const __name = (target) => target; (${installSkillWorkshopMock.toString()})(${JSON.stringify(buildSkillWorkshopMocks(baseTime))}); })();`;
}
