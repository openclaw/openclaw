import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContinuityManifest,
  formatContinuityManifest,
  hasMaterialContinuityChange,
  parseContinuityDocument,
  RECENT_CONTINUITY_LATEST,
  renderContinuitySnapshotMarkdown,
} from "./continuity.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-continuity-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "memory", "recent", "snapshots"), { recursive: true });
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("parseContinuityDocument", () => {
  it("parses recent snapshot frontmatter and sections", () => {
    const content = renderContinuitySnapshotMarkdown({
      status: "active",
      priority: "high",
      updatedAt: "2026-04-03T09:00:00.000Z",
      supersedes: "memory/recent/latest.md",
      source: "session-memory:command",
      project: "memory-system",
      sessionKey: "agent:main:main",
      validUntil: "2026-04-04T09:00:00.000Z",
      currentTask: "Implement continuity manifest",
      currentPhase: "v1 delivery",
      latestUserRequest: "Absorb Claude memory patterns",
      blockers: ["Need stable parsing"],
      nextSteps: ["Wire post-compaction context"],
      keyArtifacts: ["src/memory/continuity.ts"],
      conversationSummary: "The user wants a lighter but more resilient memory system.",
    });

    const parsed = parseContinuityDocument(content);
    expect(parsed.status).toBe("active");
    expect(parsed.priority).toBe("high");
    expect(parsed.project).toBe("memory-system");
    expect(parsed.currentTask).toBe("Implement continuity manifest");
    expect(parsed.currentPhase).toBe("v1 delivery");
    expect(parsed.latestUserRequest).toBe("Absorb Claude memory patterns");
    expect(parsed.blockers).toEqual(["Need stable parsing"]);
    expect(parsed.nextSteps).toEqual(["Wire post-compaction context"]);
    expect(parsed.keyArtifacts).toEqual(["src/memory/continuity.ts"]);
  });

  it("parses legacy markdown field headers", () => {
    const legacy = `# 当前进度说明

- 项目：系统修复
- 状态：active
- 优先级：highest
- 当前阶段：记忆系统迭代 v1 落地与验证
- 当前主任务：补近场快照与恢复索引
- 当前阻塞：还没做第二轮验证
- 下一步：跑针对性测试
`;

    const parsed = parseContinuityDocument(legacy);
    expect(parsed.project).toBe("系统修复");
    expect(parsed.status).toBe("active");
    expect(parsed.priority).toBe("highest");
    expect(parsed.currentPhase).toBe("记忆系统迭代 v1 落地与验证");
    expect(parsed.currentTask).toBe("补近场快照与恢复索引");
    expect(parsed.blockers).toEqual(["还没做第二轮验证"]);
    expect(parsed.nextSteps).toEqual(["跑针对性测试"]);
  });
});

describe("hasMaterialContinuityChange", () => {
  it("ignores validUntil-only changes", () => {
    const previous = renderContinuitySnapshotMarkdown({
      status: "active",
      priority: "high",
      updatedAt: "2026-04-03T09:00:00.000Z",
      source: "session-memory:command",
      project: "memory-system",
      sessionKey: "agent:main:main",
      validUntil: "2026-04-04T09:00:00.000Z",
      currentTask: "Implement continuity manifest",
      currentPhase: "v1 delivery",
      latestUserRequest: "Absorb Claude memory patterns",
      blockers: [],
      nextSteps: ["Wire post-compaction context"],
      keyArtifacts: [],
    });

    const next = {
      status: "active",
      priority: "high",
      updatedAt: "2026-04-03T10:00:00.000Z",
      source: "session-memory:command",
      project: "memory-system",
      sessionKey: "agent:main:main",
      validUntil: "2026-04-05T09:00:00.000Z",
      currentTask: "Implement continuity manifest",
      currentPhase: "v1 delivery",
      latestUserRequest: "Absorb Claude memory patterns",
      blockers: [],
      nextSteps: ["Wire post-compaction context"],
      keyArtifacts: [],
    };

    expect(hasMaterialContinuityChange(previous, next)).toBe(false);
  });
});

describe("buildContinuityManifest", () => {
  it("sorts active recent continuity ahead of stale memory", async () => {
    const workspace = await makeWorkspace();
    const latestPath = path.join(workspace, RECENT_CONTINUITY_LATEST);
    await fs.writeFile(
      latestPath,
      renderContinuitySnapshotMarkdown({
        status: "active",
        priority: "highest",
        updatedAt: "2026-04-03T09:00:00.000Z",
        source: "session-memory:command",
        project: "system-repair",
        sessionKey: "agent:main:main",
        validUntil: "2026-04-04T09:00:00.000Z",
        currentTask: "Ship memory iteration",
        currentPhase: "verification",
        latestUserRequest: "Implement the meeting plan",
        blockers: ["Need to finish tests"],
        nextSteps: ["Run vitest"],
        keyArtifacts: ["memory/recent/latest.md"],
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspace, "memory", "active-topics.md"),
      `# Active Topics

- 状态：active
- 优先级：high
- updated_at：2026-04-03 15:00 CST
- 当前主任务：记忆系统迭代与官方贡献目标
`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspace, "memory", "2026-03-20.md"),
      `# Old Daily

- 状态：stale
- 优先级：low
- updated_at：2026-03-20 09:00 CST
- 当前主任务：旧项目
`,
      "utf-8",
    );

    const manifest = await buildContinuityManifest({ workspaceDir: workspace });
    expect(manifest[0]?.path).toBe("memory/recent/latest.md");
    expect(manifest[1]?.path).toBe("memory/active-topics.md");

    const formatted = formatContinuityManifest(manifest, 2);
    expect(formatted).toContain("[active/highest] memory/recent/latest.md");
    expect(formatted).toContain("[active/high] memory/active-topics.md");
  });
});
