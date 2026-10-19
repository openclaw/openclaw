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
import { bumpSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import {
  readSkillResourceFiles,
  stampDiscoveredSkillBundleIdentities,
} from "../../skills/runtime/resources.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { resolveSkillReadPath } from "../../skills/workspace-skill-read-path.js";
import {
  findSkillUsageMatch,
  recordSkillUsed,
} from "../agent-tools.before-tool-call.diagnostics.js";
import {
  createSkillInstructionDeliveryMarkers,
  wrapReadToolWithSkillContent,
  type SkillInstructionDeliveryCache,
} from "../agent-tools.read.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import type { ReadToolDetails } from "../sessions/tools/index.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

// Narrow spy factory for hashing-count assertions: the discovery-intake
// stamps walk the bundle tree through `readSkillBundleTree`, so every other
// export stays real while the count observes only the tracing-gated hashing
// walks.
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

  function asAgentTool(tool: { name: string; execute: unknown }): AnyAgentTool<ReadToolDetails> {
    return tool as unknown as AnyAgentTool<ReadToolDetails>;
  }

  function asTextResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      details: { kind: "text" as const, content: text },
    };
  }

  function pondWalks(baseDir: string): number {
    const pond = path.resolve(baseDir);
    return readSkillBundleTreeSpy.mock.calls.filter((call) => path.resolve(call[0]) === pond)
      .length;
  }

  function wrapLocalReadTool(
    prepared: Awaited<ReturnType<typeof prepareLocalRun>>,
    workspace: string,
    instructionDeliveryCache: SkillInstructionDeliveryCache,
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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      stop();
    }
    const used = emitted.find((evt) => evt.type === "skill.used");
    expect(used).toMatchObject({
      type: "skill.used",
      skillName: "pond",
      activation: "read",
    });
    return used ? (used as { skillFingerprint?: string }).skillFingerprint : undefined;
  }

  it("emits ordinary local read activations with the loaded bundle identity while tracing is active", async () => {
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
      // Discovery stamps the loaded bundle's identity once per loaded
      // version, cached per version: no bundle directory is walked twice
      // within one loaded version, and the pond bundle walked exactly once.
      const walkedBundles = readSkillBundleTreeSpy.mock.calls.map((call) => path.resolve(call[0]));
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

      // Real local delivery route: settlement resolves the entry's retained
      // loaded-bundle fingerprint by lookup — no tree walk at delivery — the
      // marker rides the invocation, and the emission consumes that marker
      // rather than the current snapshot.
      const instructionDeliveryCache: SkillInstructionDeliveryCache = new Map();
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
      expect(pondWalks(baseDir)).toBe(0);
      // Already-served re-reads inherit the prior qualifying delivery's
      // identity by the same lookup and never rehash.
      const reserved = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "local-read-2",
      });
      expect(reserved).toBe(expected);
      expect(pondWalks(baseDir)).toBe(0);
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("hashes and stamps nothing while tracing is inactive with diagnostics still enabled", async () => {
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
      // Ordinary local skills still load and serve; only the identity is
      // absent, and a successful delivery settles with accounting intact.
      const instructionDeliveryCache: SkillInstructionDeliveryCache = new Map();
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

  it("retains the loaded bundle identity across an edit until the watcher reload restamps", async () => {
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-live-"));
    const baseDir = await writePondSkill(workspace);
    const prepared = await prepareLocalRun(workspace);
    try {
      const entry = prepared.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      const loaded = entry.bundleFingerprint;
      expect(loaded).toBeTypeOf("string");
      readSkillBundleTreeSpy.mockClear();
      const instructionDeliveryCache: SkillInstructionDeliveryCache = new Map();
      const instructionDeliveryMarkers = createSkillInstructionDeliveryMarkers();
      const { locator, read } = wrapLocalReadTool(
        prepared,
        workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      );
      // The bundle changes on disk between preparation and the first read:
      // the fingerprint identifies the loaded bundle — a disclosed staleness
      // window, not a defect — so this delivery still carries the loaded
      // generation's identity, and no delivery-time walk runs to chase the
      // edit.
      await fs.writeFile(path.join(baseDir, "scripts", "check.sh"), "#!/bin/sh\nprintf pond-two\n");
      const delivered = await readDeliveredIdentity({
        read,
        prepared,
        markers: instructionDeliveryMarkers,
        locator,
        toolCallId: "live-read",
      });
      expect(delivered).toBe(loaded);
      expect(pondWalks(baseDir)).toBe(0);
      // A fresh delivery generation (the compaction owner cleared the epoch)
      // re-establishes the marker by the same lookup; the identity is
      // constant within the preparation.
      instructionDeliveryCache.clear();
      instructionDeliveryMarkers.clear();
      expect(
        await readDeliveredIdentity({
          read,
          prepared,
          markers: instructionDeliveryMarkers,
          locator,
          toolCallId: "live-read-2",
        }),
      ).toBe(loaded);
      expect(pondWalks(baseDir)).toBe(0);
      // The watcher's reload closes the window: the version bump a reload
      // publishes invalidates the entry and identity caches, so the next
      // preparation re-discovers and restamps the edited tree.
      bumpSkillsSnapshotVersion({ workspaceDir: workspace, reason: "manual" });
      const second = await prepareLocalRun(workspace);
      try {
        const entrySecond = second.skillsSnapshotForRun!.resolvedSkills!.find(
          (skill) => skill.name === "pond",
        )!;
        const expectedAfterEdit = prepareSkillBundle(
          (await readSkillResourceFiles(entrySecond, { allowMissingRoot: false }))!,
        ).revision;
        expect(entrySecond.bundleFingerprint).toBe(expectedAfterEdit);
        expect(entrySecond.bundleFingerprint).not.toBe(loaded);
        // The first preparation's retained entries keep the identity they
        // loaded with.
        expect(entry.bundleFingerprint).toBe(loaded);
      } finally {
        second.restoreSkillEnv();
      }
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("restamps a new identity after a support-file edit once the watcher reloads", async () => {
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
      // identity moves. The watcher reloads the edited skill — modeled here by
      // the version bump it publishes — so the next preparation re-discovers
      // and restamps the edited bundle.
      await fs.writeFile(path.join(baseDir, "scripts", "check.sh"), "#!/bin/sh\nprintf pond-two\n");
      bumpSkillsSnapshotVersion({ workspaceDir: workspace, reason: "manual" });
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
    readSkillBundleTreeSpy.mockClear();
    const stamped = await stampDiscoveredSkillBundleIdentities([skill]);
    expect(readSkillBundleTreeSpy).not.toHaveBeenCalled();
    expect(stamped[0]!.bundleFingerprint).toBe(delivered);
    expect(stamped[0]).toBe(skill);
    expect(stamped).toHaveLength(1);
  });

  it("stamps each entry's own bundle identity when a workspace skill shares a library selection's name", async () => {
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-pin-"));
    await writePondSkill(workspace);
    const prepared = await prepareLocalRun(workspace);
    try {
      // The library selection shares the live tree's name: a pin is
      // identified by its exclusive library source, never by the name, so the
      // workspace entry keeps its own loaded-tree identity while the pinned
      // entry keeps its immutable revision-keyed store's stamp.
      const live = prepared.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      const pin: Skill = {
        ...live,
        source: "openclaw-library",
        bundleFingerprint: "fp-library-pin",
      };
      const catalog = prepareInstalledSkillCatalog({
        snapshot: {
          ...prepared.skillsSnapshotForRun!,
          resolvedSkills: [live, pin],
          discoverySkills: [live, pin],
          librarySelections: [
            { skillId: "lib-pond", revision: "rev-1", name: "pond", ownerProfileId: null },
          ],
        },
        workspaceDir: workspace,
        sandbox: null,
      });
      const entries = catalog.filter((entry) => entry.name === "pond");
      expect(entries).toHaveLength(2);
      // Each skills_read receipt carries its own entry's loaded-bundle
      // identity: the live tree's stamp and the pin's stamp never
      // cross-borrow under one shared name.
      expect(
        entries.find((entry) => entry.bundleFingerprint === live.bundleFingerprint),
      ).toBeDefined();
      expect(entries.find((entry) => entry.bundleFingerprint === "fp-library-pin")).toBeDefined();
    } finally {
      prepared.restoreSkillEnv();
    }
  });

  it("never settles a delivery or marker for a read canceled mid-delivery", async () => {
    setDiagnosticsEnabledForProcess(true);
    registerActiveTracingBridge();
    const workspace = await fs.realpath(temps.make("openclaw-local-fingerprint-abort-"));
    await writePondSkill(workspace);
    const prepared = await prepareLocalRun(workspace);
    try {
      const instructionDeliveryCache: SkillInstructionDeliveryCache = new Map();
      const instructionDeliveryMarkers = createSkillInstructionDeliveryMarkers();
      const { locator, read } = wrapLocalReadTool(
        prepared,
        workspace,
        instructionDeliveryCache,
        instructionDeliveryMarkers,
      );
      const controller = new AbortController();
      // The invocation aborts while its instruction I/O is in flight; the
      // non-abort-aware fixture read still completes underneath.
      const pending = read.execute(
        "canceled-read",
        { path: locator },
        controller.signal,
        undefined,
      );
      controller.abort();
      const served = (await pending) as { details: { kind: string; content: string } };
      // The completed read still returns its served bytes...
      expect(served.details.kind).toBe("text");
      expect(served.details.content).toContain("complete instructions");
      // ...but the canceled delivery settles nothing: no delivery-cache entry
      // survives for the path — the next invocation serves fresh bytes
      // instead of an already-served status for content the model may never
      // have received — and no marker rides the canceled invocation.
      expect(instructionDeliveryCache.size).toBe(0);
      const canceledMatch = findSkillUsageMatch({
        toolName: "read",
        toolParams: { path: locator },
        ctx: {
          skillsSnapshot: prepared.skillsSnapshotForRun,
          skillInstructionDeliveryMarkers: instructionDeliveryMarkers,
        },
        toolCallId: "canceled-read",
      });
      expect(canceledMatch).toBeDefined();
      expect(canceledMatch?.skillFingerprint).toBeUndefined();
      // A later qualifying delivery establishes its own marker and emits the
      // entry's retained loaded-bundle identity.
      const entry = prepared.skillsSnapshotForRun!.resolvedSkills!.find(
        (skill) => skill.name === "pond",
      )!;
      expect(
        await readDeliveredIdentity({
          read,
          prepared,
          markers: instructionDeliveryMarkers,
          locator,
          toolCallId: "post-abort-read",
        }),
      ).toBe(entry.bundleFingerprint);
    } finally {
      prepared.restoreSkillEnv();
    }
  });
});
