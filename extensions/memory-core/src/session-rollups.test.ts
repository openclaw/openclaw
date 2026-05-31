import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inspectSessionRollupPlan,
  resolveMemoryRollupConfig,
  writeSessionRollups,
} from "./session-rollups.js";

type RollupConfig = Parameters<typeof inspectSessionRollupPlan>[0]["config"];

let fixtureRoot = "";
let caseCounter = 0;
let previousStateDir: string | undefined;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-rollup-tests-"));
});

afterAll(async () => {
  if (!fixtureRoot) {
    return;
  }
  if (previousStateDir !== undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function withStateDir(prefix: string): {
  stateDir: string;
  sessionsDir: string;
  restore: () => void;
} {
  const stateDir = path.join(fixtureRoot, `${prefix}-${caseCounter++}`);
  const previous = process.env.OPENCLAW_STATE_DIR;
  previousStateDir = previous;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  return {
    stateDir,
    sessionsDir: path.join(stateDir, "agents", "main", "sessions"),
    restore: () => {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
    },
  };
}

function buildMessage(role: "user" | "assistant", text: string, ts: string) {
  return JSON.stringify({
    type: "message",
    message: {
      role,
      content: text,
    },
    timestamp: ts,
  });
}

function buildUntimestampedMessage(role: "user" | "assistant", text: string) {
  return JSON.stringify({
    type: "message",
    message: {
      role,
      content: text,
    },
  });
}

async function createWorkspace(prefix: string): Promise<{
  workspaceDir: string;
}> {
  const workspaceDir = path.join(fixtureRoot, `${prefix}-workspace`);
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  return {
    workspaceDir,
  };
}

function buildRollupConfig(overrides: Partial<RollupConfig> = {}): RollupConfig {
  return {
    ...resolveMemoryRollupConfig({
      memoryRollups: {
        enabled: true,
        outputDir: "memory/session-rollups",
        maxMessages: 80,
        maxSummaryChars: 2000,
        redactSecrets: true,
      },
    }),
    ...overrides,
  };
}

describe("session-rollups", () => {
  it("discovers session transcripts and builds deterministic missing actions", async () => {
    const { sessionsDir, restore } = withStateDir("plan-missing");
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "main.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          buildMessage(
            "user",
            "I decided we should persist durable summaries from every important chat.",
            "2026-05-31T01:00:00.000Z",
          ),
          buildMessage(
            "assistant",
            "Great, we should build deterministic rollups next.",
            "2026-05-31T01:00:10.000Z",
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const { workspaceDir } = await createWorkspace("plan-missing");
      const config = buildRollupConfig();
      const plan = await inspectSessionRollupPlan({
        workspaceDir,
        agentId: "main",
        config,
      });

      expect(plan.discovered).toBe(1);
      expect(plan.generated).toBe(0);
      expect(plan.pending).toBe(1);
      expect(plan.stale).toBe(0);
      expect(plan.orphaned).toBe(0);
      expect(plan.actions).toHaveLength(1);
      expect(plan.actions[0]?.status).toBe("missing");
      expect(plan.actions[0]?.sourceTranscript.endsWith("main.jsonl")).toBe(true);
    } finally {
      restore();
    }
  });

  it("writes rollups idempotently", async () => {
    const { sessionsDir, restore } = withStateDir("plan-idempotent");
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "main.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          buildMessage(
            "user",
            "Please create a deterministic summary and write the next actions.",
            "2026-05-31T02:00:00.000Z",
          ),
          buildMessage(
            "assistant",
            "Captured the follow-up and scheduling actions.",
            "2026-05-31T02:00:20.000Z",
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const { workspaceDir } = await createWorkspace("plan-idempotent");
      const config = buildRollupConfig();

      const first = await writeSessionRollups({
        workspaceDir,
        agentId: "main",
        config,
        apply: true,
      });
      expect(first.wrote).toBe(1);
      expect(first.unchanged).toBe(0);
      expect(first.generated).toBe(1);
      expect(first.pending).toBe(0);
      expect(first.evidenceCoveragePercent).toBe(100);
      expect(first.actions[0]?.status).toBe("upToDate");
      expect(first.actions[0]?.outputCreated).toBe(true);

      const second = await writeSessionRollups({
        workspaceDir,
        agentId: "main",
        config,
        apply: true,
      });
      expect(second.wrote).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(second.skipped).toBe(0);

      const rollupPath = first.actions[0]?.outputPath;
      if (!rollupPath) {
        throw new Error("expected rollup output path");
      }
      expect(rollupPath).toBe(
        path.join(workspaceDir, "memory", "session-rollups", "main", "main.md"),
      );
      const rollupText = await fs.readFile(rollupPath, "utf-8");
      expect(rollupText).toContain("sessionId: main__main");
      expect(rollupText).toContain("## Session Intent");
      expect(rollupText).toContain("## Key Decisions");
      expect(rollupText).toContain("## Open Follow-ups");
    } finally {
      restore();
    }
  });

  it("summarizes the most recent bounded messages", async () => {
    const { sessionsDir, restore } = withStateDir("plan-recent");
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "main.jsonl"),
        [
          buildMessage(
            "user",
            "Old setup detail that should fall out of a tight rollup window.",
            "2026-05-31T01:00:00.000Z",
          ),
          buildMessage(
            "assistant",
            "Old response detail that should not be used as the session intent.",
            "2026-05-31T01:00:10.000Z",
          ),
          buildMessage(
            "user",
            "Recent durable decision: generate rollups from the latest bounded context.",
            "2026-05-31T01:00:20.000Z",
          ),
          buildMessage(
            "assistant",
            "Recent follow-up: verify the generated rollup stays concise.",
            "2026-05-31T01:00:30.000Z",
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const { workspaceDir } = await createWorkspace("plan-recent");
      const result = await writeSessionRollups({
        workspaceDir,
        agentId: "main",
        config: buildRollupConfig({ maxMessages: 2 }),
        apply: true,
      });

      const rollupText = await fs.readFile(result.actions[0]?.outputPath ?? "", "utf-8");
      expect(rollupText).toContain("Recent durable decision");
      expect(rollupText).toContain("Recent follow-up");
      expect(rollupText).not.toContain("Old setup detail");
    } finally {
      restore();
    }
  });

  it("uses deterministic fallback timestamps for untimestamped transcripts", async () => {
    const { sessionsDir, restore } = withStateDir("plan-untimestamped");
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "main.jsonl"),
        [
          buildUntimestampedMessage(
            "user",
            "Remember this untimestamped session deterministically.",
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const { workspaceDir } = await createWorkspace("plan-untimestamped");
      const result = await writeSessionRollups({
        workspaceDir,
        agentId: "main",
        config: buildRollupConfig(),
        apply: true,
      });

      const rollupText = await fs.readFile(result.actions[0]?.outputPath ?? "", "utf-8");
      expect(rollupText).toContain('startAt: "1970-01-01T00:00:00.000Z"');
      expect(rollupText).toContain('endAt: "1970-01-01T00:00:00.000Z"');
    } finally {
      restore();
    }
  });

  it("detects stale and orphaned rollups", async () => {
    const { sessionsDir, restore } = withStateDir("plan-stale-orphan");
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "main.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          buildMessage(
            "user",
            "Open a clean reliability workflow and verify everything at scale.",
            "2026-05-31T03:00:00.000Z",
          ),
        ].join("\n") + "\n",
        "utf-8",
      );

      const { workspaceDir } = await createWorkspace("plan-stale-orphan");
      const config = buildRollupConfig({ maxMessages: 2 });
      const first = await writeSessionRollups({
        workspaceDir,
        agentId: "main",
        config,
        apply: true,
      });
      expect(first.unchanged).toBe(0);
      expect(first.orphaned).toBe(0);

      const stalePlan = await inspectSessionRollupPlan({
        workspaceDir,
        agentId: "main",
        config: buildRollupConfig({ maxMessages: 1 }),
      });
      expect(stalePlan.stale).toBe(1);
      expect(stalePlan.pending).toBe(0);
      expect(stalePlan.orphaned).toBe(0);

      await fs.rm(transcriptPath);
      const orphanPlan = await inspectSessionRollupPlan({
        workspaceDir,
        agentId: "main",
        config: buildRollupConfig({ maxMessages: 1 }),
      });
      expect(orphanPlan.discovered).toBe(0);
      expect(orphanPlan.pending).toBe(0);
      expect(orphanPlan.stale).toBe(0);
      expect(orphanPlan.orphaned).toBe(1);
      expect(orphanPlan.orphans).toHaveLength(1);
      const orphan = orphanPlan.orphans[0];
      expect(orphan).toBeDefined();
      expect(orphan?.reason).toBe("orphan");
      expect(orphan?.sourceTranscript?.endsWith("main.jsonl")).toBe(true);
      expect(orphan?.outputPath).toBe(first.actions[0]?.outputPath);
    } finally {
      restore();
    }
  });
});
