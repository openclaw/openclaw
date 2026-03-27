import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionRecord, SubtaskRecord } from "./subagent-mission.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before dynamic import
// ---------------------------------------------------------------------------

// vi.hoisted ensures the spy is created BEFORE vi.mock factories run (hoisting order)
const { callGatewaySpy } = vi.hoisted(() => ({
  callGatewaySpy: vi.fn(async () => ({ runId: "run-main", status: "ok" })),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewaySpy,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});

const mockLogger: Record<string, unknown> = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockLogger,
}));

vi.mock("../memory/brain-mcp-client.js", () => ({
  createBrainMcpClient: vi.fn(() => ({})),
}));

vi.mock("./subagent-mission.store.js", () => ({
  loadMissionsFromDisk: vi.fn(() => new Map()),
  saveMissionsToDisk: vi.fn(),
}));

vi.mock("./subagent-registry.js", () => ({
  registerSubagentRun: vi.fn(),
  setRunCompletionInterceptor: vi.fn(),
}));

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: vi.fn(() => ""),
}));

vi.mock("./subagent-transcript-summary.js", () => ({
  extractTranscriptSummary: vi.fn(() => ""),
  formatTranscriptForRetry: vi.fn(() => ""),
}));

vi.mock("./task-list.js", () => ({
  markTaskByMission: vi.fn(),
  parseMissionLabelForListId: vi.fn(() => null),
  startTaskByMission: vi.fn(),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(async () => ""),
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentSkillsFilter: vi.fn(() => null),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp"),
}));

vi.mock("../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routing/session-key.js")>();
  return {
    ...actual,
    parseAgentSessionKey: vi.fn(() => ({ agentId: "main" })),
  };
});

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  const subtask: SubtaskRecord = {
    id: "task-1",
    agentId: "mars",
    originalTask: "check shopee ads",
    after: [],
    status: "ok",
    retryCount: 0,
    maxRetries: 2,
    loopCount: 1,
    loopHistory: [],
    loopFallbackCount: 0,
    result: "Shopee ads ROAS is 2.28 for campaign [5].",
  };

  return {
    missionId: "test-mission-id",
    label: "listId:abc:Shopee Ads Check",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    subtasks: new Map([["task-1", subtask]]),
    executionOrder: ["task-1"],
    status: "completed",
    createdAt: Date.now(),
    totalSpawns: 1,
    maxTotalSpawns: 10,
    announced: false,
    cleanup: "keep",
    ...overrides,
  };
}

function getAnnouncedMessage(): string {
  const calls = callGatewaySpy.mock.calls as unknown[][];
  const firstCall = calls[0];
  if (!firstCall) {
    return "";
  }
  const params = (firstCall[0] as { params?: { message?: string } } | undefined)?.params;
  return params?.message ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("announceMissionResult — quality gate instructions", () => {
  let announceMissionResult: (mission: MissionRecord) => Promise<void>;

  beforeEach(async () => {
    callGatewaySpy.mockClear();
    const mod = await import("./subagent-mission.js");
    announceMissionResult = mod.__testing.announceMissionResult;
  });

  it("injects D1–D6 quality gate when qualityGateRequired is true", async () => {
    const mission = makeMission({ qualityGateRequired: true });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("DELEGATION PROTOCOL — PHASE 2 REQUIRED");
    expect(msg).toContain("D1 (Decomposition)");
    expect(msg).toContain("D2 (Discipline)");
    expect(msg).toContain("D3 (Outcome)");
    expect(msg).toContain("D4 (Contribution)");
    expect(msg).toContain("D5 (Completion)");
    expect(msg).toContain("D6 (Execution)");
    expect(msg).toContain("VERDICT: ACCEPT or RETRY");
    expect(msg).toContain("Maximum 1 outer retry");
    expect(msg).toContain("Gate 5");
    expect(msg).toContain("Gate 6");
    expect(msg).toContain("Gate 7");
    expect(msg).toContain("Do NOT skip the quality gate");
  });

  it("injects generic synthesis when qualityGateRequired is false", async () => {
    const mission = makeMission({ qualityGateRequired: false });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("Synthesize these results");
    expect(msg).not.toContain("DELEGATION PROTOCOL");
    expect(msg).not.toContain("D1 (Decomposition)");
    expect(msg).not.toContain("VERDICT");
  });

  it("defaults to generic synthesis when qualityGateRequired is undefined", async () => {
    const mission = makeMission({ qualityGateRequired: undefined });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("Synthesize these results");
    expect(msg).not.toContain("DELEGATION PROTOCOL");
  });

  it("includes subtask results in the announce message", async () => {
    const mission = makeMission({ qualityGateRequired: true });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("Shopee ads ROAS is 2.28");
    expect(msg).toContain("task-1");
  });

  it("includes BLAME_PHASE instruction for RETRY", async () => {
    const mission = makeMission({ qualityGateRequired: true });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("BLAME_PHASE");
    expect(msg).toContain("BLAME_DETAIL");
    expect(msg).toContain("planning|execution|synthesis");
  });

  it("truncates large subtask results", async () => {
    const bigResult = "x".repeat(5000);
    const mission = makeMission({ qualityGateRequired: true });
    const subtask = mission.subtasks.get("task-1")!;
    subtask.result = bigResult;
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg.length).toBeLessThan(bigResult.length);
    expect(msg).toContain("[... truncated");
    expect(msg).toContain("5000 chars");
  });

  it("injects compensation instructions for partial/failed missions", async () => {
    const failedSubtask: SubtaskRecord = {
      id: "task-2",
      agentId: "freya",
      originalTask: "fulfill lazada order",
      after: ["task-1"],
      status: "error",
      retryCount: 0,
      maxRetries: 0,
      loopCount: 0,
      loopHistory: [],
      loopFallbackCount: 0,
      outcome: { status: "error", error: "Lazada API timeout" },
    };

    const mission = makeMission({
      qualityGateRequired: true,
      status: "partial",
    });
    // Task-1 succeeded with compensation, task-2 failed
    const task1 = mission.subtasks.get("task-1")!;
    task1.compensationAction = "Call oms.record_inbound to reverse the inventory deduction";
    mission.subtasks.set("task-2", failedSubtask);
    mission.executionOrder = ["task-1", "task-2"];
    // Build compensations like checkMissionCompletion does
    const compensations: string[] = [];
    for (const id of [...mission.executionOrder].toReversed()) {
      const st = mission.subtasks.get(id);
      if (st?.status === "ok" && st.compensationAction) {
        compensations.push(`- Rollback **${id}** (${st.agentId}): ${st.compensationAction}`);
      }
    }
    mission.pendingCompensations = compensations;

    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("COMPENSATION REQUIRED");
    expect(msg).toContain("Rollback **task-1**");
    expect(msg).toContain("oms.record_inbound");
  });

  it("injects FINDINGS REQUIRING ACTION when subtask result contains findings JSON", async () => {
    const resultWithFindings = `Task completed successfully.

\`\`\`json
{
  "findings": [
    {
      "id": "F-001",
      "severity": "low",
      "category": "code-quality",
      "title": "Unused import in auth.ts",
      "action": "Remove unused import on line 14",
      "agent": "vulcan",
      "reversible": true
    },
    {
      "id": "F-002",
      "severity": "high",
      "category": "security",
      "title": "Hardcoded API key",
      "action": "Move to env variable",
      "agent": "vulcan",
      "reversible": false
    }
  ]
}
\`\`\``;

    const mission = makeMission({ qualityGateRequired: true });
    const subtask = mission.subtasks.get("task-1")!;
    subtask.result = resultWithFindings;
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("FINDINGS REQUIRING ACTION");
    expect(msg).toContain("GREEN");
    expect(msg).toContain("F-001");
    expect(msg).toContain("Unused import");
    expect(msg).toContain("RED");
    expect(msg).toContain("F-002");
    expect(msg).toContain("Hardcoded API key");
  });

  it("skips FINDINGS section when no findings JSON in subtask results", async () => {
    const mission = makeMission({ qualityGateRequired: true });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("DELEGATION PROTOCOL");
    expect(msg).not.toContain("FINDINGS REQUIRING ACTION");
  });

  it("includes Gate 6 and Gate 7 instructions in quality gate announce", async () => {
    const mission = makeMission({ qualityGateRequired: true });
    await announceMissionResult(mission);

    const msg = getAnnouncedMessage();
    expect(msg).toContain("Gate 6 (Autonomous Follow-up)");
    expect(msg).toContain("Gate 7");
    expect(msg).toContain("Do NOT emit <final> until Gate 6 completes");
  });
});

describe("extractFindings", () => {
  let extractFindings: (text: string) => import("./subagent-mission.js").Finding[];

  beforeEach(async () => {
    const mod = await import("./subagent-mission.js");
    extractFindings = mod.__testing.extractFindings;
  });

  it("extracts findings from fenced JSON blocks", () => {
    const text = `Some result text.

\`\`\`json
{
  "findings": [
    { "id": "F-001", "title": "Bad import", "severity": "low", "category": "code-quality", "action": "fix it" }
  ]
}
\`\`\``;
    const findings = extractFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F-001");
    expect(findings[0].title).toBe("Bad import");
    expect(findings[0].severity).toBe("low");
    expect(findings[0].category).toBe("code-quality");
  });

  it("returns empty array when no findings blocks exist", () => {
    const findings = extractFindings("No findings here, just text.");
    expect(findings).toHaveLength(0);
  });

  it("defaults severity to medium and category to unknown when missing", () => {
    const text = `\`\`\`json
{ "findings": [{ "id": "F-X", "title": "Missing fields" }] }
\`\`\``;
    const findings = extractFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("unknown");
  });

  it("skips invalid JSON blocks gracefully", () => {
    const text = `\`\`\`json
{ not valid json }
\`\`\`

\`\`\`json
{ "findings": [{ "id": "F-1", "title": "Valid" }] }
\`\`\``;
    const findings = extractFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("F-1");
  });
});

describe("classifyFindings", () => {
  let classifyFindings: typeof import("./subagent-mission.js").classifyFindings;

  beforeEach(async () => {
    const mod = await import("./subagent-mission.js");
    classifyFindings = mod.__testing.classifyFindings;
  });

  const defaultPolicy = {
    green: { categories: ["code-quality", "formatting"], maxSeverity: "medium" as const },
    yellow: { categories: ["refactoring"], maxSeverity: "critical" as const },
    red: { categories: ["security", "data-migration"] },
  };

  it("classifies code-quality low severity as GREEN", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "code-quality",
        title: "Unused var",
        action: "remove",
        reversible: true,
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions).toHaveLength(1);
    expect(actions[0].riskTier).toBe("green");
  });

  it("classifies security findings as RED regardless of severity", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "security",
        title: "Hardcoded key",
        action: "move to env",
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].riskTier).toBe("red");
  });

  it("classifies unknown categories as YELLOW", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "something-else",
        title: "Unknown",
        action: "check",
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].riskTier).toBe("yellow");
  });

  it("auto-promotes non-reversible GREEN to YELLOW", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "code-quality",
        title: "Irreversible fix",
        action: "apply",
        reversible: false,
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].riskTier).toBe("yellow");
  });

  it("classifies high-severity code-quality as YELLOW (exceeds green maxSeverity)", () => {
    const findings = [
      {
        id: "F-1",
        severity: "high" as const,
        category: "code-quality",
        title: "Critical fix",
        action: "refactor",
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].riskTier).toBe("yellow");
  });

  it("defaults targetAgent to vulcan when finding has no agent", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "code-quality",
        title: "Fix",
        action: "fix",
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].targetAgent).toBe("vulcan");
  });

  it("uses finding agent when specified", () => {
    const findings = [
      {
        id: "F-1",
        severity: "low" as const,
        category: "code-quality",
        title: "Fix",
        action: "fix",
        agent: "mars",
      },
    ];
    const actions = classifyFindings(findings, defaultPolicy);
    expect(actions[0].targetAgent).toBe("mars");
  });
});
