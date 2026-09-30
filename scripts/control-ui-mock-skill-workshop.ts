import type {
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
} from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

type MockWorkshopSkill = { summary: SkillWorkshopSkillSummary; content: string };

type MockWorkshopVersion = {
  id: string;
  action: SkillWorkshopChange["action"];
  createdAtMs: number;
  skill: MockWorkshopSkill;
};

type SkillWorkshopMockSeed = {
  skills: MockWorkshopSkill[];
  versions: Record<string, MockWorkshopVersion[]>;
  changes: SkillWorkshopChange[];
};

function buildSkillWorkshopMocks(baseTime: number): SkillWorkshopMockSeed {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const skill = (name: string, description: string, steps: string[], updatedAtMs: number) => {
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      "",
    ].join("\n");
    return {
      summary: {
        name,
        description,
        updatedAtMs,
        sizeBytes: content.length,
        files: ["SKILL.md"],
        useCount: 3,
        lastUsedAtMs: updatedAtMs + hour,
      },
      content,
    };
  };
  const skills = [
    skill(
      "release-notes",
      "Use when drafting release notes from merged PRs; group by user impact.",
      [
        "List merged PRs since the last tag with `gh pr list --state merged`.",
        "Group entries by user-visible impact, not by package.",
        "Link each entry to its PR once.",
      ],
      baseTime - 2 * hour,
    ),
    skill(
      "budget-reconciliation",
      "Use when reconciling the monthly budget; match bank CSV rows before categorizing.",
      [
        "Import the bank CSV before editing categories.",
        "Match transfers by amount and date within one day.",
        "Flag unmatched rows instead of guessing a category.",
      ],
      baseTime - day,
    ),
  ];
  const changes: SkillWorkshopChange[] = [
    {
      id: "change-release-notes-patch",
      agentId: "main",
      skillName: "release-notes",
      action: "patch",
      actor: "review",
      summary: "tightened PR grouping step",
      versionId: "20260101T000000000Z-patch",
      createdAtMs: baseTime - 2 * hour,
    },
    {
      id: "change-budget-create",
      agentId: "main",
      skillName: "budget-reconciliation",
      action: "create",
      actor: "agent",
      summary: "created: monthly budget reconciliation",
      createdAtMs: baseTime - day,
    },
  ];
  // The review's patch saved the pre-change copy, so its Undo has something to restore.
  const releaseNotesBeforePatch = skill(
    "release-notes",
    "Use when drafting release notes from merged PRs.",
    ["List merged PRs since the last tag.", "Group entries by package."],
    baseTime - 3 * day,
  );
  const versions = {
    "release-notes": [
      {
        id: "20260101T000000000Z-patch",
        action: "patch" as const,
        createdAtMs: baseTime - 2 * hour,
        skill: releaseNotesBeforePatch,
      },
    ],
  };
  return { skills, versions, changes };
}

/** Each agent's Workshop owns its skills, versions, and change feed. */
function installSkillWorkshopMock(seed: SkillWorkshopMockSeed): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  type Scope = {
    skills: Map<string, MockWorkshopSkill>;
    versions: Map<string, MockWorkshopVersion[]>;
    changes: SkillWorkshopChange[];
  };
  const scopes = new Map<string, Scope>();
  const scopeFor = (agentId: string): Scope => {
    let scope = scopes.get(agentId);
    if (!scope) {
      scope = {
        skills: new Map(seed.skills.map((entry) => [entry.summary.name, structuredClone(entry)])),
        versions: new Map(Object.entries(structuredClone(seed.versions))),
        changes: structuredClone(seed.changes).map((change) => Object.assign(change, { agentId })),
      };
      scopes.set(agentId, scope);
    }
    return scope;
  };
  const reject = (respond: (payload: unknown) => void, message: string) =>
    respond({ __mockError: { code: "INVALID_REQUEST", message } });
  const record = (
    scope: Scope,
    agentId: string,
    name: string,
    action: SkillWorkshopChange["action"],
    summary: string,
  ): SkillWorkshopChange => {
    const now = Date.now();
    const live = scope.skills.get(name);
    let versionId: string | undefined;
    if (live) {
      versionId = `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${action}`;
      scope.versions.set(name, [
        { id: versionId, action, createdAtMs: now, skill: structuredClone(live) },
        ...(scope.versions.get(name) ?? []),
      ]);
    }
    const change: SkillWorkshopChange = {
      id: `change-${name}-${now}`,
      agentId,
      skillName: name,
      action,
      actor: "user",
      summary,
      ...(versionId ? { versionId } : {}),
      createdAtMs: now,
    };
    scope.changes.unshift(change);
    return change;
  };
  const handlers: Record<
    string,
    (params: Record<string, unknown>, agentId: string, respond: (payload: unknown) => void) => void
  > = {
    "skills.workshop.list": (_params, agentId, respond) => {
      const scope = scopeFor(agentId);
      const result: SkillsWorkshopListResult = {
        agentId,
        mode: "auto",
        root: `~/.openclaw/agents/${agentId}/agent/workshop-skills`,
        skills: [...scope.skills.values()].map((entry) => entry.summary),
        archived: [...scope.versions.entries()].map(([name, versions]) => ({
          name,
          live: scope.skills.has(name),
          versions: versions.map(({ id, action, createdAtMs }) => ({ id, action, createdAtMs })),
        })),
      };
      respond(result);
    },
    "skills.workshop.changes": (params, agentId, respond) => {
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const beforeMs = typeof params.beforeMs === "number" ? params.beforeMs : Infinity;
      const result: SkillsWorkshopChangesResult = {
        changes: scopeFor(agentId)
          .changes.filter((change) => change.createdAtMs < beforeMs)
          .slice(0, limit),
      };
      respond(result);
    },
    "skills.workshop.read": (params, agentId, respond) => {
      const scope = scopeFor(agentId);
      const name = typeof params.name === "string" ? params.name : "";
      const skill =
        typeof params.versionId === "string"
          ? scope.versions.get(name)?.find((version) => version.id === params.versionId)?.skill
          : scope.skills.get(name);
      if (!skill) {
        reject(respond, `Mock Workshop skill not found: ${name}`);
        return;
      }
      respond({ name, filePath: "SKILL.md", content: skill.content, files: skill.summary.files });
    },
    "skills.workshop.archive": (params, agentId, respond) => {
      const scope = scopeFor(agentId);
      const name = typeof params.name === "string" ? params.name : "";
      if (!scope.skills.has(name)) {
        reject(respond, `No live Workshop skill named ${name}.`);
        return;
      }
      const reason = typeof params.reason === "string" ? params.reason : "archived";
      const change = record(scope, agentId, name, "archive", reason);
      scope.skills.delete(name);
      respond({ change });
    },
    "skills.workshop.restore": (params, agentId, respond) => {
      const scope = scopeFor(agentId);
      const name = typeof params.name === "string" ? params.name : "";
      const versions = scope.versions.get(name) ?? [];
      const version =
        typeof params.versionId === "string"
          ? versions.find((entry) => entry.id === params.versionId)
          : versions[0];
      if (!version) {
        reject(respond, `No saved version of ${name} to restore.`);
        return;
      }
      const change = record(scope, agentId, name, "restore", `restored ${version.id}`);
      scope.skills.set(name, structuredClone(version.skill));
      respond({ change });
    },
  };
  for (const [method, handler] of Object.entries(handlers)) {
    gateway.setRequestHandler(method, ({ params, respond }) => {
      const input = (params ?? {}) as Record<string, unknown>;
      handler(input, typeof input.agentId === "string" ? input.agentId : "main", respond);
    });
  }
}

export function skillWorkshopMockInitScript(baseTime: number): string {
  return `(() => { const __name = (target) => target; (${installSkillWorkshopMock.toString()})(${JSON.stringify(buildSkillWorkshopMocks(baseTime))}); })();`;
}
