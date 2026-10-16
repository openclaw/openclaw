import type {
  SkillWorkshopChange,
  SkillWorkshopSkillSummary,
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
} from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

type MockWorkshopSkill = {
  summary: SkillWorkshopSkillSummary;
  content: string;
  supportFiles?: Record<string, string>;
};

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
  const skill = (
    name: string,
    description: string,
    body: string,
    updatedAtMs: number,
    options: { useCount?: number; lastUsedAtMs?: number; files?: Record<string, string> } = {},
  ): MockWorkshopSkill => {
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      body,
      "",
    ].join("\n");
    const supportFiles = options.files ?? {};
    return {
      summary: {
        name,
        description,
        updatedAtMs,
        sizeBytes: content.length,
        files: ["SKILL.md", ...Object.keys(supportFiles)],
        ...(options.useCount !== undefined ? { useCount: options.useCount } : {}),
        ...(options.lastUsedAtMs !== undefined ? { lastUsedAtMs: options.lastUsedAtMs } : {}),
      },
      content,
      supportFiles,
    };
  };
  const releaseNotesBody = [
    "# Release notes",
    "",
    "1. List merged PRs since the last tag with `gh pr list --state merged --base main`.",
    "2. Group entries by **user-visible impact**, not by package: Features, Fixes, Breaking.",
    "3. Link each entry to its PR once; credit outside contributors with `Thanks @handle`.",
    "4. Fill [templates/notes.md](templates/notes.md) and check every breaking change has a migration line.",
    "",
    "## Preferences",
    "",
    "- Lead with the change a user notices, not the implementation.",
    "- Keep each entry to one sentence.",
  ].join("\n");
  const skills = [
    skill(
      "release-notes",
      "Use when drafting release notes from merged PRs; group by user impact.",
      releaseNotesBody,
      baseTime - 2 * hour,
      {
        useCount: 12,
        lastUsedAtMs: baseTime - 2 * hour,
        files: {
          "templates/notes.md": "## Features\n\n- \n\n## Fixes\n\n- \n\n## Breaking\n\n- \n",
        },
      },
    ),
    skill(
      "budget-reconciliation",
      "Use when reconciling the monthly budget; match bank CSV rows before categorizing.",
      [
        "1. Export the month's CSV from the bank and import it before editing categories.",
        "2. Match transfers between accounts by amount and date within one day.",
        "3. Flag unmatched rows instead of guessing a category.",
        "4. Run `scripts/summary.py budget.csv` and compare totals to the bank statement.",
      ].join("\n"),
      baseTime - day,
      {
        useCount: 7,
        lastUsedAtMs: baseTime - 3 * day,
        files: {
          "scripts/summary.py":
            "import csv, sys\nfrom collections import defaultdict\n\ntotals = defaultdict(float)\nfor row in csv.DictReader(open(sys.argv[1])):\n    totals[row['category']] += float(row['amount'])\nfor category, amount in sorted(totals.items()):\n    print(f'{category:20} {amount:10.2f}')\n",
          "references/categories.md":
            "# Categories\n\n| Merchant contains | Category |\n|---|---|\n| GROCER | Groceries |\n| UBER | Transport |\n",
        },
      },
    ),
    skill(
      "trip-packing",
      "Use when packing for a trip; build the list from destination weather and trip length.",
      [
        "1. Check the forecast for each day of the trip.",
        "2. Pack one outfit per day plus one spare; layers for anything under 15 °C.",
        "3. Chargers and passport go in the carry-on.",
      ].join("\n"),
      baseTime - 5 * hour,
      { useCount: 1, lastUsedAtMs: baseTime - 5 * hour },
    ),
    skill(
      "flaky-test-triage",
      "Use when a CI test fails intermittently; rerun in isolation before blaming the change.",
      [
        "1. Rerun the failing test alone three times before reading the diff.",
        "2. Compare timing and ordering between passing and failing runs.",
        "3. Quarantine only with a linked issue.",
      ].join("\n"),
      baseTime - 22 * day,
      { useCount: 0 },
    ),
    skill(
      "contacts-cleanup",
      "Use when deduplicating the address book export; merge by phone, then email.",
      Array.from({ length: 3000 }, (_, index) => `- Rule ${index}: merge by phone`).join("\n"),
      baseTime - 6 * hour,
      { useCount: 2, lastUsedAtMs: baseTime - 6 * hour },
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
      id: "change-trip-packing-create",
      agentId: "main",
      skillName: "trip-packing",
      action: "create",
      actor: "agent",
      summary: "packing list from forecast",
      createdAtMs: baseTime - 5 * hour,
    },
    {
      // Its saved version was pruned; the row stays, without Compare or Undo.
      id: "change-trip-packing-pruned",
      agentId: "main",
      skillName: "trip-packing",
      action: "patch",
      actor: "review",
      summary: "added a carry-on checklist",
      versionId: "20251001T000000000Z-patch",
      createdAtMs: baseTime - 3 * hour,
    },
    {
      id: "change-contacts-cleanup-patch",
      agentId: "main",
      skillName: "contacts-cleanup",
      action: "patch",
      actor: "review",
      summary: "rewrote the merge rules",
      versionId: "20260102T000000000Z-patch",
      createdAtMs: baseTime - 6 * hour,
    },
    {
      id: "change-budget-write-file",
      agentId: "main",
      skillName: "budget-reconciliation",
      action: "write_file",
      actor: "review",
      summary: "added a totals script",
      versionId: "20251231T000000000Z-write_file",
      createdAtMs: baseTime - day,
    },
    {
      id: "change-release-notes-patch-older",
      agentId: "main",
      skillName: "release-notes",
      action: "patch",
      actor: "user",
      summary: "edited description",
      versionId: "20251230T000000000Z-patch",
      createdAtMs: baseTime - 2 * day,
    },
    {
      id: "change-standup-archive",
      agentId: "main",
      skillName: "standup-summary",
      action: "archive",
      actor: "user",
      summary: "no longer posting standups",
      versionId: "20251229T000000000Z-archive",
      createdAtMs: baseTime - 3 * day,
    },
    {
      id: "change-release-notes-create",
      agentId: "main",
      skillName: "release-notes",
      action: "create",
      actor: "agent",
      summary: "release notes from merged PRs",
      createdAtMs: baseTime - 4 * day,
    },
    {
      id: "change-budget-create",
      agentId: "main",
      skillName: "budget-reconciliation",
      action: "create",
      actor: "agent",
      summary: "monthly budget reconciliation",
      createdAtMs: baseTime - 6 * day,
    },
    {
      id: "change-flaky-test-triage-create",
      agentId: "main",
      skillName: "flaky-test-triage",
      action: "create",
      actor: "review",
      summary: "learned from a CI flake hunt",
      createdAtMs: baseTime - 22 * day,
    },
  ];
  // Large enough on both sides that a line diff would exceed the comparison budget.
  const largeContactsBefore = skill(
    "contacts-cleanup",
    "Use when deduplicating the address book export.",
    Array.from({ length: 3000 }, (_, index) => `- Old rule ${index}: merge by email`).join("\n"),
    baseTime - 2 * day,
  );
  // Each saved version is the copy from before the change with the same version id.
  const releaseNotesBeforePatch = skill(
    "release-notes",
    "Use when drafting release notes from merged PRs; group by user impact.",
    releaseNotesBody.replace(
      "2. Group entries by **user-visible impact**, not by package: Features, Fixes, Breaking.",
      "2. Group entries by package.",
    ),
    baseTime - 2 * day,
  );
  const releaseNotesBeforeDescription = skill(
    "release-notes",
    "Use when drafting release notes from merged PRs.",
    releaseNotesBody.replace(
      "2. Group entries by **user-visible impact**, not by package: Features, Fixes, Breaking.",
      "2. Group entries by package.",
    ),
    baseTime - 4 * day,
  );
  const budgetBeforeScript = skill(
    "budget-reconciliation",
    "Use when reconciling the monthly budget; match bank CSV rows before categorizing.",
    [
      "1. Export the month's CSV from the bank and import it before editing categories.",
      "2. Match transfers between accounts by amount and date within one day.",
      "3. Flag unmatched rows instead of guessing a category.",
    ].join("\n"),
    baseTime - 6 * day,
  );
  const versions = {
    "release-notes": [
      {
        id: "20260101T000000000Z-patch",
        action: "patch" as const,
        createdAtMs: baseTime - 2 * hour,
        skill: releaseNotesBeforePatch,
      },
      {
        id: "20251230T000000000Z-patch",
        action: "patch" as const,
        createdAtMs: baseTime - 2 * day,
        skill: releaseNotesBeforeDescription,
      },
    ],
    "budget-reconciliation": [
      {
        id: "20251231T000000000Z-write_file",
        action: "write_file" as const,
        createdAtMs: baseTime - day,
        skill: budgetBeforeScript,
      },
      // Retained, but its change row fell out of the agent-wide recent feed.
      {
        id: "20251215T000000000Z-patch",
        action: "patch" as const,
        createdAtMs: baseTime - 20 * day,
        skill: skill(
          "budget-reconciliation",
          "Use when reconciling the monthly budget.",
          "1. Import the bank CSV.\n2. Categorize each row.",
          baseTime - 25 * day,
        ),
      },
    ],
    "contacts-cleanup": [
      {
        id: "20260102T000000000Z-patch",
        action: "patch" as const,
        createdAtMs: baseTime - 6 * hour,
        skill: largeContactsBefore,
      },
    ],
    "standup-summary": [
      {
        id: "20251229T000000000Z-archive",
        action: "archive" as const,
        createdAtMs: baseTime - 3 * day,
        skill: skill(
          "standup-summary",
          "Use when summarizing yesterday's work for the team standup.",
          "1. Collect merged PRs and closed issues from the last day.\n2. Keep it to three bullets.",
          baseTime - 9 * day,
        ),
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
          // Newest first, like the Gateway's feed.
          .toSorted((a, b) => b.createdAtMs - a.createdAtMs)
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
      const filePath = typeof params.filePath === "string" ? params.filePath : "SKILL.md";
      const content = filePath === "SKILL.md" ? skill.content : skill.supportFiles?.[filePath];
      if (content === undefined) {
        reject(respond, `Mock Workshop file not found: ${filePath}`);
        return;
      }
      respond({ name, filePath, content, files: skill.summary.files });
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
      // Same wording as the Gateway's restoreWorkshopSkill summaries.
      const summary =
        version.action === "archive"
          ? "restored from archive"
          : typeof params.versionId === "string" && version !== versions[0]
            ? `restored version ${version.id}`
            : `undid ${version.action.replace("_", " ")}`;
      const change = record(scope, agentId, name, "restore", summary);
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
