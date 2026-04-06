import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMemoryDreamingPhases } from "./dreaming-phases.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  resolveShortTermPhaseSignalStorePath,
} from "./short-term-promotion.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-phases-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createHarness(config: OpenClawConfig) {
  let beforeAgentReply:
    | ((
        event: { cleanedBody: string },
        ctx: { trigger?: string; workspaceDir?: string },
      ) => Promise<unknown>)
    | undefined;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api = {
    config,
    pluginConfig: {},
    logger,
    registerHook: vi.fn(),
    on: vi.fn((name: string, handler: unknown) => {
      if (name === "before_agent_reply") {
        beforeAgentReply = handler as typeof beforeAgentReply;
      }
    }),
  } as unknown as OpenClawPluginApi;

  registerMemoryDreamingPhases(api);
  if (!beforeAgentReply) {
    throw new Error("before_agent_reply hook not registered");
  }
  return { beforeAgentReply, logger };
}

describe("memory-core dreaming phases", () => {
  it("checkpoints daily ingestion and skips unchanged daily files", async () => {
    const workspaceDir = await createTempWorkspace();
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    const dailyPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.writeFile(
      dailyPath,
      ["# 2026-04-05", "", "- Move backups to S3 Glacier."].join("\n"),
      "utf-8",
    );

    const { beforeAgentReply } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                phases: {
                  light: {
                    enabled: true,
                    limit: 20,
                    lookbackDays: 2,
                  },
                },
              },
            },
          },
        },
      },
    });

    const readSpy = vi.spyOn(fs, "readFile");
    try {
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
      await beforeAgentReply(
        { cleanedBody: "__openclaw_memory_core_light_sleep__" },
        { trigger: "heartbeat", workspaceDir },
      );
    } finally {
      readSpy.mockRestore();
    }

    const dailyReadCount = readSpy.mock.calls.filter(
      ([target]) => String(target) === dailyPath,
    ).length;
    expect(dailyReadCount).toBe(1);
    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "daily-ingestion.json")),
    ).resolves.toBeUndefined();
  });

  it("ingests recent daily memory files even before recall traffic exists", async () => {
    const workspaceDir = await createTempWorkspace();
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      ["# 2026-04-05", "", "- Move backups to S3 Glacier.", "- Keep retention at 365 days."].join(
        "\n",
      ),
      "utf-8",
    );

    const before = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    expect(before).toHaveLength(0);

    const { beforeAgentReply } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                phases: {
                  light: {
                    enabled: true,
                    limit: 20,
                    lookbackDays: 2,
                  },
                },
              },
            },
          },
        },
      },
    });

    await beforeAgentReply(
      { cleanedBody: "__openclaw_memory_core_light_sleep__" },
      { trigger: "heartbeat", workspaceDir },
    );

    const after = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((candidate) => (candidate.dailyCount ?? 0) > 0)).toBe(true);
  });

  it("records light/rem signals that reinforce deep promotion ranking", async () => {
    const workspaceDir = await createTempWorkspace();
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await recordShortTermRecalls({
      workspaceDir,
      query: "glacier backup",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.92,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });
    await recordShortTermRecalls({
      workspaceDir,
      query: "cold storage retention",
      nowMs,
      results: [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "Move backups to S3 Glacier.",
          source: "memory",
        },
      ],
    });

    const baseline = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    expect(baseline).toHaveLength(1);
    const baselineScore = baseline[0]!.score;

    const { beforeAgentReply } = createHarness({
      plugins: {
        entries: {
          "memory-core": {
            config: {
              dreaming: {
                enabled: true,
                phases: {
                  light: {
                    enabled: true,
                    limit: 10,
                    lookbackDays: 7,
                  },
                  rem: {
                    enabled: true,
                    limit: 10,
                    lookbackDays: 7,
                    minPatternStrength: 0,
                  },
                },
              },
            },
          },
        },
      },
    });

    await beforeAgentReply(
      { cleanedBody: "__openclaw_memory_core_light_sleep__" },
      { trigger: "heartbeat", workspaceDir },
    );
    await beforeAgentReply(
      { cleanedBody: "__openclaw_memory_core_rem_sleep__" },
      { trigger: "heartbeat", workspaceDir },
    );

    const reinforced = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs,
    });
    expect(reinforced).toHaveLength(1);
    expect(reinforced[0]!.score).toBeGreaterThan(baselineScore);

    const phaseSignalPath = resolveShortTermPhaseSignalStorePath(workspaceDir);
    const phaseSignalStore = JSON.parse(await fs.readFile(phaseSignalPath, "utf-8")) as {
      entries: Record<string, { lightHits: number; remHits: number }>;
    };
    expect(phaseSignalStore.entries[reinforced[0]!.key]).toMatchObject({
      lightHits: 1,
      remHits: 1,
    });
  });
});
