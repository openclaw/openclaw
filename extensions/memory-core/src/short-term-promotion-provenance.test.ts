// Promotion keeps memory artifact provenance on the bytes it publishes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, beforeAll, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { resolveMemoryPathClassification } from "./memory/memory-path-provenance.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 } as const;
const dailyPath = "memory/2026-04-01.md";
const snippet = "Gateway binds loopback and port 18789";
let fixtureRoot = "";

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-provenance-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  resetMemoryCoreDreamingStateForTests();
});

async function createWorkspace(name: string) {
  const workspaceDir = path.join(fixtureRoot, name);
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  return workspaceDir;
}

async function writeFromTaintedTurn(workspaceDir: string, filePath: string, content: string) {
  setRuntimeConfigSnapshot({});
  try {
    const write = createOpenClawCodingTools({
      workspaceDir,
      senderIsOwner: true,
      isTurnTainted: () => true,
    }).find((tool) => tool.name === "write");
    await expectDefined(write, "write tool").execute("tainted-write", { path: filePath, content });
  } finally {
    clearRuntimeConfigSnapshot();
  }
}

async function promoteDailySnippet(workspaceDir: string) {
  await recordShortTermRecalls({
    workspaceDir,
    query: "gateway host",
    results: [
      {
        path: dailyPath,
        startLine: 1,
        endLine: 1,
        score: 0.92,
        snippet,
        source: "memory",
        provenance: {
          originClass: "agent",
          sessionKind: "unknown",
          observedAt: Date.parse("2026-04-01T12:00:00.000Z"),
        },
      },
    ],
  });
  const candidates = await rankShortTermPromotionCandidates({ workspaceDir, ...thresholds });
  expect(candidates[0]?.provenance?.originClass).toBe("agent");
  return await applyShortTermPromotions({ workspaceDir, candidates, ...thresholds });
}

it.each<[target: string, via: string]>([
  ["MEMORY.md", "MEMORY.md"],
  ...(process.platform === "win32"
    ? []
    : [["USER.md", "MEMORY.md -> USER.md"] as [string, string]]),
])("keeps an untrusted %s untrusted across a promotion through %s", async (target) => {
  const workspaceDir = await createWorkspace(`curated-${target}`);
  await fs.writeFile(path.join(workspaceDir, dailyPath), `${snippet}\n`);
  await writeFromTaintedTurn(workspaceDir, target, "# Memory\n- Injected note\n");
  if (target !== "MEMORY.md") {
    await fs.symlink(target, path.join(workspaceDir, "MEMORY.md"));
  }

  expect((await promoteDailySnippet(workspaceDir)).applied).toBe(1);
  expect(await fs.readFile(path.join(workspaceDir, target), "utf-8")).toContain(snippet);
  await expect(
    readMemoryArtifactProvenance({ workspaceDir, relativePath: target }),
  ).resolves.toMatchObject({ originClass: "untrusted" });
});

it("does not promote a trusted recall candidate from a quarantined daily file", async () => {
  const workspaceDir = await createWorkspace("daily");
  const notePath = path.join(workspaceDir, dailyPath);
  await writeFromTaintedTurn(workspaceDir, dailyPath, `${snippet}\n`);
  // An unrecorded inline dreaming block must not lift the daily-file quarantine.
  await writeDailyDreamingPhaseBlock({
    workspaceDir,
    phase: "light",
    bodyLines: ["- A light reflection."],
    hasContent: true,
    nowMs: Date.parse("2026-04-01T13:00:00.000Z"),
    timezone: "UTC",
    storage: { mode: "inline", separateReports: false },
  });
  expect(await fs.readFile(notePath, "utf-8")).toContain("openclaw:dreaming:light:start");

  const applied = await promoteDailySnippet(workspaceDir);
  expect(applied.applied).toBe(0);
  expect(applied.rejectedCandidates[0]).toMatchObject({
    reason: "origin filter (untrusted)",
    category: "origin",
  });
  await expect(fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8")).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  await expect(
    resolveMemoryPathClassification({ absolutePath: notePath, source: "memory", workspaceDir }),
  ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });
});
