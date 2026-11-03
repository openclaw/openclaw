import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { vitestArtifactEvidence, writeJson } from "./evidence-gallery.test-support.js";
import {
  buildQaOccurrenceEvidenceSummary,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import {
  aggregateQaProfileEvidenceShards,
  createQaProfileEvidenceShardPlan,
} from "./profile-evidence-sharding.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";
import * as taxonomyModule from "./scorecard-taxonomy.js";
import { makeQaSuiteTestOccurrence } from "./suite-test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { exclusiveLiveChannels, liveAdapterFactories } = vi.hoisted(() => {
  const definitions = [
    ["buzz", false, false],
    ["discord", false, true],
    ["matrix", true, true],
    ["msteams", true, false],
    ["slack", false, true],
    ["telegram", false, false],
    ["whatsapp", false, true],
  ] as const;
  return {
    exclusiveLiveChannels: definitions
      .filter(([, isolatesInstances]) => !isolatesInstances)
      .map(([channelId]) => channelId),
    liveAdapterFactories: definitions.map(([channelId, isolatesInstances, supportsModuleFlows]) =>
      Object.assign(
        {
          id: channelId,
          matches: (context: { channelId: string; driver: string }) =>
            context.channelId === channelId && context.driver === "live",
        },
        isolatesInstances ? { isolatesInstances: true } : {},
        supportsModuleFlows ? { supportsModuleFlows: true } : {},
      ),
    ),
  };
});

vi.mock("./live-transports/cli.js", () => ({
  listLiveTransportQaAdapterFactories: () => liveAdapterFactories,
}));

type ShardPlan = ReturnType<typeof createQaProfileEvidenceShardPlan>;

const aggregatePath = (outputDir: string) => path.join(outputDir, "aggregate", "qa-evidence.json");
const readEvidence = async (file: string) =>
  validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(file, "utf8")));
const aggregateEvidence = (outputDir: string, evidencePaths: string[]) =>
  aggregateQaProfileEvidenceShards({
    evidencePaths,
    generatedAt: "2026-08-16T00:00:01.000Z",
    outputPath: aggregatePath(outputDir),
    profile: "all",
  });

function shardIdForScenario(plan: ShardPlan, scenarioId: string) {
  return plan.shards.find((shard) => shard.scenarioIds.includes(scenarioId))?.id;
}

async function writeShardEvidenceSet(params: { incompleteFirstShard?: boolean } = {}) {
  const outputDir = tempDirs.make("qa-profile-shards-");
  const artifactContent = "shard artifact content\n";
  const artifactRelativePath = path.join("playwright", "scenario.log");
  const shardPlan = createQaProfileEvidenceShardPlan("all");
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
  );
  const evidencePaths: string[] = [];
  for (const [index, shard] of shardPlan.shards.entries()) {
    const scenarios = shard.scenarioIds.map((scenarioId) => scenarioById.get(scenarioId)!);
    const expectedCells: QaScenarioExecutionCell[] = scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      channel: null,
    }));
    const observedCells =
      params.incompleteFirstShard && index === 0 ? expectedCells.slice(1) : expectedCells;
    const profilePlan = qaProfileEvidencePlan.build({
      profile: "all",
      taxonomyIdentity: taxonomyModule.readQaScorecardTaxonomyReport([...scenarioById.values()])
        .taxonomy!.identity,
      membershipScenarios: scenarios,
      selectedScenarios: scenarios,
      excludedScenarios: [],
      expectedCells,
      observedCells,
    });
    const evidencePath = path.join(outputDir, shard.id, "qa-evidence.json");
    const summary = vitestArtifactEvidence({
      id: scenarios[0]?.id ?? "shard-scenario",
      title: scenarios[0]?.title ?? "Shard scenario",
      artifact: {
        kind: "log",
        path: `.artifacts/qa-e2e/profile-all-123-1/${shard.id}/${artifactRelativePath}`,
      },
    });
    const entry = summary.entries[0]!;
    entry.test.kind = "qa-scenario";
    entry.coverage = [];
    entry.execution!.runner = "qa-suite";
    if (index === 0) {
      for (const [relative, content] of [
        [artifactRelativePath, artifactContent],
        [path.join("diagnostics", "raw.log"), "unreferenced shard diagnostics\n"],
      ] as const) {
        const file = path.join(path.dirname(evidencePath), relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, "utf8");
      }
    }
    await writeJson(evidencePath, {
      ...summary,
      generatedAt: "2026-08-16T00:00:00.000Z",
      entries: index === 0 ? [entry] : [],
      profile: "all",
      profilePlan,
    });
    evidencePaths.push(evidencePath);
  }
  return {
    outputDir,
    artifactContent,
    evidencePaths,
    firstPath: evidencePaths[0]!,
    shardPlan,
  };
}

it.each(["full", "slim"] as const)(
  "rebases occurrence receipts with entry artifacts in %s evidence",
  async (evidenceMode) => {
    const { outputDir, evidencePaths, artifactContent, shardPlan } = await writeShardEvidenceSet();
    const digest = createHash("sha256").update(artifactContent).digest("hex");
    for (const [index, file] of evidencePaths.entries()) {
      const summary = await readEvidence(file);
      const occurrence = makeQaSuiteTestOccurrence(`shard-${index}-observation`);
      const artifact = summary.entries[0]?.execution?.artifacts[0];
      if (artifact) {
        occurrence.receipts.push({
          id: "runtime-receipt",
          phase: "runtime",
          identity: structuredClone(occurrence.launch),
          artifact: { ...artifact, sha256: digest },
        });
      }
      const v3 = buildQaOccurrenceEvidenceSummary({
        ...summary,
        evidenceMode,
        occurrences: [occurrence],
        entries: summary.entries.map((entry) =>
          Object.assign({}, entry, {
            effective: true,
            binding: {
              occurrenceId: occurrence.id,
              assertionId: null,
              receiptId: artifact ? "runtime-receipt" : null,
            },
          }),
        ),
      });
      await writeJson(file, v3);
    }
    const outputPath = aggregatePath(outputDir);
    const aggregate = await aggregateEvidence(outputDir, evidencePaths);
    if (aggregate.schemaVersion !== 3) {
      throw new Error("expected occurrence evidence");
    }
    const receipt = aggregate.occurrences[0]?.receipts[0];
    expect(receipt?.artifact).toMatchObject({
      path: `shards/${shardPlan.shards[0]!.id}/playwright/scenario.log`,
      sha256: digest,
    });
    expect(
      await fs.readFile(path.resolve(path.dirname(outputPath), receipt!.artifact.path), "utf8"),
    ).toBe(artifactContent);
    if (evidenceMode === "full") {
      expect(aggregate.entries[0]?.execution?.artifacts[0]?.path).toBe(receipt?.artifact.path);
    } else {
      expect(aggregate.entries[0]?.execution).toBeUndefined();
    }
  },
);

it("partitions the real all profile while keeping exclusive live channels shard-affine", () => {
  const serialPlan = createQaProfileEvidenceShardPlan("all", 1);
  const plan = createQaProfileEvidenceShardPlan("all");
  const scenarioIds = plan.shards.flatMap((shard) => shard.scenarioIds);
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
  );

  expect(serialPlan.shards).toHaveLength(1);
  expect(new Set(scenarioIds)).toEqual(new Set(serialPlan.shards[0]?.scenarioIds));
  expect(plan.shards).toHaveLength(8);
  expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  expect(plan.shards.every((shard) => shard.scenarioIds.length > 0)).toBe(true);
  expect(Math.max(...plan.shards.map((shard) => shard.estimatedCost))).toBeLessThan(
    plan.shards.reduce((total, shard) => total + shard.estimatedCost, 0),
  );

  for (const channelId of exclusiveLiveChannels) {
    const matchingScenarioIds = scenarioIds.filter((scenarioId) => {
      const { execution } = scenarioById.get(scenarioId)!;
      return execution.channel
        ? execution.channel === channelId
        : execution.kind === "flow" && execution.channels?.includes(channelId);
    });
    expect(matchingScenarioIds.length, `${channelId} selected scenarios`).toBeGreaterThan(0);
    expect(
      new Set(matchingScenarioIds.map((scenarioId) => shardIdForScenario(plan, scenarioId))).size,
      `${channelId} shard affinity`,
    ).toBe(1);
  }
  expect(shardIdForScenario(plan, "channel-canary")).toBe(
    shardIdForScenario(plan, "thread-follow-up"),
  );
});

it("rejects mixed taxonomy identity before any aggregate writes", async () => {
  const { outputDir, evidencePaths } = await writeShardEvidenceSet();
  const file = evidencePaths.at(-1)!;
  const summary = await readEvidence(file);
  summary.profilePlan!.taxonomyIdentity = { version: 1, sha256: "0".repeat(64) };
  await writeJson(file, summary);
  await expect(aggregateEvidence(outputDir, evidencePaths)).rejects.toThrow(
    "semantic taxonomy identity",
  );
  await expect(fs.stat(path.dirname(aggregatePath(outputDir)))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves an incomplete child as incomplete aggregate evidence", async () => {
  const { outputDir, evidencePaths } = await writeShardEvidenceSet({
    incompleteFirstShard: true,
  });
  const aggregate = await aggregateEvidence(outputDir, evidencePaths);

  expect(aggregate.profilePlan?.missingCells).toHaveLength(1);
  expect(() => qaProfileEvidencePlan.attest(aggregate.profilePlan, true)).toThrow(
    "successful QA profile evidence is missing 1 expected execution cell",
  );
});

it("rejects a repo-relative artifact path that cannot be mapped to its shard payload", async () => {
  const { outputDir, evidencePaths, firstPath } = await writeShardEvidenceSet();
  const summary = await readEvidence(firstPath);
  summary.entries[0]!.execution!.artifacts[0]!.path = ".artifacts/nonexistent/qa-evidence.json";
  await writeJson(firstPath, summary);

  await expect(aggregateEvidence(outputDir, evidencePaths)).rejects.toThrow(
    "was not found within downloaded payload",
  );
});

it.skipIf(process.platform === "win32")(
  "rejects a declared artifact symlink that would retain its source-payload target",
  async () => {
    const { outputDir, evidencePaths, firstPath } = await writeShardEvidenceSet();
    const artifactPath = path.join(path.dirname(firstPath), "playwright", "scenario.log");
    await fs.rm(artifactPath);
    await fs.symlink(path.join(path.dirname(firstPath), "diagnostics", "raw.log"), artifactPath);

    await expect(aggregateEvidence(outputDir, evidencePaths)).rejects.toThrow(
      "traverses a symbolic link",
    );
  },
);

it("rejects duplicate or missing shards instead of treating them as partial evidence", async () => {
  const { outputDir, evidencePaths, shardPlan } = await writeShardEvidenceSet();
  const aggregate = (paths: string[]) => aggregateEvidence(outputDir, paths);

  await expect(aggregate(evidencePaths.slice(1))).rejects.toThrow(
    `requires ${shardPlan.shards.length} shard evidence files`,
  );
  await expect(aggregate([...evidencePaths.slice(1), evidencePaths[1]!])).rejects.toThrow(
    "does not match one unique planned shard",
  );
});
