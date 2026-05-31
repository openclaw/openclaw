import { describe, expect, it } from "vitest";
import {
  appendSnesAgentDispatchRecord,
  appendSnesAgentResultRecord,
  appendSnesProjectVersion,
  applySnesJsonPatch,
  applySnesImportedTileset,
  addSnesCustomTileBrush,
  addSnesProjectScene,
  buildSnesReadiness,
  buildSnesPreviewRom,
  createSnesEmulatorBootProof,
  createSnesEmulatorReplayParityProof,
  createSnesEmulatorReplayRunPack,
  createSnesEmulatorScreenshotComparison,
  createSnesAgentDispatchRecord,
  createSnesAgentPatchProposalFromResult,
  createSnesAgentResultRecord,
  createSnesEmulatorBootPlan,
  createSnesFxpakCopyDryRun,
  createSnesFxpakCopyProof,
  createSnesFxpakMountedExportValidation,
  createSnesGatewayAgentHandoff,
  createSnesGuidedBuildChecklist,
  createSnesHardwareQaBundle,
  createSnesMacPackagingReport,
  createSnesProjectBundle,
  createSnesProjectPersistencePlan,
  createSnesProjectFromTemplate,
  createSnesProjectTemplates,
  createSnesSramPowerCycleProof,
  createSnesSramImage,
  createSnesSpriteOamBudgetReport,
  createSnesSpc700ExportPlan,
  compileSnesSpc700PlaybackProgram,
  createSnesSramSerializationReport,
  createSnesRuntimeEventPlan,
  createSnesSuperFxRuntimePlan,
  createSnesSuperFxMinimalRomArtifact,
  createSnesEmulatorValidationReport,
  createSnesAudioManifest,
  createBlankSnesStudioProject,
  createSnesAiBuildPlan,
  createSnesAiGapReport,
  createSnesAiProductionRun,
  createSnesAiProductionGatewayPlan,
  createSnesAgentTeamPlan,
  createSnesAgentTeamPreflight,
  createSnesAgentTeamReadinessPlan,
  createSnesAiAuthoringPrompts,
  createSnesAssetPipelineReport,
  createSnesCodexTaskPacket,
  createSnesCutsceneTimeline,
  createSnesCollisionParityReport,
  createSnesFxpakExportPackage,
  createSnesGeneratedObjectSummary,
  createSnesPromptSpriteAsset,
  createSnesProjectVersion,
  createSnesPatchSandboxCorpusReport,
  createSnesRecoveryCorruptionDrill,
  createSnesRomLevelLoaderTable,
  createSnesScanlineOamPlan,
  compileSnesRuntimeProject,
  createClassicPlatformerStylePack,
  selectSnesFxpakMountedVolume,
  createSnesSuperFxProfileReport,
  createDefaultSnesStudioProject,
  defaultSnesAgentProviderForSurface,
  createFxpakExportManifest,
  createSnesSaveManifest,
  createSnesAgentPatchProposal,
  createSnesAgentPatchProposalForSurface,
  createSnesCodexBlueprint,
  createSnesLocalAgentPatchResponse,
  reviewSnesOpenClawProduction,
  createSnesOnePromptGameReport,
  createSnesCollisionPhysicsPlan,
  createSnesLevelTransitionPlan,
  createSnesSceneRuntimeTable,
  compileSnesRuntimeEventBytecode,
  executeSnesRuntimeEventBytecode,
  executeSnesRomLevelLoaderTable,
  diffSnesAgentPatchProposal,
  duplicateSnesProjectScene,
  estimateSnesProjectBudgets,
  generateSnesProjectFromPrompt,
  importSnesIndexedTileAsset,
  importSnesRgbaTileAsset,
  paintSnesSceneCell,
  paintSnesSceneRect,
  parseSnesProjectDocument,
  parseSnesIndexedTilePixels,
  parseSnesAgentDispatchQueue,
  parseSnesAgentResultQueue,
  parseSnesProjectVersionHistory,
  parseSnesAgentPatchProposalResponse,
  normalizeSnesAgentRoleResult,
  readSnesSaveSlot,
  runSnesRuntimeReplay,
  runSnesAssetImporterFuzzCases,
  removeSnesProjectScene,
  runSnesAgentDispatchRecord,
  repairSnesProjectForPlayablePreview,
  resolveSnesVisualStyleFromPrompt,
  fillSnesAiGaps,
  SNES_AGENT_DISPATCH_EVENT,
  SNES_AGENT_DISPATCH_QUEUE_KEY,
  SNES_AGENT_TEAM_LIVE_PROOF_TIMEOUT_MS,
  SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS,
  SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
  SNES_IMPORTED_TILE_BRUSH_BASE,
  SNES_STUDIO_EDIT_GRID,
  sanitizeRomBaseName,
  simulateSnesEventScripts,
  simulateSnesPreviewFrame,
  stepSnesRuntimeFrame,
  moveSnesSceneEntity,
  stableProjectJson,
  summarizeSnesAgentTeamBlockers,
  validateSnesPreviewRomArtifact,
  validateSnesSramImage,
  validateSnesStudioProject,
  writeSnesSaveSlot,
  diffSnesProjectVersions,
} from "./index.ts";

function containsSubsequence(bytes: Uint8Array, sequence: number[]): boolean {
  return Array.from(bytes).some((_, index) =>
    sequence.every((value, sequenceIndex) => bytes[index + sequenceIndex] === value),
  );
}

describe("SNES Studio core", () => {
  it("creates a ready default Mode 1 FXPAK project", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const readiness = buildSnesReadiness(project);

    expect(readiness.status).toBe("ready");
    expect(readiness.score).toBe(100);
    expect(readiness.issues).toEqual([]);
    expect(project.animations.map((animation) => animation.id)).toEqual([
      "player-idle",
      "enemy-patrol",
    ]);
  });

  it("maps classic platformer graphics prompts to original SNES-safe art", () => {
    const style = resolveSnesVisualStyleFromPrompt(
      "Make a side-scrolling platformer with Super Mario World graphics.",
    );
    const stylePack = createClassicPlatformerStylePack();
    const project = generateSnesProjectFromPrompt(
      "Make a side-scrolling platformer with Super Mario World graphics.",
    ).project;
    const rom = buildSnesPreviewRom(project);
    const manifest = JSON.parse(rom.manifestJson) as {
      graphics: {
        assetProvenance: string;
        stylePackName: string;
        styleBudgetEstimate: { backgroundTiles: number; spriteTiles: number; cgramColors: number };
        styleWarnings: Array<{ message: string }>;
        visualStylePreset: string;
      };
    };

    expect(style.visualStylePreset).toBe(SNES_CLASSIC_PLATFORMER_STYLE_PRESET);
    expect(style.assetProvenance).toBe("original-generated");
    expect(style.styleWarnings[0]?.message).toContain("no Nintendo assets are copied");
    expect(stylePack.terrainTiles).toEqual(expect.arrayContaining(["rounded grass top"]));
    expect(stylePack.spriteRecipes).toEqual(
      expect.arrayContaining(["16x24 cheerful hero with bold outline"]),
    );
    expect(stylePack.backgroundLayers).toEqual(
      expect.arrayContaining(["soft clouds", "rounded hills"]),
    );
    expect(stylePack.budgetEstimate.cgramColors).toBeLessThanOrEqual(256);
    expect(project.visualStylePreset).toBe(SNES_CLASSIC_PLATFORMER_STYLE_PRESET);
    expect(project.assetProvenance).toBe("original-generated");
    expect(project.gameplayBlueprint?.artMood).toContain("Classic Colorful SNES Platformer");
    expect(rom.graphics.visualStylePreset).toBe(SNES_CLASSIC_PLATFORMER_STYLE_PRESET);
    expect(rom.graphics.assetProvenance).toBe("original-generated");
    expect(rom.graphics.stylePackName).toBe(stylePack.name);
    expect(manifest.graphics.visualStylePreset).toBe(SNES_CLASSIC_PLATFORMER_STYLE_PRESET);
    expect(manifest.graphics.assetProvenance).toBe("original-generated");
    expect(manifest.graphics.stylePackName).toBe(stylePack.name);
    expect(manifest.graphics.styleBudgetEstimate.backgroundTiles).toBe(96);
    expect(validateSnesPreviewRomArtifact(rom).valid).toBe(true);
  });

  it("runs Codex-supervised OpenClaw production with OpenClaw filling game sections", () => {
    const production = createSnesAiProductionRun(
      'Make "Summit Gem Quest", a robot platformer with three levels, gems, a rival drone, a hidden key, music, saves, and Super Mario World graphics.',
      createDefaultSnesStudioProject("2026-05-25T00:00:00.000Z"),
      "2026-05-25T01:00:00.000Z",
    );

    expect(production.run.blueprint.createdBy).toBe("codex-architect");
    expect(production.run.blueprint.qualityRubric).toContain(
      "Playable from one prompt without extra setup.",
    );
    expect(production.run.taskList).toHaveLength(11);
    expect(production.run.taskList.every((task) => task.id.startsWith("openclaw-"))).toBe(true);
    expect(production.run.agentResults.map((result) => result.role)).toEqual(
      expect.arrayContaining([
        "game-director",
        "level-designer",
        "gameplay-designer",
        "hardware-constraint-agent",
      ]),
    );
    expect(production.run.reviewRounds.at(-1)).toMatchObject({
      reviewer: "codex-qa-gate",
      status: "pass",
      approvalStatus: "approved-for-snes-game-file",
    });
    expect(production.run.status).toBe("approved-for-snes-game-file");
    expect(production.project.aiProductionRun?.id).toBe(production.run.id);
    expect(production.project.aiCommandResult).toMatchObject({
      provider: "openclaw",
      scope: "full-game",
    });
    expect(production.project.levelChapters?.length).toBeGreaterThanOrEqual(3);
    expect(production.project.gamePlan?.savePlan).toContain("Three save slots");
    expect(buildSnesReadiness(production.project).status).toBe("ready");
  });

  it("lets Codex fail weak OpenClaw output before approval", () => {
    const blueprint = createSnesCodexBlueprint(
      "Make a tiny robot platformer.",
      createDefaultSnesStudioProject("2026-05-25T00:00:00.000Z"),
      "2026-05-25T01:00:00.000Z",
    );
    const weakProject = createBlankSnesStudioProject("2026-05-25T00:00:00.000Z");
    const review = reviewSnesOpenClawProduction(
      blueprint,
      weakProject,
      1,
      "2026-05-25T01:05:00.000Z",
    );

    expect(review.status).toBe("fail");
    expect(review.approvalStatus).toBe("needs-fixes");
    expect(review.requiredCorrections).toEqual(
      expect.arrayContaining([
        "Make the first level playable with a hero, reward, challenge, ground, and goal.",
        "Create at least three level chapters with purpose, challenge, reward, and goal.",
      ]),
    );
    expect(review.score).toBeLessThan(85);
  });

  it("creates template projects and a guided hardware checklist", () => {
    const templates = createSnesProjectTemplates();
    const rpg = createSnesProjectFromTemplate("exploration-rpg", "2026-05-20T00:00:00.000Z");
    const superfx = createSnesProjectFromTemplate(
      "superfx-rail-concept",
      "2026-05-20T00:00:00.000Z",
    );
    const checklist = createSnesGuidedBuildChecklist(rpg);
    const superfxChecklist = createSnesGuidedBuildChecklist(superfx);

    expect(templates.map((template) => template.id)).toEqual([
      "mode1-platformer",
      "exploration-rpg",
      "superfx-rail-concept",
    ]);
    expect(rpg.name).toBe("Signal Grove");
    expect(rpg.profile.videoMode).toBe("mode1");
    expect(rpg.profile.enhancementChip).toBe("none");
    expect(superfx.profile.videoMode).toBe("superfx");
    expect(superfx.profile.enhancementChip).toBe("superfx");
    expect(buildSnesReadiness(superfx).status).toBe("caution");
    expect(checklist.map((item) => item.id)).toEqual([
      "game-prompt",
      "edit-level",
      "art-assets",
      "logic-events",
      "save-system",
      "rom-build",
      "emulator-proof",
    ]);
    expect(checklist.find((item) => item.id === "rom-build")).toMatchObject({
      status: "complete",
    });
    expect(checklist.find((item) => item.id === "emulator-proof")).toMatchObject({
      status: "blocked",
    });
    expect(superfxChecklist.find((item) => item.id === "rom-build")).toMatchObject({
      status: "blocked",
    });
  });

  it("reports sprite OAM budget pressure by entity", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const ready = createSnesSpriteOamBudgetReport(project);
    project.scenes[0].entities.push({
      id: "giant-boss",
      kind: "enemy",
      name: "Giant Boss",
      x: 144,
      y: 120,
      metaspriteTiles: 140,
      behavior: {
        kind: "guard",
        speed: 0,
        patrolStartX: 144,
        patrolEndX: 144,
        aggroRange: 64,
        guardDirection: -1,
      },
    });
    const blocked = createSnesSpriteOamBudgetReport(project);

    expect(ready.status).toBe("ready");
    expect(ready.usedEntries).toBeGreaterThan(0);
    expect(blocked.status).toBe("blocked");
    expect(blocked.warnings).toContain("Active scene exceeds the 128 OBJ OAM entry budget.");
    expect(blocked.entities.find((entity) => entity.id === "giant-boss")).toMatchObject({
      risk: "over-budget",
    });
  });

  it("blocks FXPAK export when the card profile is not FAT32", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.profile.fxpak.fileSystem = "exfat";

    expect(validateSnesStudioProject(project)).toContainEqual(
      expect.objectContaining({
        code: "FXPAK_FAT32_REQUIRED",
        severity: "error",
      }),
    );
  });

  it("reports hard hardware budget failures", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.assets.audioBytes = 80 * 1024;
    project.assets.audio.sampleBytes = 72 * 1024;
    project.assets.spritePalettes = 9;

    const issues = validateSnesStudioProject(project);

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ARAM_BUDGET_EXCEEDED", "SPRITE_PALETTE_LIMIT"]),
    );
    expect(buildSnesReadiness(project).status).toBe("blocked");
  });

  it("creates an SPC700 audio manifest with ARAM budget accounting", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const audio = createSnesAudioManifest(project);

    expect(audio.driver).toBe("preview-spc700");
    expect(audio.aramLimitBytes).toBe(64 * 1024);
    expect(audio.musicTracks[0]?.name).toBe("Ridge Theme");
    expect(audio.soundEffects.map((effect) => effect.id)).toEqual(["jump", "coin", "hit"]);
    expect(audio.totalBytes).toBe(project.assets.audioBytes);
    expect(audio.utilization).toBeGreaterThan(0);
    expect(audio.warnings).toEqual([]);
  });

  it("imports indexed pixel art as deduplicated SNES 4bpp CHR", () => {
    const pixels = parseSnesIndexedTilePixels(
      Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? "1" : "2")).join(" "),
    );
    const importResult = importSnesIndexedTileAsset(
      {
        name: "Checker Tiles",
        width: 16,
        height: 8,
        pixels: [...pixels, ...pixels],
      },
      "2026-05-19T03:00:00.000Z",
    );
    const project = applySnesImportedTileset(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
      importResult,
      "2026-05-19T03:05:00.000Z",
    );

    expect(importResult.sourceTileCount).toBe(2);
    expect(importResult.uniqueTileCount).toBe(1);
    expect(importResult.dedupedTileCount).toBe(1);
    expect(importResult.chrBytes.byteLength).toBe(32);
    expect(importResult.chrHex).toHaveLength(64);
    expect(importResult.paletteColorsUsed).toEqual([1, 2]);
    expect(importResult.tileIndices).toEqual([0, 0]);
    expect(project.assets.importedTilesets).toHaveLength(1);
    expect(project.assets.importedTilesets[0]).toEqual(
      expect.objectContaining({
        id: "checker-tiles",
        chrChecksum: importResult.chrChecksum,
        uniqueTileCount: 1,
      }),
    );
    expect(
      JSON.parse(buildSnesPreviewRom(project).manifestJson).assets.importedTilesets[0],
    ).toEqual(
      expect.objectContaining({
        id: "checker-tiles",
        chrChecksum: importResult.chrChecksum,
        chrSizeBytes: 32,
      }),
    );
  });

  it("imports decoded RGBA pixels into a SNES 4bpp palette and CHR tileset", () => {
    const rgba = Array.from({ length: 64 }).flatMap((_, index) =>
      index % 3 === 0 ? [0, 0, 0, 0] : index % 3 === 1 ? [255, 0, 0, 255] : [0, 0, 255, 255],
    );
    const importResult = importSnesRgbaTileAsset(
      {
        name: "RGBA Tiles",
        width: 8,
        height: 8,
        rgba,
      },
      "2026-05-19T03:10:00.000Z",
    );

    expect(importResult.sourceTileCount).toBe(1);
    expect(importResult.uniqueTileCount).toBe(1);
    expect(importResult.paletteColorsUsed).toEqual([0, 1, 2]);
    expect(importResult.chrBytes.byteLength).toBe(32);
    expect(() =>
      importSnesRgbaTileAsset({
        name: "Too Many Colors",
        width: 16,
        height: 8,
        rgba: Array.from({ length: 128 }).flatMap((_, index) => [
          (index * 17) % 256,
          (index * 29) % 256,
          (index * 43) % 256,
          255,
        ]),
      }),
    ).toThrow(/more than 16/);
  });

  it("quantizes high-color RGBA art and reports asset pipeline proof", () => {
    const rgba = Array.from({ length: 128 }).flatMap((_, index) => [
      (index * 37) % 256,
      (index * 73) % 256,
      (index * 109) % 256,
      255,
    ]);
    const importResult = importSnesRgbaTileAsset(
      {
        name: "Gradient Tiles",
        width: 16,
        height: 8,
        rgba,
      },
      "2026-05-21T02:05:00.000Z",
      { quantize: true },
    );
    const project = applySnesImportedTileset(createDefaultSnesStudioProject(), importResult);
    const report = createSnesAssetPipelineReport(project);
    const manifest = JSON.parse(buildSnesPreviewRom(project).manifestJson) as {
      assets: {
        importedTilesets: Array<{
          quantized: boolean;
          sourceColorCount: number;
          warnings: string[];
        }>;
        pipeline: { quantizedTilesetCount: number; importedChrBytes: number };
      };
    };

    expect(importResult.quantized).toBe(true);
    expect(importResult.sourceColorCount).toBeGreaterThan(16);
    expect(importResult.paletteColorsUsed.length).toBeLessThanOrEqual(16);
    expect(importResult.palettePreviewHex).toHaveLength(15);
    expect(importResult.warnings.join(" ")).toContain("Quantized");
    expect(report.quantizedTilesetCount).toBe(1);
    expect(report.importedChrBytes).toBe(importResult.chrSizeBytes);
    expect(report.checks.find((check) => check.code === "PNG_COLOR_SAFETY")?.status).toBe("pass");
    expect(manifest.assets.importedTilesets[0]?.quantized).toBe(true);
    expect(manifest.assets.pipeline.quantizedTilesetCount).toBe(1);
  });

  it("runs controlled importer fuzz cases for indexed and RGBA assets", () => {
    const report = runSnesAssetImporterFuzzCases();

    expect(report.status).toBe("verified");
    expect(report.cases).toHaveLength(5);
    expect(report.cases.every((testCase) => testCase.actual === testCase.expected)).toBe(true);
    expect(report.cases.every((testCase) => testCase.controlled)).toBe(true);
    expect(report.cases.map((testCase) => testCase.id)).toEqual([
      "valid-indexed-8x8",
      "invalid-indexed-size",
      "invalid-indexed-palette",
      "valid-rgba-quantized",
      "invalid-rgba-length",
    ]);
  });

  it("creates a save-preserving FXPAK manifest with safe paths", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.export.romBaseName = "Moonlit Ridge!! v0.1";

    const manifest = createFxpakExportManifest(project);

    expect(manifest.romFileName).toBe("moonlit-ridge-v0-1.sfc");
    expect(manifest.romPath).toBe("/SNES/OpenClaw/moonlit-ridge-v0-1.sfc");
    expect(manifest.savePath).toBe("/sd2snes/saves/moonlit-ridge-v0-1.srm");
    expect(manifest.preserveExistingSave).toBe(true);
  });

  it("exports a deterministic SRAM save manifest and validates save budgets", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.save.slots = 2;
    project.save.fields = [
      { key: "checkpoint", label: "Last checkpoint", type: "u16" },
      { key: "coins", label: "Coins", type: "u16" },
      { key: "boss_cleared", label: "Boss cleared", type: "flag" },
      { key: "score", label: "Score", type: "u32" },
    ];

    const save = createSnesSaveManifest(project);
    const rom = buildSnesPreviewRom(project);
    const manifest = JSON.parse(rom.manifestJson) as {
      runtime: { sramBaseAddress: number; sramHeaderBootstrapOffset: number };
      save: typeof save;
    };

    expect(save).toEqual(
      expect.objectContaining({
        enabled: true,
        fields: [
          { key: "checkpoint", label: "Last checkpoint", offset: 0, sizeBytes: 2, type: "u16" },
          { key: "coins", label: "Coins", offset: 2, sizeBytes: 2, type: "u16" },
          { key: "boss_cleared", label: "Boss cleared", offset: 4, sizeBytes: 1, type: "flag" },
          { key: "score", label: "Score", offset: 5, sizeBytes: 4, type: "u32" },
        ],
        savePath: "/sd2snes/saves/moonlit-ridge.srm",
        slotSizeBytes: 9,
        slots: 2,
        sramBaseAddress: 0x700000,
        sramHeaderSizeBytes: 16,
        sramSizeKib: 8,
        totalBytes: 18,
      }),
    );
    expect(save.sramHeaderHex).toHaveLength(32);
    expect(save.sramHeaderHex.startsWith("4f4353560102090012000400")).toBe(true);
    expect(manifest.save).toEqual(save);
    expect(validateSnesPreviewRomArtifact(rom).checks).toContainEqual(
      expect.objectContaining({ code: "SAVE_MANIFEST", passed: true }),
    );
    expect(validateSnesPreviewRomArtifact(rom).checks).toContainEqual(
      expect.objectContaining({ code: "SRAM_HEADER_BOOTSTRAP", passed: true }),
    );
    expect(rom.mapText).toContain("SramHeaderBootstrap");
    expect(rom.bytes[manifest.runtime.sramHeaderBootstrapOffset]).toBe(0xa9);
    expect(rom.bytes[manifest.runtime.sramHeaderBootstrapOffset + 1]).toBe(0x4f);
    expect(rom.bytes[manifest.runtime.sramHeaderBootstrapOffset + 2]).toBe(0x8f);
    expect(rom.bytes[manifest.runtime.sramHeaderBootstrapOffset + 5]).toBe(0x70);

    project.save.fields = [
      { key: "coins", label: "Coins", type: "u16" },
      { key: "coins", label: "Coins duplicate", type: "u8" },
    ];
    expect(validateSnesStudioProject(project)).toContainEqual(
      expect.objectContaining({ code: "SAVE_FIELD_KEYS_UNIQUE", severity: "error" }),
    );
  });

  it("builds a deterministic unheadered LoROM preview ROM skeleton", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const rom = buildSnesPreviewRom(project);
    const title = String.fromCharCode(...rom.bytes.slice(0x7fc0, 0x7fc0 + 21));
    const resetVector = rom.bytes[0x7ffc] | (rom.bytes[0x7ffd] << 8);
    const runtimeMagic = String.fromCharCode(
      ...rom.bytes.slice(rom.runtimeDataOffset, rom.runtimeDataOffset + 7),
    );
    const runtimeJsonSize =
      rom.bytes[rom.runtimeDataOffset + 0x0a] |
      (rom.bytes[rom.runtimeDataOffset + 0x0b] << 8) |
      (rom.bytes[rom.runtimeDataOffset + 0x0c] << 16) |
      (rom.bytes[rom.runtimeDataOffset + 0x0d] << 24);
    const backdropColor =
      rom.bytes[rom.graphics.paletteOffset] | (rom.bytes[rom.graphics.paletteOffset + 1] << 8);
    const firstGroundTile =
      rom.bytes[rom.graphics.tilemapOffset + 24 * 32 * 2] |
      (rom.bytes[rom.graphics.tilemapOffset + 24 * 32 * 2 + 1] << 8);
    const playerTile =
      rom.bytes[rom.graphics.tilemapOffset + 19 * 32 * 2] |
      (rom.bytes[rom.graphics.tilemapOffset + 19 * 32 * 2 + 1] << 8);
    const buildManifest = JSON.parse(rom.manifestJson) as {
      assets: {
        audio: {
          driver: string;
          musicBytes: number;
          soundEffectBytes: number;
          totalBytes: number;
        };
        importedTilesets: Array<{
          chrChecksum: number;
          chrSizeBytes: number;
          id: string;
          uniqueTileCount: number;
        }>;
      };
      graphics: {
        chrOffset: number;
        chrSizeBytes: number;
        paletteOffset: number;
        tileCount: number;
        tilemapOffset: number;
        tilemapSizeBytes: number;
      };
      runtime: {
        backdropColor: number;
        cameraScrollAddress: number;
        collisionPhysics: ReturnType<typeof createSnesCollisionPhysicsPlan>;
        controllerStateAddress: number;
        controllerScrollStepOffset: number;
        cgramUploadOffset: number;
        entityOamSpriteCount: number;
        entityOamUpdateOffset: number;
        joypadLoopOffset: number;
        mode: string;
        oamClearOffset: number;
        playtest: {
          cadence: string;
          frameRate: number;
          fixedPointScale: number;
          runtimeHash: string;
          sceneCount: number;
        };
        playerOamUpdateOffset: number;
        playerPhysicsStepOffset: number;
        playerStart: {
          groundY: number;
          groundedAddress: number;
          jumpVelocity: number;
          maxFallSpeed: number;
          tileIndex: number;
          x: number;
          xAddress: number;
          y: number;
          yAddress: number;
          yVelocityAddress: number;
        };
        ppuBootstrapOffset: number;
        vramChrUploadOffset: number;
        vramTilemapUploadOffset: number;
      };
      runtimeData: { offset: number; sizeBytes: number };
      scene: {
        collisionMapChecksum: number;
        collisionMapOffset: number;
        collisionMapSizeBytes: number;
        collisionTileCount: number;
        editGridHeight: number;
        editGridWidth: number;
        runtimeEntitySprites: Array<{
          attributes: number;
          id: string;
          kind: string;
          tileIndex: number;
          x: number;
          y: number;
        }>;
        tilemapChecksum: number;
        transitionPlan: ReturnType<typeof createSnesLevelTransitionPlan>;
      };
      events: ReturnType<typeof createSnesRuntimeEventPlan>;
      persistence: ReturnType<typeof createSnesProjectPersistencePlan>;
      symbols: Array<{ name: string; offset: number }>;
    };
    const symbolNames = buildManifest.symbols.map((symbol) => symbol.name);

    expect(rom.fileName).toBe("moonlit-ridge.sfc");
    expect(buildManifest.assets.audio).toEqual(
      expect.objectContaining({
        driver: "preview-spc700",
        musicBytes: 6144,
        soundEffectBytes: 320,
        totalBytes: 18 * 1024,
      }),
    );
    expect(buildManifest.assets.importedTilesets).toEqual([]);
    expect(rom.mapFileName).toBe("moonlit-ridge.map");
    expect(rom.manifestFileName).toBe("moonlit-ridge.build.json");
    expect(rom.sizeBytes).toBe(1024 * 1024);
    expect(rom.bytes[0]).toBe(0x78);
    expect(title.trim()).toBe("MOONLIT RIDGE");
    expect(rom.bytes[0x7fd5]).toBe(0x20);
    expect(resetVector).toBe(0x8000);
    expect((rom.checksum ^ rom.checksumComplement) & 0xffff).toBe(0xffff);
    expect(runtimeMagic).toBe("OCSNES1");
    expect(runtimeJsonSize).toBeGreaterThan(500);
    expect(rom.runtimeDataOffset).toBe(0x14000);
    expect(rom.runtimeDataSizeBytes).toBe(runtimeJsonSize + 16);
    expect(rom.graphics.paletteOffset).toBe(0x12000);
    expect(rom.graphics.paletteSizeBytes).toBe(32);
    expect(rom.graphics.chrOffset).toBe(0x12100);
    expect(rom.graphics.chrSizeBytes).toBe(SNES_IMPORTED_TILE_BRUSH_BASE * 32);
    expect(rom.graphics.tilemapOffset).toBe(0x13000);
    expect(rom.graphics.tilemapSizeBytes).toBe(2048);
    expect(rom.graphics.tileCount).toBe(SNES_IMPORTED_TILE_BRUSH_BASE);
    expect(rom.scene.collisionMapOffset).toBe(0x13800);
    expect(rom.scene.collisionMapSizeBytes).toBe(SNES_STUDIO_EDIT_GRID.cells);
    expect(rom.scene.collisionTileCount).toBe(71);
    expect(backdropColor).toBe(buildManifest.runtime.backdropColor);
    expect(
      containsSubsequence(
        rom.bytes.slice(
          buildManifest.runtime.ppuBootstrapOffset,
          buildManifest.runtime.cgramUploadOffset,
        ),
        [0xa9, 0x11, 0x8d, 0x2c, 0x21],
      ),
    ).toBe(true);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.cgramUploadOffset,
          buildManifest.runtime.cgramUploadOffset + 4,
        ),
      ),
    ).toEqual([0xbf, 0x00, 0xa0, 0x02]);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.vramChrUploadOffset,
          buildManifest.runtime.vramChrUploadOffset + 4,
        ),
      ),
    ).toEqual([0xbf, 0x00, 0xa1, 0x02]);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.vramTilemapUploadOffset,
          buildManifest.runtime.vramTilemapUploadOffset + 4,
        ),
      ),
    ).toEqual([0xbf, 0x00, 0xb0, 0x02]);
    expect(buildManifest.runtime.ppuBootstrapOffset).toBeLessThan(
      buildManifest.runtime.cgramUploadOffset,
    );
    expect(buildManifest.runtime.cgramUploadOffset).toBeLessThan(
      buildManifest.runtime.vramChrUploadOffset,
    );
    expect(buildManifest.runtime.vramChrUploadOffset).toBeLessThan(
      buildManifest.runtime.vramTilemapUploadOffset,
    );
    expect(buildManifest.runtime.vramTilemapUploadOffset).toBeLessThan(
      buildManifest.runtime.oamClearOffset,
    );
    expect(buildManifest.runtime.oamClearOffset).toBeLessThan(
      buildManifest.runtime.playerOamUpdateOffset,
    );
    expect(buildManifest.runtime.playerOamUpdateOffset).toBeLessThan(
      buildManifest.runtime.entityOamUpdateOffset,
    );
    expect(buildManifest.runtime.entityOamUpdateOffset).toBeLessThan(
      buildManifest.runtime.joypadLoopOffset,
    );
    expect(buildManifest.runtime.joypadLoopOffset).toBeLessThan(
      buildManifest.runtime.controllerScrollStepOffset,
    );
    expect(buildManifest.runtime.controllerScrollStepOffset).toBeLessThan(
      buildManifest.runtime.playerPhysicsStepOffset,
    );
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.controllerScrollStepOffset,
          buildManifest.runtime.controllerScrollStepOffset + 5,
        ),
      ),
    ).toEqual([0xad, 0x00, 0x02, 0x29, 0x80]);
    expect(
      containsSubsequence(
        rom.bytes.slice(
          buildManifest.runtime.controllerScrollStepOffset,
          buildManifest.runtime.controllerScrollStepOffset + 80,
        ),
        [0xee, 0x04, 0x02],
      ),
    ).toBe(true);
    expect(
      containsSubsequence(
        rom.bytes.slice(
          buildManifest.runtime.controllerScrollStepOffset,
          buildManifest.runtime.controllerScrollStepOffset + 80,
        ),
        [0xce, 0x04, 0x02],
      ),
    ).toBe(true);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.playerPhysicsStepOffset,
          buildManifest.runtime.playerPhysicsStepOffset + 5,
        ),
      ),
    ).toEqual([0xad, 0x00, 0x02, 0x29, 0x01]);
    expect(
      containsSubsequence(
        rom.bytes.slice(
          buildManifest.runtime.playerPhysicsStepOffset,
          buildManifest.runtime.playerPhysicsStepOffset + 140,
        ),
        [0xa9, 0xf8, 0x8d, 0x06, 0x02],
      ),
    ).toBe(true);
    expect(
      containsSubsequence(
        rom.bytes.slice(
          buildManifest.runtime.playerPhysicsStepOffset,
          buildManifest.runtime.playerPhysicsStepOffset + 140,
        ),
        [0xc9, 0xb8, 0x90],
      ),
    ).toBe(true);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.playerOamUpdateOffset,
          buildManifest.runtime.playerOamUpdateOffset + 9,
        ),
      ),
    ).toEqual([0x9c, 0x02, 0x21, 0x9c, 0x03, 0x21, 0xad, 0x04, 0x02]);
    expect(
      Array.from(
        rom.bytes.slice(
          buildManifest.runtime.entityOamUpdateOffset,
          buildManifest.runtime.entityOamUpdateOffset + 12,
        ),
      ),
    ).toEqual([0xa9, 0x02, 0x8d, 0x02, 0x21, 0x9c, 0x03, 0x21, 0xa9, 0xd0, 0x8d, 0x04]);
    expect(
      Array.from(rom.bytes.slice(rom.graphics.chrOffset, rom.graphics.chrOffset + 32)),
    ).toEqual(Array.from({ length: 32 }, () => 0));
    expect(firstGroundTile).toBe(1);
    expect(playerTile).toBe(5);
    expect(rom.mapText).toContain("$02:C000");
    expect(rom.mapText).toContain("OpenClawProjectData");
    expect(rom.mapText).toContain("Mode1PpuBootstrap");
    expect(rom.mapText).toContain("CgramPaletteUpload");
    expect(rom.mapText).toContain("VramChrUpload");
    expect(rom.mapText).toContain("VramTilemapUpload");
    expect(rom.mapText).toContain("JoypadPollLoop");
    expect(rom.mapText).toContain("ControllerScrollStep");
    expect(rom.mapText).toContain("OamClearLoop");
    expect(rom.mapText).toContain("PlayerOamUpdate");
    expect(rom.mapText).toContain("EntityOamUpdate");
    expect(rom.mapText).toContain("PlayerPhysicsStep");
    expect(rom.mapText).toContain("Mode1CgramPalette");
    expect(rom.mapText).toContain("Mode1ChrTiles");
    expect(rom.mapText).toContain("Mode1Bg1Tilemap");
    expect(rom.mapText).toContain("Mode1CollisionMap");
    expect(buildManifest.graphics.paletteOffset).toBe(0x12000);
    expect(buildManifest.graphics.chrSizeBytes).toBe(SNES_IMPORTED_TILE_BRUSH_BASE * 32);
    expect(buildManifest.graphics.tilemapSizeBytes).toBe(2048);
    expect(buildManifest.graphics.tileCount).toBe(SNES_IMPORTED_TILE_BRUSH_BASE);
    expect(buildManifest.runtime.mode).toBe("mode1-preview");
    expect(buildManifest.runtime.playtest).toEqual(
      expect.objectContaining({
        cadence: "ntsc-60hz",
        frameRate: 60.0988,
        fixedPointScale: 256,
        runtimeHash: rom.runtimeManifest.runtimeHash,
        sceneCount: 1,
      }),
    );
    expect(buildManifest.runtime.ppuBootstrapOffset).toBe(0x0b);
    expect(buildManifest.scene).toEqual(
      expect.objectContaining({
        activeSceneId: "ridge-1",
        activeSceneIndex: 0,
        collisionMapChecksum: rom.scene.collisionMapChecksum,
        collisionMapOffset: 0x13800,
        collisionMapSizeBytes: SNES_STUDIO_EDIT_GRID.cells,
        collisionTileCount: 71,
        editGridHeight: SNES_STUDIO_EDIT_GRID.height,
        editGridWidth: SNES_STUDIO_EDIT_GRID.width,
        runtimeEntitySprites: [
          { attributes: 0, id: "enemy-1", kind: "enemy", tileIndex: 4, x: 208, y: 176 },
          { attributes: 32, id: "item-1", kind: "item", tileIndex: 3, x: 255, y: 128 },
        ],
        runtimeTable: rom.scene.runtimeTable,
        tilemapChecksum: rom.scene.tilemapChecksum,
        transitionPlan: expect.objectContaining({
          status: "single-scene",
          runtimeStatus: "implemented-for-preview-scene",
          transitions: [],
        }),
      }),
    );
    expect(buildManifest.events).toEqual(
      expect.objectContaining({
        eventCount: 1,
        runtimeStatus: "blocked-until-65816-interpreter",
        status: "manifest-ready",
      }),
    );
    expect(buildManifest.runtime.collisionPhysics).toEqual(
      expect.objectContaining({
        physics: expect.objectContaining({
          gravityPerFrame: 1,
          groundY: 184,
          jumpVelocity: -8,
          maxFallSpeed: 6,
        }),
        runtimeStatus: "solid-cells-only",
        status: "preview-ready",
      }),
    );
    expect(buildManifest.persistence).toEqual(
      expect.objectContaining({
        cloudSyncStatus: "blocked-until-project-store-binding",
        primaryDraftStorageKey: "openclaw:snes-studio:project:v1",
        status: "local-first-ready",
      }),
    );
    expect(symbolNames).toEqual(
      expect.arrayContaining([
        "CgramPaletteUpload",
        "ControllerScrollStep",
        "EntityOamUpdate",
        "JoypadPollLoop",
        "Mode1PpuBootstrap",
        "OamClearLoop",
        "PlayerOamUpdate",
        "PlayerPhysicsStep",
        "SnesInternalHeader",
        "VramChrUpload",
        "VramTilemapUpload",
        "Mode1CollisionMap",
      ]),
    );
    expect(
      buildManifest.symbols.find((symbol) => symbol.name === "CgramPaletteUpload")?.offset,
    ).toBe(buildManifest.runtime.cgramUploadOffset);
    expect(buildManifest.runtime.controllerStateAddress).toBe(0x0200);
    expect(buildManifest.runtime.cameraScrollAddress).toBe(0x0202);
    expect(buildManifest.runtime.playerStart).toEqual({
      gravityPerFrame: 1,
      groundY: 184,
      groundedAddress: 0x0207,
      jumpVelocity: -8,
      maxFallSpeed: 6,
      moveSpeed: 1,
      tileIndex: 5,
      x: 120,
      xAddress: 0x0204,
      y: 184,
      yAddress: 0x0205,
      yVelocityAddress: 0x0206,
    });
    expect(buildManifest.runtimeData.offset).toBe(0x14000);
    expect(buildManifest.runtimeData.sizeBytes).toBe(rom.runtimeDataSizeBytes);
  });

  it("validates preview ROM integrity before export trust", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const rom = buildSnesPreviewRom(project);
    const report = validateSnesPreviewRomArtifact(rom);

    expect(report.valid).toBe(true);
    expect(report.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "CHECKSUM_PAIR",
        "CONTROLLER_SCROLL_LOOP",
        "AUDIO_MANIFEST",
        "ENTITY_OAM_LOOP",
        "EVENT_BYTECODE",
        "FXPAK_FAT32",
        "GRAPHICS_LAYOUT",
        "GRAPHICS_STYLE_PRESET",
        "LEVEL_LOADER_TABLE",
        "PLAYER_OAM_LOOP",
        "PLAYER_PHYSICS_LOOP",
        "RESET_VECTOR",
        "RUNTIME_PLAYTEST_MANIFEST",
        "RUNTIME_DATA_CHECKSUM",
        "SCENE_EDIT_LAYERS",
        "SYMBOL_MAP",
        "UPLOAD_OFFSETS",
        "UPLOAD_OPCODES",
      ]),
    );
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);

    const corrupted = {
      ...rom,
      bytes: new Uint8Array(rom.bytes),
    };
    corrupted.bytes[0x7ffc] = 0x01;

    expect(validateSnesPreviewRomArtifact(corrupted).valid).toBe(false);
  });

  it("creates a ready FXPAK PRO export package plan with SRAM preservation", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const rom = buildSnesPreviewRom(project);
    const fxpakPackage = createSnesFxpakExportPackage(rom);

    expect(fxpakPackage.status).toBe("ready");
    expect(fxpakPackage.requiredFileSystem).toBe("FAT32");
    expect(fxpakPackage.cardSizeGb).toBe(128);
    expect(fxpakPackage.files).toContainEqual(
      expect.objectContaining({
        destinationPath: "/SNES/OpenClaw/moonlit-ridge.sfc",
        kind: "rom",
        sourceName: "moonlit-ridge.sfc",
      }),
    );
    expect(fxpakPackage.files).toContainEqual(
      expect.objectContaining({
        destinationPath: "/sd2snes/saves/moonlit-ridge.srm",
        kind: "sram",
        writeMode: "preserve-existing",
      }),
    );
    expect(fxpakPackage.integrity.staticValidationPassed).toBe(true);
    expect(fxpakPackage.integrity.requiredOperatorHash).toBe("sha256-after-copy");
    expect(fxpakPackage.sram.requiredPowerCycleTest).toBe(true);
  });

  it("paints editable tile and collision cells into exported ROM metadata", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const cellIndex = 2 * SNES_STUDIO_EDIT_GRID.width + 3;
    const painted = paintSnesSceneCell(project, 0, cellIndex, 1, true, 2);
    const rom = buildSnesPreviewRom(painted);
    const manifest = JSON.parse(rom.manifestJson) as {
      scene: {
        collisionMapChecksum: number;
        collisionMapOffset: number;
        collisionMapSizeBytes: number;
        collisionTileCount: number;
        tilemapChecksum: number;
      };
    };
    const tileColumn = 3 * 2;
    const tileRow = 8 + 2 * 2;
    const paintedTile =
      rom.bytes[rom.graphics.tilemapOffset + (tileRow * 32 + tileColumn) * 2] |
      (rom.bytes[rom.graphics.tilemapOffset + (tileRow * 32 + tileColumn) * 2 + 1] << 8);

    expect(painted.scenes[0]?.tilemap[cellIndex]).toBe(1);
    expect(painted.scenes[0]?.collisionMap[cellIndex]).toBe(2);
    expect(painted.scenes[0]?.collisionTiles).toBe(72);
    expect(paintedTile).toBe(1);
    expect(rom.bytes[rom.scene.collisionMapOffset + cellIndex]).toBe(2);
    expect(manifest.scene.collisionTileCount).toBe(72);
    expect(manifest.scene.collisionMapChecksum).toBe(rom.scene.collisionMapChecksum);
  });

  it("compiles imported tile brushes into preview ROM CHR and BG1 tilemap", () => {
    const pixels = parseSnesIndexedTilePixels(
      Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? "1" : "2")).join(" "),
    );
    const imported = importSnesIndexedTileAsset({
      name: "Checker Tiles",
      width: 8,
      height: 8,
      pixels,
    });
    const withAsset = applySnesImportedTileset(createDefaultSnesStudioProject(), imported);
    const cellIndex = 1 * SNES_STUDIO_EDIT_GRID.width + 2;
    const painted = paintSnesSceneCell(
      withAsset,
      0,
      cellIndex,
      SNES_IMPORTED_TILE_BRUSH_BASE,
      false,
    );
    const rom = buildSnesPreviewRom(painted);
    const manifest = JSON.parse(rom.manifestJson) as {
      graphics: {
        builtinTileCount: number;
        chrSizeBytes: number;
        importedTileBaseIndex: number;
        importedTileCount: number;
      };
    };
    const tileColumn = 2 * 2;
    const tileRow = 8 + 1 * 2;
    const paintedTile =
      rom.bytes[rom.graphics.tilemapOffset + (tileRow * 32 + tileColumn) * 2] |
      (rom.bytes[rom.graphics.tilemapOffset + (tileRow * 32 + tileColumn) * 2 + 1] << 8);
    const importedChrOffset = rom.graphics.chrOffset + SNES_IMPORTED_TILE_BRUSH_BASE * 32;

    expect(rom.graphics.builtinTileCount).toBe(SNES_IMPORTED_TILE_BRUSH_BASE);
    expect(rom.graphics.importedTileBaseIndex).toBe(SNES_IMPORTED_TILE_BRUSH_BASE);
    expect(rom.graphics.importedTileCount).toBe(1);
    expect(rom.graphics.chrSizeBytes).toBe((SNES_IMPORTED_TILE_BRUSH_BASE + 1) * 32);
    expect(Array.from(rom.bytes.slice(importedChrOffset, importedChrOffset + 32))).toEqual(
      Array.from(imported.chrBytes),
    );
    expect(paintedTile).toBe(SNES_IMPORTED_TILE_BRUSH_BASE);
    expect(manifest.graphics).toEqual(
      expect.objectContaining({
        builtinTileCount: SNES_IMPORTED_TILE_BRUSH_BASE,
        chrSizeBytes: (SNES_IMPORTED_TILE_BRUSH_BASE + 1) * 32,
        importedTileBaseIndex: SNES_IMPORTED_TILE_BRUSH_BASE,
        importedTileCount: 1,
      }),
    );
    expect(rom.mapText).toContain("Mode1ImportedChrTiles");
  });

  it("separates static ROM validation from emulator boot proof", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));

    const blocked = createSnesEmulatorValidationReport(rom);
    expect(blocked.status).toBe("blocked");
    expect(blocked.selectedEmulator).toBeNull();
    expect(blocked.staticRomValidation.valid).toBe(true);
    expect(blocked.blockers).toContain(
      "No supported SNES emulator was detected for boot/screenshot validation.",
    );

    const ready = createSnesEmulatorValidationReport(rom, ["bsnes"]);
    expect(ready.status).toBe("ready");
    expect(ready.selectedEmulator).toBe("bsnes");
    expect(ready.nextSteps.join("\n")).toContain("Boot moonlit-ridge.sfc in bsnes.");
  });

  it("blocks preview ROM builds for SuperFX concept profiles", () => {
    const project = generateSnesProjectFromPrompt("Star Fox style 3D space shooter").project;

    expect(() => buildSnesPreviewRom(project)).toThrow(/Mode 1/);
  });

  it("keeps canonical project JSON stable", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const json = stableProjectJson(project);

    expect(json.startsWith('{\n  "aiGapReport":')).toBe(true);
    expect(json).toContain('"animations": [');
    expect(json).toContain('"assets": {');
    expect(json).toContain('"gameStoryBible": {');
    expect(json).toContain('"levelChapters": [');
    expect(json).toContain('"romBaseName": "moonlit-ridge"');
    expect(json).toContain('"updatedAt": "2026-05-19T00:00:00.000Z"');
    expect(json.endsWith("\n")).toBe(true);
  });

  it("returns meters for every critical SNES budget", () => {
    const meters = estimateSnesProjectBudgets(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(meters.map((meter) => meter.label)).toEqual([
      "WRAM",
      "VRAM",
      "CGRAM",
      "OAM",
      "ARAM",
      "SRAM",
      "ROM",
    ]);
  });

  it("sanitizes FAT32-friendly ROM base names", () => {
    expect(sanitizeRomBaseName("  Star FX: Doom??  ")).toBe("star-fx-doom");
  });

  it("generates a hardware-safe draft from a text prompt", () => {
    const result = generateSnesProjectFromPrompt(
      'Build "Ghost Castle Quest" with keys, dialogue, and a boss.',
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(result.approvalRequired).toBe(true);
    expect(result.project.name).toBe("Ghost Castle Quest");
    expect(result.project.export.romBaseName).toBe("ghost-castle-quest");
    expect(result.project.profile.fxpak.fileSystem).toBe("fat32");
    expect(result.project.profile.fxpak.preserveExistingSaves).toBe(true);
    expect(result.project.scenes[0]?.entities.some((entity) => entity.kind === "npc")).toBe(true);
    expect(result.project.gameStoryBible?.villain).toBe("Gate Guardian");
    expect(result.project.levelChapters?.[0]?.storyPurpose).toContain("Introduce");
    expect(buildSnesReadiness(result.project).status).toBe("ready");
  });

  it("reports and fills story-game gaps with safe local AI defaults", () => {
    const blank = createBlankSnesStudioProject("2026-05-19T00:00:00.000Z");
    const before = createSnesAiGapReport(blank);
    const filled = fillSnesAiGaps(blank, "2026-05-19T00:00:01.000Z");

    expect(before.status).toBe("needs-fixes");
    expect(filled.report.status).toBe("complete");
    expect(filled.project.scenes.length).toBeGreaterThanOrEqual(3);
    expect(filled.project.levelChapters?.length).toBeGreaterThanOrEqual(3);
    expect(filled.project.scenes[0]?.entities.some((entity) => entity.name.includes("Goal"))).toBe(
      true,
    );
    expect(filled.changes.join("\n")).toContain("Filled levels as story chapters");
  });

  it("generates multiple editable levels from one full-game prompt", () => {
    const result = generateSnesProjectFromPrompt(
      'Build "Crystal Key Quest" with three levels, keys, dialogue, lava hazards, audio, saves, and a boss.',
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(result.project.scenes).toHaveLength(3);
    expect(result.project.scenes.map((scene) => scene.name)).toEqual([
      "Crystal Key Quest 1-1",
      "Crystal Key Quest Boss Gate",
      "Crystal Key Quest 3-1",
    ]);
    expect(result.project.scenes[1]?.entities.some((entity) => entity.kind === "enemy")).toBe(true);
    expect(result.project.scenes[2]?.entities.some((entity) => entity.kind === "item")).toBe(true);
    expect(result.appliedChanges).toContain(
      "Generated 3 editable levels from the full-game prompt.",
    );
    expect(buildSnesReadiness(result.project).status).toBe("ready");
  });

  it("reports one-prompt game completeness and editable surfaces", () => {
    const result = generateSnesProjectFromPrompt(
      'Build "Signal Grove" with three levels, enemies, items, dialogue, audio, SRAM saves, and FXPAK export.',
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );
    const report = createSnesOnePromptGameReport(result.project);

    expect(report.status).toBe("blocked");
    expect(report.editableObjectCount).toBeGreaterThanOrEqual(10);
    expect(report.prompt.requiredSurfaces).toEqual([
      "full-game",
      "level",
      "player",
      "enemies",
      "items",
      "dialogue",
      "audio",
      "save",
      "export",
    ]);
    expect(report.components.map((component) => component.id)).toEqual([
      "game-prompt",
      "edit-level",
      "art-assets",
      "logic-events",
      "save-system",
      "rom-build",
      "emulator-proof",
    ]);
    expect(report.components.find((component) => component.id === "rom-build")?.status).toBe(
      "complete",
    );
    expect(report.components.find((component) => component.id === "emulator-proof")?.status).toBe(
      "blocked",
    );
  });

  it("keeps SuperFX prompts explicit without breaking FXPAK constraints", () => {
    const result = generateSnesProjectFromPrompt("Star Fox style 3D space shooter");
    const superFx = createSnesSuperFxProfileReport(result.project);

    expect(result.project.profile.videoMode).toBe("superfx");
    expect(result.project.profile.enhancementChip).toBe("superfx");
    expect(result.project.profile.target).toBe("fxpak-pro");
    expect(superFx.status).toBe("concept-only");
    expect(superFx.fxpakCompatible).toBe(true);
    expect(superFx.blockers).toContain("GSU instruction assembler/linker is not implemented.");
    expect(validateSnesStudioProject(result.project).map((issue) => issue.code)).toContain(
      "V01_MODE1_VERTICAL_SLICE",
    );
  });

  it("creates approval-gated patch proposals before mutating a project", () => {
    const baseProject = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createSnesAgentPatchProposal(
      'Build "Gem Forest Bots" with gems, robots, and a guide NPC.',
      baseProject,
    );

    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.operations.map((operation) => operation.path)).toEqual(
      expect.arrayContaining(["/name", "/scenes/0/entities", "/export/romBaseName"]),
    );
    expect(baseProject.name).toBe("Moonlit Ridge");
    expect(proposal.previewProject.name).toBe("Gem Forest Bots");
    expect(proposal.readiness.status).toBe("ready");
  });

  it("offers AI authoring prompts for every editable game surface", () => {
    const catalog = createSnesAiAuthoringPrompts(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(catalog.map((entry) => entry.surface)).toEqual([
      "full-game",
      "level",
      "player",
      "enemies",
      "items",
      "audio",
      "dialogue",
      "save",
      "export",
    ]);
    expect(catalog.map((entry) => entry.title)).toContain("Create Entire Game");
    expect(catalog.every((entry) => entry.placeholder.length > 20)).toBe(true);
    const beginnerPromptText = catalog
      .map((entry) => `${entry.description} ${entry.placeholder}`)
      .join(" ");
    expect(beginnerPromptText).toContain("save points");
    expect(beginnerPromptText).toContain("real-hardware export");
    expect(beginnerPromptText).not.toMatch(/\b(SRAM|FXPAK|LoROM|OAM|VRAM|CGRAM|SPC700)\b/u);
  });

  it("starts from a blank AI-first project and reports the ordered build plan", () => {
    const blank = createBlankSnesStudioProject("2026-05-19T00:00:00.000Z");
    const plan = createSnesAiBuildPlan(blank);

    expect(blank.name).toBe("Untitled SNES Game");
    expect(blank.scenes[0]?.entities).toEqual([]);
    expect(blank.scenes[0]?.tilemap.every((tile) => tile === 0)).toBe(true);
    expect(blank.scenes[0]?.collisionMap.every((material) => material === 0)).toBe(true);
    expect(blank.save.enabled).toBe(false);
    expect(plan.map((stage) => stage.surface)).toEqual([
      "full-game",
      "level",
      "player",
      "enemies",
      "items",
      "dialogue",
      "audio",
      "save",
      "export",
    ]);
    expect(
      plan.filter((stage) => stage.status === "recommended").map((stage) => stage.surface),
    ).toEqual(["full-game", "level", "player", "enemies", "items", "save", "export"]);
    expect(plan.find((stage) => stage.surface === "level")?.editPanel).toBe("scene");
    expect(plan.find((stage) => stage.surface === "audio")?.editPanel).toBe("assets");
  });

  it("marks generated AI surfaces complete after prompt-created content exists", () => {
    const base = createBlankSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createSnesAgentPatchProposalForSurface(
      "full-game",
      'Create "Signal Ridge" with gems, robots, a guide NPC, music, and saves.',
      base,
      "openclaw",
    );
    const generated = proposal.previewProject;
    const plan = createSnesAiBuildPlan(generated);

    expect(plan.find((stage) => stage.surface === "full-game")?.status).toBe("complete");
    expect(plan.find((stage) => stage.surface === "level")?.status).toBe("complete");
    expect(plan.find((stage) => stage.surface === "player")?.status).toBe("complete");
    expect(plan.find((stage) => stage.surface === "enemies")?.status).toBe("complete");
    expect(plan.find((stage) => stage.surface === "items")?.status).toBe("complete");
    expect(plan.find((stage) => stage.surface === "save")?.status).toBe("complete");
  });

  it("repairs a blank prompt project into a playable editable preview", () => {
    const blank = createBlankSnesStudioProject("2026-05-19T00:00:00.000Z");
    const repair = repairSnesProjectForPlayablePreview(blank, "2026-05-19T03:00:00.000Z");
    const summary = createSnesGeneratedObjectSummary(repair.project);

    expect(repair.beforeReadiness.status).toBe("caution");
    expect(repair.afterReadiness.status).toBe("ready");
    expect(repair.changes).toEqual(
      expect.arrayContaining([
        "Filled the active level with editable starter tiles and collision.",
        "Added an editable player start.",
        "Added editable SPC700 preview music and sound effects.",
        "Added editable SRAM save slots and fields.",
      ]),
    );
    expect(summary.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "entity",
        "animation",
        "dialogue",
        "event",
        "audio",
        "save",
        "export",
      ]),
    );
    expect(summary.find((item) => item.label === "SRAM Save System")?.editPanel).toBe("export");
  });

  it("creates level prompt brushes and visible tile/collision data from a blank canvas", () => {
    const blank = createBlankSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createSnesAgentPatchProposalForSurface(
      "level",
      "Create a vertical water cave with spike hazards, pits, and layered platforms.",
      blank,
      "codex",
    );

    expect(proposal.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/scenes/0/tilemap" }),
        expect.objectContaining({ path: "/scenes/0/collisionMap" }),
        expect.objectContaining({ path: "/assets/customTileBrushes" }),
      ]),
    );
    expect(proposal.previewProject.assets.customTileBrushes.map((brush) => brush.name)).toEqual(
      expect.arrayContaining(["AI Hazard", "AI Water"]),
    );
    expect(proposal.previewProject.scenes[0]?.collisionTiles).toBeGreaterThan(0);
  });

  it("generates SNES 4bpp prompt sprite assets with editable metasprite defaults", () => {
    const sprite = createSnesPromptSpriteAsset(
      "Create an armored blue robot hero with wings.",
      "player",
      "2026-05-19T03:30:00.000Z",
    );

    expect(sprite.importResult.width).toBe(16);
    expect(sprite.importResult.height).toBe(16);
    expect(sprite.importResult.chrBytes.byteLength).toBeGreaterThan(0);
    expect(sprite.importResult.paletteColorsUsed.every((color) => color >= 0 && color <= 15)).toBe(
      true,
    );
    expect(sprite.defaultEntity.kind).toBe("player");
    expect(sprite.defaultEntity.metaspriteTiles).toBe(4);
    expect(sprite.animation?.entityKind).toBe("player");
    expect(sprite.paletteHints).toContain(
      "Generated pixels stay inside one SNES 4bpp 16-color palette.",
    );
  });

  it("creates editable per-surface AI patch proposals with provider choice", () => {
    const baseProject = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const prompts = {
      audio: "Create a fast boss theme with pickup and hit sound effects.",
      dialogue: "Create a guide NPC named Signal Sage.",
      enemies: "Create robot enemies and a boss.",
      export: "Create export settings for Signal Ridge DX.",
      "full-game": 'Create "Signal Ridge" with gems, robots, and dialogue.',
      items: "Create many gems and a key.",
      level: "Create a large vertical platform level with pits.",
      player: "Create a detailed armored explorer player at the center.",
      save: "Create save fields for checkpoint, gems, keys, and boss state.",
    } as const;

    const proposals = Object.entries(prompts).map(([surface, prompt], index) =>
      createSnesAgentPatchProposalForSurface(
        surface as keyof typeof prompts,
        prompt,
        baseProject,
        index % 2 === 0 ? "openclaw" : "codex",
      ),
    );

    expect(proposals).toHaveLength(9);
    expect(proposals.every((proposal) => proposal.approvalRequired)).toBe(true);
    expect(proposals.every((proposal) => proposal.operations.length > 0)).toBe(true);
    expect(proposals.every((proposal) => proposal.readiness.status !== "blocked")).toBe(true);
    expect(proposals.map((proposal) => proposal.requestedAgent)).toContain("openclaw");
    expect(proposals.map((proposal) => proposal.requestedAgent)).toContain("codex");
    expect(proposals.find((proposal) => proposal.surface === "enemies")?.operations).toContainEqual(
      expect.objectContaining({ path: "/scenes/0/entities" }),
    );
    expect(proposals.find((proposal) => proposal.surface === "save")?.operations).toContainEqual(
      expect.objectContaining({ path: "/save/fields" }),
    );
    expect(proposals.find((proposal) => proposal.surface === "audio")?.operations).toContainEqual(
      expect.objectContaining({ path: "/assets/audio" }),
    );
  });

  it("exports a constrained OpenClaw/Codex task packet", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const packet = createSnesCodexTaskPacket(
      project,
      "Add a forest NPC and two robot enemies.",
      "2026-05-19T02:00:00.000Z",
      "openclaw",
      "enemies",
    );

    expect(packet.target).toBe("openclaw-codex");
    expect(packet.requestedAgent).toBe("openclaw");
    expect(packet.surface).toBe("enemies");
    expect(packet.approvalRequired).toBe(true);
    expect(packet.hardwareProfile.fxpak.fileSystem).toBe("fat32");
    expect(packet.hardwareProfile.fxpak.preserveExistingSaves).toBe(true);
    expect(packet.allowedPatchPaths).toContain("/scenes/0/entities");
    expect(packet.responseContract.operation).toBe("replace");
    expect(packet.projectJson).toContain('"name": "Moonlit Ridge"');
    expect(packet.constraints.join("\n")).toContain("FXPAK PRO");
    expect(packet.constraints.join("\n")).toContain("Requested authoring surface: enemies.");
  });

  it("defaults creative agent work to OpenClaw and reserves Codex for export gates", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createSnesAgentPatchProposalForSurface(
      "level",
      "Add a gentle starter level with coins.",
      project,
    );
    const taskPacket = createSnesCodexTaskPacket(
      project,
      "Add a forest NPC and two robot enemies.",
      "2026-05-19T02:00:00.000Z",
    );
    const dispatch = createSnesAgentDispatchRecord(
      project,
      "Create a custom reward item.",
      "2026-05-19T02:01:00.000Z",
    );

    expect(defaultSnesAgentProviderForSurface("full-game")).toBe("openclaw");
    expect(defaultSnesAgentProviderForSurface("level")).toBe("openclaw");
    expect(defaultSnesAgentProviderForSurface("export")).toBe("codex");
    expect(proposal.requestedAgent).toBe("openclaw");
    expect(taskPacket.requestedAgent).toBe("openclaw");
    expect(dispatch.requestedAgent).toBe("openclaw");
    expect(dispatch.taskPacket.requestedAgent).toBe("openclaw");
  });

  it("creates durable OpenClaw/Codex dispatch records for a local queue handoff", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const record = createSnesAgentDispatchRecord(
      project,
      "Add a forest NPC and two robot enemies.",
      "2026-05-19T02:00:00.000Z",
      "openclaw",
      "enemies",
    );
    const queue = appendSnesAgentDispatchRecord([], record);
    const parsed = parseSnesAgentDispatchQueue(JSON.stringify(queue));

    expect(record.id).toBe("snes-codex-task-moonlit-ridge-20260519020000000");
    expect(record.status).toBe("queued");
    expect(record.requestedAgent).toBe("openclaw");
    expect(record.surface).toBe("enemies");
    expect(record.approvalRequired).toBe(true);
    expect(record.handoff.eventName).toBe(SNES_AGENT_DISPATCH_EVENT);
    expect(record.handoff.queueStorageKey).toBe(SNES_AGENT_DISPATCH_QUEUE_KEY);
    expect(record.safety.readinessStatus).toBe("ready");
    expect(record.safety.staticRomValidationRequired).toBe(true);
    expect(record.taskPacket.responseContract.format).toBe("json-patch-proposal");
    expect(record.taskPacket.requestedAgent).toBe("openclaw");
    expect(record.taskPacket.surface).toBe("enemies");
    expect(parsed[0]?.taskPacket.userPrompt).toBe("Add a forest NPC and two robot enemies.");
    expect(parsed[0]?.requestedAgent).toBe("openclaw");
    expect(parsed[0]?.surface).toBe("enemies");
  });

  it("imports live OpenClaw/Codex result records as approval-gated patches", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const record = createSnesAgentDispatchRecord(
      project,
      "Rename the game from a live agent.",
      "2026-05-19T02:00:00.000Z",
      "openclaw",
      "full-game",
    );
    const result = createSnesAgentResultRecord(
      record,
      JSON.stringify({
        summary: "Live result patch.",
        rationale: ["Returned through the result queue."],
        operations: [{ op: "replace", path: "/name", value: "Live Signal Quest" }],
      }),
      "2026-05-19T02:01:00.000Z",
    );
    const queue = appendSnesAgentResultRecord([], result);
    const parsed = parseSnesAgentResultQueue(JSON.stringify(queue));
    const proposal = createSnesAgentPatchProposalFromResult(parsed[0], project);

    expect(result.handoff.eventName).toBe("openclaw:snes-studio:codex-result");
    expect(result.handoff.queueStorageKey).toBe("openclaw:snes-studio:codex-result-queue:v1");
    expect(parsed[0]?.requestedAgent).toBe("openclaw");
    expect(proposal.summary).toBe("Live result patch.");
    expect(proposal.previewProject.name).toBe("Live Signal Quest");
  });

  it("rejects malicious AI patch corpus cases while accepting a safe patch", () => {
    const report = createSnesPatchSandboxCorpusReport(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(report.status).toBe("verified");
    expect(report.acceptedSafeCase).toBe(true);
    expect(report.rejectedMaliciousCases).toBe(5);
    expect(report.cases.every((testCase) => testCase.actual === testCase.expected)).toBe(true);
    expect(report.cases.find((testCase) => testCase.id === "prototype-pollution")?.actual).toBe(
      "rejected",
    );
  });

  it("creates a Gateway agent handoff for queued OpenClaw/Codex tasks", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const record = createSnesAgentDispatchRecord(
      project,
      "Add a forest NPC and two robot enemies.",
      "2026-05-19T02:00:00.000Z",
      "openclaw",
      "enemies",
    );
    const handoff = createSnesGatewayAgentHandoff(record, {
      sessionKey: "agent:main:dashboard:snes-studio-test",
    });

    expect(handoff.status).toBe("ready");
    expect(handoff.method).toBe("agent");
    expect(handoff.sessionKey).toBe("agent:main:dashboard:snes-studio-test");
    expect(handoff.request).toEqual(
      expect.objectContaining({
        deliver: false,
        idempotencyKey: record.id,
        promptMode: "minimal",
        sessionKey: "agent:main:dashboard:snes-studio-test",
        timeout: 180,
      }),
    );
    expect(handoff.wait).toEqual({ method: "agent.wait", timeoutMs: 120000 });
    expect(handoff.history).toEqual({ method: "chat.history", limit: 12, maxChars: 60000 });
    expect(handoff.request.message).toContain("SNES Studio OpenClaw/Codex generation task.");
    expect(handoff.request.message).toContain('"requestedAgent": "openclaw"');
    expect(handoff.request.message).toContain('"surface": "enemies"');
    expect(handoff.request.message).toContain("allowedPatchPaths");
    expect(handoff.request.model).toBeUndefined();
    expect(handoff.instructions.join("\n")).toContain("approval");
  });

  it("creates a Codex-supervised OpenClaw Gateway production route", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const plan = createSnesAiProductionGatewayPlan(
      project,
      "Make a mountain robot platformer with three levels.",
      {
        createdAt: "2026-05-19T02:10:00.000Z",
        sessionKey: "agent:main:dashboard:snes-studio-test",
      },
    );

    expect(plan.sessionKey).toBe("agent:main:dashboard:snes-studio-test");
    expect(plan.stages.map((stage) => stage.role)).toEqual([
      "codex-architect",
      "openclaw-game-director",
      "openclaw-level-designer",
      "openclaw-gameplay-designer",
      "openclaw-art-audio",
      "openclaw-hardware-qa",
      "codex-qa-gate",
    ]);
    expect(plan.stages.map((stage) => stage.requestedAgent)).toEqual([
      "codex",
      "openclaw",
      "openclaw",
      "openclaw",
      "openclaw",
      "openclaw",
      "codex",
    ]);
    expect(plan.stages.every((stage) => stage.handoff.method === "agent")).toBe(true);
    expect(plan.stages.every((stage) => !stage.handoff.request.deliver)).toBe(true);
    expect(plan.stages[0]?.handoff.request.model).toBe("openai/gpt-5.5");
    expect(
      plan.stages.slice(1, 6).every((stage) => stage.handoff.request.model === undefined),
    ).toBe(true);
    expect(plan.stages[6]?.handoff.request.model).toBe("openai/gpt-5.5");
    expect(plan.stages.every((stage) => stage.handoff.wait.method === "agent.wait")).toBe(true);
    expect(plan.stages.every((stage) => stage.handoff.history.method === "chat.history")).toBe(
      true,
    );
    expect(plan.stages[0]?.handoff.request.message).toContain("Codex Architect stage.");
    expect(plan.stages[1]?.handoff.request.message).toContain(
      "OpenClaw Game Director production stage.",
    );
    expect(plan.stages[2]?.handoff.request.message).toContain(
      "OpenClaw Level Designer production stage.",
    );
    expect(plan.stages[6]?.handoff.request.message).toContain("Codex QA Gate stage.");
    expect(plan.acceptanceCriteria.join(" ")).toContain("approval-gated JSON");
    expect(plan.blockers.join(" ")).toContain("FAT32 flash-cart");
  });

  it("creates stable SNES Studio AI team roles for Codex review and OpenClaw worker lanes", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const team = createSnesAgentTeamPlan(project, "Make a robot platformer.", {
      createdAt: "2026-05-19T02:20:00.000Z",
      sessionKey: "agent:main:dashboard:snes-studio-test",
    });

    expect(team.members.map((member) => member.role)).toEqual([
      "codex-architect",
      "openclaw-game-director",
      "openclaw-level-designer",
      "openclaw-gameplay-designer",
      "openclaw-art-audio",
      "openclaw-hardware-qa",
      "codex-qa-gate",
    ]);
    expect(
      team.members
        .filter((member) => !member.agentId)
        .every((member) => member.sessionKey.startsWith(team.sessionBaseKey)),
    ).toBe(true);
    expect(team.members.find((member) => member.role === "openclaw-game-director")?.agentId).toBe(
      "snes-game-director",
    );
    expect(
      team.members.find((member) => member.role === "openclaw-game-director")?.sessionKey,
    ).toContain("agent:snes-game-director:");
    expect(
      team.members
        .filter((member) => member.requestedAgent === "codex")
        .every((member) => member.model === "openai/gpt-5.5"),
    ).toBe(true);
    expect(
      team.members
        .filter((member) => member.requestedAgent === "openclaw")
        .every((member) => member.model === undefined),
    ).toBe(true);
    expect(team.members.filter((member) => member.fillsTextBoxes)).toHaveLength(4);

    const codexPreflight = createSnesAgentTeamPreflight(team.members[0], {
      createdAt: "2026-05-19T02:21:00.000Z",
    });
    const openClawPreflight = createSnesAgentTeamPreflight(team.members[1], {
      createdAt: "2026-05-19T02:21:00.000Z",
    });
    expect(codexPreflight.request.model).toBe("openai/gpt-5.5");
    expect(openClawPreflight.request.model).toBeUndefined();
    expect(openClawPreflight.request.agentId).toBe("snes-game-director");
    expect(codexPreflight.request.timeout).toBe(SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS / 1000);
    expect(codexPreflight.wait.timeoutMs).toBe(SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS);
    expect(codexPreflight.request.message).toContain("SNES Studio AI team connection preflight.");
    expect(codexPreflight.request.message).toContain('"ready":true');
  });

  it("reports configured SNES Studio OpenClaw workers as proof pending without live JSON", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const report = createSnesAgentTeamReadinessPlan(project, "agent:main:dashboard:snes-studio", {
      checkedAt: "2026-05-19T02:23:00.000Z",
      configuredAgentIds: [
        "snes-game-director",
        "snes-level-designer",
        "snes-gameplay-designer",
        "snes-art-audio",
        "snes-hardware-qa",
      ],
      runtimeAvailable: true,
    });

    expect(report.status).toBe("ready");
    expect(report.title).toBe("Live proof pending");
    expect(report.roles.filter((role) => role.state === "proof-pending")).toHaveLength(7);
    expect(report.blockers).toHaveLength(0);
    expect(
      createSnesGatewayAgentHandoff(createSnesAgentDispatchRecord(project, "test")).wait.timeoutMs,
    ).toBe(SNES_AGENT_TEAM_LIVE_PROOF_TIMEOUT_MS);
  });

  it("reports missing SNES Studio OpenClaw worker agents before live checks", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const report = createSnesAgentTeamReadinessPlan(project, "agent:main:dashboard:snes-studio", {
      checkedAt: "2026-05-19T02:22:00.000Z",
      configuredAgentIds: ["main"],
    });

    expect(report.status).toBe("unavailable");
    expect(report.title).toBe("Live OpenClaw unavailable");
    expect(report.roles.filter((role) => role.state === "needs-setup")).toHaveLength(5);
    expect(report.blockers[0]?.code).toBe("missing-agent");
    expect(summarizeSnesAgentTeamBlockers(report)).toContain("OpenClaw worker agent");
  });

  it("normalizes invalid SNES Studio role readiness output as an actionable blocker", () => {
    const result = normalizeSnesAgentRoleResult("plain text", "openclaw-level-designer");

    expect(result.state).toBe("invalid-response");
    expect(result.validJsonReturned).toBe(false);
    expect(result.blocker?.recommendedFix).toContain("agent transcript");
  });

  it("normalizes older queued agent records that predate per-surface controls", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const current = createSnesAgentDispatchRecord(
      project,
      "Create a castle level.",
      "2026-05-19T02:00:00.000Z",
    );
    const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    delete legacy.requestedAgent;
    delete legacy.surface;
    if (legacy.taskPacket && typeof legacy.taskPacket === "object") {
      delete (legacy.taskPacket as Record<string, unknown>).requestedAgent;
      delete (legacy.taskPacket as Record<string, unknown>).surface;
    }

    const parsed = parseSnesAgentDispatchQueue(JSON.stringify([legacy]));

    expect(parsed[0]?.requestedAgent).toBe("codex");
    expect(parsed[0]?.surface).toBe("full-game");
    expect(parsed[0]?.taskPacket.requestedAgent).toBe("codex");
    expect(parsed[0]?.taskPacket.surface).toBe("full-game");
  });

  it("creates durable project version history entries", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const version = createSnesProjectVersion(
      project,
      "Before boss edit",
      "2026-05-19T04:00:00.000Z",
    );
    const history = appendSnesProjectVersion([], version);
    const parsed = parseSnesProjectVersionHistory(JSON.stringify(history));

    expect(version.id).toBe("snes-version-moonlit-ridge-20260519040000000");
    expect(version.reason).toBe("Before boss edit");
    expect(version.projectName).toBe("Moonlit Ridge");
    expect(version.projectJson).toContain('"romBaseName": "moonlit-ridge"');
    expect(parsed[0]?.id).toBe(version.id);
  });

  it("runs a project recovery corruption drill without accepting broken bundles", () => {
    const report = createSnesRecoveryCorruptionDrill(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
    );

    expect(report.status).toBe("verified");
    expect(report.restoredProjectId).toBe("snes-platformer-v01");
    expect(report.checks.map((check) => check.code)).toEqual([
      "VALID_BUNDLE_RESTORES",
      "VERSION_HISTORY_RESTORES",
      "CORRUPT_JSON_REJECTED",
      "CORRUPT_BUNDLE_REJECTED",
    ]);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("imports approval-gated OpenClaw/Codex patch responses", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = parseSnesAgentPatchProposalResponse(
      JSON.stringify({
        summary: "Rename and retheme the starter cart.",
        rationale: ["Kept the patch inside approved project fields."],
        operations: [
          { op: "replace", path: "/name", value: "Crystal Signal" },
          { op: "replace", path: "/export/romBaseName", value: "crystal-signal" },
          {
            op: "replace",
            path: "/scenes/0/entities",
            value: [
              {
                id: "player",
                kind: "player",
                name: "Player Start",
                x: 32,
                y: 176,
                metaspriteTiles: 8,
              },
              {
                id: "npc-1",
                kind: "npc",
                name: "Signal Guide",
                x: 96,
                y: 176,
                metaspriteTiles: 8,
              },
            ],
          },
        ],
      }),
      project,
    );

    expect(proposal.source).toBe("openclaw-codex");
    expect(proposal.approvalRequired).toBe(true);
    expect(proposal.previewProject.name).toBe("Crystal Signal");
    expect(proposal.previewProject.profile.fxpak.fileSystem).toBe("fat32");
    expect(proposal.readiness.status).toBe("ready");
    expect(proposal.rationale).toContain("Kept the patch inside approved project fields.");
  });

  it("rejects unsafe OpenClaw/Codex patch paths", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");

    expect(() =>
      parseSnesAgentPatchProposalResponse(
        JSON.stringify({
          operations: [{ op: "replace", path: "/profile/sramSizeKib", value: 0 }],
        }),
        project,
      ),
    ).toThrow(/Unsupported SNES Studio patch path/);
  });

  it("applies approved SNES JSON patches while preserving FXPAK safety", () => {
    const baseProject = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    baseProject.profile.fxpak.fileSystem = "exfat";
    const proposal = createSnesAgentPatchProposal('Create "Castle Key Quest"', baseProject);
    const approved = applySnesJsonPatch(
      baseProject,
      proposal.operations,
      "2026-05-19T01:00:00.000Z",
    );

    expect(approved.name).toBe("Castle Key Quest");
    expect(approved.profile.fxpak.fileSystem).toBe("fat32");
    expect(approved.profile.fxpak.preserveExistingSaves).toBe(true);
    expect(approved.updatedAt).toBe("2026-05-19T01:00:00.000Z");
    expect(validateSnesStudioProject(approved).some((issue) => issue.severity === "error")).toBe(
      false,
    );
  });

  it("creates an emulator boot plan only after an emulator is available", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));

    const blocked = createSnesEmulatorBootPlan(rom);
    const ready = createSnesEmulatorBootPlan(rom, ["ares"]);

    expect(blocked.status).toBe("blocked");
    expect(blocked.command).toEqual([]);
    expect(blocked.screenshotFileName).toBe("moonlit-ridge.boot.png");
    expect(ready.status).toBe("ready");
    expect(ready.selectedEmulator).toBe("ares");
    expect(ready.command).toEqual([
      "ares",
      "--fullscreen=false",
      "--screenshot",
      "moonlit-ridge.boot.png",
      "moonlit-ridge.sfc",
    ]);
  });

  it("records emulator boot proof only with exit and screenshot evidence", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));

    const blocked = createSnesEmulatorBootProof(rom);
    const ready = createSnesEmulatorBootProof(rom, ["snes9x"]);
    const failed = createSnesEmulatorBootProof(rom, ["snes9x"], {
      elapsedMs: 1200,
      exitCode: 0,
      screenshotBytes: new Uint8Array(),
      stderr: "",
      stdout: "booted",
    });
    const verified = createSnesEmulatorBootProof(rom, ["snes9x"], {
      elapsedMs: 1200,
      exitCode: 0,
      screenshotBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      stderr: "",
      stdout: "booted",
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers).toContain(
      "No supported SNES emulator was detected for boot/screenshot validation.",
    );
    expect(ready.status).toBe("ready-to-run");
    expect(ready.evidence.command).toEqual([
      "snes9x",
      "-snapshot",
      "moonlit-ridge.boot.png",
      "moonlit-ridge.sfc",
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.checks).toContainEqual(
      expect.objectContaining({ code: "SCREENSHOT_BYTES", passed: false }),
    );
    expect(verified.status).toBe("verified");
    expect(verified.checks.every((check) => check.passed)).toBe(true);
    expect(verified.evidence).toEqual(
      expect.objectContaining({
        emulator: "snes9x",
        exitCode: 0,
        screenshotBytes: 4,
        screenshotFileName: "moonlit-ridge.boot.png",
      }),
    );
  });

  it("compares emulator screenshots before boot proof can be accepted", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));
    const blank = new Uint8Array([0, 0, 0, 0]);
    const captured = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const capturedProof = createSnesEmulatorScreenshotComparison(rom, captured);
    const matchedBaseline = createSnesEmulatorScreenshotComparison(rom, captured, {
      expectedChecksum: capturedProof.checksum,
    });
    const mismatchedBaseline = createSnesEmulatorScreenshotComparison(rom, captured, {
      expectedChecksum: (capturedProof.checksum + 1) & 0xffff,
    });

    expect(createSnesEmulatorScreenshotComparison(rom, null).status).toBe("blocked");
    expect(createSnesEmulatorScreenshotComparison(rom, blank).status).toBe("mismatch");
    expect(capturedProof.status).toBe("verified");
    expect(capturedProof.screenshotFileName).toBe("moonlit-ridge.boot.png");
    expect(capturedProof.checks).toContainEqual(
      expect.objectContaining({ code: "NONBLANK_FRAME", passed: true }),
    );
    expect(matchedBaseline.status).toBe("verified");
    expect(mismatchedBaseline.status).toBe("mismatch");
    expect(mismatchedBaseline.checks).toContainEqual(
      expect.objectContaining({ code: "EXPECTED_CHECKSUM", passed: false }),
    );
  });

  it("serializes, reads, and validates SRAM slot data", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const image = createSnesSramImage(project);
    const report = createSnesSramSerializationReport(project);
    const written = writeSnesSaveSlot(project, image, 1, {
      bosscleared: true,
      checkpoint: 12,
      coins: 345,
    });

    expect(validateSnesSramImage(project, written).valid).toBe(true);
    expect(readSnesSaveSlot(project, written, 1)).toEqual({
      bosscleared: true,
      checkpoint: 12,
      coins: 345,
    });
    expect(Array.from(written.slice(0, 4))).toEqual([0x4f, 0x43, 0x53, 0x56]);
    expect(report.status).toBe("ready");
    expect(report.headerChecksumHex).toMatch(/^\$[0-9A-F]{4}$/);
    expect(report.sramBaseAddressHex).toBe("$700000");
    expect(report.fields.map((field) => [field.key, field.offset, field.sizeBytes])).toEqual([
      ["checkpoint", 0, 2],
      ["coins", 2, 2],
      ["bosscleared", 4, 1],
    ]);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it("verifies SRAM power-cycle preservation from before and after images", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const before = writeSnesSaveSlot(project, createSnesSramImage(project), 0, {
      bosscleared: true,
      checkpoint: 7,
      coins: 42,
    });
    const after = new Uint8Array(before);
    const corrupted = new Uint8Array(before);
    corrupted[20] ^= 0xff;

    const verified = createSnesSramPowerCycleProof(project, before, after, 0);
    const blocked = createSnesSramPowerCycleProof(project, before, null, 0);
    const mismatch = createSnesSramPowerCycleProof(project, before, corrupted, 0);

    expect(verified.status).toBe("verified");
    expect(verified.beforeValues).toEqual({
      bosscleared: true,
      checkpoint: 7,
      coins: 42,
    });
    expect(verified.afterValues).toEqual(verified.beforeValues);
    expect(verified.checks.every((check) => check.passed)).toBe(true);
    expect(blocked.status).toBe("blocked");
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ code: "AFTER_IMAGE", passed: false }),
    );
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.checks).toContainEqual(
      expect.objectContaining({ code: "BYTE_MATCH", passed: false }),
    );
  });

  it("runs an injected OpenClaw/Codex dispatch executor through the approval contract", async () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const record = createSnesAgentDispatchRecord(
      project,
      "Rename the project to Signal Ridge.",
      "2026-05-19T05:00:00.000Z",
      "openclaw",
      "full-game",
    );

    const result = await runSnesAgentDispatchRecord(record, project, () =>
      JSON.stringify({
        summary: "Rename from the live runner.",
        operations: [
          { op: "replace", path: "/name", value: "Signal Ridge" },
          { op: "replace", path: "/export/romBaseName", value: "signal-ridge" },
        ],
      }),
    );

    expect(result.status).toBe("proposal-ready");
    expect(result.recordId).toBe(record.id);
    expect(result.proposal.source).toBe("openclaw-agent");
    expect(result.proposal.requestedAgent).toBe("openclaw");
    expect(result.appliedProjectPreview.name).toBe("Signal Ridge");
    expect(result.staticRomValidation?.valid).toBe(true);
  });

  it("runs the local dashboard agent executor through the same patch approval contract", async () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const record = createSnesAgentDispatchRecord(
      project,
      'Create "Signal Ridge" with gems and robots.',
      "2026-05-19T05:10:00.000Z",
      "codex",
      "full-game",
    );

    const result = await runSnesAgentDispatchRecord(record, project, (queuedRecord) =>
      createSnesLocalAgentPatchResponse(queuedRecord, project),
    );

    expect(result.status).toBe("proposal-ready");
    expect(result.proposal.source).toBe("openclaw-codex");
    expect(result.proposal.operations.length).toBeGreaterThan(0);
    expect(result.appliedProjectPreview.name).toBe("Signal Ridge");
    expect(result.staticRomValidation?.valid).toBe(true);
  });

  it("plans level transitions, runtime events, collision materials, and local persistence", () => {
    let project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project = addSnesProjectScene(project, "Sky Dock");
    project.scenes[0].collisionMap[0] = 2;
    project.scenes[1].collisionMap[1] = 3;
    project.events = [
      {
        id: "grant-key",
        name: "Grant key on start",
        trigger: "on-start",
        targetId: "scene",
        actions: [
          { type: "give-item", itemId: "keycard" },
          { type: "set-flag", flag: "opened_gate" },
          { type: "show-dialogue", cutsceneId: "intro" },
        ],
      },
    ];

    const transitionPlan = createSnesLevelTransitionPlan(project);
    const eventPlan = createSnesRuntimeEventPlan(project);
    const eventBytecode = compileSnesRuntimeEventBytecode(project);
    const eventBytecodeExecution = executeSnesRuntimeEventBytecode(project, "on-start");
    const levelLoaderTable = createSnesRomLevelLoaderTable(project);
    const levelLoaderExecution = executeSnesRomLevelLoaderTable(project, "ridge-1");
    const collisionPlan = createSnesCollisionPhysicsPlan(project);
    const persistencePlan = createSnesProjectPersistencePlan();
    const manifest = JSON.parse(buildSnesPreviewRom(project).manifestJson) as {
      eventBytecode: ReturnType<typeof compileSnesRuntimeEventBytecode>;
      events: ReturnType<typeof createSnesRuntimeEventPlan>;
      persistence: ReturnType<typeof createSnesProjectPersistencePlan>;
      runtime: { collisionPhysics: ReturnType<typeof createSnesCollisionPhysicsPlan> };
      scene: {
        levelLoaderTable: ReturnType<typeof createSnesRomLevelLoaderTable>;
        transitionPlan: ReturnType<typeof createSnesLevelTransitionPlan>;
      };
    };

    expect(transitionPlan).toEqual(
      expect.objectContaining({
        runtimeStatus: "blocked-until-scene-loader",
        status: "manifest-ready",
        transitions: [
          expect.objectContaining({
            fromSceneId: "ridge-1",
            toSceneName: "Sky Dock",
            trigger: "right-edge",
          }),
        ],
      }),
    );
    expect(eventPlan.events[0]).toEqual(
      expect.objectContaining({
        actionCount: 3,
        actions: ["give-item:keycard", "set-flag:opened_gate", "show-dialogue:intro"],
        id: "grant-key",
      }),
    );
    expect(eventBytecode).toEqual(
      expect.objectContaining({
        actionCount: 3,
        eventCount: 1,
        runtimeStatus: "blocked-until-65816-vm",
        status: "compiled",
      }),
    );
    expect(eventBytecode.bytecodeHex.startsWith("4f434556")).toBe(true);
    expect(eventBytecodeExecution).toEqual(
      expect.objectContaining({
        decodedEventCount: 1,
        grantedItemIds: ["keycard"],
        runtimeStatus: "bytecode-interpreter-tested",
        shownCutsceneIds: ["intro"],
        status: "verified",
        triggeredEventIds: ["grant-key"],
        flags: ["opened_gate"],
      }),
    );
    expect(levelLoaderTable).toEqual(
      expect.objectContaining({
        sceneCount: 2,
        runtimeStatus: "data-embedded-loader-blocked",
        status: "compiled",
      }),
    );
    expect(levelLoaderTable.bytecodeHex.startsWith("4f434c56")).toBe(true);
    expect(levelLoaderExecution).toEqual(
      expect.objectContaining({
        fromSceneId: "ridge-1",
        runtimeStatus: "loader-table-tested",
        status: "verified",
        toSceneId: project.scenes[1].id,
        trigger: "right-edge",
      }),
    );
    expect(levelLoaderExecution.selectedEntry).toEqual(
      expect.objectContaining({
        id: project.scenes[1].id,
        collisionMapChecksum: levelLoaderTable.entries[1].collisionMapChecksum,
        tilemapChecksum: levelLoaderTable.entries[1].tilemapChecksum,
      }),
    );
    expect(collisionPlan.materials.find((material) => material.id === "solid")?.cellCount).toBe(
      project.scenes.reduce(
        (sum, scene) => sum + scene.collisionMap.filter((cell) => cell === 1).length,
        0,
      ),
    );
    expect(collisionPlan.materials.find((material) => material.id === "hazard")).toEqual(
      expect.objectContaining({
        cellCount: 1,
        productionRuntimeStatus: "blocked",
      }),
    );
    expect(collisionPlan.materials.find((material) => material.id === "one-way")).toEqual(
      expect.objectContaining({
        cellCount: 1,
        productionRuntimeStatus: "blocked",
      }),
    );
    expect(persistencePlan.portableFormats.map((format) => format.extension)).toEqual([
      ".oc-snes.json",
      ".oc-snes-bundle.json",
    ]);
    expect(manifest.scene.transitionPlan).toEqual(transitionPlan);
    expect(manifest.scene.levelLoaderTable).toEqual(levelLoaderTable);
    expect(manifest.events).toEqual(eventPlan);
    expect(manifest.eventBytecode).toEqual(eventBytecode);
    expect(manifest.runtime.collisionPhysics).toEqual(collisionPlan);
    expect(manifest.persistence).toEqual(persistencePlan);
  });

  it("creates an SPC700 export plan with BRR sample-pool evidence", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const plan = createSnesSpc700ExportPlan(project);
    const playbackProgram = compileSnesSpc700PlaybackProgram(project);

    expect(plan.status).toBe("manifest-ready");
    expect(plan.aramMap.map((entry) => entry.name)).toEqual([
      "SPC700 driver reserve",
      "Music pattern data",
      "Sound effect sequences",
      "BRR/sample pool",
    ]);
    expect(plan.brrSilenceBlockHex).toBe("010000000000000000");
    expect(plan.blockers.join("\n")).toContain("not linked");
    expect(playbackProgram).toEqual(
      expect.objectContaining({
        brrSilenceBlockHex: "010000000000000000",
        commandStreamHex: expect.stringMatching(/^4f435350/u),
        driver: "preview-spc700",
        runtimeStatus: "playback-stream-tested",
        soundEffectCount: project.assets.audio.soundEffects.length,
        status: "compiled",
        trackCount: project.assets.audio.musicTracks.length,
      }),
    );
    expect(playbackProgram.commands.map((command) => command.kind)).toEqual([
      "music",
      "sound-effect",
      "sound-effect",
      "sound-effect",
      "brr-silence",
    ]);
  });

  it("simulates the preview game loop for movement, jump, and item collection", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].entities = [
      { id: "player", kind: "player", name: "Player Start", x: 32, y: 176, metaspriteTiles: 8 },
      { id: "item-1", kind: "item", name: "Moon Coin", x: 33, y: 176, metaspriteTiles: 2 },
    ];

    const moved = simulateSnesPreviewFrame(project, null, { right: true });
    const jumped = simulateSnesPreviewFrame(project, moved, { jump: true });

    expect(moved.playerX).toBe(33);
    expect(moved.cameraScrollX).toBe(0);
    expect(moved.frame).toBe(1);
    expect(jumped.grounded).toBe(false);
    expect(jumped.playerY).toBeLessThan(176);
    expect(jumped.collectedItems).toContain("item-1");
  });

  it("compiles a 60 Hz runtime contract and verifies deterministic browser replay", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const runtime = compileSnesRuntimeProject(project);
    const first = stepSnesRuntimeFrame(runtime, null, { right: true });
    const second = stepSnesRuntimeFrame(runtime, first, { jump: true });
    const replay = runSnesRuntimeReplay(runtime, {
      runtimeHash: runtime.manifest.runtimeHash,
      inputs: [{ right: true }, { jump: true }, { right: true }],
    });

    expect(runtime.frameRate).toBe(60.0988);
    expect(runtime.frameTimeMs).toBeCloseTo(1000 / 60.0988, 4);
    expect(runtime.viewport).toEqual({ width: 256, height: 224 });
    expect(runtime.fixedPointScale).toBe(256);
    expect(runtime.scenes[0]?.entities.find((entity) => entity.role === "hero")?.x).toBe(32);
    expect(first.frame).toBe(1);
    expect(second.frame).toBe(2);
    expect(second.grounded).toBe(false);
    expect(replay.status).toBe("verified");
    expect(replay.runtimeStatus).toBe("browser-runtime-verified");
    expect(replay.runtimeHash).toBe(runtime.manifest.runtimeHash);
    expect(replay.blockers).toContain(
      "Emulator WRAM/state-dump comparison is still required before ROM parity is verified.",
    );
  });

  it("creates emulator replay parity proof from runtime replay and state dump evidence", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const runtime = compileSnesRuntimeProject(project);
    const rom = buildSnesPreviewRom(project);
    const replay = {
      runtimeHash: runtime.manifest.runtimeHash,
      inputs: [{ right: true }, { right: true }, { jump: true }, { right: true }],
    };
    const browserReplay = runSnesRuntimeReplay(runtime, replay);
    const blocked = createSnesEmulatorReplayParityProof(rom, runtime, replay);
    const ready = createSnesEmulatorReplayParityProof(rom, runtime, replay, ["snes9x"]);
    const verified = createSnesEmulatorReplayParityProof(rom, runtime, replay, ["snes9x"], {
      emulatorExecution: {
        elapsedMs: 1600,
        exitCode: 0,
        screenshotBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]),
        stderr: "",
        stdout: "booted replay",
      },
      emulatorStateDump: {
        browserReplayChecksum: browserReplay.browserReplayChecksum,
        capturedAt: "2026-05-19T00:01:00.000Z",
        finalStateHash: browserReplay.finalStateHash,
        frameCount: browserReplay.frameCount,
        runtimeHash: browserReplay.runtimeHash,
        source: "snes9x-debug-state",
      },
    });
    const mismatch = createSnesEmulatorReplayParityProof(rom, runtime, replay, ["snes9x"], {
      emulatorExecution: {
        elapsedMs: 1600,
        exitCode: 0,
        screenshotBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]),
        stderr: "",
        stdout: "booted replay",
      },
      emulatorStateDump: {
        browserReplayChecksum: browserReplay.browserReplayChecksum,
        capturedAt: "2026-05-19T00:01:00.000Z",
        finalStateHash: "ffff",
        frameCount: browserReplay.frameCount,
        runtimeHash: browserReplay.runtimeHash,
        source: "snes9x-debug-state",
      },
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ code: "EMULATOR_AVAILABLE", passed: false }),
    );
    expect(ready.status).toBe("ready-to-run");
    expect(ready.evidence.command).toEqual([
      "snes9x",
      "-snapshot",
      "moonlit-ridge.boot.png",
      "moonlit-ridge.sfc",
    ]);
    expect(verified.status).toBe("verified");
    expect(verified.blockers).toEqual([]);
    expect(verified.checks).toContainEqual(
      expect.objectContaining({ code: "STATE_HASH", passed: true }),
    );
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.checks).toContainEqual(
      expect.objectContaining({ code: "STATE_HASH", passed: false }),
    );
  });

  it("creates an emulator replay run script tied to the exported runtime hash", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const runtime = compileSnesRuntimeProject(project);
    const rom = buildSnesPreviewRom(project);
    const replay = {
      runtimeHash: runtime.manifest.runtimeHash,
      inputs: [{ right: true }, { jump: true }, { right: true }],
    };
    const blocked = createSnesEmulatorReplayRunPack(rom, runtime, replay);
    const ready = createSnesEmulatorReplayRunPack(rom, runtime, replay, ["snes9x"]);

    expect(blocked.status).toBe("blocked");
    expect(blocked.scriptText).toContain("emulator proof is blocked");
    expect(ready.status).toBe("ready");
    expect(ready.selectedEmulator).toBe("snes9x");
    expect(ready.command).toEqual([
      "snes9x",
      "-snapshot",
      "moonlit-ridge.boot.png",
      "moonlit-ridge.sfc",
    ]);
    expect(ready.proofFileName).toBe("moonlit-ridge.emulator-proof.json");
    expect(ready.scriptFileName).toBe("moonlit-ridge.run-emulator-proof.sh");
    expect(ready.scriptText).toContain(`Expected runtime hash: ${runtime.manifest.runtimeHash}`);
    expect(ready.scriptText).toContain(
      `Expected final state hash: ${ready.expectedFinalStateHash}`,
    );
    expect(ready.scriptText).toContain("snes9x -snapshot moonlit-ridge.boot.png moonlit-ridge.sfc");
  });

  it("creates deterministic collision parity proof until emulator state comparison exists", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].collisionMap[0] = 2;
    project.scenes[0].collisionMap[1] = 4;

    const report = createSnesCollisionParityReport(project, [
      { right: true },
      { jump: true },
      { right: true },
    ]);

    expect(report.status).toBe("verified");
    expect(report.runtimeStatus).toBe("blocked-until-emulator-state-dump");
    expect(report.frameCount).toBe(3);
    expect(report.deterministic).toBe(true);
    expect(report.materialCounts.hazard).toBe(1);
    expect(report.materialCounts.water).toBe(1);
    expect(report.finalStateChecksum).toBeGreaterThan(0);
    expect(report.blockers).toContain(
      "Emulator WRAM/state-dump comparison is still required before ROM collision parity is verified.",
    );
  });

  it("plans scanline OAM pressure before hardware sprite stress testing", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].entities = Array.from({ length: 20 }, (_, index) => ({
      id: `enemy-${index}`,
      kind: "enemy" as const,
      metaspriteTiles: 4,
      name: `Enemy ${index}`,
      x: 16 + index,
      y: 80,
    }));

    const plan = createSnesScanlineOamPlan(project);

    expect(plan.status).toBe("blocked");
    expect(plan.spriteEntryLimit).toBe(32);
    expect(plan.spriteSliverLimit).toBe(34);
    expect(plan.worstSpriteEntries).toBeGreaterThan(32);
    expect(plan.scanlines.some((scanline) => scanline.status === "blocked")).toBe(true);
  });

  it("applies editable player physics to preview simulation and ROM metadata", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.physics = {
      moveSpeed: 3,
      jumpVelocity: -12,
      gravityPerFrame: 2,
      maxFallSpeed: 9,
      groundY: 180,
    };

    const moved = simulateSnesPreviewFrame(project, null, { right: true });
    const jumped = simulateSnesPreviewFrame(project, null, { jump: true });
    const physics = createSnesCollisionPhysicsPlan(project).physics;
    const manifest = JSON.parse(buildSnesPreviewRom(project).manifestJson) as {
      runtime: {
        playerStart: { moveSpeed: number; jumpVelocity: number; gravityPerFrame: number };
      };
    };

    expect(moved.playerX).toBe(35);
    expect(jumped.playerY).toBe(166);
    expect(physics).toEqual(
      expect.objectContaining({ gravityPerFrame: 2, groundY: 180, jumpVelocity: -12 }),
    );
    expect(manifest.runtime.playerStart).toEqual(
      expect.objectContaining({ gravityPerFrame: 2, jumpVelocity: -12, moveSpeed: 3 }),
    );
  });

  it("simulates enemy patrol positions and enemy collision state", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].entities = [
      { id: "enemy-1", kind: "enemy", name: "Patrol Bot", x: 121, y: 184, metaspriteTiles: 8 },
    ];

    const frame = simulateSnesPreviewFrame(project, null, { right: true });
    const nextFrame = simulateSnesPreviewFrame(project, frame, { right: true });

    expect(frame.enemyPositions["enemy-1"]).toEqual(
      expect.objectContaining({ direction: 1, x: 122, y: 184 }),
    );
    expect(nextFrame.enemyPositions["enemy-1"]?.x).toBe(123);
    expect(frame.collisions).toContain("enemy-1");
  });

  it("normalizes editable enemy behaviors and simulates chase movement", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].entities = [
      { id: "player", kind: "player", name: "Player Start", x: 121, y: 176, metaspriteTiles: 8 },
      {
        id: "enemy-1",
        kind: "enemy",
        name: "Chase Bot",
        x: 170,
        y: 184,
        metaspriteTiles: 8,
        behavior: {
          kind: "chase",
          speed: 3,
          patrolStartX: 100,
          patrolEndX: 200,
          aggroRange: 96,
          guardDirection: 1,
        },
      },
    ];

    const frame = simulateSnesPreviewFrame(project, null, {});
    const rom = buildSnesPreviewRom(project);
    const runtimeJsonSize =
      rom.bytes[rom.runtimeDataOffset + 0x0a] |
      (rom.bytes[rom.runtimeDataOffset + 0x0b] << 8) |
      (rom.bytes[rom.runtimeDataOffset + 0x0c] << 16) |
      (rom.bytes[rom.runtimeDataOffset + 0x0d] << 24);
    const embeddedProject = JSON.parse(
      new TextDecoder().decode(
        rom.bytes.slice(rom.runtimeDataOffset + 16, rom.runtimeDataOffset + 16 + runtimeJsonSize),
      ),
    ) as { scenes: Array<{ entities: Array<{ behavior?: unknown }> }> };

    expect(frame.enemyPositions["enemy-1"]).toEqual(
      expect.objectContaining({ direction: -1, x: 167, y: 184 }),
    );
    expect(embeddedProject.scenes[0]?.entities[1]?.behavior).toEqual(
      expect.objectContaining({ kind: "chase", speed: 3, aggroRange: 96 }),
    );
  });

  it("simulates advanced collision materials for hazards and one-way platforms", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.scenes[0].entities = [
      { id: "player", kind: "player", name: "Player Start", x: 112, y: 176, metaspriteTiles: 8 },
    ];
    project.scenes[0].collisionMap = Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, () => 0);
    project.scenes[0].collisionMap[11 * SNES_STUDIO_EDIT_GRID.width + 7] = 2;
    const hazard = simulateSnesPreviewFrame(project, null, {});
    project.scenes[0].collisionMap[11 * SNES_STUDIO_EDIT_GRID.width + 7] = 3;
    const oneWay = simulateSnesPreviewFrame(project, null, {});

    expect(hazard.collisions).toContain("hazard");
    expect(oneWay.collisions).toContain("ground");
  });

  it("paints rectangle fills for professional level editing", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const painted = paintSnesSceneRect(project, 0, 0, 0, 3, 2, 2, true);
    const scene = painted.scenes[0];

    expect(scene.tilemap.slice(0, 3)).toEqual([2, 2, 2]);
    expect(scene.tilemap.slice(16, 19)).toEqual([2, 2, 2]);
    expect(scene.collisionMap.slice(0, 3)).toEqual([1, 1, 1]);
    expect(scene.collisionTiles).toBe(77);
  });

  it("manages multiple editable levels and draggable entity coordinates", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const withLevel = addSnesProjectScene(project, "Boss Gate", "2026-05-19T07:00:00.000Z");
    const duplicated = duplicateSnesProjectScene(withLevel, 1, "2026-05-19T07:05:00.000Z");
    const moved = moveSnesSceneEntity(duplicated, 1, "player", 144, 96, "2026-05-19T07:10:00.000Z");
    const removed = removeSnesProjectScene(moved, 2, "2026-05-19T07:15:00.000Z");

    expect(withLevel.scenes.map((scene) => scene.name)).toEqual(["Ridge 1-1", "Boss Gate"]);
    expect(duplicated.scenes).toHaveLength(3);
    expect(moved.scenes[1]?.entities.find((entity) => entity.id === "player")).toEqual(
      expect.objectContaining({ x: 144, y: 96 }),
    );
    expect(removed.scenes.map((scene) => scene.name)).toEqual(["Ridge 1-1", "Boss Gate"]);
    expect(() => removeSnesProjectScene(createDefaultSnesStudioProject(), 0)).toThrow(
      /at least one scene/,
    );
  });

  it("embeds every editable level in the ROM scene runtime table", () => {
    const project = addSnesProjectScene(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
      "Boss Gate",
      "2026-05-19T07:00:00.000Z",
    );
    const table = createSnesSceneRuntimeTable(project);
    const rom = buildSnesPreviewRom(project);
    const manifest = JSON.parse(rom.manifestJson) as {
      scene: { runtimeTable: typeof table };
    };

    expect(table).toHaveLength(2);
    expect(table.map((entry) => entry.id)).toEqual(["ridge-1", "boss-gate-2"]);
    expect(table[0]?.compiledPreviewTarget).toBe(true);
    expect(table[1]?.compiledPreviewTarget).toBe(false);
    expect(manifest.scene.runtimeTable).toEqual(table);
    expect(validateSnesPreviewRomArtifact(rom).checks).toContainEqual(
      expect.objectContaining({ code: "SCENE_RUNTIME_TABLE", passed: true }),
    );
  });

  it("persists custom metatile brushes into project JSON and ROM manifests", () => {
    const project = addSnesCustomTileBrush(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
      { name: "Spike Hazard", tile: 4, solid: true },
      "2026-05-19T07:20:00.000Z",
    );
    const manifest = JSON.parse(buildSnesPreviewRom(project).manifestJson) as {
      assets: { customTileBrushes: Array<{ name: string; solid: boolean; tile: number }> };
    };

    expect(project.assets.customTileBrushes).toContainEqual(
      expect.objectContaining({ name: "Spike Hazard", solid: true, tile: 4 }),
    );
    expect(stableProjectJson(project)).toContain('"customTileBrushes"');
    expect(manifest.assets.customTileBrushes).toContainEqual(
      expect.objectContaining({ name: "Spike Hazard", solid: true, tile: 4 }),
    );
  });

  it("normalizes editable sprite animations for the dashboard and ROM manifest", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.animations = [
      {
        id: "enemy-patrol",
        name: "Enemy Patrol",
        entityKind: "enemy",
        loop: true,
        frames: [{ id: "walk-1", durationTicks: 0, tileIndex: 999, xOffset: -999, yOffset: 999 }],
      },
    ];
    const normalized = JSON.parse(stableProjectJson(project)) as {
      animations: typeof project.animations;
    };
    const rom = buildSnesPreviewRom(project);
    const manifest = JSON.parse(rom.manifestJson) as { project: { animationCount: number } };

    expect(normalized.animations[0]?.frames[0]).toEqual(
      expect.objectContaining({
        durationTicks: 1,
        tileIndex: 255,
        xOffset: -128,
        yOffset: 127,
      }),
    );
    expect(manifest.project.animationCount).toBe(1);
  });

  it("validates dialogue, cutscene, and no-code event script references", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.dialogue = [
      {
        id: "gate-warning",
        name: "Gate Warning",
        trigger: "boss-gate",
        lines: [{ id: "line-1", speaker: "Guide", text: "Bring the key to the ridge gate." }],
      },
    ];
    project.events = [
      {
        id: "gate-event",
        name: "Show gate warning",
        trigger: "on-enter-zone",
        targetId: "npc-1",
        actions: [{ type: "show-dialogue", cutsceneId: "gate-warning" }],
      },
    ];

    expect(
      validateSnesStudioProject(project).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    project.events[0].actions = [{ type: "show-dialogue", cutsceneId: "missing" }];
    expect(validateSnesStudioProject(project)).toContainEqual(
      expect.objectContaining({ code: "EVENT_DIALOGUE_TARGET", severity: "error" }),
    );
  });

  it("builds a cutscene timeline with timing and event links", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const timeline = createSnesCutsceneTimeline(project);
    const manifest = JSON.parse(buildSnesPreviewRom(project).manifestJson) as {
      cutscenes: { lineCount: number; totalDurationTicks: number };
    };

    expect(timeline.status).toBe("ready");
    expect(timeline.steps[0]).toEqual(
      expect.objectContaining({
        cutsceneId: "intro",
        linkedEventIds: ["intro-event"],
        speaker: "Guide",
      }),
    );
    expect(timeline.totalDurationTicks).toBeGreaterThanOrEqual(90);
    expect(manifest.cutscenes.lineCount).toBe(timeline.lineCount);
    expect(manifest.cutscenes.totalDurationTicks).toBe(timeline.totalDurationTicks);
  });

  it("simulates no-code event script runtime actions for previews", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    project.events = [
      {
        id: "intro-event",
        name: "Intro",
        trigger: "on-start",
        targetId: "scene",
        actions: [
          { type: "show-dialogue", cutsceneId: "intro" },
          { type: "give-item", itemId: "debug-key" },
          { type: "set-flag", flag: "intro_seen" },
        ],
      },
    ];

    const result = simulateSnesEventScripts(project, "on-start", "scene");

    expect(result.triggeredEventIds).toEqual(["intro-event"]);
    expect(result.shownCutsceneIds).toEqual(["intro"]);
    expect(result.grantedItemIds).toEqual(["debug-key"]);
    expect(result.flags).toEqual(["intro_seen"]);
    expect(result.warnings).toEqual([]);
  });

  it("imports durable project JSON and bundle documents", () => {
    const project = addSnesProjectScene(
      createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"),
      "Second Level",
      "2026-05-19T07:25:00.000Z",
    );
    const version = createSnesProjectVersion(project, "Before import", "2026-05-19T07:30:00.000Z");
    const bundle = createSnesProjectBundle(project, [version], "2026-05-19T07:35:00.000Z");
    const parsedBundle = parseSnesProjectDocument(JSON.stringify(bundle));
    const parsedProject = parseSnesProjectDocument(stableProjectJson(project));

    expect(parsedBundle.project.scenes).toHaveLength(2);
    expect(parsedBundle.versions[0]?.reason).toBe("Before import");
    expect(parsedProject.project.scenes).toHaveLength(2);
    expect(parsedProject.versions).toEqual([]);
  });

  it("creates before-and-after diffs for approval-gated agent patches", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createSnesAgentPatchProposalForSurface(
      "items",
      "Create many gems and a key.",
      project,
      "codex",
    );
    const diffs = diffSnesAgentPatchProposal(project, proposal);

    expect(diffs).toContainEqual(
      expect.objectContaining({
        path: "/scenes/0/entities",
        before: expect.any(Array),
        after: expect.any(Array),
      }),
    );
  });

  it("verifies FXPAK copy bytes before hardware launch", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));
    const fxpakPackage = createSnesFxpakExportPackage(rom);
    const proof = createSnesFxpakCopyProof(fxpakPackage, rom.bytes, new Uint8Array(rom.bytes));
    const corrupted = new Uint8Array(rom.bytes);
    corrupted[0] ^= 0xff;

    expect(proof.status).toBe("verified");
    expect(proof.destinationPath).toBe("/SNES/OpenClaw/moonlit-ridge.sfc");
    expect(proof.byteContentMatched).toBe(true);
    expect(createSnesFxpakCopyProof(fxpakPackage, rom.bytes, corrupted).status).toBe("mismatch");
  });

  it("validates mounted FXPAK PRO export requirements before copy", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));
    const fxpakPackage = createSnesFxpakExportPackage(rom);

    const ready = createSnesFxpakMountedExportValidation(fxpakPackage, {
      cardSizeGb: 128,
      existingSavePresent: true,
      fileSystem: "FAT32",
      freeBytes: rom.bytes.byteLength * 2,
      mounted: true,
      volumePath: "/Volumes/FXPAK",
    });
    const blocked = createSnesFxpakMountedExportValidation(fxpakPackage, {
      cardSizeGb: 64,
      existingSavePresent: true,
      fileSystem: "exFAT",
      freeBytes: 10,
      mounted: true,
      volumePath: "/Volumes/FXPAK",
    });

    expect(ready.status).toBe("ready");
    expect(ready.destinationRomPath).toBe("/Volumes/FXPAK/SNES/OpenClaw/moonlit-ridge.sfc");
    expect(ready.destinationSavePath).toBe("/Volumes/FXPAK/sd2snes/saves/moonlit-ridge.srm");
    expect(ready.checks.every((check) => check.passed)).toBe(true);
    expect(blocked.status).toBe("blocked");
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ code: "FAT32", passed: false }),
    );
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ code: "CARD_SIZE", passed: false }),
    );
    expect(blocked.checks).toContainEqual(
      expect.objectContaining({ code: "FREE_SPACE", passed: false }),
    );
  });

  it("selects a valid FXPAK volume and creates a dry-run copy manifest", () => {
    const rom = buildSnesPreviewRom(createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z"));
    const fxpakPackage = createSnesFxpakExportPackage(rom);
    const invalidVolume = {
      cardSizeGb: 64,
      existingSavePresent: true,
      fileSystem: "exFAT" as const,
      freeBytes: 10,
      mounted: true,
      volumePath: "/Volumes/WRONG",
    };
    const validVolume = {
      cardSizeGb: 128,
      existingSavePresent: true,
      fileSystem: "FAT32" as const,
      freeBytes: rom.bytes.byteLength * 2,
      mounted: true,
      volumePath: "/Volumes/FXPAK",
    };
    const selection = selectSnesFxpakMountedVolume(fxpakPackage, [invalidVolume, validVolume]);
    const dryRun = createSnesFxpakCopyDryRun(fxpakPackage, validVolume);
    const blockedDryRun = createSnesFxpakCopyDryRun(fxpakPackage, invalidVolume);

    expect(selection.status).toBe("ready");
    expect(selection.selectedVolume?.volumePath).toBe("/Volumes/FXPAK");
    expect(selection.checks).toContainEqual(
      expect.objectContaining({ volumePath: "/Volumes/WRONG", status: "blocked" }),
    );
    expect(selectSnesFxpakMountedVolume(fxpakPackage, []).status).toBe("blocked");
    expect(dryRun.status).toBe("ready");
    expect(dryRun.destinationRoot).toBe("/Volumes/FXPAK");
    expect(dryRun.requiredDirectories).toEqual([
      "/Volumes/FXPAK/SNES/OpenClaw",
      "/Volumes/FXPAK/sd2snes/saves",
    ]);
    expect(dryRun.operations).toEqual([
      expect.objectContaining({
        action: "copy-rom",
        destinationPath: "/Volumes/FXPAK/SNES/OpenClaw/moonlit-ridge.sfc",
        kind: "rom",
      }),
      expect.objectContaining({
        action: "preserve-existing-sram",
        destinationPath: "/Volumes/FXPAK/sd2snes/saves/moonlit-ridge.srm",
        kind: "sram",
      }),
    ]);
    expect(dryRun.warnings.join("\n")).toContain("Preserve existing SRAM");
    expect(blockedDryRun.status).toBe("blocked");
    expect(blockedDryRun.blockers.length).toBeGreaterThan(0);
  });

  it("exports a hardware QA bundle with emulator, FXPAK, and SRAM proof gates", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const rom = buildSnesPreviewRom(project);
    const runtime = compileSnesRuntimeProject(project);
    const runtimeReplay = {
      runtimeHash: runtime.manifest.runtimeHash,
      inputs: [{ right: true }, { right: true }, { jump: true }, { right: true }],
    };
    const browserReplay = runSnesRuntimeReplay(runtime, runtimeReplay);
    const before = writeSnesSaveSlot(project, createSnesSramImage(project), 0, {
      checkpoint: 3,
      coins: 7,
      unlocked_exit: 1,
    });
    const sramProof = createSnesSramPowerCycleProof(project, before, new Uint8Array(before), 0);
    const ready = createSnesHardwareQaBundle(project, "2026-05-19T08:00:00.000Z", {
      availableEmulators: ["bsnes"],
      emulatorExecution: {
        elapsedMs: 1200,
        exitCode: 0,
        screenshotBytes: new Uint8Array([1, 2, 3]),
        stderr: "",
        stdout: "booted",
      },
      emulatorStateDump: {
        browserReplayChecksum: browserReplay.browserReplayChecksum,
        capturedAt: "2026-05-19T08:00:00.000Z",
        finalStateHash: browserReplay.finalStateHash,
        frameCount: browserReplay.frameCount,
        runtimeHash: browserReplay.runtimeHash,
        source: "bsnes-state-dump",
      },
      mountedVolume: {
        cardSizeGb: 128,
        existingSavePresent: true,
        fileSystem: "FAT32",
        freeBytes: rom.bytes.byteLength * 2,
        mounted: true,
        volumePath: "/Volumes/FXPAK",
      },
      runtimeReplay,
      sramPowerCycle: sramProof,
    });
    const blocked = createSnesHardwareQaBundle(project, "2026-05-19T08:00:00.000Z");

    expect(ready.status).toBe("ready-for-operator");
    expect(ready.artifacts.emulatorProof.status).toBe("verified");
    expect(ready.artifacts.emulatorReplayParity.status).toBe("verified");
    expect(ready.artifacts.mountedExport?.status).toBe("ready");
    expect(ready.artifacts.sramPowerCycle?.status).toBe("verified");
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers).toContain("Emulator boot/screenshot proof is not verified.");
    expect(blocked.blockers).toContain("Emulator replay parity proof is not verified.");
    expect(blocked.blockers).toContain("FXPAK PRO FAT32 mounted export is not verified.");
  });

  it("keeps the SuperFX runtime path explicit and blocked until GSU tooling exists", () => {
    const project = generateSnesProjectFromPrompt("Star Fox style SuperFX rail shooter").project;
    const plan = createSnesSuperFxRuntimePlan(project);
    const artifact = createSnesSuperFxMinimalRomArtifact(project);

    expect(plan.status).toBe("blocked");
    expect(plan.requiredTools).toContain("GSU assembler/linker");
    expect(plan.memorySegments.map((segment) => segment.name)).toContain("GSU work RAM");
    expect(plan.milestones.map((milestone) => milestone.id)).toEqual([
      "gsu-assemble",
      "framebuffer-upload",
      "fxpak-proof",
    ]);
    expect(artifact).toEqual(
      expect.objectContaining({
        fileName: "star-fox-style-superfx-rail.superfx-concept.sfc",
        gsuProgramHex: expect.stringMatching(/^4f43475355/u),
        runtimeStatus: "blocked-until-gsu-runtime-and-emulator-proof",
        sizeBytes: 512 * 1024,
        status: "static-artifact-ready",
      }),
    );
    expect(artifact.romMap.map((entry) => entry.name)).toEqual([
      "Concept SuperFX ROM shell",
      "GSU program marker",
      "Project data preview",
    ]);
    expect(artifact.blockers.join("\n")).toContain("not a boot-verified production ROM");
  });

  it("reports desktop signing requirements separately from local app packaging", () => {
    const unsigned = createSnesMacPackagingReport("apps/snes-studio/release/SNES Studio.app");
    const signed = createSnesMacPackagingReport(
      "apps/snes-studio/release/SNES Studio.app",
      "Developer ID Application: Example",
    );

    expect(unsigned.status).toBe("unsigned-blocked");
    expect(unsigned.blockers).toContain("Developer ID signing identity was not provided.");
    expect(signed.status).toBe("signed");
    expect(signed.signingIdentity).toBe("Developer ID Application: Example");
  });

  it("creates project bundles and diffs version history", () => {
    const beforeProject = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const afterProject = { ...beforeProject, name: "Moonlit Ridge DX" };
    const before = createSnesProjectVersion(
      beforeProject,
      "Before rename",
      "2026-05-19T06:00:00.000Z",
    );
    const after = createSnesProjectVersion(
      afterProject,
      "After rename",
      "2026-05-19T06:05:00.000Z",
    );
    const bundle = createSnesProjectBundle(
      afterProject,
      [after, before],
      "2026-05-19T06:10:00.000Z",
    );
    const diff = diffSnesProjectVersions(before, after);

    expect(bundle.format).toBe("openclaw-snes-project-bundle");
    expect(bundle.manifest.versionCount).toBe(2);
    expect(bundle.manifest.readiness.status).toBe("ready");
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        after: "Moonlit Ridge DX",
        before: "Moonlit Ridge",
        path: "/name",
      }),
    );
  });
});
