import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  registerDiagnosticTracePropagationBridge,
  resetDiagnosticTracePropagationForTest,
} from "../../infra/diagnostic-trace-propagation.js";
import { prepareSkillBundle, readSkillBundleTree } from "../../skills/library/bundle.js";
import type { Skill } from "../../skills/loading/skill-contract.js";
import {
  readSkillResourceFiles,
  stampLocalSkillBundleIdentities,
} from "../../skills/runtime/resources.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSkillReadPath } from "../../skills/workspace-skill-read-path.js";
import {
  findSkillUsageMatch,
  recordSkillUsed,
} from "../agent-tools.before-tool-call.diagnostics.js";
import {
  createSkillInstructionDeliveryCache,
  createSkillInstructionDeliveryMarkers,
  wrapReadToolWithSkillContent,
} from "../agent-tools.read.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

// Narrow spy factory for hashing-count assertions: preparation-boundary
// discovery stamps and delivery-time acquisition both walk the bundle tree
// through `readSkillBundleTree`, while the ordinary-local discovery path never
// touches it, so every other export stays real while the count observes only
// the tracing-gated hashing walks.
vi.mock("../../skills/library/bundle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/library/bundle.js")>();
  return { ...actual, readSkillBundleTree: vi.fn(actual.readSkillBundleTree) };
});

describe("prepareEmbeddedSkills bundle fingerprints", () => {
  const temps = useAutoCleanupTempDirTracker(afterEach);
  const readSkillBundleTreeSpy = vi.mocked(readSkillBundleTree);

  afterEach(() => {
    resetDiagnosticTracePropagationForTest();
    setDiagnosticsEnabledForProcess(true);
  });

  // The active-tracing gate the producer keys on: a registered
  // trace-propagation bridge is exactly the exporter-owned tracing consumer the
  // diagnostics-otel service registers while traces are active, and a
  // metrics-only install never registers one. Driving the gate through the real
  // bridge surface keeps these tests on the contract the product ships.
  function registerActiveTracingBridge(): () => void {
    return registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
    });
  }

  async function writePondSkill(workspace: string) {
    const baseDir = path.join(workspace, "skills", "pond");
    await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "SKILL.md"),
      "---\nname: pond\ndescription: Pond skill\n---\n# Pond\ncomplete instructions\n",
    );
    await fs.writeFile(path.join(baseDir, "scripts", "check.sh"), "#!/bin/sh\nprintf pond-one\n");
    return baseDir;
  }

  function prepareLocalRun(workspace: string) {
    return prepareEmbeddedSkills({
      includeCodeModeSkills: true,
      attempt: {
        bootstrapWorkspaceDir: workspace,
        config: {},
      } as EmbeddedRunAttemptParams,
      effectiveWorkspace: workspace,
      sandbox: null,
      sessionAgentId: "main",
    });
  }

  function asAgentTool(tool: { name: string; execute: unknown }): AnyAgentTool {
    return tool as unknown as AnyAgentTool;
  }

  function asTextResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      details: { kind: "text" as const, content: text },
    };
  }

  function pondWalks(baseDir: string): number {
    const pond = path.resolve(baseDir);
    return readSkillBundleTreeSpy.mock.calls.filter(
      (call) => path.resolve(String(call[0])) === pond,
    ).length;
  }

  function wrapLocalReadTool(
    prepared: Awaited<ReturnType<typeof prepareLocalRun>>,
    workspace: string,
    instructionDeliveryCache: ReturnType<typeof createSkillInstructionDeliveryCache>,
    instructionDeliveryMarkers: ReturnType<typeof createSkillInstructionDeliveryMarkers>,
  ) {
    const locator = resolveSkillReadPath(
      prepared.skillsSnapshotForRun!.resolvedSkills!.find((skill) => skill.name === "pond")!,
    );
    const read = wrapReadToolWithSkillContent(
      asAgentTool({
        name: "read",
        execute: async (_toolCallId: unknown, params: unknown) =>
          asTextResult(await fs.readFile((params as { path: string }).path, "utf8")),
      }),
      prepared.skillReadResources!.map((skill) => ({
        filePath: resolveSkillReadPath(skill),
        readContent: skill.readContent,
        bundleFingerprint: skill.bundleFingerprint,
        acquireDeliveredFingerprint: prepared.skillDeliveredIdentityAcquirers?.get(skill),
      })),
      {
        cwd: workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      },
    );
    return { locator, read };
  }

  /** Drives the real wrapper settlement and emission route; returns the emitted identity. */
  async function readDeliveredIdentity(params: {
    read: AnyAgentTool;
    prepared: Awaited<ReturnType<typeof prepareLocalRun>>;
    markers: ReturnType<typeof createSkillInstructionDeliveryMarkers>;
    locator: string;
    toolCallId: string;
  }): Promise<string | undefined> {
    const served = (await params.read.execute(
      params.toolCallId,
      { path: params.locator },
      undefined,
      undefined,
    )) as {
      details: { kind: string; content: string };
    };
    expect(served.details.kind).toBe("text");
    const match = findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: params.locator },
      ctx: {
        skillsSnapshot: params.prepared.skillsSnapshotForRun,
        skillInstructionDeliveryMarkers: params.markers,
      },
      toolCallId: params.toolCallId,
    });
    expect(match).toBeDefined();
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => emitted.push(evt));
    try {
      recordSkillUsed({ match: match!, toolName: "read", toolCallId: params.toolCallId });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      stop();
    }
    const [used] = emitted.filter((evt) => evt.type === "skill.used");
    expect(used).toMatchObject({
      type: "skill.used",
      skillName: "pond",
      activation: "read",
    });
    return used ? (used as { skillFingerprint?: string }).skillFingerprint : undefined;
  }

  it("emits ordinary local read activations with the delivered bundle identity while tracing is active", async () => {
    // Diagnostics dispatch stays enabled throughout every test here: the gate
    // is the active tracing consumer, never the dispatcher flag.
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-"));
    const baseDir = await writePondSkill(workspace);
    readSkillBundleTreeSpy.mockClear();
    const prepared = await prepareLocalRun(workspace);
    try {
      const entry = prepared.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      // Preparation stamps discovery identities once per loaded bundle, cached
      // per preparation: no bundle directory is walked twice, and the pond
      // bundle walked exactly once.
      const walkedBundles = readSkillBundleTreeSpy.mock.calls.map((call) =>
        path.resolve(String(call[0])),
      );
      expect(new Set(walkedBundles).size).toBe(walkedBundles.length);
      expect(pondWalks(baseDir)).toBe(1);
      const expected = prepareSkillBundle(
        (await readSkillResourceFiles(entry, { allowMissingRoot: false }))!,
      ).revision;
      expect(entry.bundleFingerprint).toBe(expected);
      expect(
        prepared.skillsSnapshotForRun!.discoverySkills!.find((skill) => skill.name === "pond")!
          .bundleFingerprint,
      ).toBe(expected);
      expect(
        prepared.skillReadResources!.find((skill) => skill.name === "pond")!.bundleFingerprint,
      ).toBe(expected);
      readSkillBundleTreeSpy.mockClear();

      // Real local delivery route: settlement acquires the identity of the
      // bytes this delivery serves (one acquisition walk), the marker rides the
      // invocation, and the emission match reads that marker rather than the
      // current snapshot.
      const instructionDeliveryCache = createSkillInstructionDeliveryCache();
      const instructionDeliveryMarkers = createSkillInstructionDeliveryMarkers();
      const { locator, read } = wrapLocalReadTool(
        prepared,
        workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      );
      const delivered = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "local-read",
      });
      expect(delivered).toBe(expected);
      expect(pondWalks(baseDir)).toBe(1);
      // Already-served re-reads inherit the settled delivery identity and never
      // rehash.
      const reserved = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "local-read-2",
      });
      expect(reserved).toBe(expected);
      expect(pondWalks(baseDir)).toBe(1);
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("hashes and acquires nothing while tracing is inactive with diagnostics still enabled", async () => {
    // The exact state the round-3 dispatcher-off control could not see:
    // diagnostics dispatch is on, but no trace consumer is registered — the
    // metrics-only install shape. Zero hashing may happen here.
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticTracePropagationForTest();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-off-"));
    await writePondSkill(workspace);
    readSkillBundleTreeSpy.mockClear();
    const prepared = await prepareLocalRun(workspace);
    try {
      expect(readSkillBundleTreeSpy).not.toHaveBeenCalled();
      expect(
        prepared.skillsSnapshotForRun!.resolvedSkills!.every(
          (skill) => skill.bundleFingerprint === undefined,
        ),
      ).toBe(true);
      expect(prepared.skillDeliveredIdentityAcquirers).toBeUndefined();
      // Ordinary local skills still load and serve; only the identity is
      // absent, and a successful delivery settles with accounting intact.
      const instructionDeliveryCache = createSkillInstructionDeliveryCache();
      const instructionDeliveryMarkers = createSkillInstructionDeliveryMarkers();
      const { locator, read } = wrapLocalReadTool(
        prepared,
        workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      );
      const delivered = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "local-read-off",
      });
      expect(delivered).toBeUndefined();
      expect(readSkillBundleTreeSpy).not.toHaveBeenCalled();
      expect(prepared.skillsPrompt).toContain("pond");
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("binds the delivered identity to the bytes the read actually serves, not the preparation-time tree", async () => {
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-live-"));
    const baseDir = await writePondSkill(workspace);
    const prepared = await prepareLocalRun(workspace);
    try {
      const entry = prepared.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      const discovered = entry.bundleFingerprint;
      expect(discovered).toBeTypeOf("string");
      // The bundle changes on disk between preparation and the first read: the
      // served bytes must never inherit the preparation-time fingerprint.
      await fs.writeFile(path.join(baseDir, "scripts", "check.sh"), "#!/bin/sh\nprintf pond-two\n");
      const expectedServed = prepareSkillBundle(
        (await readSkillResourceFiles(entry, { allowMissingRoot: false }))!,
      ).revision;
      readSkillBundleTreeSpy.mockClear();
      const instructionDeliveryCache = createSkillInstructionDeliveryCache();
      const instructionDeliveryMarkers = createSkillInstructionDeliveryMarkers();
      const { locator, read } = wrapLocalReadTool(
        prepared,
        workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      );
      // First delivery: settlement acquires the identity of the bytes it
      // actually serves — the edited tree, never the preparation-time stamp.
      const servedIdentity = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "live-read",
      });
      expect(servedIdentity).toBe(expectedServed);
      expect(servedIdentity).not.toBe(discovered);
      // Discovery entries keep the discovered bundle's identity; only the
      // delivered emission followed the bytes the reader actually served.
      expect(entry.bundleFingerprint).toBe(discovered);
      // Already-served re-reads inherit this delivery's identity without a
      // second walk.
      expect(
        await readDeliveredIdentity({
          read,
          prepared,
          markers: instructionDeliveryMarkers,
          locator,
          toolCallId: "live-read-2",
        }),
      ).toBe(servedIdentity);
      expect(pondWalks(baseDir)).toBe(1);
      // A fresh delivery generation (the compaction owner cleared the epoch)
      // re-acquires the identity of the bytes it serves.
      instructionDeliveryCache.clear();
      instructionDeliveryMarkers.clear();
      expect(
        await readDeliveredIdentity({
          read,
          prepared,
          markers: instructionDeliveryMarkers,
          locator,
          toolCallId: "live-read-3",
        }),
      ).toBe(servedIdentity);
      expect(pondWalks(baseDir)).toBe(2);
      // And an edit before a fresh delivery is never mislabeled with the old
      // generation's identity.
      await fs.writeFile(
        path.join(baseDir, "scripts", "check.sh"),
        "#!/bin/sh\nprintf pond-three\n",
      );
      const expectedAfterEdit = prepareSkillBundle(
        (await readSkillResourceFiles(entry, { allowMissingRoot: false }))!,
      ).revision;
      readSkillBundleTreeSpy.mockClear();
      instructionDeliveryCache.clear();
      instructionDeliveryMarkers.clear();
      const afterEdit = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "live-read-4",
      });
      expect(afterEdit).toBe(expectedAfterEdit);
      expect(afterEdit).not.toBe(servedIdentity);
      expect(pondWalks(baseDir)).toBe(1);
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("stamps a new identity after a support-file edit on the next preparation", async () => {
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-edit-"));
    const baseDir = await writePondSkill(workspace);
    const first = await prepareLocalRun(workspace);
    try {
      const entryFirst = first.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      const identityFirst = entryFirst.bundleFingerprint;
      expect(identityFirst).toBeTypeOf("string");
      // Support-file-only edit: SKILL.md bytes stay identical while the bundle
      // identity moves, and the next preparation delivers the new identity.
      await fs.writeFile(path.join(baseDir, "scripts", "check.sh"), "#!/bin/sh\nprintf pond-two\n");
      const second = await prepareLocalRun(workspace);
      try {
        const entrySecond = second.skillsSnapshotForRun!.resolvedSkills!.find(
          (skill) => skill.name === "pond",
        )!;
        const expected = prepareSkillBundle(
          (await readSkillResourceFiles(entrySecond, { allowMissingRoot: false }))!,
        ).revision;
        expect(entrySecond.bundleFingerprint).toBe(expected);
        expect(entrySecond.bundleFingerprint).not.toBe(identityFirst);
        // The first preparation's retained entries keep their delivered identity.
        expect(entryFirst.bundleFingerprint).toBe(identityFirst);
        expect(entrySecond.contentHash).toBe(entryFirst.contentHash);
      } finally {
        second.restoreSkillEnv();
      }
    } finally {
      first.restoreSkillEnv();
    }
  });

  it("trusts entry-carried identities from other producers without re-hashing", async () => {
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-trust-"));
    const baseDir = await writePondSkill(workspace);
    // A worker, session, or transfer producer stamped this snapshot's entries:
    // the ordinary-local preparation keeps each retained identity and does not
    // walk or re-hash the bundle behind it.
    const delivered = "delivered-bundle-identity";
    const skill: Skill = {
      ...createCanonicalFixtureSkill({
        name: "pond",
        description: "Pond skill",
        filePath: path.join(baseDir, "SKILL.md"),
        baseDir,
        source: "openclaw-workspace",
      }),
      contentHash: "skill-md-digest",
      bundleFingerprint: delivered,
    };
    const snapshot: SkillSnapshot = {
      prompt: "",
      skills: [{ name: "pond" }],
      resolvedSkills: [skill],
      discoverySkills: [skill],
    };
    readSkillBundleTreeSpy.mockClear();
    const stamped = await stampLocalSkillBundleIdentities({
      snapshot,
      libraryEntries: [],
    });
    expect(readSkillBundleTreeSpy).not.toHaveBeenCalled();
    expect(stamped.snapshot?.resolvedSkills![0]!.bundleFingerprint).toBe(delivered);
    expect(stamped.snapshot?.resolvedSkills![0]).toBe(skill);
    expect(stamped.snapshot?.discoverySkills![0]).toBe(skill);
    expect(stamped.libraryEntries).toEqual([]);
  });
});
