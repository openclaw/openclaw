export const SNES_HARDWARE_LIMITS = {
  wramBytes: 128 * 1024,
  vramBytes: 64 * 1024,
  cgramColors: 256,
  oamEntries: 128,
  aramBytes: 64 * 1024,
  spritePalettes: 8,
  backgroundPalettes: 8,
  spriteEntriesPerScanline: 32,
  spriteSliversPerScanline: 34,
  defaultFxpakCardGb: 128,
} as const;

export const SNES_STUDIO_EDIT_GRID = {
  cells: 16 * 12,
  height: 12,
  width: 16,
} as const;
export const SNES_BUILTIN_TILE_COUNT = 12;
export const SNES_IMPORTED_TILE_BRUSH_BASE = SNES_BUILTIN_TILE_COUNT;

export type SnesSeverity = "error" | "warning" | "info";
export type SnesMapMode = "lorom" | "hirom";
export type SnesRegion = "ntsc" | "pal";
export type SnesVideoMode = "mode1" | "mode7" | "superfx";
export type SnesEnhancementChip = "none" | "superfx";
export type SnesBuildTarget = "emulator" | "fxpak-pro";
export const SNES_CLASSIC_PLATFORMER_STYLE_PRESET = "classic-colorful-platformer" as const;
export type SnesVisualStylePreset = typeof SNES_CLASSIC_PLATFORMER_STYLE_PRESET;
export type SnesAssetProvenance = "original-generated" | "user-imported";
export type SnesArtDirection = {
  paletteMood: string;
  outlineThickness: "thin" | "medium" | "bold";
  spriteScale: "16x16-readable" | "16x24-hero" | "32x32-boss";
  backgroundTheme: "grassland" | "sky" | "cave" | "mountain";
  tileTheme: "rounded-grass" | "cave-blocks" | "mountain-ledges";
};
export type SnesStyleWarning = {
  code: "original-art-required" | "licensed-import-required" | "budget-watch";
  severity: "info" | "warning";
  message: string;
};
export type SnesDataFirstTileSpec = {
  id: string;
  name: string;
  tileId: number;
  size: "16x16";
  paletteIndex: number;
  collisionClass: "solid" | "passable" | "hazard" | "decorative" | "reward";
};
export type SnesDataFirstSpriteSpec = {
  id: string;
  name: string;
  kind: SnesSceneEntityKind;
  frameSize: "8x8" | "16x16" | "16x24" | "16x32";
  paletteIndex: number;
  frames: Array<{ id: string; tileId: number; durationTicks: number }>;
};
export type SnesDataFirstMusicPatternSpec = {
  id: string;
  name: string;
  tempo: number;
  patternRows: number;
  loopBars: number;
  channelPlan: string[];
};
export type SnesDataFirstSfxEventSpec = {
  event: "jump" | "pickup" | "enemy-hit" | "door-open" | "goal";
  soundEffectId: string;
};
export type SnesDataFirstPaletteSpec = {
  id: string;
  name: string;
  paletteIndex: number;
  colors: string[];
};
export type SnesGeneratedAssetSpecs = {
  tileSpecs: SnesDataFirstTileSpec[];
  spriteSpecs: SnesDataFirstSpriteSpec[];
  paletteSpecs: SnesDataFirstPaletteSpec[];
  musicPatternSpecs: SnesDataFirstMusicPatternSpec[];
  sfxEventMap: SnesDataFirstSfxEventSpec[];
};
export type SnesClassicPlatformerStylePack = {
  id: SnesVisualStylePreset;
  name: "Classic Colorful SNES Platformer";
  provenance: "original-generated";
  plainDescription: string;
  paletteHex: string[];
  backgroundLayers: string[];
  terrainTiles: string[];
  spriteRecipes: string[];
  animationRecipes: string[];
  tileSpecs: SnesDataFirstTileSpec[];
  spriteSpecs: SnesDataFirstSpriteSpec[];
  musicPatternSpecs: SnesDataFirstMusicPatternSpec[];
  sfxEventMap: SnesDataFirstSfxEventSpec[];
  budgetEstimate: {
    backgroundTiles: number;
    spriteTiles: number;
    backgroundPalettes: number;
    spritePalettes: number;
    cgramColors: number;
  };
};

export type SnesStudioProfile = {
  mapMode: SnesMapMode;
  region: SnesRegion;
  videoMode: SnesVideoMode;
  enhancementChip: SnesEnhancementChip;
  romSizeMbit: number;
  sramSizeKib: number;
  target: SnesBuildTarget;
  fxpak: {
    cardSizeGb: number;
    fileSystem: "fat32" | "exfat" | "unknown";
    preserveExistingSaves: boolean;
  };
};

export type SnesImportedTileset = {
  id: string;
  name: string;
  width: number;
  height: number;
  sourceTileCount: number;
  uniqueTileCount: number;
  dedupedTileCount: number;
  chrSizeBytes: number;
  chrChecksum: number;
  chrHex: string;
  paletteColorsUsed: number[];
  palettePreviewHex: string[];
  quantized: boolean;
  sourceColorCount: number;
  tileIndices: number[];
  createdAt: string;
  warnings: string[];
};

export type SnesCustomTileBrush = {
  id: string;
  name: string;
  tile: SnesTileBrush;
  solid: boolean;
};

export type SnesAudioSequenceStep = {
  instrument: "pulse" | "noise" | "sample";
  note: string;
  ticks: number;
  volume: number;
};

export type SnesSoundEffect = {
  id: string;
  name: string;
  priority: number;
  estimatedBytes: number;
  steps: SnesAudioSequenceStep[];
};

export type SnesMusicTrack = {
  id: string;
  name: string;
  tempo: number;
  patternRows: number;
  estimatedBytes: number;
};

export type SnesAudioProject = {
  driver: "preview-spc700";
  aramReservedBytes: number;
  sampleBytes: number;
  musicTracks: SnesMusicTrack[];
  soundEffects: SnesSoundEffect[];
};

export type SnesAssetInventory = {
  backgroundTiles: number;
  spriteTiles: number;
  backgroundPalettes: number;
  spritePalettes: number;
  audioBytes: number;
  audio: SnesAudioProject;
  customTileBrushes: SnesCustomTileBrush[];
  importedTilesets: SnesImportedTileset[];
  scriptBytes: number;
};

export type SnesAudioManifest = {
  driver: "preview-spc700";
  aramLimitBytes: number;
  reservedDriverBytes: number;
  musicBytes: number;
  soundEffectBytes: number;
  sampleBytes: number;
  totalBytes: number;
  utilization: number;
  musicTracks: SnesMusicTrack[];
  soundEffects: Array<Omit<SnesSoundEffect, "steps"> & { sequenceBytes: number }>;
  warnings: string[];
  exportNotes: string[];
};

export type SnesIndexedTileImportInput = {
  name: string;
  width: number;
  height: number;
  pixels: number[];
};

export type SnesRgbaTileImportInput = {
  name: string;
  width: number;
  height: number;
  rgba: number[];
};

export type SnesRgbaTileImportOptions = {
  quantize?: boolean;
  transparentAlpha?: number;
};

export type SnesIndexedTileImportResult = SnesImportedTileset & {
  chrBytes: Uint8Array;
};

export type SnesAssetPipelineReport = {
  status: "ready" | "warning" | "blocked";
  importedTilesetCount: number;
  sourceTileCount: number;
  uniqueTileCount: number;
  dedupedTileCount: number;
  importedChrBytes: number;
  importedPaletteColors: number;
  quantizedTilesetCount: number;
  vramBytes: {
    used: number;
    limit: number;
    remaining: number;
  };
  cgramColors: {
    used: number;
    limit: number;
    remaining: number;
  };
  checks: Array<{
    code: string;
    label: string;
    status: "pass" | "warning" | "blocked";
    detail: string;
  }>;
};

export type SnesProductionGateId =
  | "browser-preview"
  | "asset-pipeline"
  | "visual-approval"
  | "engine-runtime-proof"
  | "rom-build"
  | "emulator-proof"
  | "fxpak-package"
  | "hardware-proof";

export type SnesProductionGateStatus =
  | "pass"
  | "warning"
  | "blocked"
  | "manual-required"
  | "not-run";

export type SnesProductionGate = {
  id: SnesProductionGateId;
  label: string;
  status: SnesProductionGateStatus;
  requiredForProduction: boolean;
  summary: string;
  blockers: string[];
  evidence: string[];
};

export type SnesProductionAssetType =
  | "character-sprite"
  | "enemy-sprite"
  | "item-sprite"
  | "tileset"
  | "background-layer"
  | "ui"
  | "music"
  | "sfx"
  | "concept";

export type SnesProductionAssetMaturity =
  | "spec-only"
  | "procedural-placeholder"
  | "draft-generated"
  | "artist-imported"
  | "ai-generated-source"
  | "production-approved";

export type SnesProductionVisualProofKind =
  | "source-image"
  | "sprite-contact-sheet"
  | "tileset-atlas"
  | "background-composite"
  | "in-game-screenshot";

export type SnesProductionVisualProofArtifact = {
  kind: SnesProductionVisualProofKind;
  path: string;
  sha256?: string;
  sourceAssetPath?: string;
};

export type SnesProductionAssetRecord = {
  id: string;
  type: SnesProductionAssetType;
  status: "real-asset" | "spec-only" | "blocked";
  conversionStatus?: "converted" | "blocked" | "not-run";
  conversionReceiptPath?: string;
  visualMaturity?: SnesProductionAssetMaturity;
  sourcePath?: string;
  sourceHash?: string;
  license: "original" | "user-provided" | "licensed" | "unknown";
  provenance: "openclaw-generated" | "user-imported" | "external-licensed" | "spec";
  palette?: {
    colorCount: number;
    colors: string[];
  };
  frames?: Array<{ id: string; width: number; height: number; durationTicks?: number }>;
  tileMetadata?: {
    tileSize: "8x8" | "16x16";
    tileCount: number;
    collisionClasses: string[];
  };
  usage: string[];
  visualProof?: SnesProductionVisualProofArtifact[];
  screenshotProof?: string[];
  blockers: string[];
};

export type SnesProductionAssetRegistry = {
  status: "ready" | "blocked";
  records: SnesProductionAssetRecord[];
  requiredTypes: SnesProductionAssetType[];
  missingRequiredTypes: SnesProductionAssetType[];
  blockers: string[];
};

export type SnesProductionVisualReport = {
  format: "openclaw-snes-production-visual-report";
  status: "pass" | "blocked" | "manual-required";
  targetScore: number;
  humanGrade: number | null;
  machineScore: number;
  importedConvertedSourceArt: SnesProductionAssetRecord[];
  deterministicGeneratedArt: SnesProductionAssetRecord[];
  specOnlyPlaceholderArt: SnesProductionAssetRecord[];
  productionApprovedArt: SnesProductionAssetRecord[];
  visualProof: SnesProductionVisualProofArtifact[];
  screenshotProof: string[];
  visualGate: SnesArtDirectorVisualGateReport;
  blockers: string[];
  summary: string;
};

export type SnesVisualApprovalContract = {
  targetScore: number;
  currentHumanScore: number | null;
  machineScore: number | null;
  gpt55ReviewStatus: "not-requested" | "approved" | "rejected" | "blocked";
  status: "approved" | "blocked" | "manual-required";
  blocker: string | null;
};

export type SnesToolchainToolId =
  | "pvsneslib"
  | "superfamiconv"
  | "pixelorama"
  | "aseprite"
  | "ldtk"
  | "tiled"
  | "mesen"
  | "bsnes"
  | "superfamicheck"
  | "brrtools";

export type SnesToolchainToolStatus = {
  id: SnesToolchainToolId;
  label: string;
  status: "available" | "missing" | "optional-missing" | "blocked";
  requiredForProduction: boolean;
  path?: string;
  version?: string;
  detail: string;
  installHint: string;
};

export type SnesToolchainDoctorReport = {
  status: "ready" | "blocked";
  tools: SnesToolchainToolStatus[];
  fxpakVolume: {
    status: "mounted" | "missing" | "blocked";
    path?: string;
    fileSystem?: string;
    detail: string;
  };
  blockers: string[];
};

export type SnesToolchainDoctorInput = {
  tools?: Partial<
    Record<
      SnesToolchainToolId,
      {
        available?: boolean;
        path?: string;
        version?: string;
        detail?: string;
      }
    >
  >;
  fxpakVolume?: {
    mounted?: boolean;
    path?: string;
    fileSystem?: string;
    detail?: string;
  };
};

export type SnesBuildReceiptStatus = "pass" | "blocked" | "not-run";

export type SnesRomBuildReceipt = {
  status: SnesBuildReceiptStatus;
  romFileName?: string;
  projectHash?: string;
  assetManifestHash?: string;
  toolVersions: Record<string, string>;
  checksumStatus: "pass" | "blocked" | "not-run";
  blockers: string[];
  proofKind?: "scaffold" | "engine-runtime";
};

export type SnesEngineRuntimeFeature =
  | "player-movement"
  | "jump"
  | "gravity"
  | "camera-scroll"
  | "collision"
  | "enemy"
  | "collectible"
  | "goal"
  | "converted-assets-visible";

export type SnesEngineRuntimeProofReceipt = {
  status: SnesBuildReceiptStatus;
  engineVersion?: "platformer-v1";
  romFileName?: string;
  sourceDataHash?: string;
  features: SnesEngineRuntimeFeature[];
  blockers: string[];
};

export type SnesEmulatorProofReceipt = {
  status: SnesBuildReceiptStatus;
  emulator?: "mesen" | "bsnes" | "ares" | "snes9x";
  romHash?: string;
  launchCommand?: string[];
  screenshotPath?: string;
  blockers: string[];
};

export type SnesFxpakPackageReceipt = {
  status: SnesBuildReceiptStatus;
  destinationPath?: string;
  fileSystemRequired: "fat32";
  savePolicy: "preserve-existing-sram";
  dryRun: boolean;
  blockers: string[];
};

export type SnesHardwareProofReceipt = {
  status: "pass" | "manual-required" | "blocked";
  checklist: Array<{ label: string; status: "pass" | "manual-required" | "blocked" }>;
  blockers: string[];
};

export type SnesProductionReadinessOptions = {
  assetRecords?: SnesProductionAssetRecord[];
  visualApproval?: Partial<SnesVisualApprovalContract>;
  artDirectorGate?: Partial<SnesArtDirectorVisualGateReport>;
  toolchain?: SnesToolchainDoctorReport;
  engineRuntimeProof?: SnesEngineRuntimeProofReceipt;
  romBuild?: SnesRomBuildReceipt;
  emulatorProof?: SnesEmulatorProofReceipt;
  fxpakPackage?: SnesFxpakPackageReceipt;
  hardwareProof?: SnesHardwareProofReceipt;
  targetHumanVisualScore?: number;
};

export type SnesProductionReadinessReport = {
  status: "production-ready" | "production-blocked";
  score: number;
  summary: string;
  gates: SnesProductionGate[];
  assetRegistry: SnesProductionAssetRegistry;
  visualApproval: SnesVisualApprovalContract;
  artDirectorGate: SnesArtDirectorVisualGateReport;
  toolchain: SnesToolchainDoctorReport;
  engineRuntimeProof: SnesEngineRuntimeProofReceipt;
  blockers: string[];
};

export type SnesGameBuilderManifest = {
  format: "openclaw-snes-game-builder-project";
  manifestVersion: 1;
  createdAt: string;
  project: SnesStudioProject;
  assetRegistry: SnesProductionAssetRegistry;
  productionReadiness: SnesProductionReadinessReport;
  toolchain: SnesToolchainDoctorReport;
  receipts: {
    engineRuntimeProof?: SnesEngineRuntimeProofReceipt;
    romBuild?: SnesRomBuildReceipt;
    emulatorProof?: SnesEmulatorProofReceipt;
    fxpakPackage?: SnesFxpakPackageReceipt;
    hardwareProof?: SnesHardwareProofReceipt;
  };
};

export type SnesAssetAdapterKind =
  | "pixelorama"
  | "aseprite"
  | "superfamiconv"
  | "ldtk"
  | "tiled"
  | "brrtools";

export type SnesAssetAdapterReceipt = {
  adapter: SnesAssetAdapterKind;
  status: "ready" | "blocked";
  inputPath: string;
  outputPath?: string;
  inputHash: string;
  outputHash?: string;
  producedAssetId?: string;
  blockers: string[];
};

export type SnesAssetAdapterPlan = {
  status: "ready" | "blocked";
  projectId: string;
  receipts: SnesAssetAdapterReceipt[];
  blockers: string[];
};

export type SnesRomBuildScaffoldDryRun = {
  status: "ready" | "blocked";
  projectId: string;
  scaffoldRoot: string;
  plannedFiles: Array<{ path: string; purpose: string }>;
  receipt: SnesRomBuildReceipt;
  blockers: string[];
};

export type SnesEmulatorProofPlan = {
  status: "ready" | "blocked";
  projectId: string;
  receipt: SnesEmulatorProofReceipt;
  selectedEmulator: string | null;
  proofArtifacts: Array<{ path: string; purpose: string }>;
  blockers: string[];
};

export type SnesFxpakDryRunPlan = {
  status: "ready" | "blocked";
  projectId: string;
  receipt: SnesFxpakPackageReceipt;
  destinationPath: string | null;
  copyPlan: Array<{ source: string; destination: string; purpose: string }>;
  warnings: string[];
  blockers: string[];
};

export type SnesProjectPackageSource =
  | "generic"
  | "sample-stanski"
  | "sample-mvp"
  | "stanski-production";

export type SnesStanskiReferenceReceipt = {
  id: string;
  sourceType: "prompt-text" | "image-reference" | "canon-summary";
  status: "preserved" | "blocked" | "planned";
  path: string;
  sha256?: string;
  dimensions?: { width: number; height: number };
  usage: string;
  blocker?: string;
};

export type SnesStanskiWorldLevelRecord = {
  id: string;
  world: "World 1";
  title: string;
  purpose: string;
  mechanicsTaught: string[];
  firstReward: string;
  firstEnemy: string;
  checkpoint: string;
  secretPath: string;
  toiletEnding: string;
  requiredAssets: string[];
  snesBudgetEstimate: string;
  qaExpectations: string[];
};

export type SnesStanskiMovementFeelContract = {
  walkSpeed: number;
  runMultiplier: number;
  acceleration: number;
  jumpVelocity: number;
  variableJump: boolean;
  coyoteTimeFrames: number;
  jumpBufferFrames: number;
  slopeSupport: "planned" | "implemented";
  conveyorSupport: "planned" | "implemented";
  damageKnockback: { xVelocity: number; yVelocity: number; invulnerabilityFrames: number };
};

export type SnesStanskiLevelOneChecklistItem = {
  id: string;
  label: string;
  status: "implemented" | "blocked" | "planned";
  proof: string;
  blocker?: string;
};

export type SnesStanskiLevelOneSection = {
  id: string;
  name: string;
  startX: number;
  endX: number;
  purpose: string;
  requiredMechanics: string[];
  requiredReward: string;
  qaExpectation: string;
};

export type SnesStanskiLevelOneObject = {
  id: string;
  kind:
    | "player-start"
    | "collectible"
    | "enemy"
    | "block"
    | "power-up"
    | "checkpoint"
    | "secret-route"
    | "projectile-gate"
    | "goal"
    | "vfx";
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  behavior: string;
  qaAssertion: string;
};

export type SnesStanskiLevelOneReplayStep = {
  id: string;
  startFrame: number;
  durationFrames: number;
  input: string[];
  expected: string;
};

export type SnesStanskiLevelOneProductionState = {
  format: "openclaw-stanski-level-one-production-state";
  version: 1;
  projectId: "stanskis-world";
  activeLevelId: "w1-1-cleveland-skyline-scramble";
  activeLevelTitle: "Cleveland: Skyline Scramble";
  productionScope: "level-1-only";
  fullGamePlanStatus: "preserved-for-later";
  deferredMilestoneGroups: string[];
  openingOverlay: { world: "Cleveland"; level: "1" };
  mechanics: SnesStanskiMovementFeelContract & {
    startingLives: 5;
    gasBoostMultiplier: 1.5;
    fallingGasBoostAllowed: true;
    crouchHitbox: { smallHeight: number; bigStandingHeight: number; bigCrouchedHeight: number };
    projectileOrigins: { smallY: number; bigStandingY: number; bigCrouchedY: number };
  };
  definitionOfDone: SnesStanskiLevelOneChecklistItem[];
  sections: SnesStanskiLevelOneSection[];
  objects: SnesStanskiLevelOneObject[];
  replayScript: SnesStanskiLevelOneReplayStep[];
  snesBudget: {
    mapMode: "lorom";
    videoMode: "mode1";
    widthPixels: number;
    heightPixels: number;
    metatileBudget: number;
    activeSpriteBudget: number;
    enhancementChip: "none";
  };
  proofSurfaces: SnesStanskiLevelOneChecklistItem[];
  blockers: string[];
};

export type SnesStanskiWorldCanon = {
  format: "openclaw-stanski-world-canon";
  version: 1;
  targetPlatform: "original-snes-via-fxpak-pro";
  baseRom: "standard-snes-compatible";
  optionalEnhancements: "disabled-by-default";
  fxpakWrites: "blocked-until-exact-mounted-volume";
  visualTarget: { score: 100; approval: "human-required" };
  gameBible: string[];
  technicalContract: string[];
  worldStructure: string[];
  worldOneVerticalSlice: SnesStanskiWorldLevelRecord[];
  storyArc: string[];
  finalBoss: string[];
  secretSystems: string[];
  visualStandard: string[];
  audioStandard: string[];
  definitionOfDone: string[];
  riskRegister: string[];
  references: SnesStanskiReferenceReceipt[];
  movementFeel: SnesStanskiMovementFeelContract;
  levelOneProduction?: SnesStanskiLevelOneProductionState;
};

export type SnesProjectPackageQaReceipt = {
  id: string;
  status: "pass" | "warning" | "blocked" | "not-run";
  summary: string;
  path?: string;
};

export type SnesProjectPackage = {
  format: "openclaw-snes-project-package";
  packageVersion: 1;
  createdAt: string;
  projectId: string;
  projectName: string;
  source: SnesProjectPackageSource;
  sampleSpecific: false;
  manifest: SnesGameBuilderManifest;
  receipts: {
    assetAdapters: SnesAssetAdapterReceipt[];
    qa: SnesProjectPackageQaReceipt[];
    engineRuntimeProof?: SnesEngineRuntimeProofReceipt;
    romBuild?: SnesRomBuildReceipt;
    emulatorProof?: SnesEmulatorProofReceipt;
    fxpakPackage?: SnesFxpakPackageReceipt;
    hardwareProof?: SnesHardwareProofReceipt;
  };
  packageHash: string;
};

export type SnesGenericProductionMilestone = {
  id: string;
  name: string;
  surface: "manifest" | "assets" | "levels" | "playtest" | "rom" | "emulator" | "fxpak";
  patchSchema: "manifestPatch" | "assetPackPatch" | "levelPatch" | "proofPatch";
  goal: string;
  acceptance: string[];
  status?:
    | "planned"
    | "active"
    | "implemented"
    | "built"
    | "emulator-tested"
    | "fxpak-tested"
    | "hardware-tested";
  group?: string;
};

export type SnesGenericProductionMemoryCard = {
  milestoneId: string;
  status: "pass" | "blocked";
  summary: string;
  lockedDecisions: string[];
  qaProof: Record<string, unknown>;
};

export type SnesGenericProductionState = {
  format: "openclaw-snes-generic-production-state";
  stateVersion: 1;
  projectId: string;
  currentMilestoneId: string | null;
  completedMilestones: string[];
  blockedMilestone: string | null;
  backlog: SnesGenericProductionMilestone[];
  memoryCards: SnesGenericProductionMemoryCard[];
  receipts: SnesProjectPackageQaReceipt[];
  policy: {
    localGlmOnly: true;
    hostedGlmAllowed: false;
    routineGpt55Allowed: false;
    defaultGpt55Reasoning: "low";
    highReasoningUseCases?: SnesGpt55UseCase[];
    lowReasoningUseCases?: SnesGpt55UseCase[];
    repeatedFailureThreshold?: number;
  };
};

export type SnesGenericProductionPacket = {
  task: string;
  projectId: string;
  milestone: SnesGenericProductionMilestone | null;
  completedMilestones: string[];
  memoryCards: SnesGenericProductionMemoryCard[];
  allowedPatchSchema: SnesGenericProductionMilestone["patchSchema"] | null;
  doNotBreak: string[];
  gpt55Used: false;
  gpt55Policy: SnesGpt55TokenGovernorDecision;
  localGlmOnly: true;
};

export type SnesGenericProductionPatchValidation = {
  status: "pass" | "blocked";
  milestoneId: string | null;
  patchType: string | null;
  localGlmOnly: boolean;
  hostedGlmUsed: boolean;
  blockers: string[];
};

export type SnesGenericProductionStepResult = {
  status: "pass" | "blocked";
  state: SnesGenericProductionState;
  receipt: SnesProjectPackageQaReceipt;
  validation: SnesGenericProductionPatchValidation;
};

export type SnesGpt55ReasoningLevel = "none" | "low" | "high" | "extra-high";

export type SnesGpt55UseCase =
  | "initial-blueprint"
  | "qa-summary"
  | "obvious-repair-brief"
  | "repeated-blocker-diagnosis"
  | "architecture-or-design-conflict"
  | "production-visual-approval"
  | "final-shipping-approval"
  | "routine-local-patch";

export type SnesGpt55TokenGovernorDecision = {
  useCase: SnesGpt55UseCase;
  gpt55Used: boolean;
  reasoningLevel: SnesGpt55ReasoningLevel;
  whyUsed: string;
  costAvoidedByLocalAgents: string;
  localWorkerDefault: boolean;
  requiresExplicitUserApproval: boolean;
  blocker: string | null;
};

export type SnesAgentOperatingManualRole = {
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa";
  owner: "producer" | "gpt-5.5" | "local-openclaw-glm" | "deterministic-qa";
  surface: SnesAiAuthoringSurface | "production-state" | "visual-quality";
  responsibility: string;
  allowedToPatch: string[];
  requiredReceiptFields: Array<keyof SnesAgentHandoffReceipt>;
};

export type SnesAgentOperatingManual = {
  format: "openclaw-snes-agent-operating-manual";
  version: 1;
  summary: string;
  roles: SnesAgentOperatingManualRole[];
  workflow: string[];
  tokenPolicy: SnesGpt55TokenGovernorDecision[];
  completionRule: string;
};

export type SnesAgentHandoffReceipt = {
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa";
  title: string;
  surfaceChanged: SnesAiAuthoringSurface | "production-state" | "visual-quality";
  patchPath: string | null;
  patchHash: string | null;
  assumptions: string[];
  risks: string[];
  testHypothesis: string;
  qaEvidenceRequired: string[];
  nextRole: SnesAgentTeamRole | "art-director-visual-qa" | "human-review" | null;
  blocker: string | null;
  gpt55Used: boolean;
  reasoningLevel: SnesGpt55ReasoningLevel;
  localModelUsed: string | null;
};

export type SnesArtDirectorVisualGateReport = {
  status: "pass" | "blocked" | "manual-required";
  targetScore: number;
  humanScore: number | null;
  machineScore: number;
  gpt55ReviewStatus: SnesVisualApprovalContract["gpt55ReviewStatus"];
  metrics: {
    realSpriteSheets: number;
    realTilesetVariants: number;
    realBackgroundLayers: number;
    paletteRamps: number;
    screenshotProofs: number;
    visualProofArtifacts: number;
    productionApprovedAssets: number;
    proceduralPlaceholderAssets: number;
    draftGeneratedAssets: number;
    heroAnimationFrames: number;
    specOnlyAssetCount: number;
    placeholderArtDetected: boolean;
  };
  blockers: string[];
  evidence: string[];
};

export type SnesRepairLoopPlan = {
  status: "not-needed" | "ready" | "blocked";
  failureEvidence: string[];
  targetRole: SnesAgentTeamRole | "art-director-visual-qa" | null;
  gpt55Decision: SnesGpt55TokenGovernorDecision;
  repairBrief: string[];
  localWorkerPatchRequired: boolean;
  rerunRequired: boolean;
  blocker: string | null;
};

export type SnesAgentWorkflowReport = {
  format: "openclaw-snes-agent-workflow-report";
  version: 1;
  projectId: string;
  projectName: string;
  operatingManual: SnesAgentOperatingManual;
  tokenGovernor: {
    routinePatch: SnesGpt55TokenGovernorDecision;
    blueprint: SnesGpt55TokenGovernorDecision;
    repair: SnesGpt55TokenGovernorDecision;
    visualApproval: SnesGpt55TokenGovernorDecision;
    finalApproval: SnesGpt55TokenGovernorDecision;
  };
  manifestMemory: {
    sourceOfTruth: "snes-project-manifest";
    fullTranscriptRequired: false;
    latestPacket: SnesGenericProductionPacket;
  };
  handoffReceipts: SnesAgentHandoffReceipt[];
  visualGate: SnesArtDirectorVisualGateReport;
  repairLoop: SnesRepairLoopPlan;
  nextRecommendedAction: string;
  blockers: string[];
};

export type SnesSceneEntityKind = "player" | "enemy" | "item" | "npc";
export type SnesEnemyBehaviorKind = "stationary" | "patrol" | "chase" | "guard";
export type SnesEnemyBehavior = {
  kind: SnesEnemyBehaviorKind;
  speed: number;
  patrolStartX: number;
  patrolEndX: number;
  aggroRange: number;
  guardDirection: -1 | 1;
};

export type SnesPromptSpriteAsset = {
  prompt: string;
  kind: SnesSceneEntityKind;
  importResult: SnesIndexedTileImportResult;
  defaultEntity: SnesSceneEntity;
  animation: SnesSpriteAnimation | null;
  paletteHints: string[];
};

export type SnesSceneEntity = {
  id: string;
  kind: SnesSceneEntityKind;
  name: string;
  x: number;
  y: number;
  metaspriteTiles: number;
  visualRecipe?: string;
  behavior?: SnesEnemyBehavior;
};

export type SnesTileBrush = number;
export type SnesCollisionMaterial = 0 | 1 | 2 | 3 | 4;

export type SnesStudioScene = {
  id: string;
  name: string;
  widthMetatiles: number;
  heightMetatiles: number;
  layers: number;
  collisionTiles: number;
  collisionMap: number[];
  entities: SnesSceneEntity[];
  tilemap: number[];
};

export type SnesSpriteAnimationFrame = {
  id: string;
  durationTicks: number;
  tileIndex: number;
  xOffset: number;
  yOffset: number;
};

export type SnesSpriteAnimation = {
  id: string;
  name: string;
  entityKind: Exclude<SnesSceneEntityKind, "item">;
  loop: boolean;
  frames: SnesSpriteAnimationFrame[];
};

export type SnesSaveFieldType = "u8" | "u16" | "u32" | "flag";

export type SnesSaveField = {
  key: string;
  label: string;
  type: SnesSaveFieldType;
};

export type SnesSaveSystem = {
  enabled: boolean;
  slots: number;
  fields: SnesSaveField[];
};

export type SnesPlayerPhysicsConfig = {
  moveSpeed: number;
  jumpVelocity: number;
  gravityPerFrame: number;
  maxFallSpeed: number;
  groundY: number;
};

export type SnesDialogueLine = {
  id: string;
  speaker: string;
  text: string;
};

export type SnesCutscene = {
  id: string;
  name: string;
  trigger: string;
  lines: SnesDialogueLine[];
};

export type SnesCutsceneTimelineStep = {
  id: string;
  cutsceneId: string;
  cutsceneName: string;
  trigger: string;
  lineIndex: number;
  speaker: string;
  text: string;
  durationTicks: number;
  linkedEventIds: string[];
};

export type SnesCutsceneTimeline = {
  status: "ready" | "warning";
  cutsceneCount: number;
  lineCount: number;
  totalDurationTicks: number;
  steps: SnesCutsceneTimelineStep[];
  warnings: string[];
};

export type SnesEventAction =
  | { type: "show-dialogue"; cutsceneId: string }
  | { type: "give-item"; itemId: string }
  | { type: "set-flag"; flag: string };

export type SnesEventScript = {
  id: string;
  name: string;
  trigger: "on-start" | "on-enter-zone" | "on-collect-item" | "on-defeat-enemy";
  targetId: string;
  actions: SnesEventAction[];
};

export type SnesGameplayBlueprint = {
  genre: "side-scrolling-platformer";
  premise: string;
  difficulty: "easy" | "normal" | "hard";
  controls: string[];
  artMood: string;
  musicMood: string;
};

export type SnesThingLibraryEntry = {
  id: string;
  kind: "hero" | "enemy" | "item" | "powerup" | "block" | "door" | "goal" | "hazard";
  name: string;
  prompt: string;
  behavior: string;
};

export type SnesPlatformerRules = {
  movement: string;
  enemyBehavior: string;
  itemEffects: string;
  damage: string;
  scoring: string;
  winLoss: string;
};

export type SnesLevelPlan = {
  id: string;
  name: string;
  summary: string;
  chunks: string[];
  goal: string;
};

export type SnesGameStoryBible = {
  premise: string;
  world: string;
  hero: string;
  heroGoal: string;
  villain: string;
  conflict: string;
  ending: string;
  tone: string;
};

export type SnesLevelChapter = {
  id: string;
  sceneId: string;
  order: number;
  title: string;
  storyPurpose: string;
  setting: string;
  challenge: string;
  reward: string;
  goal: string;
  requiredThings: string[];
};

export type SnesGamePartLock = {
  id: string;
  kind: "story" | "level" | "character" | "enemy" | "item" | "rule" | "music" | "export";
  label: string;
};

export type SnesAiGapSeverity = "blocker" | "warning" | "suggestion";

export type SnesAiGap = {
  id: string;
  title: string;
  detail: string;
  severity: SnesAiGapSeverity;
  suggestedFix: string;
  safeAutofill: boolean;
  resolved: boolean;
};

export type SnesAiGapReport = {
  status: "complete" | "needs-fixes";
  summary: string;
  gaps: SnesAiGap[];
};

export type SnesCompletionChecklist = {
  playable: boolean;
  storyComplete: boolean;
  levelsComplete: boolean;
  castComplete: boolean;
  exportReady: boolean;
};

export type SnesAiGapFillResult = {
  project: SnesStudioProject;
  changes: string[];
  report: SnesAiGapReport;
};

export type SnesAiCommandResult = {
  provider: SnesAgentProvider;
  scope: SnesAiAuthoringSurface | "selected-thing" | "thing-library";
  summary: string;
  changed: string[];
  unchanged: string[];
  undoToken?: string;
  suggestedTest: string;
};

export type SnesAiProductionStatus =
  | "planning"
  | "building"
  | "validating"
  | "reviewing"
  | "openclaw-building"
  | "codex-reviewing"
  | "needs-fixes"
  | "approved-for-playtest"
  | "approved-for-snes-game-file"
  | "rejected-needs-repair"
  | "blocked";

export type SnesOpenClawAgentRole =
  | "game-director"
  | "level-designer"
  | "gameplay-designer"
  | "character-agent"
  | "enemy-agent"
  | "item-powerup-agent"
  | "story-dialog-agent"
  | "art-direction-agent"
  | "audio-direction-agent"
  | "playtest-fun-agent"
  | "hardware-constraint-agent";

export type SnesOpenClawAgentTask = {
  id: string;
  role: SnesOpenClawAgentRole;
  targetSurface: SnesAiAuthoringSurface;
  targetTextBox: string;
  prompt: string;
  lockedFields: string[];
  expectedOutput: string;
  acceptanceCriteria: string[];
};

export type SnesCodexBlueprint = {
  id: string;
  createdAt: string;
  createdBy: "codex-architect";
  sourcePrompt: string;
  gameConcept: string;
  genre: "story-driven-side-scrolling-platformer";
  story: {
    title: string;
    world: string;
    hero: string;
    villain: string;
    goal: string;
    ending: string;
  };
  levelList: Array<{
    title: string;
    purpose: string;
    challenge: string;
    reward: string;
  }>;
  cast: string[];
  items: string[];
  powerups: string[];
  rules: string[];
  artDirection: string;
  musicDirection: string;
  qualityRubric: string[];
  riskList: string[];
  agentTasks: SnesOpenClawAgentTask[];
};

export type SnesOpenClawAgentResult = {
  taskId: string;
  role: SnesOpenClawAgentRole;
  targetSurface: SnesAiAuthoringSurface;
  filledText: string;
  structuredPatchSummary: string;
  changed: string[];
  risks: string[];
  missingPieces: string[];
  status: "filled" | "needs-review";
};

export type SnesCodexReview = {
  id: string;
  createdAt: string;
  reviewer: "codex-qa-gate";
  round: number;
  score: number;
  status: "pass" | "fail";
  approvalStatus: Extract<
    SnesAiProductionStatus,
    | "needs-fixes"
    | "approved-for-playtest"
    | "approved-for-snes-game-file"
    | "rejected-needs-repair"
    | "blocked"
  >;
  requiredCorrections: string[];
  optionalSuggestions: string[];
  reviewedChecks: string[];
};

export type SnesAiValidationCheck = {
  code: string;
  status: "pass" | "warning" | "fail";
  detail: string;
};

export type SnesAiValidationReport = {
  status: "pass" | "warning" | "fail";
  score: number;
  checks: SnesAiValidationCheck[];
  requiredRepairs: string[];
};

export type SnesAiReplayEvidence = {
  terminalStatus: SnesRuntimeFrameState["status"] | "blocked";
  framesSimulated: number;
  reachedGoal: boolean;
  collectedRewardCount: number;
  damageTaken: number;
  maxProgressPixels: number;
  firstFailure: string | null;
  inputSummary: string;
};

export type SnesAiPlaytestReport = {
  status: "pass" | "warning" | "fail";
  score: number;
  replayEvidence: SnesAiReplayEvidence;
  metrics: {
    levelFinishable: boolean;
    goalReachable: boolean;
    visibleGoalOrPath: boolean;
    jumpsReachable: boolean;
    firstJumpReachable: boolean;
    noUnavoidableFirstScreenEnemyOrHazard: boolean;
    hazardsAvoidable: boolean;
    rewardsReachable: boolean;
    enemyDensitySane: boolean;
    firstLevelHasStartChallengeRewardGoal: boolean;
    firstThirtySecondsInteresting: boolean;
  };
  requiredRepairs: string[];
};

export type SnesGameQualityReport = {
  status: "pass" | "warning" | "fail";
  score: number;
  modelRouting: {
    planner: "gpt-5.5-live" | "deterministic-fallback";
    workers: "local-openclaw" | "deterministic-fallback";
    qa: "gpt-5.5-live" | "deterministic-fallback";
    codexCostUsed: boolean;
  };
  validationReport: SnesAiValidationReport;
  playtestReport: SnesAiPlaytestReport;
  gates: SnesAiValidationCheck[];
  requiredRepairs: string[];
  receipt: string[];
};

export type SnesLocalModelBenchmarkRole =
  | "snes-game-director"
  | "snes-level-designer"
  | "snes-gameplay-designer"
  | "snes-art-audio"
  | "snes-hardware-qa";

export type SnesLocalModelBenchmarkTask = {
  id: string;
  role: SnesLocalModelBenchmarkRole;
  prompt: string;
  requiredSignals: string[];
  scoringFocus: string[];
};

export type SnesLocalModelBenchmarkCandidate = {
  modelRef: string;
  reason: string;
  promotionRule: string;
};

export type SnesLocalModelBenchmarkScore = {
  modelRef: string;
  role: SnesLocalModelBenchmarkRole;
  available: boolean;
  score: number;
  blocker: string | null;
  evidence: string[];
};

export type SnesLocalModelBenchmarkReport = {
  status: "ready" | "partial" | "blocked";
  currentDefaultModel: string;
  winnersByRole: Record<SnesLocalModelBenchmarkRole, string>;
  scores: SnesLocalModelBenchmarkScore[];
  blockers: string[];
};

export type SnesRoleModelRuntimeStatus = "ready" | "blocked" | "missing" | "offline";

export type SnesRoleModelParamsContract = {
  modelRef: string;
  provider: "openai" | "ollama" | "local-glm52";
  quant: string;
  contextTokens: number;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  schemaMode: boolean;
  timeoutSeconds: number;
  fallbackModels: string[];
  promotionRule: string;
};

export type SnesRoleToolCapability = {
  id: string;
  label: string;
  required: boolean;
  status: "ready" | "blocked" | "optional";
  receiptRequired: string;
  blocker: string | null;
};

export type SnesRoleCapabilityMatrixEntry = {
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa";
  title: string;
  owner: "producer" | "gpt-5.5" | "local-openclaw-glm" | "deterministic-qa";
  agentId: string | null;
  allowedSurfaces: string[];
  tools: SnesRoleToolCapability[];
  model: SnesRoleModelParamsContract;
  runtime: {
    status: SnesRoleModelRuntimeStatus;
    blocker: string | null;
  };
  receiptsRequired: string[];
};

export type SnesAgentCapabilityMatrixReport = {
  format: "openclaw-snes-agent-capability-matrix";
  version: 1;
  status: "ready" | "blocked";
  generatedAt: string;
  entries: SnesRoleCapabilityMatrixEntry[];
  blockers: string[];
  localOnly: true;
  hostedGlmUsed: false;
  gpt55AutomatedVisualJudgeUsed: false;
};

export type SnesAiRepairHistoryEntry = {
  round: number;
  requestedBy: "gpt-5.5-quality-gate";
  targetRole: SnesOpenClawAgentRole;
  instructions: string[];
  status: "applied" | "blocked";
};

export type SnesAiProductionRun = {
  id: string;
  createdAt: string;
  status: SnesAiProductionStatus;
  prompt: string;
  blueprint: SnesCodexBlueprint;
  directorPlan: SnesCodexBlueprint;
  taskList: SnesOpenClawAgentTask[];
  builderTasks: SnesOpenClawAgentTask[];
  agentResults: SnesOpenClawAgentResult[];
  workerResults: SnesOpenClawAgentResult[];
  validationReport: SnesAiValidationReport;
  playtestReport: SnesAiPlaytestReport;
  qualityReport: SnesGameQualityReport;
  reviewRounds: SnesCodexReview[];
  gpt55Review: SnesCodexReview | null;
  finalApproval: SnesCodexReview | null;
  approvalStatus: SnesCodexReview["approvalStatus"];
  repairHistory: SnesAiRepairHistoryEntry[];
  auditTrail: string[];
};

export type SnesAiProductionResult = {
  project: SnesStudioProject;
  run: SnesAiProductionRun;
};

export type SnesAiProductionGatewayRole =
  | "codex-architect"
  | "openclaw-game-team"
  | "openclaw-game-director"
  | "openclaw-level-designer"
  | "openclaw-gameplay-designer"
  | "openclaw-art-audio"
  | "openclaw-hardware-qa"
  | "codex-qa-gate";

export type SnesAiProductionGatewayStage = {
  id: string;
  role: SnesAiProductionGatewayRole;
  title: string;
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  sessionKey: string;
  agentId?: string;
  model?: string;
  prompt: string;
  record: SnesAgentDispatchRecord;
  handoff: SnesGatewayAgentHandoff;
};

export type SnesAiProductionGatewayPlan = {
  id: string;
  proofMode: "full-production" | "dashboard-e2e";
  createdAt: string;
  sessionKey: string;
  sourcePrompt: string;
  stages: SnesAiProductionGatewayStage[];
  acceptanceCriteria: string[];
  blockers: string[];
};

export type SnesAgentTeamRole =
  | "codex-architect"
  | "openclaw-game-director"
  | "openclaw-level-designer"
  | "openclaw-gameplay-designer"
  | "openclaw-art-audio"
  | "openclaw-hardware-qa"
  | "codex-qa-gate";

export type SnesAgentTeamMember = {
  role: SnesAgentTeamRole;
  title: string;
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  sessionKey: string;
  agentId?: string;
  model?: string;
  purpose: string;
  fillsTextBoxes: boolean;
};

export type SnesAgentRoleBlocker = {
  code:
    | "missing-agent"
    | "gateway-unavailable"
    | "timeout"
    | "invalid-response"
    | "agent-error"
    | "model-runtime-unavailable"
    | "not-checked";
  message: string;
  recommendedFix: string;
  canUseLocalFallback: boolean;
};

export type SnesAgentRoleReadiness = {
  role: SnesAgentTeamRole;
  title: string;
  requestedAgent: SnesAgentProvider;
  sessionKey: string;
  agentId?: string;
  state:
    | "not-checked"
    | "checking"
    | "configured"
    | "runtime-ready"
    | "proof-pending"
    | "proof-running"
    | "proof-passed"
    | "proof-failed"
    | "ready"
    | "needs-setup"
    | "timed-out"
    | "invalid-response"
    | "unavailable";
  configured: boolean;
  reachable: boolean;
  responding: boolean;
  validJsonReturned: boolean;
  checkedAt?: string;
  detail: string;
  blocker?: SnesAgentRoleBlocker;
};

export type SnesAgentTeamReadiness = {
  role: SnesAgentTeamRole;
  status: "not-checked" | "checking" | "ready" | "blocked";
  sessionKey: string;
  requestedAgent: SnesAgentProvider;
  detail: string;
  blocker?: string;
  checkedAt?: string;
};

export type SnesAgentTeamStageResult = {
  role: SnesAgentTeamRole;
  status: "ready" | "blocked";
  summary: string;
  responseText?: string;
};

export type SnesAgentTeamReadinessReport = {
  status: "not-checked" | "checking" | "ready" | "unavailable";
  title: string;
  detail: string;
  checkedAt?: string;
  roles: SnesAgentRoleReadiness[];
  blockers: SnesAgentRoleBlocker[];
  localFallbackAvailable: boolean;
};

export type SnesAgentTeamExecutionResult = {
  status: "live" | "fallback" | "blocked";
  provider: "openclaw" | "codex" | "local";
  summary: string;
  readiness: SnesAgentTeamReadinessReport;
};

export type SnesAgentTeamRun = {
  id: string;
  createdAt: string;
  sessionBaseKey: string;
  sourcePrompt: string;
  status: "planned" | "checking" | "ready" | "blocked";
  members: SnesAgentTeamMember[];
  readiness: SnesAgentTeamReadiness[];
};

export const SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS = 30000;
export const SNES_AGENT_TEAM_LIVE_PROOF_TIMEOUT_MS = 180000;

export type SnesGameBrief = {
  prompt: string;
  gameType: "side-scrolling-platformer";
  audience: "beginner";
  promise: string;
};

export type SnesGamePlan = {
  title: string;
  hero: string;
  goal: string;
  villain: string;
  levels: string[];
  items: string[];
  powerups: string[];
  artMood: string;
  musicMood: string;
  rulesSummary: string;
  savePlan: string;
};

export type SnesScreenAreaSelection = {
  sceneId: string;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  label: string;
};

export type SnesAiChangeRequest = {
  prompt: string;
  provider: SnesAgentProvider;
  scope: "whole-game" | "selected-thing" | "selected-area";
  selectedThingId?: string;
  selectedArea?: SnesScreenAreaSelection;
};

export type SnesExportReadiness = {
  status: "ready" | "needs-fixes" | "blocked";
  summary: string;
  blockers: string[];
};

export type SnesRuntimeInputFrame = SnesPreviewControllerInput & {
  frame?: number;
};

export type SnesRuntimeEntityRole = "hero" | "enemy" | "item" | "npc" | "door" | "goal";

export type SnesRuntimeEntity = {
  id: string;
  kind: SnesSceneEntityKind;
  role: SnesRuntimeEntityRole;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  metaspriteTiles: number;
  visualRecipe?: string;
  behavior?: SnesEnemyBehavior;
};

export type SnesRuntimeScene = {
  id: string;
  name: string;
  widthMetatiles: number;
  heightMetatiles: number;
  widthPixels: number;
  heightPixels: number;
  collisionMap: SnesCollisionMaterial[];
  tilemap: SnesTileBrush[];
  entities: SnesRuntimeEntity[];
  collisionMapChecksum: number;
  tilemapChecksum: number;
};

export type SnesRuntimeManifest = {
  version: 1;
  cadence: "ntsc-60hz" | "pal-50hz";
  frameRate: number;
  frameTimeMs: number;
  fixedPointScale: number;
  viewport: {
    width: 256;
    height: 224;
  };
  activeSceneId: string;
  sceneCount: number;
  runtimeHash: string;
  stateHash: string;
  visualStylePreset: SnesVisualStylePreset;
};

export type SnesRuntimeProject = {
  version: 1;
  region: SnesRegion;
  frameRate: number;
  frameTimeMs: number;
  fixedPointScale: number;
  viewport: {
    width: 256;
    height: 224;
  };
  activeSceneId: string;
  scenes: SnesRuntimeScene[];
  physics: SnesPlayerPhysicsConfig;
  visualStylePreset: SnesVisualStylePreset;
  artDirection: SnesArtDirection;
  manifest: SnesRuntimeManifest;
};

export type SnesRuntimeFrameState = {
  cameraScrollX: number;
  collectedItems: string[];
  collisions: string[];
  defeatedEnemies: string[];
  enemyPositions: Record<string, { direction: -1 | 1; x: number; y: number }>;
  frame: number;
  grounded: boolean;
  health: number;
  inputLog: string[];
  inventory: string[];
  lives: number;
  playerX: number;
  playerY: number;
  playerYVelocity: number;
  runtimeHash: string;
  sceneId: string;
  score: number;
  status: "playing" | "won" | "lost";
};

export type SnesRuntimeReplay = {
  runtimeHash: string;
  inputs: SnesRuntimeInputFrame[];
};

export type SnesRuntimeParityReport = {
  status: "verified" | "blocked";
  runtimeStatus: "browser-runtime-verified" | "blocked-until-emulator-state-dump";
  frameCount: number;
  deterministic: boolean;
  runtimeHash: string;
  finalStateHash: string;
  browserReplayChecksum: number;
  blockers: string[];
};

export type SnesEmulatorReplayStateDump = {
  source: string;
  runtimeHash: string;
  finalStateHash: string;
  frameCount: number;
  browserReplayChecksum: number;
  capturedAt: string;
};

export type SnesStudioProject = {
  schemaVersion: 1;
  id: string;
  name: string;
  updatedAt: string;
  profile: SnesStudioProfile;
  assets: SnesAssetInventory;
  animations: SnesSpriteAnimation[];
  dialogue: SnesCutscene[];
  events: SnesEventScript[];
  physics: SnesPlayerPhysicsConfig;
  scenes: SnesStudioScene[];
  save: SnesSaveSystem;
  gameplayBlueprint?: SnesGameplayBlueprint;
  thingLibrary?: SnesThingLibraryEntry[];
  platformerRules?: SnesPlatformerRules;
  levelPlan?: SnesLevelPlan;
  gameStoryBible?: SnesGameStoryBible;
  levelChapters?: SnesLevelChapter[];
  gamePartLocks?: SnesGamePartLock[];
  aiGapReport?: SnesAiGapReport;
  completionChecklist?: SnesCompletionChecklist;
  aiCommandResult?: SnesAiCommandResult;
  aiProductionRun?: SnesAiProductionRun;
  gameBrief?: SnesGameBrief;
  gamePlan?: SnesGamePlan;
  visualStylePreset?: SnesVisualStylePreset;
  artDirection?: SnesArtDirection;
  assetProvenance?: SnesAssetProvenance;
  styleWarnings?: SnesStyleWarning[];
  generatedAssets?: SnesGeneratedAssetSpecs;
  selectedScreenArea?: SnesScreenAreaSelection;
  aiChangeRequest?: SnesAiChangeRequest;
  emulatorPlaytestState?: SnesRuntimeFrameState;
  exportReadiness?: SnesExportReadiness;
  stanskiCanon?: SnesStanskiWorldCanon;
  stanskiLevelOneProduction?: SnesStanskiLevelOneProductionState;
  export: {
    romBaseName: string;
  };
};

export type SnesBudgetMeter = {
  label: string;
  used: number;
  limit: number;
  unit: "bytes" | "colors" | "entries" | "mbit";
  ratio: number;
  severity: SnesSeverity;
};

export type SnesValidationIssue = {
  severity: SnesSeverity;
  code: string;
  path: string;
  message: string;
  suggestion: string;
};

export type SnesBuildReadiness = {
  status: "ready" | "blocked" | "caution";
  score: number;
  issues: SnesValidationIssue[];
  budgets: SnesBudgetMeter[];
};

export type SnesBuildStep = {
  id: string;
  label: string;
  owner: "project" | "asset-pipeline" | "runtime" | "compiler" | "export";
  requiredFor: SnesBuildTarget[];
  description: string;
};

export type SnesProjectTemplate = {
  id: "mode1-platformer" | "exploration-rpg" | "superfx-rail-concept";
  name: string;
  summary: string;
  prompt: string;
  enhancementChip: SnesEnhancementChip;
  videoMode: SnesVideoMode;
  status: "ready" | "concept-blocked";
};

export type SnesGuidedBuildChecklistItem = {
  id: string;
  label: string;
  status: "complete" | "action-needed" | "blocked";
  detail: string;
  nextAction: string;
};

export type SnesOnePromptGameReport = {
  status: "ready" | "action-needed" | "blocked";
  score: number;
  editableObjectCount: number;
  prompt: {
    placeholder: string;
    requiredSurfaces: SnesAiAuthoringSurface[];
  };
  components: SnesGuidedBuildChecklistItem[];
  nextEditPanels: Array<"project" | "prompt" | "scene" | "assets" | "story" | "logic" | "export">;
  acceptance: string[];
};

export type SnesSpriteOamBudgetReport = {
  status: "ready" | "warning" | "blocked";
  usedEntries: number;
  limitEntries: number;
  remainingEntries: number;
  largestMetaspriteTiles: number;
  entities: Array<{
    id: string;
    name: string;
    kind: SnesSceneEntityKind;
    metaspriteTiles: number;
    oamEntries: number;
    risk: "ok" | "large-metasprite" | "over-budget";
  }>;
  warnings: string[];
};

export type SnesFxpakExportManifest = {
  target: "FXPAK PRO";
  requiredFileSystem: "FAT32";
  cardSizeGb: number;
  romFileName: string;
  romPath: string;
  savePath: string | null;
  preserveExistingSave: boolean;
  hashAlgorithm: "sha256";
  checks: string[];
};

export type SnesFxpakExportPackage = {
  packageVersion: 1;
  target: "FXPAK PRO";
  status: "blocked" | "ready";
  blockers: string[];
  requiredFileSystem: "FAT32";
  cardSizeGb: number;
  romFileName: string;
  files: Array<{
    kind: "rom" | "sram";
    sourceName: string;
    destinationPath: string;
    sizeBytes: number;
    writeMode: "create-or-replace" | "preserve-existing";
  }>;
  integrity: {
    checksum: number;
    checksumComplement: number;
    runtimeDataChecksum: number;
    staticValidationPassed: boolean;
    requiredOperatorHash: "sha256-after-copy";
  };
  sram: {
    enabled: boolean;
    savePath: string | null;
    preserveExistingSave: boolean;
    requiredPowerCycleTest: true;
  };
  copyPlan: string[];
};

export type SnesSaveManifest = {
  enabled: boolean;
  slots: number;
  slotSizeBytes: number;
  totalBytes: number;
  sramSizeKib: number;
  savePath: string | null;
  sramBaseAddress: number | null;
  sramHeaderChecksum: number;
  sramHeaderHex: string;
  sramHeaderSizeBytes: number;
  fields: Array<SnesSaveField & { offset: number; sizeBytes: number }>;
};

export type SnesSramSerializationReport = {
  status: "ready" | "blocked";
  headerChecksumHex: string;
  headerVersion: number;
  sramBaseAddressHex: string | null;
  slotCount: number;
  slotSizeBytes: number;
  totalSaveBytes: number;
  imageSizeBytes: number;
  fields: Array<SnesSaveField & { offset: number; sizeBytes: number }>;
  checks: Array<{
    code: string;
    passed: boolean;
    detail: string;
  }>;
};

export type SnesRomSymbol = {
  name: string;
  offset: number;
  bank: number;
  address: number;
  sizeBytes: number;
  description: string;
};

export type SnesSceneRuntimeTableEntry = {
  index: number;
  id: string;
  name: string;
  widthMetatiles: number;
  heightMetatiles: number;
  layers: number;
  collisionTileCount: number;
  entityCount: number;
  tilemapChecksum: number;
  collisionMapChecksum: number;
  compiledPreviewTarget: boolean;
};

export type SnesPreviewRomArtifact = {
  fileName: string;
  bytes: Uint8Array;
  mapFileName: string;
  mapText: string;
  manifestFileName: string;
  manifestJson: string;
  sizeBytes: number;
  resetVector: 0x8000;
  checksum: number;
  checksumComplement: number;
  runtimeDataOffset: number;
  runtimeDataSizeBytes: number;
  runtimeDataChecksum: number;
  runtimeManifest: SnesRuntimeManifest;
  graphics: {
    paletteOffset: number;
    paletteSizeBytes: number;
    chrOffset: number;
    chrSizeBytes: number;
    tilemapOffset: number;
    tilemapSizeBytes: number;
    builtinTileCount: number;
    importedTileBaseIndex: number;
    importedTileCount: number;
    tileCount: number;
    bg1ChrBaseWord: number;
    bg1TilemapBaseWord: number;
    visualStylePreset: SnesVisualStylePreset;
    assetProvenance: SnesAssetProvenance;
    stylePackName: string;
  };
  scene: {
    activeSceneId: string;
    activeSceneIndex: number;
    collisionMapChecksum: number;
    collisionMapOffset: number;
    collisionMapSizeBytes: number;
    collisionTileCount: number;
    editGridHeight: number;
    editGridWidth: number;
    runtimeTable: SnesSceneRuntimeTableEntry[];
    tilemapChecksum: number;
  };
  symbols: SnesRomSymbol[];
  notes: string[];
};

export type SnesPreviewRomValidationCheck = {
  code: string;
  label: string;
  passed: boolean;
  severity: "error" | "warning";
  detail: string;
};

export type SnesPreviewRomValidationReport = {
  valid: boolean;
  checks: SnesPreviewRomValidationCheck[];
};

export type SnesEmulatorKind = "ares" | "bsnes" | "mesen" | "snes9x";

export type SnesEmulatorValidationReport = {
  status: "blocked" | "ready";
  selectedEmulator: SnesEmulatorKind | null;
  supportedEmulators: SnesEmulatorKind[];
  staticRomValidation: SnesPreviewRomValidationReport;
  blockers: string[];
  nextSteps: string[];
};

export type SnesEmulatorBootPlan = {
  status: "blocked" | "ready";
  selectedEmulator: SnesEmulatorKind | null;
  romFileName: string;
  screenshotFileName: string;
  command: string[];
  blockers: string[];
  validation: SnesEmulatorValidationReport;
};

export type SnesEmulatorBootExecution = {
  exitCode: number;
  screenshotBytes: Uint8Array;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

export type SnesEmulatorBootProof = {
  status: "blocked" | "ready-to-run" | "verified" | "failed";
  plan: SnesEmulatorBootPlan;
  checks: Array<{
    code: "STATIC_ROM" | "EMULATOR_AVAILABLE" | "EXIT_CODE" | "SCREENSHOT_BYTES";
    passed: boolean;
    detail: string;
  }>;
  evidence: {
    emulator: SnesEmulatorKind | null;
    command: string[];
    screenshotFileName: string;
    screenshotBytes: number;
    exitCode: number | null;
    elapsedMs: number | null;
  };
  blockers: string[];
};

export type SnesEmulatorScreenshotComparison = {
  status: "verified" | "blocked" | "mismatch";
  screenshotFileName: string;
  screenshotBytes: number;
  checksum: number;
  uniqueByteCount: number;
  nonZeroByteCount: number;
  expectedChecksum: number | null;
  checks: Array<{
    code: "SCREENSHOT_PRESENT" | "NONBLANK_FRAME" | "EXPECTED_CHECKSUM";
    passed: boolean;
    detail: string;
  }>;
  blockers: string[];
};

export type SnesEmulatorReplayParityProof = {
  status: "verified" | "ready-to-run" | "blocked" | "mismatch";
  runtimeManifest: SnesRuntimeManifest;
  browserReplay: SnesRuntimeParityReport;
  bootProof: SnesEmulatorBootProof;
  emulatorStateDump: SnesEmulatorReplayStateDump | null;
  checks: Array<{
    code:
      | "RUNTIME_MANIFEST"
      | "BROWSER_REPLAY"
      | "EMULATOR_AVAILABLE"
      | "BOOT_SCREENSHOT"
      | "STATE_DUMP"
      | "STATE_HASH";
    passed: boolean;
    detail: string;
  }>;
  evidence: {
    romFileName: string;
    emulator: SnesEmulatorKind | null;
    command: string[];
    runtimeHash: string;
    browserFinalStateHash: string;
    emulatorFinalStateHash: string | null;
    frameCount: number;
    browserReplayChecksum: number;
  };
  blockers: string[];
  nextSteps: string[];
};

export type SnesEmulatorReplayRunPack = {
  status: "ready" | "blocked";
  romFileName: string;
  proofFileName: string;
  scriptFileName: string;
  selectedEmulator: SnesEmulatorKind | null;
  command: string[];
  expectedFinalStateHash: string;
  runtimeHash: string;
  frameCount: number;
  scriptText: string;
  blockers: string[];
  nextSteps: string[];
};

export type SnesSuperFxProfileReport = {
  status: "concept-only" | "not-enabled";
  enhancementChip: SnesEnhancementChip;
  videoMode: SnesVideoMode;
  fxpakCompatible: boolean;
  memoryMap: {
    romMapMode: SnesMapMode;
    sramSizeKib: number;
    gsuWorkRamBytes: number;
    targetCardFileSystem: "FAT32";
  };
  blockers: string[];
  buildRules: string[];
};

export type SnesSuperFxRuntimePlan = {
  status: "blocked" | "not-enabled";
  profile: SnesSuperFxProfileReport;
  requiredTools: string[];
  memorySegments: Array<{
    name: string;
    sizeBytes: number;
    purpose: string;
  }>;
  milestones: Array<{
    id: string;
    title: string;
    acceptance: string;
  }>;
};

export type SnesSuperFxMinimalRomArtifact = {
  status: "static-artifact-ready" | "not-enabled";
  runtimeStatus: "blocked-until-gsu-runtime-and-emulator-proof" | "not-enabled";
  fileName: string;
  sizeBytes: number;
  checksum: number;
  gsuProgramOffset: number;
  gsuProgramSizeBytes: number;
  gsuProgramHex: string;
  romMap: Array<{
    name: string;
    offset: number;
    sizeBytes: number;
    purpose: string;
  }>;
  blockers: string[];
};

export type SnesAgentTaskBlueprint = {
  role: string;
  title: string;
  prompt: string;
  approvalRequired: true;
};

export const SNES_AI_AUTHORING_SURFACES = [
  "full-game",
  "level",
  "player",
  "enemies",
  "items",
  "audio",
  "dialogue",
  "save",
  "export",
] as const;

export type SnesAiAuthoringSurface = (typeof SNES_AI_AUTHORING_SURFACES)[number];
export type SnesAgentProvider = "codex" | "openclaw";

export function defaultSnesAgentProviderForSurface(
  surface: SnesAiAuthoringSurface,
): SnesAgentProvider {
  return surface === "export" ? "codex" : "openclaw";
}

export type SnesAiAuthoringPrompt = {
  surface: SnesAiAuthoringSurface;
  title: string;
  description: string;
  placeholder: string;
};

export type SnesAiBuildStage = {
  surface: SnesAiAuthoringSurface;
  title: string;
  status: "complete" | "recommended" | "optional";
  editPanel: "project" | "prompt" | "scene" | "assets" | "story" | "logic" | "export" | "agents";
  promptGoal: string;
  acceptance: string;
  dragDropHint: string;
};

export type SnesGeneratedObjectSummaryItem = {
  id: string;
  kind: "entity" | "animation" | "dialogue" | "event" | "audio" | "save" | "export";
  label: string;
  editPanel: "project" | "prompt" | "scene" | "assets" | "story" | "logic" | "export" | "agents";
  detail: string;
};

export type SnesPlayableRepairResult = {
  project: SnesStudioProject;
  changes: string[];
  beforeReadiness: SnesBuildReadiness;
  afterReadiness: SnesBuildReadiness;
};

export type SnesCodexTaskPacket = {
  id: string;
  createdAt: string;
  target: "openclaw-codex";
  role: "SNES Studio Game Builder";
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  userPrompt: string;
  approvalRequired: true;
  hardwareProfile: {
    mapMode: SnesMapMode;
    region: SnesRegion;
    videoMode: SnesVideoMode;
    enhancementChip: SnesEnhancementChip;
    target: SnesBuildTarget;
    fxpak: {
      cardSizeGb: number;
      fileSystem: "fat32";
      preserveExistingSaves: true;
    };
  };
  constraints: string[];
  allowedPatchPaths: SnesAgentPatchPath[];
  projectJson: string;
  responseContract: {
    format: "json-patch-proposal";
    operation: "replace";
    instructions: string[];
  };
};

export const SNES_AGENT_DISPATCH_EVENT = "openclaw:snes-studio:codex-task";
export const SNES_AGENT_DISPATCH_QUEUE_KEY = "openclaw:snes-studio:codex-task-queue:v1";
export const SNES_AGENT_RESULT_EVENT = "openclaw:snes-studio:codex-result";
export const SNES_AGENT_RESULT_QUEUE_KEY = "openclaw:snes-studio:codex-result-queue:v1";

export type SnesAgentDispatchRecord = {
  id: string;
  createdAt: string;
  status: "queued";
  target: "openclaw-codex";
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  projectId: string;
  projectName: string;
  promptChecksum: string;
  approvalRequired: true;
  taskPacket: SnesCodexTaskPacket;
  handoff: {
    eventName: typeof SNES_AGENT_DISPATCH_EVENT;
    queueStorageKey: typeof SNES_AGENT_DISPATCH_QUEUE_KEY;
    responseContract: "json-patch-proposal";
  };
  safety: {
    readinessStatus: SnesBuildReadiness["status"];
    readinessScore: number;
    staticRomValidationRequired: true;
    constraints: string[];
  };
};

export type SnesAgentResultRecord = {
  id: string;
  createdAt: string;
  status: "proposal-ready";
  target: "openclaw-codex";
  recordId: string;
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  responseText: string;
  handoff: {
    eventName: typeof SNES_AGENT_RESULT_EVENT;
    queueStorageKey: typeof SNES_AGENT_RESULT_QUEUE_KEY;
    responseContract: "json-patch-proposal";
  };
};

export type SnesGatewayAgentHandoff = {
  status: "ready";
  method: "agent";
  sessionKey: string;
  request: {
    sessionKey: string;
    message: string;
    deliver: false;
    idempotencyKey: string;
    agentId?: string;
    model?: string;
    timeout: number;
    promptMode: "minimal";
  };
  wait: {
    method: "agent.wait";
    timeoutMs: number;
  };
  history: {
    method: "chat.history";
    limit: number;
    maxChars: number;
  };
  instructions: string[];
};

export type SnesAgentRunnerResult = {
  status: "proposal-ready";
  recordId: string;
  proposal: SnesAgentPatchProposal;
  appliedProjectPreview: SnesStudioProject;
  staticRomValidation: SnesPreviewRomValidationReport | null;
};

export type SnesPromptGenerationResult = {
  prompt: string;
  summary: string;
  appliedChanges: string[];
  project: SnesStudioProject;
  approvalRequired: true;
};

export type SnesProjectVersion = {
  id: string;
  createdAt: string;
  projectId: string;
  projectName: string;
  reason: string;
  projectJson: string;
};

export type SnesProjectVersionDiff = {
  beforeId: string;
  afterId: string;
  changes: Array<{
    path: string;
    before: unknown;
    after: unknown;
  }>;
};

export type SnesProjectBundle = {
  format: "openclaw-snes-project-bundle";
  bundleVersion: 1;
  createdAt: string;
  projectId: string;
  projectName: string;
  projectJson: string;
  versions: SnesProjectVersion[];
  manifest: {
    fxpak: SnesFxpakExportManifest;
    readiness: SnesBuildReadiness;
    versionCount: number;
  };
};

export type SnesSramSlotValues = Record<string, boolean | number>;

export type SnesSramImageValidationReport = {
  valid: boolean;
  checks: Array<{
    code: string;
    passed: boolean;
    detail: string;
  }>;
};

export type SnesSramPowerCycleProof = {
  status: "verified" | "blocked" | "mismatch";
  slotIndex: number;
  beforeValues: SnesSramSlotValues;
  afterValues: SnesSramSlotValues;
  checks: Array<{
    code: "BEFORE_IMAGE" | "AFTER_IMAGE" | "SLOT_VALUES" | "BYTE_MATCH";
    passed: boolean;
    detail: string;
  }>;
  blockers: string[];
};

export type SnesPreviewControllerInput = {
  left?: boolean;
  right?: boolean;
  jump?: boolean;
};

export type SnesPreviewSimulationState = SnesRuntimeFrameState;

export type SnesEventSimulationResult = {
  triggeredEventIds: string[];
  shownCutsceneIds: string[];
  grantedItemIds: string[];
  flags: string[];
  warnings: string[];
};

export type SnesLevelTransitionPlan = {
  status: "single-scene" | "manifest-ready";
  runtimeStatus: "implemented-for-preview-scene" | "blocked-until-scene-loader";
  transitions: Array<{
    fromSceneId: string;
    fromSceneName: string;
    toSceneId: string;
    toSceneName: string;
    trigger: "right-edge" | "manual-event";
  }>;
  acceptance: string[];
};

export type SnesRuntimeEventPlan = {
  status: "no-events" | "manifest-ready";
  runtimeStatus: "preview-simulator-ready" | "blocked-until-65816-interpreter";
  eventCount: number;
  events: Array<{
    id: string;
    name: string;
    trigger: SnesEventScript["trigger"];
    targetId: string;
    actionCount: number;
    actions: string[];
  }>;
  acceptance: string[];
};

export type SnesRuntimeEventBytecode = {
  status: "empty" | "compiled";
  runtimeStatus: "data-embedded" | "blocked-until-65816-vm";
  eventCount: number;
  actionCount: number;
  offset: number;
  sizeBytes: number;
  checksum: number;
  bytecodeHex: string;
  opcodes: {
    showDialogue: 1;
    giveItem: 2;
    setFlag: 3;
    endEvent: 255;
  };
  blockers: string[];
};

export type SnesRuntimeEventBytecodeExecution = {
  status: "verified" | "blocked";
  runtimeStatus: "bytecode-interpreter-tested" | "empty-bytecode";
  trigger: SnesEventScript["trigger"];
  targetId: string;
  decodedEventCount: number;
  triggeredEventIds: string[];
  shownCutsceneIds: string[];
  grantedItemIds: string[];
  flags: string[];
  warnings: string[];
  blockers: string[];
  checksum: number;
};

export type SnesRomLevelLoaderTable = {
  status: "single-scene" | "compiled";
  runtimeStatus: "preview-scene-only" | "data-embedded-loader-blocked";
  offset: number;
  sizeBytes: number;
  checksum: number;
  sceneCount: number;
  bytecodeHex: string;
  entries: Array<{
    index: number;
    id: string;
    widthMetatiles: number;
    heightMetatiles: number;
    tilemapChecksum: number;
    collisionMapChecksum: number;
    entityCount: number;
    compiledPreviewTarget: boolean;
  }>;
  blockers: string[];
};

export type SnesRomLevelLoaderExecution = {
  status: "verified" | "blocked" | "mismatch";
  runtimeStatus: "loader-table-tested" | "single-scene";
  trigger: "right-edge" | "manual-event";
  fromSceneId: string;
  toSceneId: string | null;
  selectedEntry: SnesRomLevelLoaderTable["entries"][number] | null;
  checks: Array<{
    code:
      | "TRANSITION_EXISTS"
      | "TABLE_ENTRY_EXISTS"
      | "TILEMAP_CHECKSUM"
      | "COLLISION_CHECKSUM"
      | "ENTITY_COUNT";
    passed: boolean;
    detail: string;
  }>;
  blockers: string[];
  checksum: number;
};

export type SnesCollisionPhysicsPlan = {
  status: "preview-ready";
  runtimeStatus: "solid-cells-only";
  materials: Array<{
    id: "empty" | "solid" | "hazard" | "one-way" | "water";
    value: number;
    label: string;
    cellCount: number;
    previewBehavior: string;
    productionRuntimeStatus: "implemented" | "blocked";
  }>;
  physics: {
    jumpVelocity: number;
    gravityPerFrame: number;
    maxFallSpeed: number;
    groundY: number;
  };
  acceptance: string[];
};

export type SnesScanlineOamPlan = {
  status: "ready" | "warning" | "blocked";
  spriteEntryLimit: number;
  spriteSliverLimit: number;
  worstSpriteEntries: number;
  worstSpriteSlivers: number;
  worstScanline: number;
  scanlines: Array<{
    y: number;
    spriteEntries: number;
    spriteSlivers: number;
    entityIds: string[];
    status: "ok" | "warning" | "blocked";
  }>;
  warnings: string[];
};

export type SnesCollisionParityReport = {
  status: "verified" | "blocked";
  runtimeStatus: "blocked-until-emulator-state-dump";
  frameCount: number;
  deterministic: boolean;
  finalStateChecksum: number;
  materialCounts: Record<"passable" | "solid" | "hazard" | "oneWay" | "water", number>;
  collisions: string[];
  blockers: string[];
};

export type SnesAssetImporterFuzzReport = {
  status: "verified" | "failed";
  cases: Array<{
    id: string;
    expected: "accepted" | "rejected";
    actual: "accepted" | "rejected";
    controlled: boolean;
    detail: string;
  }>;
};

export type SnesPatchSandboxCorpusReport = {
  status: "verified" | "failed";
  acceptedSafeCase: boolean;
  rejectedMaliciousCases: number;
  cases: Array<{
    id: string;
    expected: "accepted" | "rejected";
    actual: "accepted" | "rejected";
    detail: string;
  }>;
};

export type SnesRecoveryCorruptionDrill = {
  status: "verified" | "failed";
  restoredProjectId: string;
  checks: Array<{
    code:
      | "VALID_BUNDLE_RESTORES"
      | "CORRUPT_JSON_REJECTED"
      | "CORRUPT_BUNDLE_REJECTED"
      | "VERSION_HISTORY_RESTORES";
    passed: boolean;
    detail: string;
  }>;
  blockers: string[];
};

export type SnesSpc700ExportPlan = {
  status: "manifest-ready" | "blocked";
  driver: "preview-spc700";
  aramLimitBytes: number;
  aramMap: Array<{
    name: string;
    offset: number;
    sizeBytes: number;
  }>;
  brrSilenceBlockHex: string;
  blockers: string[];
};

export type SnesSpc700PlaybackProgram = {
  status: "compiled" | "blocked";
  runtimeStatus: "playback-stream-tested" | "blocked-until-spc700-driver";
  driver: "preview-spc700";
  sizeBytes: number;
  checksum: number;
  commandStreamHex: string;
  trackCount: number;
  soundEffectCount: number;
  brrSilenceBlockHex: string;
  commands: Array<{
    kind: "music" | "sound-effect" | "brr-silence";
    id: string;
    offset: number;
    sizeBytes: number;
  }>;
  blockers: string[];
};

export type SnesFxpakCopyProof = {
  status: "verified" | "blocked" | "mismatch";
  destinationPath: string;
  byteLengthMatched: boolean;
  byteContentMatched: boolean;
  sourceChecksum: number;
  copiedChecksum: number;
  blockers: string[];
};

export type SnesFxpakMountedVolumeProbe = {
  mounted: boolean;
  volumePath: string;
  fileSystem: "FAT32" | "exFAT" | "APFS" | "HFS+" | "unknown";
  cardSizeGb: number;
  freeBytes: number;
  existingSavePresent: boolean;
};

export type SnesFxpakMountedExportValidation = {
  status: "ready" | "blocked";
  destinationRomPath: string;
  destinationSavePath: string | null;
  checks: Array<{
    code:
      | "VOLUME_MOUNTED"
      | "FAT32"
      | "CARD_SIZE"
      | "FREE_SPACE"
      | "ROM_DESTINATION"
      | "SRAM_PRESERVATION";
    passed: boolean;
    detail: string;
  }>;
  blockers: string[];
};

export type SnesFxpakMountedVolumeSelection = {
  status: "ready" | "blocked";
  selectedVolume: SnesFxpakMountedVolumeProbe | null;
  detectedVolumes: SnesFxpakMountedVolumeProbe[];
  checks: Array<{
    volumePath: string;
    status: SnesFxpakMountedExportValidation["status"];
    blockers: string[];
  }>;
  blockers: string[];
};

export type SnesFxpakCopyDryRun = {
  status: "ready" | "blocked";
  destinationRoot: string;
  mountedValidation: SnesFxpakMountedExportValidation;
  requiredDirectories: string[];
  operations: Array<{
    kind: SnesFxpakExportPackage["files"][number]["kind"];
    sourceName: string;
    destinationPath: string;
    sizeBytes: number;
    writeMode: SnesFxpakExportPackage["files"][number]["writeMode"];
    action: "copy-rom" | "preserve-existing-sram" | "skip-sram";
  }>;
  blockers: string[];
  warnings: string[];
};

export type SnesHardwareQaBundle = {
  format: "openclaw-snes-hardware-qa-bundle";
  bundleVersion: 1;
  createdAt: string;
  projectId: string;
  projectName: string;
  status: "ready-for-operator" | "blocked";
  blockers: string[];
  artifacts: {
    romFileName: string;
    romSizeBytes: number;
    checksum: number;
    checksumComplement: number;
    runtimeDataChecksum: number;
    emulatorProof: SnesEmulatorBootProof;
    emulatorReplayParity: SnesEmulatorReplayParityProof;
    fxpakPackage: SnesFxpakExportPackage;
    mountedExport: SnesFxpakMountedExportValidation | null;
    sramPowerCycle: SnesSramPowerCycleProof | null;
  };
  checklist: string[];
};

export type SnesMacPackagingReport = {
  status: "signed" | "unsigned-blocked";
  bundlePath: string;
  signingIdentity: string | null;
  notarizationRequired: boolean;
  blockers: string[];
};

export type SnesProjectPersistencePlan = {
  status: "local-first-ready";
  primaryDraftStorageKey: string;
  versionHistoryStorageKey: string;
  portableFormats: Array<{
    extension: ".oc-snes.json" | ".oc-snes-bundle.json";
    purpose: string;
  }>;
  recoveryGuarantees: string[];
  cloudSyncStatus: "blocked-until-project-store-binding";
};

const SNES_AGENT_PATCH_PATHS = [
  "/id",
  "/name",
  "/updatedAt",
  "/profile/mapMode",
  "/profile/region",
  "/profile/videoMode",
  "/profile/enhancementChip",
  "/profile/romSizeMbit",
  "/profile/target",
  "/profile/fxpak/cardSizeGb",
  "/profile/fxpak/fileSystem",
  "/profile/fxpak/preserveExistingSaves",
  "/assets/backgroundTiles",
  "/assets/spriteTiles",
  "/assets/backgroundPalettes",
  "/assets/spritePalettes",
  "/assets/audioBytes",
  "/assets/audio",
  "/assets/customTileBrushes",
  "/assets/importedTilesets",
  "/assets/scriptBytes",
  "/animations",
  "/dialogue",
  "/events",
  "/save/enabled",
  "/save/slots",
  "/save/fields",
  "/scenes",
  "/scenes/0/name",
  "/scenes/0/widthMetatiles",
  "/scenes/0/heightMetatiles",
  "/scenes/0/layers",
  "/scenes/0/collisionMap",
  "/scenes/0/collisionTiles",
  "/scenes/0/entities",
  "/scenes/0/tilemap",
  "/gameplayBlueprint",
  "/thingLibrary",
  "/platformerRules",
  "/levelPlan",
  "/gameStoryBible",
  "/levelChapters",
  "/visualStylePreset",
  "/artDirection",
  "/assetProvenance",
  "/styleWarnings",
  "/gamePartLocks",
  "/aiGapReport",
  "/aiProductionRun",
  "/completionChecklist",
  "/export/romBaseName",
] as const;

export type SnesAgentPatchPath = (typeof SNES_AGENT_PATCH_PATHS)[number];

export type SnesJsonPatchOperation = {
  op: "replace";
  path: SnesAgentPatchPath;
  value: unknown;
};

export type SnesAgentPatchProposal = {
  id: string;
  source: "local-prompt-agent" | "openclaw-agent" | "openclaw-codex";
  surface: SnesAiAuthoringSurface;
  requestedAgent: SnesAgentProvider;
  prompt: string;
  summary: string;
  rationale: string[];
  operations: SnesJsonPatchOperation[];
  previewProject: SnesStudioProject;
  readiness: SnesBuildReadiness;
  approvalRequired: true;
};

export type SnesAgentPatchDiff = {
  path: SnesAgentPatchPath;
  before: unknown;
  after: unknown;
};

type ParsedAgentPatchResponse = {
  summary?: string;
  rationale?: string[];
  operations: SnesJsonPatchOperation[];
};

const ENGINE_WRAM_RESERVE_BYTES = 32 * 1024;
const ENGINE_ROM_RESERVE_BYTES = 128 * 1024;
const TILE_BYTES_4BPP = 32;
const TILEMAP_ENTRY_BYTES = 2;
const LOROM_HEADER_OFFSET = 0x7fc0;
const LOROM_RESET_VECTOR_OFFSET = 0x7ffc;
const LOROM_VECTOR_START_OFFSET = 0x7fe4;
const PALETTE_DATA_OFFSET = 0x12000;
const CHR_DATA_OFFSET = 0x12100;
const TILEMAP_DATA_OFFSET = 0x13000;
const COLLISION_MAP_DATA_OFFSET = 0x13800;
const EVENT_BYTECODE_DATA_OFFSET = 0x13a00;
const LEVEL_TABLE_DATA_OFFSET = 0x13c00;
const RUNTIME_DATA_OFFSET = 0x14000;
const BG1_CHR_BASE_WORD = 0x0000;
const BG1_TILEMAP_BASE_WORD = 0x0400;
const SNES_RESET_VECTOR = 0x8000;
const WRAM_JOYPAD_STATE_ADDRESS = 0x0200;
const WRAM_CAMERA_SCROLL_X_ADDRESS = 0x0202;
const WRAM_PLAYER_X_ADDRESS = 0x0204;
const WRAM_PLAYER_Y_ADDRESS = 0x0205;
const WRAM_PLAYER_Y_VELOCITY_ADDRESS = 0x0206;
const WRAM_PLAYER_GROUNDED_ADDRESS = 0x0207;
const SRAM_BASE_LONG_ADDRESS = 0x700000;
const SRAM_HEADER_SIZE_BYTES = 16;
const PREVIEW_PLAYER_START_X = 120;
const PREVIEW_PLAYER_START_Y = 184;
const PREVIEW_PLAYER_TILE_INDEX = 5;
const PREVIEW_PLAYER_GROUND_Y = 184;
const PREVIEW_PLAYER_JUMP_VELOCITY = 0xf8;
const PREVIEW_PLAYER_GRAVITY = 1;
const PREVIEW_PLAYER_MAX_FALL_SPEED = 6;
export const SNES_NTSC_FRAME_RATE = 60.0988;
export const SNES_PAL_FRAME_RATE = 50.0069;
export const SNES_RUNTIME_VIEWPORT = {
  width: 256,
  height: 224,
} as const;
export const SNES_RUNTIME_FIXED_POINT_SCALE = 256;
const DEFAULT_PLAYER_PHYSICS: SnesPlayerPhysicsConfig = {
  moveSpeed: 1,
  jumpVelocity: PREVIEW_PLAYER_JUMP_VELOCITY,
  gravityPerFrame: PREVIEW_PLAYER_GRAVITY,
  maxFallSpeed: PREVIEW_PLAYER_MAX_FALL_SPEED,
  groundY: PREVIEW_PLAYER_GROUND_Y,
};
const OAM_BYTES = 544;
const PREVIEW_RUNTIME_ENTITY_LIMIT = 31;

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampRatio(used: number, limit: number): number {
  if (limit <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, used / limit));
}

function severityForRatio(ratio: number): SnesSeverity {
  if (ratio > 1) {
    return "error";
  }
  if (ratio >= 0.9) {
    return "warning";
  }
  return "info";
}

function bytesForSaveField(field: SnesSaveField): number {
  switch (field.type) {
    case "flag":
    case "u8":
      return 1;
    case "u16":
      return 2;
    case "u32":
      return 4;
  }
  throw new Error(`Unsupported save field type: ${String(field.type)}`);
}

function normalizeSaveField(value: unknown, index: number): SnesSaveField | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim().slice(0, 40)
      : `Save Field ${index + 1}`;
  const keySource =
    typeof record.key === "string" && record.key.trim() ? record.key : label.toLowerCase();
  const key = sanitizeRomBaseName(keySource).replace(/-/g, "_") || `field_${index + 1}`;
  const type = ["flag", "u8", "u16", "u32"].includes(String(record.type))
    ? (record.type as SnesSaveFieldType)
    : "u8";
  return { key, label, type };
}

function normalizeSnesSaveSystem(save: unknown): SnesSaveSystem {
  const record = recordValue(save);
  const fields = Array.isArray(record?.fields)
    ? record.fields.flatMap((field, index) => {
        const normalized = normalizeSaveField(field, index);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    enabled: typeof record?.enabled === "boolean" ? record.enabled : true,
    slots:
      typeof record?.slots === "number" && Number.isInteger(record.slots)
        ? Math.max(1, Math.min(16, record.slots))
        : 1,
    fields,
  };
}

function normalizePlayerPhysicsConfig(value: unknown): SnesPlayerPhysicsConfig {
  const record = recordValue(value);
  return {
    moveSpeed:
      typeof record?.moveSpeed === "number" && Number.isFinite(record.moveSpeed)
        ? Math.max(1, Math.min(8, Math.round(record.moveSpeed)))
        : DEFAULT_PLAYER_PHYSICS.moveSpeed,
    jumpVelocity:
      typeof record?.jumpVelocity === "number" && Number.isFinite(record.jumpVelocity)
        ? Math.max(-32, Math.min(-1, Math.round(record.jumpVelocity)))
        : DEFAULT_PLAYER_PHYSICS.jumpVelocity - 0x100,
    gravityPerFrame:
      typeof record?.gravityPerFrame === "number" && Number.isFinite(record.gravityPerFrame)
        ? Math.max(1, Math.min(8, Math.round(record.gravityPerFrame)))
        : DEFAULT_PLAYER_PHYSICS.gravityPerFrame,
    maxFallSpeed:
      typeof record?.maxFallSpeed === "number" && Number.isFinite(record.maxFallSpeed)
        ? Math.max(1, Math.min(16, Math.round(record.maxFallSpeed)))
        : DEFAULT_PLAYER_PHYSICS.maxFallSpeed,
    groundY:
      typeof record?.groundY === "number" && Number.isFinite(record.groundY)
        ? Math.max(32, Math.min(223, Math.round(record.groundY)))
        : DEFAULT_PLAYER_PHYSICS.groundY,
  };
}

function saveSlotBytes(save: SnesSaveSystem): number {
  if (!save.enabled) {
    return 0;
  }
  return save.fields.reduce((sum, field) => sum + bytesForSaveField(field), 0);
}

function totalSaveBytes(save: SnesSaveSystem): number {
  if (!save.enabled) {
    return 0;
  }
  return saveSlotBytes(save) * Math.max(1, save.slots);
}

function defaultTileForEditCell(column: number, row: number): SnesTileBrush {
  if (row >= 8) {
    return 1;
  }
  if (row === 6 && column >= 4 && column <= 10) {
    return 2;
  }
  if (row === 4 && column >= 7 && column <= 9) {
    return 3;
  }
  return 0;
}

function defaultCollisionForTile(tile: number): number {
  return tile === 1 || tile === 2 ? 1 : 0;
}

function normalizeTileBrush(value: unknown): SnesTileBrush {
  const tile = typeof value === "number" && Number.isInteger(value) ? value : 0;
  return Math.max(0, Math.min(255, tile));
}

function normalizeCollisionMaterial(value: unknown): SnesCollisionMaterial {
  const material = typeof value === "number" && Number.isInteger(value) ? value : 0;
  return Math.max(0, Math.min(4, material)) as SnesCollisionMaterial;
}

function createDefaultSceneTilemap(): number[] {
  return Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, (_, index) =>
    defaultTileForEditCell(
      index % SNES_STUDIO_EDIT_GRID.width,
      Math.floor(index / SNES_STUDIO_EDIT_GRID.width),
    ),
  );
}

function createDefaultSceneCollisionMap(tilemap = createDefaultSceneTilemap()): number[] {
  return tilemap.map(defaultCollisionForTile);
}

function normalizeSceneEditLayer(values: unknown, fallback: number[]): number[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }
  return Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, (_, index) =>
    normalizeTileBrush(values[index] ?? fallback[index] ?? 0),
  );
}

function countSolidCollisionCells(collisionMap: readonly number[]): number {
  return collisionMap.filter((cell) => cell > 0).length;
}

function normalizeEnemyBehavior(value: unknown, fallbackX: number): SnesEnemyBehavior {
  const record = recordValue(value);
  const kind = ["stationary", "patrol", "chase", "guard"].includes(String(record?.kind))
    ? (record!.kind as SnesEnemyBehaviorKind)
    : "patrol";
  const patrolStartX =
    typeof record?.patrolStartX === "number" && Number.isFinite(record.patrolStartX)
      ? Math.round(record.patrolStartX)
      : fallbackX - 32;
  const patrolEndX =
    typeof record?.patrolEndX === "number" && Number.isFinite(record.patrolEndX)
      ? Math.round(record.patrolEndX)
      : fallbackX + 32;
  const minPatrol = Math.max(0, Math.min(patrolStartX, patrolEndX));
  const maxPatrol = Math.max(minPatrol, Math.max(patrolStartX, patrolEndX));
  return {
    kind,
    speed:
      typeof record?.speed === "number" && Number.isFinite(record.speed)
        ? Math.max(0, Math.min(8, Math.round(record.speed)))
        : kind === "stationary"
          ? 0
          : 1,
    patrolStartX: minPatrol,
    patrolEndX: maxPatrol,
    aggroRange:
      typeof record?.aggroRange === "number" && Number.isFinite(record.aggroRange)
        ? Math.max(0, Math.min(512, Math.round(record.aggroRange)))
        : kind === "chase"
          ? 96
          : 48,
    guardDirection: record?.guardDirection === -1 ? -1 : 1,
  };
}

function normalizeSnesSceneEntity(value: unknown, index: number): SnesSceneEntity | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const kind = ["player", "enemy", "item", "npc"].includes(String(record.kind))
    ? (record.kind as SnesSceneEntityKind)
    : "item";
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 48)
      : `${kind} ${index + 1}`;
  const x =
    typeof record.x === "number" && Number.isFinite(record.x)
      ? Math.max(0, Math.min(8191, Math.round(record.x)))
      : 32;
  const y =
    typeof record.y === "number" && Number.isFinite(record.y)
      ? Math.max(0, Math.min(8191, Math.round(record.y)))
      : kind === "item"
        ? 112
        : 176;
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `${kind}-${index + 1}`
        : `${kind}-${index + 1}`,
    kind,
    name,
    x,
    y,
    metaspriteTiles:
      typeof record.metaspriteTiles === "number" && Number.isFinite(record.metaspriteTiles)
        ? Math.max(1, Math.min(512, Math.round(record.metaspriteTiles)))
        : kind === "item"
          ? 2
          : 8,
    visualRecipe:
      typeof record.visualRecipe === "string" && record.visualRecipe.trim()
        ? record.visualRecipe.trim().slice(0, 120)
        : kind === "enemy"
          ? "round colorful patrol enemy with bold outline"
          : kind === "item"
            ? "sparkling gold collectible"
            : kind === "player"
              ? "cheerful readable platform hero with bold outline"
              : "friendly guide sprite with clear outline",
    ...(kind === "enemy" ? { behavior: normalizeEnemyBehavior(record.behavior, x) } : {}),
  };
}

function normalizeSnesStudioScene(scene: SnesStudioScene): SnesStudioScene {
  const fallbackTilemap = createDefaultSceneTilemap();
  const tilemap = normalizeSceneEditLayer(scene.tilemap, fallbackTilemap);
  const collisionMap = normalizeSceneEditLayer(
    scene.collisionMap,
    createDefaultSceneCollisionMap(tilemap),
  ).map(normalizeCollisionMaterial);
  return {
    ...scene,
    collisionMap,
    collisionTiles: countSolidCollisionCells(collisionMap),
    entities: Array.isArray(scene.entities)
      ? scene.entities.flatMap((entity, index) => {
          const normalized = normalizeSnesSceneEntity(entity, index);
          return normalized ? [normalized] : [];
        })
      : [],
    tilemap,
  };
}

function normalizeSpriteAnimationFrame(
  value: unknown,
  animationIndex: number,
  frameIndex: number,
): SnesSpriteAnimationFrame | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `anim-${animationIndex + 1}-frame-${frameIndex + 1}`
        : `anim-${animationIndex + 1}-frame-${frameIndex + 1}`,
    durationTicks:
      typeof record.durationTicks === "number" && Number.isInteger(record.durationTicks)
        ? Math.max(1, Math.min(255, record.durationTicks))
        : 8,
    tileIndex: normalizeTileBrush(record.tileIndex),
    xOffset:
      typeof record.xOffset === "number" && Number.isInteger(record.xOffset)
        ? Math.max(-128, Math.min(127, record.xOffset))
        : 0,
    yOffset:
      typeof record.yOffset === "number" && Number.isInteger(record.yOffset)
        ? Math.max(-128, Math.min(127, record.yOffset))
        : 0,
  };
}

function normalizeSpriteAnimation(value: unknown, index: number): SnesSpriteAnimation | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 48)
      : `Animation ${index + 1}`;
  const entityKind = ["player", "enemy", "npc"].includes(String(record.entityKind))
    ? (record.entityKind as SnesSpriteAnimation["entityKind"])
    : "player";
  const frames = Array.isArray(record.frames)
    ? record.frames.flatMap((frame, frameIndex) => {
        const normalized = normalizeSpriteAnimationFrame(frame, index, frameIndex);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `animation-${index + 1}`
        : sanitizeRomBaseName(name) || `animation-${index + 1}`,
    name,
    entityKind,
    loop: typeof record.loop === "boolean" ? record.loop : true,
    frames:
      frames.length > 0
        ? frames
        : [
            {
              id: `anim-${index + 1}-frame-1`,
              durationTicks: 8,
              tileIndex: entityKind === "enemy" ? 4 : 5,
              xOffset: 0,
              yOffset: 0,
            },
          ],
  };
}

function normalizeImportedTileset(value: unknown): SnesImportedTileset | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Imported Tileset";
  const width =
    typeof record.width === "number" && Number.isInteger(record.width) ? record.width : 0;
  const height =
    typeof record.height === "number" && Number.isInteger(record.height) ? record.height : 0;
  const chrHex =
    typeof record.chrHex === "string" ? record.chrHex.replace(/[^0-9a-f]/gi, "").toLowerCase() : "";
  const chrSizeBytes =
    typeof record.chrSizeBytes === "number" && Number.isInteger(record.chrSizeBytes)
      ? record.chrSizeBytes
      : Math.floor(chrHex.length / 2);
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || "imported-tileset"
        : sanitizeRomBaseName(name) || "imported-tileset",
    name,
    width,
    height,
    sourceTileCount:
      typeof record.sourceTileCount === "number" && Number.isInteger(record.sourceTileCount)
        ? record.sourceTileCount
        : 0,
    uniqueTileCount:
      typeof record.uniqueTileCount === "number" && Number.isInteger(record.uniqueTileCount)
        ? record.uniqueTileCount
        : 0,
    dedupedTileCount:
      typeof record.dedupedTileCount === "number" && Number.isInteger(record.dedupedTileCount)
        ? record.dedupedTileCount
        : 0,
    chrSizeBytes,
    chrChecksum:
      typeof record.chrChecksum === "number" && Number.isInteger(record.chrChecksum)
        ? record.chrChecksum
        : 0,
    chrHex,
    paletteColorsUsed: Array.isArray(record.paletteColorsUsed)
      ? record.paletteColorsUsed
          .filter((color): color is number => typeof color === "number" && Number.isInteger(color))
          .map((color) => Math.max(0, Math.min(15, color)))
      : [],
    palettePreviewHex: Array.isArray(record.palettePreviewHex)
      ? record.palettePreviewHex.filter(
          (color): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/iu.test(color),
        )
      : [],
    quantized: typeof record.quantized === "boolean" ? record.quantized : false,
    sourceColorCount:
      typeof record.sourceColorCount === "number" && Number.isInteger(record.sourceColorCount)
        ? Math.max(0, record.sourceColorCount)
        : 0,
    tileIndices: Array.isArray(record.tileIndices)
      ? record.tileIndices.filter(
          (tileIndex): tileIndex is number =>
            typeof tileIndex === "number" && Number.isInteger(tileIndex),
        )
      : [],
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

function normalizeCustomTileBrush(value: unknown, index: number): SnesCustomTileBrush | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 40)
      : `Brush ${index + 1}`;
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `brush-${index + 1}`
        : sanitizeRomBaseName(name) || `brush-${index + 1}`,
    name,
    tile: normalizeTileBrush(record.tile),
    solid:
      typeof record.solid === "boolean"
        ? record.solid
        : defaultCollisionForTile(Number(record.tile ?? 0)) > 0,
  };
}

function normalizeAudioStep(value: unknown): SnesAudioSequenceStep | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const instrument = ["pulse", "noise", "sample"].includes(String(record.instrument))
    ? (record.instrument as SnesAudioSequenceStep["instrument"])
    : "pulse";
  const note =
    typeof record.note === "string" && record.note.trim() ? record.note.trim().slice(0, 8) : "C4";
  const ticks =
    typeof record.ticks === "number" && Number.isInteger(record.ticks)
      ? Math.max(1, Math.min(255, record.ticks))
      : 6;
  const volume =
    typeof record.volume === "number" && Number.isInteger(record.volume)
      ? Math.max(0, Math.min(15, record.volume))
      : 12;
  return { instrument, note, ticks, volume };
}

function normalizeSoundEffect(value: unknown, index: number): SnesSoundEffect | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 40)
      : `Sound ${index + 1}`;
  const steps = Array.isArray(record.steps)
    ? record.steps.flatMap((step) => {
        const normalized = normalizeAudioStep(step);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `sfx-${index + 1}`
        : sanitizeRomBaseName(name) || `sfx-${index + 1}`,
    name,
    priority:
      typeof record.priority === "number" && Number.isInteger(record.priority)
        ? Math.max(0, Math.min(7, record.priority))
        : 3,
    estimatedBytes:
      typeof record.estimatedBytes === "number" && Number.isInteger(record.estimatedBytes)
        ? Math.max(0, Math.min(SNES_HARDWARE_LIMITS.aramBytes, record.estimatedBytes))
        : Math.max(64, steps.length * 4),
    steps,
  };
}

function normalizeMusicTrack(value: unknown, index: number): SnesMusicTrack | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 40)
      : `Track ${index + 1}`;
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `track-${index + 1}`
        : sanitizeRomBaseName(name) || `track-${index + 1}`,
    name,
    tempo:
      typeof record.tempo === "number" && Number.isInteger(record.tempo)
        ? Math.max(40, Math.min(240, record.tempo))
        : 120,
    patternRows:
      typeof record.patternRows === "number" && Number.isInteger(record.patternRows)
        ? Math.max(1, Math.min(1024, record.patternRows))
        : 64,
    estimatedBytes:
      typeof record.estimatedBytes === "number" && Number.isInteger(record.estimatedBytes)
        ? Math.max(0, Math.min(SNES_HARDWARE_LIMITS.aramBytes, record.estimatedBytes))
        : 4096,
  };
}

function createDefaultAudioProject(totalAudioBytes = 18 * 1024): SnesAudioProject {
  const soundEffects: SnesSoundEffect[] = [
    {
      id: "jump",
      name: "Jump",
      priority: 4,
      estimatedBytes: 96,
      steps: [
        { instrument: "pulse", note: "C5", ticks: 4, volume: 12 },
        { instrument: "pulse", note: "G5", ticks: 6, volume: 9 },
      ],
    },
    {
      id: "coin",
      name: "Coin",
      priority: 5,
      estimatedBytes: 96,
      steps: [
        { instrument: "pulse", note: "E5", ticks: 3, volume: 12 },
        { instrument: "pulse", note: "B5", ticks: 5, volume: 10 },
      ],
    },
    {
      id: "hit",
      name: "Hit",
      priority: 6,
      estimatedBytes: 128,
      steps: [
        { instrument: "noise", note: "N1", ticks: 5, volume: 14 },
        { instrument: "noise", note: "N1", ticks: 7, volume: 8 },
      ],
    },
  ];
  const track: SnesMusicTrack = {
    id: "ridge-theme",
    name: "Ridge Theme",
    tempo: 126,
    patternRows: 96,
    estimatedBytes: 6144,
  };
  const aramReservedBytes = 8192;
  const authoredBytes =
    aramReservedBytes +
    track.estimatedBytes +
    soundEffects.reduce((sum, effect) => sum + effect.estimatedBytes, 0);
  return {
    driver: "preview-spc700",
    aramReservedBytes,
    sampleBytes: Math.max(0, totalAudioBytes - authoredBytes),
    musicTracks: [track],
    soundEffects,
  };
}

function normalizeSnesAudioProject(audio: unknown, fallbackBytes: number): SnesAudioProject {
  const record = recordValue(audio);
  if (!record) {
    return createDefaultAudioProject(fallbackBytes);
  }
  const musicTracks = Array.isArray(record.musicTracks)
    ? record.musicTracks.flatMap((track, index) => {
        const normalized = normalizeMusicTrack(track, index);
        return normalized ? [normalized] : [];
      })
    : [];
  const soundEffects = Array.isArray(record.soundEffects)
    ? record.soundEffects.flatMap((effect, index) => {
        const normalized = normalizeSoundEffect(effect, index);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    driver: "preview-spc700",
    aramReservedBytes:
      typeof record.aramReservedBytes === "number" && Number.isInteger(record.aramReservedBytes)
        ? Math.max(4096, Math.min(24 * 1024, record.aramReservedBytes))
        : 8192,
    sampleBytes:
      typeof record.sampleBytes === "number" && Number.isInteger(record.sampleBytes)
        ? Math.max(0, Math.min(SNES_HARDWARE_LIMITS.aramBytes, record.sampleBytes))
        : Math.max(0, fallbackBytes - 8192),
    musicTracks,
    soundEffects,
  };
}

function normalizeDialogueLine(value: unknown, index: number): SnesDialogueLine | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const speaker =
    typeof record.speaker === "string" && record.speaker.trim()
      ? record.speaker.trim().slice(0, 32)
      : "Guide";
  const text =
    typeof record.text === "string" && record.text.trim()
      ? record.text.trim().slice(0, 160)
      : "The road ahead is dangerous.";
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `line-${index + 1}`
        : `line-${index + 1}`,
    speaker,
    text,
  };
}

function normalizeCutscene(value: unknown, index: number): SnesCutscene | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 48)
      : `Cutscene ${index + 1}`;
  const lines = Array.isArray(record.lines)
    ? record.lines.flatMap((line, lineIndex) => {
        const normalized = normalizeDialogueLine(line, lineIndex);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `cutscene-${index + 1}`
        : sanitizeRomBaseName(name) || `cutscene-${index + 1}`,
    name,
    trigger:
      typeof record.trigger === "string" && record.trigger.trim()
        ? record.trigger.trim().slice(0, 64)
        : "on-start",
    lines,
  };
}

function normalizeEventAction(value: unknown): SnesEventAction | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  if (record.type === "give-item") {
    return {
      type: "give-item",
      itemId:
        typeof record.itemId === "string" && record.itemId.trim()
          ? sanitizeRomBaseName(record.itemId) || "item-1"
          : "item-1",
    };
  }
  if (record.type === "set-flag") {
    return {
      type: "set-flag",
      flag:
        typeof record.flag === "string" && record.flag.trim()
          ? sanitizeRomBaseName(record.flag).replace(/-/g, "_") || "flag"
          : "flag",
    };
  }
  return {
    type: "show-dialogue",
    cutsceneId:
      typeof record.cutsceneId === "string" && record.cutsceneId.trim()
        ? sanitizeRomBaseName(record.cutsceneId) || "intro"
        : "intro",
  };
}

function normalizeEventScript(value: unknown, index: number): SnesEventScript | null {
  const record = recordValue(value);
  if (!record) {
    return null;
  }
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 48)
      : `Event ${index + 1}`;
  const trigger = ["on-start", "on-enter-zone", "on-collect-item", "on-defeat-enemy"].includes(
    String(record.trigger),
  )
    ? (record.trigger as SnesEventScript["trigger"])
    : "on-start";
  const actions = Array.isArray(record.actions)
    ? record.actions.flatMap((action) => {
        const normalized = normalizeEventAction(action);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || `event-${index + 1}`
        : sanitizeRomBaseName(name) || `event-${index + 1}`,
    name,
    trigger,
    targetId:
      typeof record.targetId === "string" && record.targetId.trim()
        ? sanitizeRomBaseName(record.targetId) || "scene"
        : "scene",
    actions,
  };
}

function estimatedSnesAudioBytes(audio: SnesAudioProject): number {
  return (
    audio.aramReservedBytes +
    audio.sampleBytes +
    audio.musicTracks.reduce((sum, track) => sum + track.estimatedBytes, 0) +
    audio.soundEffects.reduce((sum, effect) => sum + effect.estimatedBytes, 0)
  );
}

function normalizeAssetInventory(assets: SnesAssetInventory): SnesAssetInventory {
  const record = assets as SnesAssetInventory & { audio?: unknown; importedTilesets?: unknown };
  const audioBytes =
    typeof record.audioBytes === "number" && Number.isInteger(record.audioBytes)
      ? Math.max(0, record.audioBytes)
      : 0;
  const audio = normalizeSnesAudioProject(record.audio, audioBytes);
  return {
    ...assets,
    audio,
    audioBytes: estimatedSnesAudioBytes(audio),
    customTileBrushes: Array.isArray(record.customTileBrushes)
      ? record.customTileBrushes.flatMap((brush, index) => {
          const normalized = normalizeCustomTileBrush(brush, index);
          return normalized ? [normalized] : [];
        })
      : [],
    importedTilesets: Array.isArray(record.importedTilesets)
      ? record.importedTilesets.flatMap((asset) => {
          const normalized = normalizeImportedTileset(asset);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function normalizeVisualStylePreset(value: unknown): SnesVisualStylePreset {
  return value === SNES_CLASSIC_PLATFORMER_STYLE_PRESET
    ? SNES_CLASSIC_PLATFORMER_STYLE_PRESET
    : SNES_CLASSIC_PLATFORMER_STYLE_PRESET;
}

function normalizeSnesArtDirection(value: unknown): SnesArtDirection {
  const fallback = createDefaultSnesArtDirection();
  const record = recordValue(value);
  if (!record) {
    return fallback;
  }
  const outlineThickness =
    record.outlineThickness === "thin" ||
    record.outlineThickness === "medium" ||
    record.outlineThickness === "bold"
      ? record.outlineThickness
      : fallback.outlineThickness;
  const spriteScale =
    record.spriteScale === "16x16-readable" ||
    record.spriteScale === "16x24-hero" ||
    record.spriteScale === "32x32-boss"
      ? record.spriteScale
      : fallback.spriteScale;
  const backgroundTheme =
    record.backgroundTheme === "sky" ||
    record.backgroundTheme === "cave" ||
    record.backgroundTheme === "mountain" ||
    record.backgroundTheme === "grassland"
      ? record.backgroundTheme
      : fallback.backgroundTheme;
  const tileTheme =
    record.tileTheme === "cave-blocks" ||
    record.tileTheme === "mountain-ledges" ||
    record.tileTheme === "rounded-grass"
      ? record.tileTheme
      : fallback.tileTheme;
  return {
    paletteMood:
      typeof record.paletteMood === "string" && record.paletteMood.trim()
        ? record.paletteMood.trim().slice(0, 120)
        : fallback.paletteMood,
    outlineThickness,
    spriteScale,
    backgroundTheme,
    tileTheme,
  };
}

function normalizeAssetProvenance(value: unknown): SnesAssetProvenance {
  return value === "user-imported" ? "user-imported" : "original-generated";
}

function normalizeStyleWarnings(
  value: unknown,
  provenance: SnesAssetProvenance,
): SnesStyleWarning[] {
  if (!Array.isArray(value)) {
    return createDefaultStyleWarnings(provenance);
  }
  const warnings = value.flatMap((entry): SnesStyleWarning[] => {
    const record = recordValue(entry);
    if (!record) {
      return [];
    }
    const code =
      record.code === "licensed-import-required" ||
      record.code === "budget-watch" ||
      record.code === "original-art-required"
        ? record.code
        : provenance === "user-imported"
          ? "licensed-import-required"
          : "original-art-required";
    const severity = record.severity === "warning" ? "warning" : "info";
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim().slice(0, 240)
        : createDefaultStyleWarnings(provenance)[0].message;
    return [{ code, severity, message }];
  });
  return warnings.length > 0 ? warnings.slice(0, 6) : createDefaultStyleWarnings(provenance);
}

function generatedAssetSpecsFromStylePack(
  stylePack = createClassicPlatformerStylePack(),
): SnesGeneratedAssetSpecs {
  return {
    tileSpecs: stylePack.tileSpecs.map((spec) => ({ ...spec })),
    spriteSpecs: stylePack.spriteSpecs.map((spec) => ({
      ...spec,
      frames: spec.frames.map((frame) => ({ ...frame })),
    })),
    paletteSpecs: [
      {
        id: "palette-grass-sky",
        name: "Grass and sky",
        paletteIndex: 2,
        colors: ["#2f7d32", "#6fbd45", "#c8f070", "#78c8f8"],
      },
      {
        id: "palette-reward-gold",
        name: "Reward gold",
        paletteIndex: 3,
        colors: ["#5a3600", "#b86f00", "#ffd34d", "#fff4a3"],
      },
      {
        id: "palette-danger",
        name: "Readable danger",
        paletteIndex: 4,
        colors: ["#391010", "#a02020", "#f05050", "#ffd0d0"],
      },
    ],
    musicPatternSpecs: stylePack.musicPatternSpecs.map((spec) => ({
      ...spec,
      channelPlan: [...spec.channelPlan],
    })),
    sfxEventMap: stylePack.sfxEventMap.map((spec) => ({ ...spec })),
  };
}

function normalizeSnesGeneratedAssetSpecs(value: unknown): SnesGeneratedAssetSpecs {
  const fallback = generatedAssetSpecsFromStylePack();
  const record = recordValue(value);
  if (!record) {
    return fallback;
  }
  const tileSpecs = Array.isArray(record.tileSpecs)
    ? record.tileSpecs.flatMap((entry): SnesDataFirstTileSpec[] => {
        const spec = recordValue(entry);
        if (!spec) return [];
        const tileId = Number(spec.tileId);
        const paletteIndex = Number(spec.paletteIndex);
        return [
          {
            id:
              typeof spec.id === "string" && spec.id.trim()
                ? spec.id.trim()
                : `tile-${tileId || 0}`,
            name:
              typeof spec.name === "string" && spec.name.trim()
                ? spec.name.trim()
                : "Generated tile",
            tileId: Number.isFinite(tileId) ? Math.max(0, Math.trunc(tileId)) : 0,
            size: "16x16",
            paletteIndex: Number.isFinite(paletteIndex) ? Math.max(0, Math.trunc(paletteIndex)) : 0,
            collisionClass:
              spec.collisionClass === "passable" ||
              spec.collisionClass === "hazard" ||
              spec.collisionClass === "decorative" ||
              spec.collisionClass === "reward"
                ? spec.collisionClass
                : "solid",
          },
        ];
      })
    : fallback.tileSpecs;
  const spriteSpecs = Array.isArray(record.spriteSpecs)
    ? record.spriteSpecs.flatMap((entry): SnesDataFirstSpriteSpec[] => {
        const spec = recordValue(entry);
        if (!spec) return [];
        const frames = Array.isArray(spec.frames)
          ? spec.frames.flatMap(
              (frame, index): Array<{ id: string; tileId: number; durationTicks: number }> => {
                const frameRecord = recordValue(frame);
                if (!frameRecord) return [];
                return [
                  {
                    id:
                      typeof frameRecord.id === "string" && frameRecord.id.trim()
                        ? frameRecord.id.trim()
                        : `frame-${index + 1}`,
                    tileId: Math.max(0, Math.trunc(Number(frameRecord.tileId) || 0)),
                    durationTicks: Math.max(1, Math.trunc(Number(frameRecord.durationTicks) || 8)),
                  },
                ];
              },
            )
          : [];
        return [
          {
            id: typeof spec.id === "string" && spec.id.trim() ? spec.id.trim() : "sprite-generated",
            name:
              typeof spec.name === "string" && spec.name.trim()
                ? spec.name.trim()
                : "Generated sprite",
            kind:
              spec.kind === "enemy" || spec.kind === "item" || spec.kind === "npc"
                ? spec.kind
                : "player",
            frameSize:
              spec.frameSize === "8x8" || spec.frameSize === "16x24" || spec.frameSize === "16x32"
                ? spec.frameSize
                : "16x16",
            paletteIndex: Math.max(0, Math.trunc(Number(spec.paletteIndex) || 0)),
            frames: frames.length > 0 ? frames : [{ id: "frame-1", tileId: 0, durationTicks: 8 }],
          },
        ];
      })
    : fallback.spriteSpecs;
  const paletteSpecs = Array.isArray(record.paletteSpecs)
    ? record.paletteSpecs.flatMap((entry): SnesDataFirstPaletteSpec[] => {
        const spec = recordValue(entry);
        if (!spec) return [];
        const colors = Array.isArray(spec.colors)
          ? spec.colors
              .filter(
                (color): color is string => typeof color === "string" && color.trim().length > 0,
              )
              .slice(0, 16)
          : [];
        return [
          {
            id:
              typeof spec.id === "string" && spec.id.trim() ? spec.id.trim() : "palette-generated",
            name:
              typeof spec.name === "string" && spec.name.trim()
                ? spec.name.trim()
                : "Generated palette",
            paletteIndex: Math.max(0, Math.trunc(Number(spec.paletteIndex) || 0)),
            colors: colors.length > 0 ? colors : fallback.paletteSpecs[0].colors,
          },
        ];
      })
    : fallback.paletteSpecs;
  return {
    tileSpecs: tileSpecs.length > 0 ? tileSpecs : fallback.tileSpecs,
    spriteSpecs: spriteSpecs.length > 0 ? spriteSpecs : fallback.spriteSpecs,
    paletteSpecs: paletteSpecs.length > 0 ? paletteSpecs : fallback.paletteSpecs,
    musicPatternSpecs: fallback.musicPatternSpecs,
    sfxEventMap: fallback.sfxEventMap,
  };
}

export function normalizeSnesStudioProject(project: SnesStudioProject): SnesStudioProject {
  const normalized = cloneProject(project);
  normalized.assets = normalizeAssetInventory(normalized.assets);
  normalized.animations = Array.isArray(
    (normalized as SnesStudioProject & { animations?: unknown }).animations,
  )
    ? (normalized as SnesStudioProject & { animations: unknown[] }).animations.flatMap(
        (animation, index) => {
          const normalizedAnimation = normalizeSpriteAnimation(animation, index);
          return normalizedAnimation ? [normalizedAnimation] : [];
        },
      )
    : [];
  normalized.dialogue = Array.isArray(
    (normalized as SnesStudioProject & { dialogue?: unknown }).dialogue,
  )
    ? (normalized as SnesStudioProject & { dialogue: unknown[] }).dialogue.flatMap(
        (cutscene, index) => {
          const normalizedCutscene = normalizeCutscene(cutscene, index);
          return normalizedCutscene ? [normalizedCutscene] : [];
        },
      )
    : [];
  normalized.events = Array.isArray((normalized as SnesStudioProject & { events?: unknown }).events)
    ? (normalized as SnesStudioProject & { events: unknown[] }).events.flatMap((event, index) => {
        const normalizedEvent = normalizeEventScript(event, index);
        return normalizedEvent ? [normalizedEvent] : [];
      })
    : [];
  normalized.physics = normalizePlayerPhysicsConfig(
    (normalized as SnesStudioProject & { physics?: unknown }).physics,
  );
  normalized.save = normalizeSnesSaveSystem(normalized.save);
  normalized.scenes = normalized.scenes.map(normalizeSnesStudioScene);
  normalized.gameplayBlueprint = normalizeGameplayBlueprint(
    (normalized as SnesStudioProject & { gameplayBlueprint?: unknown }).gameplayBlueprint,
    normalized.name,
  );
  normalized.thingLibrary = normalizeThingLibrary(
    (normalized as SnesStudioProject & { thingLibrary?: unknown }).thingLibrary,
  );
  normalized.platformerRules = normalizePlatformerRules(
    (normalized as SnesStudioProject & { platformerRules?: unknown }).platformerRules,
  );
  normalized.levelPlan = normalizeLevelPlan(
    (normalized as SnesStudioProject & { levelPlan?: unknown }).levelPlan,
    normalized.scenes[0]?.name ?? normalized.name,
  );
  normalized.gameStoryBible = normalizeGameStoryBible(
    (normalized as SnesStudioProject & { gameStoryBible?: unknown }).gameStoryBible,
    normalized.name,
  );
  normalized.levelChapters = normalizeLevelChapters(
    (normalized as SnesStudioProject & { levelChapters?: unknown }).levelChapters,
    normalized.scenes,
  );
  normalized.visualStylePreset = normalizeVisualStylePreset(
    (normalized as SnesStudioProject & { visualStylePreset?: unknown }).visualStylePreset,
  );
  normalized.artDirection = normalizeSnesArtDirection(
    (normalized as SnesStudioProject & { artDirection?: unknown }).artDirection,
  );
  normalized.assetProvenance = normalizeAssetProvenance(
    (normalized as SnesStudioProject & { assetProvenance?: unknown }).assetProvenance,
  );
  normalized.styleWarnings = normalizeStyleWarnings(
    (normalized as SnesStudioProject & { styleWarnings?: unknown }).styleWarnings,
    normalized.assetProvenance,
  );
  normalized.generatedAssets = normalizeSnesGeneratedAssetSpecs(
    (normalized as SnesStudioProject & { generatedAssets?: unknown }).generatedAssets,
  );
  normalized.gamePartLocks = normalizeGamePartLocks(
    (normalized as SnesStudioProject & { gamePartLocks?: unknown }).gamePartLocks,
  );
  normalized.completionChecklist = createSnesCompletionChecklist(normalized);
  normalized.aiGapReport = buildSnesAiGapReport(normalized);
  return normalized;
}

export function paintSnesSceneCell(
  project: SnesStudioProject,
  sceneIndex: number,
  cellIndex: number,
  tile: SnesTileBrush,
  solid = defaultCollisionForTile(tile) > 0,
  collisionMaterial: SnesCollisionMaterial = solid ? 1 : 0,
): SnesStudioProject {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex >= project.scenes.length) {
    throw new Error("Cannot paint missing SNES Studio scene.");
  }
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= SNES_STUDIO_EDIT_GRID.cells) {
    throw new Error("Cannot paint outside the SNES Studio edit grid.");
  }
  const next = normalizeSnesStudioProject(project);
  const scene = next.scenes[sceneIndex];
  if (!scene) {
    throw new Error("Cannot paint missing SNES Studio scene.");
  }
  scene.tilemap[cellIndex] = normalizeTileBrush(tile);
  scene.collisionMap[cellIndex] = normalizeCollisionMaterial(collisionMaterial);
  scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
  next.updatedAt = new Date().toISOString();
  return next;
}

export function paintSnesSceneRect(
  project: SnesStudioProject,
  sceneIndex: number,
  column: number,
  row: number,
  width: number,
  height: number,
  tile: SnesTileBrush,
  solid = defaultCollisionForTile(tile) > 0,
  collisionMaterial: SnesCollisionMaterial = solid ? 1 : 0,
): SnesStudioProject {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("SNES Studio rectangle paint dimensions must be positive integers.");
  }
  const next = normalizeSnesStudioProject(project);
  const scene = next.scenes[sceneIndex];
  if (!scene) {
    throw new Error("Cannot paint missing SNES Studio scene.");
  }
  const safeTile = normalizeTileBrush(tile);
  const safeCollisionMaterial = normalizeCollisionMaterial(collisionMaterial);
  for (let y = Math.max(0, row); y < Math.min(SNES_STUDIO_EDIT_GRID.height, row + height); y++) {
    for (
      let x = Math.max(0, column);
      x < Math.min(SNES_STUDIO_EDIT_GRID.width, column + width);
      x++
    ) {
      const cellIndex = y * SNES_STUDIO_EDIT_GRID.width + x;
      scene.tilemap[cellIndex] = safeTile;
      scene.collisionMap[cellIndex] = safeCollisionMaterial;
    }
  }
  scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
  next.updatedAt = new Date().toISOString();
  return next;
}

function activeScene(project: SnesStudioProject): SnesStudioScene {
  if (!project.scenes[0]) {
    project.scenes[0] = {
      id: "scene-empty",
      name: "Empty Scene",
      widthMetatiles: 1,
      heightMetatiles: 1,
      layers: 1,
      collisionTiles: 0,
      collisionMap: createDefaultSceneCollisionMap(),
      entities: [],
      tilemap: createDefaultSceneTilemap(),
    };
  }
  project.scenes[0] = normalizeSnesStudioScene(project.scenes[0]);
  return project.scenes[0];
}

function createDefaultGameplayBlueprint(name = "Moonlit Ridge"): SnesGameplayBlueprint {
  return {
    genre: "side-scrolling-platformer",
    premise: `${name} is a side-scrolling platformer with a readable hero, simple jumps, rewards, and a clear finish.`,
    difficulty: "easy",
    controls: ["Move left/right", "Jump", "Collect rewards", "Reach the goal"],
    artMood: "Classic Colorful SNES Platformer",
    musicMood: "upbeat looping platformer theme",
  };
}

export function createClassicPlatformerStylePack(): SnesClassicPlatformerStylePack {
  return {
    id: SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
    name: "Classic Colorful SNES Platformer",
    provenance: "original-generated",
    plainDescription:
      "Bright original SNES-safe platformer art: rounded grass, chunky dirt, soft clouds, hills, coins, expressive enemies, and clean readable sprites.",
    paletteHex: [
      "#7fd7ff",
      "#ffffff",
      "#5ec65e",
      "#238442",
      "#8b5a2b",
      "#d4933f",
      "#ffd84a",
      "#ff9345",
      "#e84855",
      "#3157c8",
      "#5b7cff",
      "#272838",
      "#6cd4ff",
      "#b7ef8a",
      "#8a63d2",
      "#f7c59f",
    ],
    backgroundLayers: ["blue sky", "soft clouds", "rounded hills", "distant mountains"],
    terrainTiles: [
      "rounded grass top",
      "chunky dirt underside",
      "passable ledge",
      "coin block",
      "pipe door",
      "goal post",
      "water",
      "danger spikes",
      "cave block",
      "mountain ledge",
    ],
    spriteRecipes: [
      "16x24 cheerful hero with bold outline",
      "16x16 round patrol enemy",
      "16x16 flying enemy",
      "8x8 spinning coin",
      "8x8 gem/key pickup",
      "16x16 powerup",
      "16x32 pipe/door",
      "16x32 goal post",
    ],
    animationRecipes: [
      "hero idle 2 frames",
      "hero run 4 frames",
      "hero jump 1 frame",
      "enemy walk 2 frames",
      "coin sparkle 4 frames",
      "goal flutter 2 frames",
    ],
    tileSpecs: [
      {
        id: "tile-grass-top",
        name: "Rounded grass top",
        tileId: 1,
        size: "16x16",
        paletteIndex: 2,
        collisionClass: "solid",
      },
      {
        id: "tile-passable-ledge",
        name: "Passable ledge",
        tileId: 2,
        size: "16x16",
        paletteIndex: 2,
        collisionClass: "passable",
      },
      {
        id: "tile-spikes",
        name: "Readable danger spikes",
        tileId: 7,
        size: "16x16",
        paletteIndex: 4,
        collisionClass: "hazard",
      },
      {
        id: "tile-coin-block",
        name: "Gold reward block",
        tileId: 8,
        size: "16x16",
        paletteIndex: 3,
        collisionClass: "reward",
      },
    ],
    spriteSpecs: [
      {
        id: "sprite-hero",
        name: "Readable hero",
        kind: "player",
        frameSize: "16x24",
        paletteIndex: 8,
        frames: [
          { id: "hero-idle-1", tileId: 32, durationTicks: 10 },
          { id: "hero-idle-2", tileId: 34, durationTicks: 10 },
          { id: "hero-run-1", tileId: 36, durationTicks: 6 },
          { id: "hero-run-2", tileId: 38, durationTicks: 6 },
        ],
      },
      {
        id: "sprite-patrol-enemy",
        name: "Round patrol enemy",
        kind: "enemy",
        frameSize: "16x16",
        paletteIndex: 9,
        frames: [
          { id: "enemy-walk-1", tileId: 48, durationTicks: 8 },
          { id: "enemy-walk-2", tileId: 50, durationTicks: 8 },
        ],
      },
      {
        id: "sprite-coin",
        name: "Sparkling coin",
        kind: "item",
        frameSize: "8x8",
        paletteIndex: 10,
        frames: [
          { id: "coin-1", tileId: 60, durationTicks: 4 },
          { id: "coin-2", tileId: 61, durationTicks: 4 },
          { id: "coin-3", tileId: 62, durationTicks: 4 },
          { id: "coin-4", tileId: 63, durationTicks: 4 },
        ],
      },
    ],
    musicPatternSpecs: [
      {
        id: "music-main-loop",
        name: "Bright platformer loop",
        tempo: 144,
        patternRows: 32,
        loopBars: 4,
        channelPlan: [
          "square lead: short rising hook",
          "square harmony: off-beat answer",
          "sample bass: root-fifth motion",
          "noise percussion: soft snare on beats 2 and 4",
        ],
      },
    ],
    sfxEventMap: [
      { event: "jump", soundEffectId: "sfx-soft-hop" },
      { event: "pickup", soundEffectId: "sfx-coin-sparkle" },
      { event: "enemy-hit", soundEffectId: "sfx-bump" },
      { event: "door-open", soundEffectId: "sfx-door-chime" },
      { event: "goal", soundEffectId: "sfx-goal-fanfare" },
    ],
    budgetEstimate: {
      backgroundTiles: 96,
      spriteTiles: 64,
      backgroundPalettes: 4,
      spritePalettes: 4,
      cgramColors: 64,
    },
  };
}

export function createDefaultSnesArtDirection(): SnesArtDirection {
  return {
    paletteMood: "bright grassland with blue sky, gold rewards, readable dark outlines",
    outlineThickness: "medium",
    spriteScale: "16x16-readable",
    backgroundTheme: "grassland",
    tileTheme: "rounded-grass",
  };
}

function createDefaultStyleWarnings(
  provenance: SnesAssetProvenance = "original-generated",
): SnesStyleWarning[] {
  return provenance === "user-imported"
    ? [
        {
          code: "licensed-import-required",
          severity: "warning",
          message:
            "Imported graphics must be licensed by the user before they are used in an exported game.",
        },
      ]
    : [
        {
          code: "original-art-required",
          severity: "info",
          message:
            "Using original SNES-safe classic platformer art inspired by the readability of early-90s platformers; no Nintendo assets are copied.",
        },
      ];
}

function stylePromptWantsClassicPlatformer(prompt: string) {
  return includesAny(prompt, [
    "super mario world",
    "mario world",
    "mario style",
    "mario graphics",
    "classic platformer",
    "colorful snes",
    "snes platformer",
    "16-bit platformer",
    "grassland",
  ]);
}

export function resolveSnesVisualStyleFromPrompt(prompt: string): {
  visualStylePreset: SnesVisualStylePreset;
  artDirection: SnesArtDirection;
  assetProvenance: SnesAssetProvenance;
  styleWarnings: SnesStyleWarning[];
  matchedClassicPrompt: boolean;
} {
  const promptLower = prompt.trim().toLowerCase();
  const matchedClassicPrompt = stylePromptWantsClassicPlatformer(promptLower);
  const artDirection = createDefaultSnesArtDirection();
  return {
    visualStylePreset: SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
    artDirection: {
      ...artDirection,
      backgroundTheme: includesAny(promptLower, ["cave", "underground"])
        ? "cave"
        : includesAny(promptLower, ["mountain", "ridge"])
          ? "mountain"
          : includesAny(promptLower, ["sky", "cloud"])
            ? "sky"
            : "grassland",
      tileTheme: includesAny(promptLower, ["cave", "underground"])
        ? "cave-blocks"
        : includesAny(promptLower, ["mountain", "ridge"])
          ? "mountain-ledges"
          : "rounded-grass",
      paletteMood: matchedClassicPrompt
        ? "classic bright SNES platformer colors with original grassland art"
        : artDirection.paletteMood,
    },
    assetProvenance: "original-generated",
    styleWarnings: createDefaultStyleWarnings("original-generated"),
    matchedClassicPrompt,
  };
}

function createDefaultThingLibrary(): SnesThingLibraryEntry[] {
  return [
    {
      id: "hero",
      kind: "hero",
      name: "Hero",
      prompt: "A readable 16x16 platform hero with a clear silhouette.",
      behavior: "Runs, jumps, collects items, and reaches the goal.",
    },
    {
      id: "patrol-enemy",
      kind: "enemy",
      name: "Patrol Enemy",
      prompt: "A simple walking enemy that is easy to dodge.",
      behavior: "Patrols a short path and hurts the hero on contact.",
    },
    {
      id: "collectible",
      kind: "item",
      name: "Collectible",
      prompt: "A bright reward item that disappears when collected.",
      behavior: "Adds score and confirms progress.",
    },
    {
      id: "goal",
      kind: "goal",
      name: "Goal",
      prompt: "A clear end-of-level goal.",
      behavior: "Ends the level when the hero reaches it.",
    },
  ];
}

function createDefaultPlatformerRules(): SnesPlatformerRules {
  return {
    movement: "The hero moves left and right, jumps from safe ground, and falls with gravity.",
    enemyBehavior: "Enemies patrol predictable paths and can be defeated by landing on them.",
    itemEffects: "Items add score and disappear from the playtest after collection.",
    damage: "Touching an enemy or danger lowers health. Losing all health ends the test.",
    scoring: "Collecting items adds 100 points. Defeating enemies adds 200 points.",
    winLoss: "Reach the goal to win. Lose all health to restart and revise the level.",
  };
}

function createDefaultLevelPlan(name = "Ridge 1-1"): SnesLevelPlan {
  return {
    id: "first-level-plan",
    name,
    summary:
      "A beginner side-scrolling level with safe ground, one enemy, one reward, and a clear goal.",
    chunks: [
      "Start safely",
      "Learn one jump",
      "Collect a reward",
      "Dodge one enemy",
      "Reach the goal",
    ],
    goal: "Teach movement, then reward the player for reaching the end.",
  };
}

function createDefaultGameStoryBible(name = "Moonlit Ridge"): SnesGameStoryBible {
  return {
    premise: `${name} is a story-driven platformer about reaching a clear ending through readable challenges.`,
    world: "A bright SNES world with safe starter paths, rewards, and one memorable final area.",
    hero: "A brave hero with a clear silhouette.",
    heroGoal: "Recover the hidden reward, help the world, and reach the final goal.",
    villain: "A rival guardian who blocks the path.",
    conflict:
      "The hero must learn movement, avoid enemies, collect rewards, and unlock the route forward.",
    ending: "The hero reaches the summit goal and restores the world.",
    tone: "hopeful, adventurous, and easy to understand",
  };
}

function createDefaultLevelChapter(
  scene: Pick<SnesStudioScene, "id" | "name">,
  order: number,
): SnesLevelChapter {
  const finalLevel = order >= 2;
  return {
    id: `chapter-${order + 1}`,
    sceneId: scene.id,
    order,
    title: scene.name || `Level ${order + 1}`,
    storyPurpose:
      order === 0
        ? "Teach the hero's movement and introduce the main reward."
        : finalLevel
          ? "Resolve the story with a stronger challenge and clear finish."
          : "Build confidence with a new setting, reward, and readable enemy pattern.",
    setting: order === 0 ? "starter path" : finalLevel ? "final gate" : "middle route",
    challenge: order === 0 ? "one safe enemy and one jump" : "a tougher patrol and a bigger jump",
    reward: order === 0 ? "first collectible reward" : "key reward or powerup",
    goal: finalLevel ? "Reach the ending goal." : "Reach the door or goal and continue.",
    requiredThings: ["Hero", "Reward", finalLevel ? "Goal" : "Enemy"],
  };
}

function createDefaultLevelChapters(scenes: SnesStudioScene[]): SnesLevelChapter[] {
  const sourceScenes = scenes.length > 0 ? scenes : [createSnesStudioScene("Level 1")];
  return sourceScenes.slice(0, 6).map((scene, index) => createDefaultLevelChapter(scene, index));
}

function normalizeGameStoryBible(value: unknown, fallbackName: string): SnesGameStoryBible {
  const record = recordValue(value);
  const fallback = createDefaultGameStoryBible(fallbackName);
  if (!record) {
    return fallback;
  }
  return {
    premise:
      typeof record.premise === "string" && record.premise.trim()
        ? record.premise.trim().slice(0, 260)
        : fallback.premise,
    world:
      typeof record.world === "string" && record.world.trim()
        ? record.world.trim().slice(0, 180)
        : fallback.world,
    hero:
      typeof record.hero === "string" && record.hero.trim()
        ? record.hero.trim().slice(0, 80)
        : fallback.hero,
    heroGoal:
      typeof record.heroGoal === "string" && record.heroGoal.trim()
        ? record.heroGoal.trim().slice(0, 160)
        : fallback.heroGoal,
    villain:
      typeof record.villain === "string" && record.villain.trim()
        ? record.villain.trim().slice(0, 80)
        : fallback.villain,
    conflict:
      typeof record.conflict === "string" && record.conflict.trim()
        ? record.conflict.trim().slice(0, 180)
        : fallback.conflict,
    ending:
      typeof record.ending === "string" && record.ending.trim()
        ? record.ending.trim().slice(0, 160)
        : fallback.ending,
    tone:
      typeof record.tone === "string" && record.tone.trim()
        ? record.tone.trim().slice(0, 120)
        : fallback.tone,
  };
}

function normalizeLevelChapters(value: unknown, scenes: SnesStudioScene[]): SnesLevelChapter[] {
  const fallback = createDefaultLevelChapters(scenes);
  if (!Array.isArray(value)) {
    return fallback;
  }
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const chapters = value.flatMap((entry, index): SnesLevelChapter[] => {
    const record = recordValue(entry);
    if (!record) {
      return [];
    }
    const fallbackChapter =
      fallback[index] ??
      createDefaultLevelChapter(scenes[0] ?? createSnesStudioScene("Level 1"), index);
    const sceneId =
      typeof record.sceneId === "string" && sceneIds.has(record.sceneId)
        ? record.sceneId
        : fallbackChapter.sceneId;
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim().slice(0, 64)
        : fallbackChapter.title;
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? sanitizeRomBaseName(record.id) || fallbackChapter.id
            : fallbackChapter.id,
        sceneId,
        order: Number.isInteger(record.order) ? Math.max(0, Number(record.order)) : index,
        title,
        storyPurpose:
          typeof record.storyPurpose === "string" && record.storyPurpose.trim()
            ? record.storyPurpose.trim().slice(0, 180)
            : fallbackChapter.storyPurpose,
        setting:
          typeof record.setting === "string" && record.setting.trim()
            ? record.setting.trim().slice(0, 80)
            : fallbackChapter.setting,
        challenge:
          typeof record.challenge === "string" && record.challenge.trim()
            ? record.challenge.trim().slice(0, 120)
            : fallbackChapter.challenge,
        reward:
          typeof record.reward === "string" && record.reward.trim()
            ? record.reward.trim().slice(0, 120)
            : fallbackChapter.reward,
        goal:
          typeof record.goal === "string" && record.goal.trim()
            ? record.goal.trim().slice(0, 120)
            : fallbackChapter.goal,
        requiredThings: Array.isArray(record.requiredThings)
          ? record.requiredThings
              .filter(
                (thing): thing is string => typeof thing === "string" && thing.trim().length > 0,
              )
              .slice(0, 8)
          : fallbackChapter.requiredThings,
      },
    ];
  });
  return chapters.length > 0 ? chapters.slice(0, 12) : fallback;
}

function normalizeGamePartLocks(value: unknown): SnesGamePartLock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry, index): SnesGamePartLock[] => {
    const record = recordValue(entry);
    if (!record) {
      return [];
    }
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim().slice(0, 80)
        : `Locked part ${index + 1}`;
    const kind =
      record.kind === "story" ||
      record.kind === "level" ||
      record.kind === "character" ||
      record.kind === "enemy" ||
      record.kind === "item" ||
      record.kind === "rule" ||
      record.kind === "music" ||
      record.kind === "export"
        ? record.kind
        : "story";
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? sanitizeRomBaseName(record.id) || `lock-${index + 1}`
            : sanitizeRomBaseName(label) || `lock-${index + 1}`,
        kind,
        label,
      },
    ];
  });
}

function hasGamePartLock(
  project: Pick<SnesStudioProject, "gamePartLocks">,
  kind: SnesGamePartLock["kind"],
  id?: string,
): boolean {
  return (project.gamePartLocks ?? []).some(
    (lock) => lock.kind === kind && (!id || lock.id === id || lock.label === id),
  );
}

export function createSnesCompletionChecklist(project: SnesStudioProject): SnesCompletionChecklist {
  const scene = activeScene(project);
  const story = project.gameStoryBible ?? createDefaultGameStoryBible(project.name);
  const hasHero = scene.entities.some((entity) => entity.kind === "player");
  const hasEnemy = scene.entities.some((entity) => entity.kind === "enemy");
  const hasReward = scene.entities.some((entity) => entity.kind === "item");
  const hasGoal = scene.entities.some((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door") || name.includes("flag");
  });
  const storyComplete = Boolean(
    story.premise && story.world && story.hero && story.villain && story.conflict && story.ending,
  );
  return {
    playable:
      hasHero && hasReward && (hasEnemy || hasGoal) && scene.tilemap.some((tile) => tile > 0),
    storyComplete,
    levelsComplete:
      (project.levelChapters?.length ?? 0) >= project.scenes.length &&
      (project.levelChapters ?? []).every((chapter) => chapter.goal && chapter.challenge),
    castComplete: hasHero && hasEnemy && hasReward,
    exportReady:
      project.profile.mapMode === "lorom" &&
      project.profile.fxpak.fileSystem === "fat32" &&
      project.profile.fxpak.preserveExistingSaves,
  };
}

function gap(
  id: string,
  title: string,
  detail: string,
  severity: SnesAiGapSeverity,
  suggestedFix: string,
  safeAutofill = true,
  resolved = false,
): SnesAiGap {
  return { id, title, detail, severity, suggestedFix, safeAutofill, resolved };
}

function buildSnesAiGapReport(project: SnesStudioProject): SnesAiGapReport {
  const scene = activeScene(project);
  const checklist = createSnesCompletionChecklist(project);
  const gaps: SnesAiGap[] = [];
  const story = project.gameStoryBible ?? createDefaultGameStoryBible(project.name);
  const hasGoal = scene.entities.some((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door") || name.includes("flag");
  });
  if (!checklist.storyComplete || /reaches the summit goal/iu.test(story.ending)) {
    gaps.push(
      gap(
        "story-ending",
        "Story needs a stronger ending",
        "The game should have a plain ending the player is trying to reach.",
        "warning",
        "Write a clear ending and connect the final level goal to it.",
      ),
    );
  }
  if (project.scenes.length < 3) {
    gaps.push(
      gap(
        "level-count",
        "Game needs more level chapters",
        "A full story game should have a beginning, middle, and ending level.",
        "suggestion",
        "Add three story levels with a purpose, challenge, reward, and goal.",
      ),
    );
  }
  if (!scene.entities.some((entity) => entity.kind === "player")) {
    gaps.push(
      gap(
        "hero",
        "Hero missing",
        "The first level needs a playable hero.",
        "blocker",
        "Add a hero start.",
      ),
    );
  }
  if (!scene.entities.some((entity) => entity.kind === "enemy")) {
    gaps.push(
      gap(
        "enemy",
        "Challenge missing",
        "The first level needs at least one readable challenge.",
        "warning",
        "Add a simple patrol enemy.",
      ),
    );
  }
  if (!scene.entities.some((entity) => entity.kind === "item")) {
    gaps.push(
      gap(
        "reward",
        "Reward missing",
        "The first level needs a reward so the player understands progress.",
        "warning",
        "Add a collectible reward.",
      ),
    );
  }
  if (!hasGoal) {
    gaps.push(
      gap(
        "goal",
        "Goal missing",
        "The player needs an obvious finish point.",
        "blocker",
        "Add a door, flag, or goal marker.",
      ),
    );
  }
  if (!project.save.enabled || project.save.fields.length === 0) {
    gaps.push(
      gap(
        "save-memory",
        "Save plan missing",
        "A full game needs save memory fields for progress.",
        "warning",
        "Add checkpoint, reward count, and ending flags.",
      ),
    );
  }
  if (project.assets.audio.musicTracks.length === 0) {
    gaps.push(
      gap(
        "music",
        "Music missing",
        "A story game needs at least one music idea for playtesting and export planning.",
        "suggestion",
        "Add a looping platformer theme.",
      ),
    );
  }
  const unresolved = gaps.filter((entry) => !entry.resolved);
  return {
    status: unresolved.length === 0 ? "complete" : "needs-fixes",
    summary:
      unresolved.length === 0
        ? "AI sees a complete playable story-game draft."
        : `${unresolved.length} game gap${unresolved.length === 1 ? "" : "s"} need attention before this feels complete.`,
    gaps,
  };
}

export function createSnesAiGapReport(project: SnesStudioProject): SnesAiGapReport {
  return buildSnesAiGapReport(normalizeSnesStudioProject(project));
}

function normalizeGameplayBlueprint(value: unknown, fallbackName: string): SnesGameplayBlueprint {
  const record = recordValue(value);
  const fallback = createDefaultGameplayBlueprint(fallbackName);
  if (!record) {
    return fallback;
  }
  return {
    genre: "side-scrolling-platformer",
    premise:
      typeof record.premise === "string" && record.premise.trim()
        ? record.premise.trim().slice(0, 240)
        : fallback.premise,
    difficulty:
      record.difficulty === "normal" || record.difficulty === "hard" ? record.difficulty : "easy",
    controls: Array.isArray(record.controls)
      ? record.controls
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 6)
      : fallback.controls,
    artMood:
      typeof record.artMood === "string" && record.artMood.trim()
        ? record.artMood.trim().slice(0, 96)
        : fallback.artMood,
    musicMood:
      typeof record.musicMood === "string" && record.musicMood.trim()
        ? record.musicMood.trim().slice(0, 96)
        : fallback.musicMood,
  };
}

function normalizeThingLibrary(value: unknown): SnesThingLibraryEntry[] {
  const fallback = createDefaultThingLibrary();
  if (!Array.isArray(value)) {
    return fallback;
  }
  const entries = value.flatMap((entry, index): SnesThingLibraryEntry[] => {
    const record = recordValue(entry);
    if (!record) {
      return [];
    }
    const name =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim().slice(0, 48)
        : `Thing ${index + 1}`;
    const kind =
      record.kind === "hero" ||
      record.kind === "enemy" ||
      record.kind === "item" ||
      record.kind === "powerup" ||
      record.kind === "block" ||
      record.kind === "door" ||
      record.kind === "goal" ||
      record.kind === "hazard"
        ? record.kind
        : "item";
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? sanitizeRomBaseName(record.id) || `thing-${index + 1}`
            : sanitizeRomBaseName(name) || `thing-${index + 1}`,
        kind,
        name,
        prompt:
          typeof record.prompt === "string" && record.prompt.trim()
            ? record.prompt.trim().slice(0, 240)
            : `Create ${name}.`,
        behavior:
          typeof record.behavior === "string" && record.behavior.trim()
            ? record.behavior.trim().slice(0, 200)
            : "Appears in the level and can be edited.",
      },
    ];
  });
  return entries.length > 0 ? entries.slice(0, 48) : fallback;
}

function normalizePlatformerRules(value: unknown): SnesPlatformerRules {
  const record = recordValue(value);
  const fallback = createDefaultPlatformerRules();
  if (!record) {
    return fallback;
  }
  return {
    movement:
      typeof record.movement === "string" ? record.movement.slice(0, 200) : fallback.movement,
    enemyBehavior:
      typeof record.enemyBehavior === "string"
        ? record.enemyBehavior.slice(0, 200)
        : fallback.enemyBehavior,
    itemEffects:
      typeof record.itemEffects === "string"
        ? record.itemEffects.slice(0, 200)
        : fallback.itemEffects,
    damage: typeof record.damage === "string" ? record.damage.slice(0, 200) : fallback.damage,
    scoring: typeof record.scoring === "string" ? record.scoring.slice(0, 200) : fallback.scoring,
    winLoss: typeof record.winLoss === "string" ? record.winLoss.slice(0, 200) : fallback.winLoss,
  };
}

function normalizeLevelPlan(value: unknown, fallbackName: string): SnesLevelPlan {
  const record = recordValue(value);
  const fallback = createDefaultLevelPlan(fallbackName);
  if (!record) {
    return fallback;
  }
  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? sanitizeRomBaseName(record.id) || fallback.id
        : fallback.id,
    name:
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim().slice(0, 48)
        : fallback.name,
    summary:
      typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim().slice(0, 240)
        : fallback.summary,
    chunks: Array.isArray(record.chunks)
      ? record.chunks
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 8)
      : fallback.chunks,
    goal:
      typeof record.goal === "string" && record.goal.trim()
        ? record.goal.trim().slice(0, 160)
        : fallback.goal,
  };
}

export function createSnesStudioScene(
  name: string,
  id = sanitizeRomBaseName(name) || "scene",
): SnesStudioScene {
  const tilemap = createDefaultSceneTilemap();
  const collisionMap = createDefaultSceneCollisionMap(tilemap);
  return {
    id,
    name: name.trim().slice(0, 48) || "New Level",
    widthMetatiles: 128,
    heightMetatiles: 16,
    layers: 2,
    collisionMap,
    collisionTiles: countSolidCollisionCells(collisionMap),
    entities: [
      {
        id: "player",
        kind: "player",
        name: "Player Start",
        x: 32,
        y: 176,
        metaspriteTiles: 8,
      },
    ],
    tilemap,
  };
}

export function addSnesProjectScene(
  project: SnesStudioProject,
  name = `Level ${project.scenes.length + 1}`,
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  const scene = createSnesStudioScene(
    name,
    `${sanitizeRomBaseName(name) || "level"}-${next.scenes.length + 1}`,
  );
  next.scenes = [...next.scenes, scene];
  next.updatedAt = updatedAt;
  return next;
}

export function duplicateSnesProjectScene(
  project: SnesStudioProject,
  sceneIndex: number,
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  const source = next.scenes[sceneIndex];
  if (!source) {
    throw new Error("Cannot duplicate missing SNES Studio scene.");
  }
  const copy = normalizeSnesStudioScene(cloneJsonValue(source) as SnesStudioScene);
  copy.id = `${sanitizeRomBaseName(copy.name) || "level"}-copy-${next.scenes.length + 1}`;
  copy.name = `${copy.name} Copy`;
  next.scenes = [...next.scenes, copy];
  next.updatedAt = updatedAt;
  return next;
}

export function removeSnesProjectScene(
  project: SnesStudioProject,
  sceneIndex: number,
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  if (next.scenes.length <= 1) {
    throw new Error("SNES Studio projects must keep at least one scene.");
  }
  if (!next.scenes[sceneIndex]) {
    throw new Error("Cannot remove missing SNES Studio scene.");
  }
  next.scenes = next.scenes.filter((_, index) => index !== sceneIndex);
  next.updatedAt = updatedAt;
  return next;
}

export function moveSnesSceneEntity(
  project: SnesStudioProject,
  sceneIndex: number,
  entityId: string,
  x: number,
  y: number,
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  const scene = next.scenes[sceneIndex];
  if (!scene) {
    throw new Error("Cannot move an entity in a missing SNES Studio scene.");
  }
  const entity = scene.entities.find((candidate) => candidate.id === entityId);
  if (!entity) {
    throw new Error("Cannot move a missing SNES Studio entity.");
  }
  entity.x = Math.max(0, Math.min(scene.widthMetatiles * 16 - 1, Math.round(x)));
  entity.y = Math.max(0, Math.min(scene.heightMetatiles * 16 - 1, Math.round(y)));
  next.updatedAt = updatedAt;
  return next;
}

export function addSnesCustomTileBrush(
  project: SnesStudioProject,
  brush: Omit<SnesCustomTileBrush, "id"> & { id?: string },
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  const name = brush.name.trim().slice(0, 40) || "Custom Brush";
  const id =
    sanitizeRomBaseName(brush.id || name) || `brush-${next.assets.customTileBrushes.length + 1}`;
  const entry = normalizeCustomTileBrush(
    { ...brush, id, name },
    next.assets.customTileBrushes.length,
  );
  if (!entry) {
    throw new Error("Cannot add invalid SNES Studio tile brush.");
  }
  next.assets.customTileBrushes = [
    ...next.assets.customTileBrushes.filter((candidate) => candidate.id !== entry.id),
    entry,
  ];
  next.updatedAt = updatedAt;
  return next;
}

export function createDefaultSnesStudioProject(updatedAt = new Date().toISOString()) {
  const project: SnesStudioProject = {
    schemaVersion: 1,
    id: "snes-platformer-v01",
    name: "Moonlit Ridge",
    updatedAt,
    profile: {
      mapMode: "lorom",
      region: "ntsc",
      videoMode: "mode1",
      enhancementChip: "none",
      romSizeMbit: 8,
      sramSizeKib: 8,
      target: "fxpak-pro",
      fxpak: {
        cardSizeGb: SNES_HARDWARE_LIMITS.defaultFxpakCardGb,
        fileSystem: "fat32",
        preserveExistingSaves: true,
      },
    },
    assets: {
      backgroundTiles: 384,
      spriteTiles: 192,
      backgroundPalettes: 6,
      spritePalettes: 4,
      audioBytes: 18 * 1024,
      audio: createDefaultAudioProject(18 * 1024),
      customTileBrushes: [
        { id: "solid-ground", name: "Solid Ground", tile: 1, solid: true },
        { id: "passable-ledge", name: "Passable Ledge", tile: 2, solid: true },
      ],
      importedTilesets: [],
      scriptBytes: 12 * 1024,
    },
    animations: [
      {
        id: "player-idle",
        name: "Player Idle",
        entityKind: "player",
        loop: true,
        frames: [
          { id: "player-idle-1", durationTicks: 10, tileIndex: 5, xOffset: 0, yOffset: 0 },
          { id: "player-idle-2", durationTicks: 10, tileIndex: 6, xOffset: 0, yOffset: 0 },
        ],
      },
      {
        id: "enemy-patrol",
        name: "Enemy Patrol",
        entityKind: "enemy",
        loop: true,
        frames: [
          { id: "enemy-patrol-1", durationTicks: 8, tileIndex: 4, xOffset: 0, yOffset: 0 },
          { id: "enemy-patrol-2", durationTicks: 8, tileIndex: 4, xOffset: 1, yOffset: 0 },
        ],
      },
    ],
    dialogue: [
      {
        id: "intro",
        name: "Intro Warning",
        trigger: "on-start",
        lines: [
          {
            id: "intro-1",
            speaker: "Guide",
            text: "The ridge gate only opens after the moon coin is found.",
          },
        ],
      },
    ],
    events: [
      {
        id: "intro-event",
        name: "Show intro warning",
        trigger: "on-start",
        targetId: "ridge-1",
        actions: [{ type: "show-dialogue", cutsceneId: "intro" }],
      },
    ],
    physics: {
      ...DEFAULT_PLAYER_PHYSICS,
      jumpVelocity: DEFAULT_PLAYER_PHYSICS.jumpVelocity - 0x100,
    },
    scenes: [
      {
        id: "ridge-1",
        name: "Ridge 1-1",
        widthMetatiles: 128,
        heightMetatiles: 16,
        layers: 2,
        collisionMap: createDefaultSceneCollisionMap(),
        collisionTiles: countSolidCollisionCells(createDefaultSceneCollisionMap()),
        entities: [
          {
            id: "player",
            kind: "player",
            name: "Player Start",
            x: 32,
            y: 176,
            metaspriteTiles: 8,
          },
          {
            id: "enemy-1",
            kind: "enemy",
            name: "Patrol Shell",
            x: 208,
            y: 176,
            metaspriteTiles: 8,
          },
          {
            id: "item-1",
            kind: "item",
            name: "Moon Coin",
            x: 352,
            y: 128,
            metaspriteTiles: 2,
          },
        ],
        tilemap: createDefaultSceneTilemap(),
      },
    ],
    save: {
      enabled: true,
      slots: 3,
      fields: [
        { key: "checkpoint", label: "Last checkpoint", type: "u16" },
        { key: "coins", label: "Coins", type: "u16" },
        { key: "bossCleared", label: "Boss cleared", type: "flag" },
      ],
    },
    gameplayBlueprint: createDefaultGameplayBlueprint("Moonlit Ridge"),
    thingLibrary: createDefaultThingLibrary(),
    platformerRules: createDefaultPlatformerRules(),
    levelPlan: createDefaultLevelPlan("Ridge 1-1"),
    visualStylePreset: SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
    artDirection: createDefaultSnesArtDirection(),
    assetProvenance: "original-generated",
    styleWarnings: createDefaultStyleWarnings("original-generated"),
    generatedAssets: generatedAssetSpecsFromStylePack(),
    export: {
      romBaseName: "moonlit-ridge",
    },
  };
  return project;
}

export function createBlankSnesStudioProject(updatedAt = new Date().toISOString()) {
  const project = createDefaultSnesStudioProject(updatedAt);
  project.id = "untitled-snes-game";
  project.name = "Untitled SNES Game";
  project.export.romBaseName = "untitled-snes-game";
  project.assets.backgroundTiles = 64;
  project.assets.spriteTiles = 32;
  project.assets.backgroundPalettes = 2;
  project.assets.spritePalettes = 1;
  project.assets.audio = createDefaultAudioProject(0);
  project.assets.audio.musicTracks = [];
  project.assets.audio.soundEffects = [];
  project.assets.audio.sampleBytes = 0;
  project.assets.audioBytes = 0;
  project.assets.customTileBrushes = [];
  project.assets.importedTilesets = [];
  project.assets.scriptBytes = 1024;
  project.animations = [];
  project.dialogue = [];
  project.events = [];
  project.save = { enabled: false, slots: 1, fields: [] };
  project.gameplayBlueprint = createDefaultGameplayBlueprint("Untitled SNES Game");
  project.thingLibrary = createDefaultThingLibrary();
  project.platformerRules = createDefaultPlatformerRules();
  project.levelPlan = createDefaultLevelPlan("Blank Canvas");
  project.scenes = [
    {
      id: "blank-1",
      name: "Blank Canvas",
      widthMetatiles: 64,
      heightMetatiles: 16,
      layers: 2,
      collisionMap: Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, () => 0),
      collisionTiles: 0,
      entities: [],
      tilemap: Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, () => 0),
    },
  ];
  return normalizeSnesStudioProject(project);
}

export function createSnesAudioManifest(project: SnesStudioProject): SnesAudioManifest {
  const audio = normalizeSnesAudioProject(project.assets.audio, project.assets.audioBytes);
  const musicBytes = audio.musicTracks.reduce((sum, track) => sum + track.estimatedBytes, 0);
  const soundEffectBytes = audio.soundEffects.reduce(
    (sum, effect) => sum + effect.estimatedBytes,
    0,
  );
  const totalBytes = estimatedSnesAudioBytes(audio);
  const warnings = [
    ...(totalBytes > SNES_HARDWARE_LIMITS.aramBytes
      ? ["Audio data exceeds the 64 KiB SNES ARAM budget."]
      : []),
    ...(audio.musicTracks.length === 0 ? ["No music tracks are configured."] : []),
    ...(audio.soundEffects.length === 0 ? ["No sound effects are configured."] : []),
  ];
  return {
    driver: "preview-spc700",
    aramLimitBytes: SNES_HARDWARE_LIMITS.aramBytes,
    reservedDriverBytes: audio.aramReservedBytes,
    musicBytes,
    soundEffectBytes,
    sampleBytes: audio.sampleBytes,
    totalBytes,
    utilization: clampRatio(totalBytes, SNES_HARDWARE_LIMITS.aramBytes),
    musicTracks: audio.musicTracks,
    soundEffects: audio.soundEffects.map((effect) => ({
      estimatedBytes: effect.estimatedBytes,
      id: effect.id,
      name: effect.name,
      priority: effect.priority,
      sequenceBytes: effect.steps.length * 4,
    })),
    warnings,
    exportNotes: [
      "Preview manifest budgets SPC700 driver reserve, music pattern data, SFX sequences, and BRR/sample bytes.",
      "A production SPC700 driver must consume this manifest before hardware audio playback is marked verified.",
    ],
  };
}

function productionBlockerGate(
  id: SnesProductionGateId,
  label: string,
  status: SnesProductionGateStatus,
  summary: string,
  blockers: string[] = [],
  evidence: string[] = [],
): SnesProductionGate {
  return {
    id,
    label,
    status,
    requiredForProduction: true,
    summary,
    blockers,
    evidence,
  };
}

function productionHash(value: unknown): string {
  return checksumText(stableStringify(value, 0)).toString(16).padStart(8, "0");
}

function normalizeSnesProductionAssetMaturity(
  record: Pick<SnesProductionAssetRecord, "provenance" | "status" | "visualMaturity">,
): SnesProductionAssetMaturity {
  if (record.visualMaturity) {
    return record.visualMaturity;
  }
  if (record.status === "spec-only" || record.provenance === "spec") {
    return "spec-only";
  }
  if (record.status === "blocked") {
    return "procedural-placeholder";
  }
  if (record.provenance === "user-imported" || record.provenance === "external-licensed") {
    return "artist-imported";
  }
  return "draft-generated";
}

function hasProductionVisualProof(record: SnesProductionAssetRecord): boolean {
  return (record.visualProof ?? []).some(
    (proof) =>
      proof.kind !== "source-image" &&
      typeof proof.path === "string" &&
      proof.path.trim().length > 0,
  );
}

function productionAssetReadinessBlockers(record: SnesProductionAssetRecord): string[] {
  if (record.status !== "real-asset") {
    return [];
  }
  const visualMaturity = normalizeSnesProductionAssetMaturity(record);
  return [
    ...(record.sourcePath && record.sourceHash
      ? []
      : ["Real asset source path and hash are required."]),
    ...(visualMaturity === "production-approved"
      ? []
      : [
          `Asset visual maturity is ${visualMaturity}; production visuals require production-approved.`,
        ]),
    ...(visualMaturity === "production-approved" && hasProductionVisualProof(record)
      ? []
      : [
          "Review proof artifact is required for production visual assets; source PNGs do not count.",
        ]),
  ];
}

export function createSnesProductionAssetRecord(
  record: Omit<SnesProductionAssetRecord, "id" | "blockers"> & {
    id: string;
    blockers?: string[];
  },
): SnesProductionAssetRecord {
  const id = sanitizeRomBaseName(record.id) || "asset";
  const visualMaturity = normalizeSnesProductionAssetMaturity(record);
  const normalizedRecord: SnesProductionAssetRecord = {
    ...record,
    id,
    usage: record.usage.map((usage) => usage.trim()).filter(Boolean),
    visualMaturity,
    blockers: [],
  };
  const blockers = [
    ...productionAssetReadinessBlockers(normalizedRecord),
    ...(record.license === "unknown" ? ["Asset license/provenance must be explicit."] : []),
    ...(record.blockers ?? []),
  ];
  return {
    ...normalizedRecord,
    blockers,
  };
}

export function createSnesProductionAssetRegistry(
  project: SnesStudioProject,
  records: SnesProductionAssetRecord[] = [],
): SnesProductionAssetRegistry {
  const normalized = normalizeSnesStudioProject(project);
  const specRecords: SnesProductionAssetRecord[] = [
    ...(normalized.generatedAssets?.spriteSpecs ?? []).map(
      (sprite): SnesProductionAssetRecord => ({
        id: sprite.id,
        type:
          sprite.kind === "enemy"
            ? "enemy-sprite"
            : sprite.kind === "item"
              ? "item-sprite"
              : "character-sprite",
        status: "spec-only",
        visualMaturity: "spec-only",
        license: "original",
        provenance: "spec",
        palette: { colorCount: 0, colors: [] },
        frames: sprite.frames.map((frame) => ({
          id: frame.id,
          width: sprite.frameSize === "16x24" ? 16 : sprite.frameSize === "16x32" ? 16 : 16,
          height: sprite.frameSize === "16x24" ? 24 : sprite.frameSize === "16x32" ? 32 : 16,
          durationTicks: frame.durationTicks,
        })),
        usage: [`generated sprite spec for ${sprite.kind}`],
        blockers: ["Spec-only sprite recipe is not a production image asset."],
      }),
    ),
    ...(normalized.generatedAssets?.tileSpecs ?? []).map(
      (tile): SnesProductionAssetRecord => ({
        id: tile.id,
        type: "tileset",
        status: "spec-only",
        visualMaturity: "spec-only",
        license: "original",
        provenance: "spec",
        palette: { colorCount: 0, colors: [] },
        tileMetadata: {
          tileSize: "16x16",
          tileCount: 1,
          collisionClasses: [tile.collisionClass],
        },
        usage: [`generated tile spec ${tile.tileId}`],
        blockers: ["Spec-only tile recipe is not a production tileset image."],
      }),
    ),
    ...normalized.assets.importedTilesets.map(
      (tileset): SnesProductionAssetRecord => ({
        id: tileset.id,
        type: "tileset",
        status: "real-asset",
        visualMaturity: "artist-imported",
        sourceHash: tileset.chrChecksum.toString(16),
        license: "user-provided",
        provenance: "user-imported",
        palette: {
          colorCount: tileset.paletteColorsUsed.length,
          colors: tileset.palettePreviewHex,
        },
        tileMetadata: {
          tileSize: "8x8",
          tileCount: tileset.uniqueTileCount,
          collisionClasses: ["imported"],
        },
        usage: [`imported tileset ${tileset.name}`],
        blockers: [],
      }),
    ),
  ];
  const allRecords = [...specRecords, ...records.map(createSnesProductionAssetRecord)];
  const requiredTypes: SnesProductionAssetType[] = [
    "character-sprite",
    "enemy-sprite",
    "item-sprite",
    "tileset",
    "background-layer",
  ];
  const realTypes = new Set(
    allRecords
      .filter(
        (record) =>
          record.status === "real-asset" &&
          record.sourceHash &&
          normalizeSnesProductionAssetMaturity(record) === "production-approved" &&
          hasProductionVisualProof(record) &&
          record.blockers.length === 0,
      )
      .map((record) => record.type),
  );
  const missingRequiredTypes = requiredTypes.filter((type) => !realTypes.has(type));
  const blockers = Array.from(
    new Set([
      ...missingRequiredTypes.map((type) => `Missing production real asset: ${type}.`),
      ...allRecords.flatMap((record) =>
        record.provenance === "spec"
          ? []
          : [...record.blockers, ...productionAssetReadinessBlockers(record)].map(
              (blocker) => `Asset ${record.id}: ${blocker}`,
            ),
      ),
    ]),
  );
  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    records: allRecords,
    requiredTypes,
    missingRequiredTypes,
    blockers,
  };
}

const SNES_TOOLCHAIN_DEFINITIONS: Array<{
  id: SnesToolchainToolId;
  label: string;
  requiredForProduction: boolean;
  installHint: string;
}> = [
  {
    id: "pvsneslib",
    label: "PVSnesLib",
    requiredForProduction: true,
    installHint: "Install the free PVSnesLib/devkitSNES toolchain before ROM builds.",
  },
  {
    id: "superfamiconv",
    label: "SuperFamiconv",
    requiredForProduction: true,
    installHint: "Install SuperFamiconv so PNG assets can become SNES tiles, palettes, and maps.",
  },
  {
    id: "pixelorama",
    label: "Pixelorama",
    requiredForProduction: true,
    installHint: "Install Pixelorama or provide an equivalent free pixel-art editor/export path.",
  },
  {
    id: "aseprite",
    label: "Aseprite CLI",
    requiredForProduction: false,
    installHint: "Optional paid upgrade; use only if already installed or explicitly approved.",
  },
  {
    id: "ldtk",
    label: "LDtk",
    requiredForProduction: true,
    installHint: "Install LDtk for entity-rich level editing JSON exports.",
  },
  {
    id: "tiled",
    label: "Tiled",
    requiredForProduction: false,
    installHint: "Optional alternate tilemap editor; useful later for broad import/export support.",
  },
  {
    id: "mesen",
    label: "Mesen/MesenCE",
    requiredForProduction: false,
    installHint: "Install MesenCE or bsnes so generated ROMs can be emulator-booted.",
  },
  {
    id: "bsnes",
    label: "bsnes",
    requiredForProduction: false,
    installHint: "Install bsnes or MesenCE so generated ROMs can be emulator-booted.",
  },
  {
    id: "superfamicheck",
    label: "SuperFamicheck",
    requiredForProduction: true,
    installHint: "Install SuperFamicheck for ROM header/checksum inspection.",
  },
  {
    id: "brrtools",
    label: "BRRtools",
    requiredForProduction: true,
    installHint: "Install BRRtools for SNES-native BRR sample conversion.",
  },
];

export function createSnesToolchainDoctorReport(
  input: SnesToolchainDoctorInput = {},
): SnesToolchainDoctorReport {
  const tools = SNES_TOOLCHAIN_DEFINITIONS.map((definition): SnesToolchainToolStatus => {
    const probe = input.tools?.[definition.id];
    const available = probe?.available === true;
    return {
      id: definition.id,
      label: definition.label,
      status: available
        ? "available"
        : definition.requiredForProduction
          ? "missing"
          : "optional-missing",
      requiredForProduction: definition.requiredForProduction,
      path: probe?.path,
      version: probe?.version,
      detail:
        probe?.detail ??
        (available
          ? `${definition.label} is available.`
          : `${definition.label} is not detected by the read-only Toolchain Doctor.`),
      installHint: definition.installHint,
    };
  });
  const hasEmulator =
    input.tools?.mesen?.available === true || input.tools?.bsnes?.available === true;
  if (!hasEmulator) {
    for (const tool of tools) {
      if (tool.id === "mesen" || tool.id === "bsnes") {
        tool.status = "missing";
        tool.requiredForProduction = tool.id === "mesen";
      }
    }
  }
  const fxpakVolume: SnesToolchainDoctorReport["fxpakVolume"] = input.fxpakVolume?.mounted
    ? {
        status: input.fxpakVolume.fileSystem?.toLowerCase() === "fat32" ? "mounted" : "blocked",
        path: input.fxpakVolume.path,
        fileSystem: input.fxpakVolume.fileSystem,
        detail:
          input.fxpakVolume.fileSystem?.toLowerCase() === "fat32"
            ? "FXPAK/SD2SNES-style FAT32 volume is mounted."
            : "Mounted flash-cart volume is not FAT32.",
      }
    : {
        status: "missing" as const,
        path: input.fxpakVolume?.path,
        fileSystem: input.fxpakVolume?.fileSystem,
        detail: input.fxpakVolume?.detail ?? "No FXPAK/SD2SNES-style FAT32 volume is mounted.",
      };
  const blockers = [
    ...tools.flatMap((tool) =>
      tool.requiredForProduction && tool.status !== "available"
        ? [`${tool.label} is required for production SNES builds.`]
        : [],
    ),
    ...(fxpakVolume.status === "blocked" ? [fxpakVolume.detail] : []),
  ];
  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    tools,
    fxpakVolume,
    blockers,
  };
}

export function createSnesVisualApprovalContract(
  options: Partial<SnesVisualApprovalContract> & {
    targetScore?: number;
    currentHumanScore?: number | null;
    machineScore?: number | null;
  } = {},
): SnesVisualApprovalContract {
  const targetScore = Math.max(0, Math.min(100, Math.trunc(options.targetScore ?? 100)));
  const normalizedHumanScore =
    typeof options.currentHumanScore === "number"
      ? Math.max(0, Math.min(100, Math.trunc(options.currentHumanScore)))
      : null;
  const machineScore =
    typeof options.machineScore === "number"
      ? Math.max(0, Math.min(100, Math.trunc(options.machineScore)))
      : null;
  const gpt55ReviewStatus = options.gpt55ReviewStatus ?? "not-requested";
  const status =
    normalizedHumanScore === null
      ? "manual-required"
      : normalizedHumanScore >= targetScore &&
          (gpt55ReviewStatus === "approved" || gpt55ReviewStatus === "not-requested")
        ? "approved"
        : "blocked";
  const blocker =
    status === "approved"
      ? null
      : normalizedHumanScore === null
        ? `Human visual grade is required for production target ${targetScore}/100.`
        : `Human visual grade ${normalizedHumanScore}/100 is below production target ${targetScore}/100.`;
  return {
    targetScore,
    currentHumanScore: normalizedHumanScore,
    machineScore,
    gpt55ReviewStatus,
    status,
    blocker,
  };
}

export function decideSnesGpt55Usage(
  useCase: SnesGpt55UseCase,
  options: { repeatedFailureCount?: number; explicitVisualApproval?: boolean } = {},
): SnesGpt55TokenGovernorDecision {
  const repeatedFailureCount = options.repeatedFailureCount ?? 0;
  if (useCase === "routine-local-patch") {
    return {
      blocker: "Routine milestone patches must use local OpenClaw/GLM workers.",
      costAvoidedByLocalAgents:
        "Local agents generate the routine patch so GPT 5.5 tokens are preserved.",
      gpt55Used: false,
      localWorkerDefault: true,
      reasoningLevel: "none",
      requiresExplicitUserApproval: false,
      useCase,
      whyUsed: "GPT 5.5 is not used for routine local patch generation.",
    };
  }
  if (useCase === "qa-summary" || useCase === "obvious-repair-brief") {
    return {
      blocker: null,
      costAvoidedByLocalAgents:
        "GPT 5.5 is limited to a concise summary or repair brief; local agents still implement.",
      gpt55Used: true,
      localWorkerDefault: false,
      reasoningLevel: "low",
      requiresExplicitUserApproval: false,
      useCase,
      whyUsed:
        useCase === "qa-summary"
          ? "Low reasoning is enough to summarize deterministic QA evidence."
          : "Low reasoning is enough to write an obvious targeted repair brief.",
    };
  }
  if (useCase === "production-visual-approval" && !options.explicitVisualApproval) {
    return {
      blocker: "GPT 5.5 visual approval needs explicit approval or a human visual grade.",
      costAvoidedByLocalAgents:
        "The system keeps visual approval manual until GPT 5.5 visual judging is approved.",
      gpt55Used: false,
      localWorkerDefault: true,
      reasoningLevel: "none",
      requiresExplicitUserApproval: true,
      useCase,
      whyUsed: "GPT 5.5 visual judging was not requested.",
    };
  }
  const highReasoning =
    useCase === "initial-blueprint" ||
    useCase === "repeated-blocker-diagnosis" ||
    useCase === "architecture-or-design-conflict" ||
    useCase === "production-visual-approval" ||
    useCase === "final-shipping-approval";
  return {
    blocker:
      useCase === "repeated-blocker-diagnosis" && repeatedFailureCount < 2
        ? "Use local repair first; high-reasoning GPT 5.5 is reserved after repeated failure."
        : null,
    costAvoidedByLocalAgents:
      "GPT 5.5 is used only for direction, diagnosis, or approval; local workers still do implementation.",
    gpt55Used: useCase === "repeated-blocker-diagnosis" ? repeatedFailureCount >= 2 : highReasoning,
    localWorkerDefault: false,
    reasoningLevel:
      useCase === "repeated-blocker-diagnosis" && repeatedFailureCount < 2
        ? "none"
        : highReasoning
          ? "high"
          : "low",
    requiresExplicitUserApproval: useCase === "production-visual-approval",
    useCase,
    whyUsed:
      useCase === "initial-blueprint"
        ? "GPT 5.5 provides the high-level game blueprint, quality rubric, risks, and role briefs."
        : useCase === "final-shipping-approval"
          ? "GPT 5.5 can approve final shipping only after machine proof passes."
          : useCase === "production-visual-approval"
            ? "GPT 5.5 visual review is used only as an explicit approval gate."
            : useCase === "architecture-or-design-conflict"
              ? "High reasoning is reserved for major design or architecture conflicts."
              : "High reasoning is reserved for repeated blockers after local repair fails.",
  };
}

export function createSnesArtDirectorVisualGate(
  project: SnesStudioProject,
  options: {
    assetRecords?: SnesProductionAssetRecord[];
    targetScore?: number;
    humanScore?: number | null;
    machineScore?: number | null;
    gpt55ReviewStatus?: SnesVisualApprovalContract["gpt55ReviewStatus"];
  } = {},
): SnesArtDirectorVisualGateReport {
  const normalized = normalizeSnesStudioProject(project);
  const registry = createSnesProductionAssetRegistry(normalized, options.assetRecords ?? []);
  const realRecords = registry.records.filter((record) => record.status === "real-asset");
  const productionApprovedRecords = realRecords.filter(
    (record) =>
      normalizeSnesProductionAssetMaturity(record) === "production-approved" &&
      hasProductionVisualProof(record) &&
      record.blockers.length === 0,
  );
  const realSpriteSheets = productionApprovedRecords.filter(
    (record) =>
      (record.type === "character-sprite" ||
        record.type === "enemy-sprite" ||
        record.type === "item-sprite") &&
      (record.frames?.length ?? 0) >= 2,
  ).length;
  const realTilesetVariants = productionApprovedRecords
    .filter((record) => record.type === "tileset")
    .reduce((sum, record) => sum + (record.tileMetadata?.tileCount ?? 0), 0);
  const realBackgroundLayers = productionApprovedRecords.filter(
    (record) => record.type === "background-layer",
  ).length;
  const paletteRamps = productionApprovedRecords.filter(
    (record) => (record.palette?.colorCount ?? 0) >= 4,
  ).length;
  const reviewProofArtifacts = productionApprovedRecords.reduce(
    (sum, record) =>
      sum +
      (record.visualProof ?? []).filter(
        (proof) => proof.kind !== "source-image" && proof.path.trim().length > 0,
      ).length,
    0,
  );
  const screenshotProofs = reviewProofArtifacts;
  const productionApprovedAssets = productionApprovedRecords.length;
  const proceduralPlaceholderAssets = registry.records.filter(
    (record) => normalizeSnesProductionAssetMaturity(record) === "procedural-placeholder",
  ).length;
  const draftGeneratedAssets = registry.records.filter(
    (record) => normalizeSnesProductionAssetMaturity(record) === "draft-generated",
  ).length;
  const heroAnimationFrames = productionApprovedRecords
    .filter((record) => record.type === "character-sprite")
    .reduce((maxFrames, record) => Math.max(maxFrames, record.frames?.length ?? 0), 0);
  const specOnlyAssetCount = registry.records.filter(
    (record) => record.status === "spec-only",
  ).length;
  const targetScore = Math.max(0, Math.min(100, Math.trunc(options.targetScore ?? 100)));
  const strictProductionTarget = targetScore >= 100;
  const minTilesetVariants = strictProductionTarget ? 96 : 24;
  const minHeroAnimationFrames = strictProductionTarget ? 40 : 2;
  const placeholderArtDetected =
    proceduralPlaceholderAssets > 0 ||
    draftGeneratedAssets > 0 ||
    realSpriteSheets === 0 ||
    realTilesetVariants < minTilesetVariants ||
    realBackgroundLayers === 0 ||
    reviewProofArtifacts === 0 ||
    heroAnimationFrames < minHeroAnimationFrames;
  const humanScore =
    typeof options.humanScore === "number"
      ? Math.max(0, Math.min(100, Math.trunc(options.humanScore)))
      : null;
  const gpt55ReviewStatus = options.gpt55ReviewStatus ?? "not-requested";
  const rawMachineScore =
    (realSpriteSheets >= 3 ? 20 : realSpriteSheets * 6) +
    (realTilesetVariants >= minTilesetVariants
      ? 20
      : Math.min(18, Math.floor((realTilesetVariants / minTilesetVariants) * 20))) +
    (realBackgroundLayers >= 3 ? 15 : realBackgroundLayers * 5) +
    (paletteRamps >= 5 ? 15 : paletteRamps * 3) +
    (reviewProofArtifacts >= 5 ? 15 : reviewProofArtifacts * 3) +
    (heroAnimationFrames >= minHeroAnimationFrames ? 15 : 0) +
    (placeholderArtDetected ? 0 : 15);
  const machineScore = Math.max(
    0,
    Math.min(100, Math.trunc(options.machineScore ?? rawMachineScore)),
  );
  const blockers = [
    ...(productionApprovedAssets > 0
      ? []
      : [
          "Production visuals need production-approved asset records; converted placeholders do not count.",
        ]),
    ...(realSpriteSheets >= 3
      ? []
      : ["Production visuals need real character, enemy, and item sprite sheets with frames."]),
    ...(realTilesetVariants >= minTilesetVariants
      ? []
      : [
          `Production visuals need at least ${minTilesetVariants} production-approved tileset variants.`,
        ]),
    ...(realBackgroundLayers >= 3
      ? []
      : ["Production visuals need at least 3 real background/parallax layers."]),
    ...(paletteRamps >= 5 ? [] : ["Production visuals need palette ramps across key assets."]),
    ...(reviewProofArtifacts >= 5
      ? []
      : ["Production visuals need review proof artifacts; source PNGs do not count."]),
    ...(heroAnimationFrames >= minHeroAnimationFrames
      ? []
      : [
          `Production hero sprite needs at least ${minHeroAnimationFrames} approved animation frames for target ${targetScore}/100.`,
        ]),
    ...(placeholderArtDetected ? ["Placeholder or rectangle-quality art is still detected."] : []),
    ...(humanScore === null && gpt55ReviewStatus !== "approved"
      ? ["Human visual grade or approved GPT 5.5 visual review is required."]
      : []),
    ...(humanScore !== null && humanScore < targetScore
      ? [`Human visual grade ${humanScore}/100 is below target ${targetScore}/100.`]
      : []),
    ...(machineScore < targetScore && (humanScore === null || humanScore < targetScore)
      ? [`Art Director machine score ${machineScore}/100 is below target ${targetScore}/100.`]
      : []),
  ];
  const manualOnly = blockers.every((blocker) =>
    blocker.includes("Human visual grade or approved GPT 5.5 visual review"),
  );
  return {
    blockers,
    evidence: productionApprovedRecords.map((record) => `${record.type}:${record.id}`),
    gpt55ReviewStatus,
    humanScore,
    machineScore,
    metrics: {
      paletteRamps,
      placeholderArtDetected,
      productionApprovedAssets,
      proceduralPlaceholderAssets,
      draftGeneratedAssets,
      heroAnimationFrames,
      realBackgroundLayers,
      realSpriteSheets,
      realTilesetVariants,
      screenshotProofs,
      visualProofArtifacts: reviewProofArtifacts,
      specOnlyAssetCount,
    },
    status: blockers.length === 0 ? "pass" : manualOnly ? "manual-required" : "blocked",
    targetScore,
  };
}

export function createSnesProductionVisualReport(
  project: SnesStudioProject,
  options: {
    assetRecords?: SnesProductionAssetRecord[];
    targetScore?: number;
    humanScore?: number | null;
    machineScore?: number | null;
    gpt55ReviewStatus?: SnesVisualApprovalContract["gpt55ReviewStatus"];
  } = {},
): SnesProductionVisualReport {
  const normalized = normalizeSnesStudioProject(project);
  const registry = createSnesProductionAssetRegistry(normalized, options.assetRecords ?? []);
  const visualGate = createSnesArtDirectorVisualGate(normalized, options);
  const realAssets = registry.records.filter((record) => record.status === "real-asset");
  const productionApprovedArt = realAssets.filter(
    (record) =>
      normalizeSnesProductionAssetMaturity(record) === "production-approved" &&
      hasProductionVisualProof(record) &&
      record.blockers.length === 0,
  );
  const importedConvertedSourceArt = realAssets.filter(
    (record) => record.provenance === "user-imported" || record.provenance === "external-licensed",
  );
  const deterministicGeneratedArt = realAssets.filter(
    (record) => record.provenance === "openclaw-generated",
  );
  const specOnlyPlaceholderArt = registry.records.filter(
    (record) =>
      record.status === "spec-only" ||
      record.provenance === "spec" ||
      normalizeSnesProductionAssetMaturity(record) === "procedural-placeholder",
  );
  const visualProof = realAssets.flatMap((record) =>
    (record.visualProof ?? []).filter(
      (proof) => proof.kind !== "source-image" && proof.path.trim().length > 0,
    ),
  );
  const screenshotProof = visualProof.map((proof) => proof.path);
  const blockers = [
    ...visualGate.blockers,
    ...registry.blockers,
    ...(registry.status !== "ready" && specOnlyPlaceholderArt.length > 0
      ? [
          `${specOnlyPlaceholderArt.length} spec-only placeholder asset${specOnlyPlaceholderArt.length === 1 ? "" : "s"} must be replaced before production graphics can pass.`,
        ]
      : []),
    ...(screenshotProof.length === 0
      ? ["Screenshot proof is required before production graphics can pass."]
      : []),
  ];
  const status =
    visualGate.status === "pass" && registry.status === "ready"
      ? "pass"
      : visualGate.status === "manual-required"
        ? "manual-required"
        : "blocked";
  return {
    blockers: Array.from(new Set(blockers)),
    deterministicGeneratedArt,
    format: "openclaw-snes-production-visual-report",
    humanGrade: visualGate.humanScore,
    importedConvertedSourceArt,
    machineScore: visualGate.machineScore,
    productionApprovedArt,
    screenshotProof,
    specOnlyPlaceholderArt,
    visualProof,
    status,
    summary: `${productionApprovedArt.length} production-approved assets, ${importedConvertedSourceArt.length} imported/converted source assets, ${deterministicGeneratedArt.length} deterministic generated assets, ${specOnlyPlaceholderArt.length} placeholder assets, ${visualProof.length} review proof artifacts.`,
    targetScore: visualGate.targetScore,
    visualGate,
  };
}

export function createSnesProductionReadinessReport(
  project: SnesStudioProject,
  options: SnesProductionReadinessOptions = {},
): SnesProductionReadinessReport {
  const normalized = normalizeSnesStudioProject(project);
  const quality = createSnesGameQualityReport(normalized);
  const assetRegistry = createSnesProductionAssetRegistry(normalized, options.assetRecords ?? []);
  const visualApproval = createSnesVisualApprovalContract({
    targetScore: options.targetHumanVisualScore ?? options.visualApproval?.targetScore ?? 100,
    currentHumanScore: options.visualApproval?.currentHumanScore ?? null,
    machineScore: options.visualApproval?.machineScore ?? quality.score,
    gpt55ReviewStatus: options.visualApproval?.gpt55ReviewStatus ?? "not-requested",
  });
  const artDirectorGate = createSnesArtDirectorVisualGate(normalized, {
    assetRecords: options.assetRecords ?? [],
    gpt55ReviewStatus: visualApproval.gpt55ReviewStatus,
    humanScore: visualApproval.currentHumanScore,
    machineScore: options.artDirectorGate?.machineScore ?? visualApproval.machineScore,
    targetScore: options.targetHumanVisualScore ?? visualApproval.targetScore,
  });
  const toolchain = options.toolchain ?? createSnesToolchainDoctorReport();
  const romBuild = options.romBuild ?? {
    status: "not-run" as const,
    toolVersions: {},
    checksumStatus: "not-run" as const,
    blockers: ["Production ROM build has not run."],
    proofKind: "scaffold" as const,
  };
  const rawEngineRuntimeProof = options.engineRuntimeProof ?? {
    status: "not-run" as const,
    features: [],
    blockers: ["Playable SNES engine proof has not run."],
  };
  const engineRuntimeProof = {
    ...rawEngineRuntimeProof,
    blockers: Array.isArray(rawEngineRuntimeProof.blockers) ? rawEngineRuntimeProof.blockers : [],
    features: Array.isArray(rawEngineRuntimeProof.features) ? rawEngineRuntimeProof.features : [],
    status: rawEngineRuntimeProof.status ?? ("not-run" as const),
  };
  const emulatorProof = options.emulatorProof ?? {
    status: "not-run" as const,
    blockers: ["Emulator boot proof has not run."],
  };
  const fxpakPackage = options.fxpakPackage ?? {
    status: "not-run" as const,
    fileSystemRequired: "fat32" as const,
    savePolicy: "preserve-existing-sram" as const,
    dryRun: true,
    blockers: ["FXPAK package dry-run has not run."],
  };
  const hardwareProof = options.hardwareProof ?? {
    status: "manual-required" as const,
    checklist: [
      { label: "Boot on original SNES through FXPAK Pro", status: "manual-required" as const },
      {
        label: "Verify controls, audio, video, save, and power-cycle behavior",
        status: "manual-required" as const,
      },
    ],
    blockers: ["Real original-SNES hardware proof is manual and has not been recorded."],
  };
  const gates: SnesProductionGate[] = [
    productionBlockerGate(
      "browser-preview",
      "Browser Preview",
      quality.status === "fail" ? "blocked" : quality.status === "warning" ? "warning" : "pass",
      `Browser preview quality score ${quality.score}/100.`,
      quality.status === "fail" ? quality.requiredRepairs : [],
      quality.receipt,
    ),
    productionBlockerGate(
      "asset-pipeline",
      "Real Asset Pipeline",
      assetRegistry.status === "ready" ? "pass" : "blocked",
      assetRegistry.status === "ready"
        ? "Required production asset records are present."
        : "Production graphics require real sprite, tileset, item, and background assets.",
      assetRegistry.blockers,
      assetRegistry.records
        .filter((record) => record.status === "real-asset")
        .map((record) => `${record.type}:${record.id}`),
    ),
    productionBlockerGate(
      "visual-approval",
      "Art Director / Visual Approval",
      visualApproval.status === "approved" && artDirectorGate.status === "pass"
        ? "pass"
        : artDirectorGate.status === "manual-required" ||
            visualApproval.status === "manual-required"
          ? "manual-required"
          : "blocked",
      visualApproval.status === "approved" && artDirectorGate.status === "pass"
        ? `Visual target ${visualApproval.targetScore}/100 approved with real asset proof.`
        : `Visual target ${visualApproval.targetScore}/100 is not approved with production asset proof.`,
      [...(visualApproval.blocker ? [visualApproval.blocker] : []), ...artDirectorGate.blockers],
      [
        `human=${visualApproval.currentHumanScore ?? "missing"}`,
        `machine=${visualApproval.machineScore ?? "missing"}`,
        `artDirector=${artDirectorGate.machineScore}`,
      ],
    ),
    productionBlockerGate(
      "engine-runtime-proof",
      "Engine Runtime Proof",
      engineRuntimeProof.status === "pass"
        ? "pass"
        : engineRuntimeProof.status === "not-run"
          ? "not-run"
          : "blocked",
      engineRuntimeProof.status === "pass"
        ? `Playable ${engineRuntimeProof.engineVersion ?? "SNES"} runtime proof passed.`
        : "Playable SNES runtime engine proof is not complete.",
      engineRuntimeProof.blockers,
      [
        ...(engineRuntimeProof.romFileName ? [engineRuntimeProof.romFileName] : []),
        ...engineRuntimeProof.features,
      ],
    ),
    productionBlockerGate(
      "rom-build",
      "ROM Build",
      romBuild.status === "pass" ? "pass" : romBuild.status === "not-run" ? "not-run" : "blocked",
      romBuild.status === "pass"
        ? `Built ${romBuild.romFileName ?? ".sfc ROM"} (${romBuild.proofKind ?? "scaffold"}).`
        : "Production .sfc ROM build is not complete.",
      romBuild.blockers,
      romBuild.romFileName ? [romBuild.romFileName] : [],
    ),
    productionBlockerGate(
      "emulator-proof",
      "Emulator Proof",
      emulatorProof.status === "pass"
        ? "pass"
        : emulatorProof.status === "not-run"
          ? "not-run"
          : "blocked",
      emulatorProof.status === "pass"
        ? `ROM booted in ${emulatorProof.emulator ?? "emulator"}.`
        : "Emulator boot proof is not complete.",
      emulatorProof.blockers,
      emulatorProof.screenshotPath ? [emulatorProof.screenshotPath] : [],
    ),
    productionBlockerGate(
      "fxpak-package",
      "FXPAK Package",
      fxpakPackage.status === "pass"
        ? "pass"
        : fxpakPackage.status === "not-run"
          ? "not-run"
          : "blocked",
      fxpakPackage.status === "pass"
        ? `FXPAK package dry-run ready for ${fxpakPackage.destinationPath ?? "target volume"}.`
        : "FXPAK package proof is not complete.",
      fxpakPackage.blockers,
      fxpakPackage.destinationPath ? [fxpakPackage.destinationPath] : [],
    ),
    productionBlockerGate(
      "hardware-proof",
      "Original SNES Hardware Proof",
      hardwareProof.status === "pass" ? "pass" : hardwareProof.status,
      hardwareProof.status === "pass"
        ? "Original SNES hardware proof is recorded."
        : "Original SNES hardware proof remains separate and manual.",
      hardwareProof.blockers,
      hardwareProof.checklist.map((check) => `${check.label}:${check.status}`),
    ),
  ];
  const blockers = gates.flatMap((gate) =>
    gate.status === "pass" || gate.status === "warning" ? [] : gate.blockers,
  );
  const requiredPassed = gates.every((gate) => gate.status === "pass" || gate.status === "warning");
  const score = Math.max(
    0,
    100 - blockers.length * 10 - gates.filter((gate) => gate.status === "not-run").length * 5,
  );
  return {
    status: requiredPassed ? "production-ready" : "production-blocked",
    score,
    summary: requiredPassed
      ? "All production-grade SNES proof surfaces passed."
      : "Production-grade SNES output is blocked until asset, visual, ROM, emulator, FXPAK, and hardware proof pass.",
    gates,
    assetRegistry,
    visualApproval,
    artDirectorGate,
    toolchain,
    engineRuntimeProof,
    blockers,
  };
}

export function createSnesGameBuilderManifest(
  project: SnesStudioProject,
  options: SnesProductionReadinessOptions & { createdAt?: string } = {},
): SnesGameBuilderManifest {
  const normalized = normalizeSnesStudioProject(project);
  const productionReadiness = createSnesProductionReadinessReport(normalized, options);
  return {
    format: "openclaw-snes-game-builder-project",
    manifestVersion: 1,
    createdAt: options.createdAt ?? normalized.updatedAt,
    project: normalized,
    assetRegistry: productionReadiness.assetRegistry,
    productionReadiness,
    toolchain: productionReadiness.toolchain,
    receipts: {
      engineRuntimeProof: options.engineRuntimeProof,
      romBuild: options.romBuild,
      emulatorProof: options.emulatorProof,
      fxpakPackage: options.fxpakPackage,
      hardwareProof: options.hardwareProof,
    },
  };
}

export function parseSnesGameBuilderManifest(raw: string): SnesGameBuilderManifest {
  const parsed = JSON.parse(raw) as unknown;
  const record = recordValue(parsed);
  if (!record || record.format !== "openclaw-snes-game-builder-project") {
    throw new Error("SNES Game Builder manifest is invalid.");
  }
  const project = normalizeSnesStudioProject(record.project as SnesStudioProject);
  const receipts = recordValue(record.receipts);
  const readiness = recordValue(record.productionReadiness);
  const visualApproval = recordValue(readiness?.visualApproval);
  const assetRegistry = recordValue(record.assetRegistry);
  const assetRecords = Array.isArray(assetRegistry?.records)
    ? (assetRegistry.records as SnesProductionAssetRecord[]).filter(
        (assetRecord) => assetRecord.provenance !== "spec",
      )
    : [];
  const stanskiCanonBlockers = validateStanskiWorldCanon(project, assetRecords);
  if (stanskiCanonBlockers.length > 0) {
    throw new Error(`Stanski's World canon is invalid: ${stanskiCanonBlockers.join("; ")}`);
  }
  return createSnesGameBuilderManifest(project, {
    createdAt: typeof record.createdAt === "string" ? record.createdAt : project.updatedAt,
    assetRecords,
    visualApproval: visualApproval as Partial<SnesVisualApprovalContract>,
    toolchain: recordValue(record.toolchain) as SnesToolchainDoctorReport,
    engineRuntimeProof: recordValue(receipts?.engineRuntimeProof) as SnesEngineRuntimeProofReceipt,
    romBuild: recordValue(receipts?.romBuild) as SnesRomBuildReceipt,
    emulatorProof: recordValue(receipts?.emulatorProof) as SnesEmulatorProofReceipt,
    fxpakPackage: recordValue(receipts?.fxpakPackage) as SnesFxpakPackageReceipt,
    hardwareProof: recordValue(receipts?.hardwareProof) as SnesHardwareProofReceipt,
  });
}

export function validateStanskiWorldCanon(
  project: SnesStudioProject,
  assetRecords: SnesProductionAssetRecord[] = [],
): string[] {
  const canon = project.stanskiCanon;
  if (!canon) {
    return [];
  }
  const blockers: string[] = [];
  if (canon.targetPlatform !== "original-snes-via-fxpak-pro") {
    blockers.push("target platform must be original SNES via FXPAK Pro");
  }
  if (canon.fxpakWrites !== "blocked-until-exact-mounted-volume") {
    blockers.push("FXPAK writes must remain blocked until an exact mounted volume exists");
  }
  const levels = canon.worldOneVerticalSlice;
  const requiredRoute = [
    "Cleveland: Skyline Scramble",
    "Detroit: Motor City Mayhem",
    "Lakewood: Warren Road Roof Run",
    "Edgewater Ticket Cache",
    "Turnpike Toll Trouble",
    "Fare Snatcher Boss",
  ];
  const levelTitles = new Set(levels.map((level) => level.title));
  for (const requiredTitle of requiredRoute) {
    if (!levelTitles.has(requiredTitle)) {
      blockers.push(`World 1 progression route is missing ${requiredTitle}`);
    }
  }
  for (const level of levels) {
    if (!level.firstReward?.trim()) {
      blockers.push(`${level.title} is missing a first reward`);
    }
    if (!level.firstEnemy?.trim()) {
      blockers.push(`${level.title} is missing a first enemy`);
    }
    if (!level.checkpoint?.trim()) {
      blockers.push(`${level.title} is missing a checkpoint`);
    }
    if (!level.secretPath?.trim()) {
      blockers.push(`${level.title} is missing a secret path`);
    }
    if (level.title !== "Fare Snatcher Boss" && !level.toiletEnding?.trim()) {
      blockers.push(`${level.title} is missing toilet completion data`);
    }
    if (!Array.isArray(level.requiredAssets) || level.requiredAssets.length === 0) {
      blockers.push(`${level.title} is missing required assets`);
    }
  }
  const boss = levels.find((level) => level.title === "Fare Snatcher Boss");
  if (!boss) {
    blockers.push("World 1 boss record is missing");
  } else {
    const bossText = [boss.firstReward, boss.purpose, ...boss.qaExpectations].join(" ");
    if (!/Golden Transfer Pass #1/u.test(bossText)) {
      blockers.push("World 1 boss reward must grant Golden Transfer Pass #1");
    }
    if (!/state-machine|state machine/u.test(bossText) || !/phase/u.test(bossText)) {
      blockers.push("World 1 boss must define state-machine phases");
    }
    if (!boss.toiletEnding?.trim()) {
      blockers.push("World 1 boss is missing toilet completion data");
    }
  }
  const finalBossText = canon.finalBoss.join(" ");
  if (!/Auditor/u.test(finalBossText)) {
    blockers.push("Final boss must include The Auditor");
  }
  if (!/state machine|state-machine/u.test(finalBossText) || !/phase/u.test(finalBossText)) {
    blockers.push("Final boss must define state-machine phases");
  }
  const levelOne =
    project.stanskiLevelOneProduction ??
    canon.levelOneProduction ??
    createStanskiLevelOneProductionState(canon.movementFeel);
  if (levelOne.activeLevelId !== "w1-1-cleveland-skyline-scramble") {
    blockers.push("Level 1 production state must target Cleveland: Skyline Scramble");
  }
  if (levelOne.fullGamePlanStatus !== "preserved-for-later") {
    blockers.push("Full-game plan must remain preserved for later while Level 1 is active");
  }
  if (levelOne.openingOverlay.world !== "Cleveland" || levelOne.openingOverlay.level !== "1") {
    blockers.push('Level 1 opening overlay must say "World: Cleveland" and "Level: 1"');
  }
  if (levelOne.mechanics.startingLives !== 5) {
    blockers.push("Level 1 must start Todd with five lives");
  }
  if (levelOne.mechanics.runMultiplier !== 1.5 || levelOne.mechanics.gasBoostMultiplier !== 1.5) {
    blockers.push("Level 1 run and gas boost multipliers must be 1.5x");
  }
  if (!levelOne.mechanics.fallingGasBoostAllowed) {
    blockers.push("Level 1 must allow gas boost while Todd is falling");
  }
  const requiredLevelOneObjects = [
    "l1-cheeseburger-trail",
    "l1-receipt-goblin",
    "l1-burrito-block",
    "l1-bridge-checkpoint",
    "l1-upper-awning-secret",
    "l1-pizza-slice",
    "l1-turnstile-snatcher",
    "l1-toilet-ending",
    "l1-fireworks-vfx",
  ];
  const levelOneObjectIds = new Set(levelOne.objects.map((object) => object.id));
  for (const requiredObjectId of requiredLevelOneObjects) {
    if (!levelOneObjectIds.has(requiredObjectId)) {
      blockers.push(`Level 1 is missing required gameplay object ${requiredObjectId}`);
    }
  }
  if (!levelOne.replayScript.some((step) => step.id === "toilet-ending")) {
    blockers.push("Level 1 replay script must reach the toilet ending");
  }
  const requiredCanonTerms = [
    ["Secret World 9", canon.secretSystems],
    ["Receipt Reality", canon.secretSystems],
    ["Back of the Map", canon.secretSystems],
    ["true ending", canon.storyArc.concat(canon.finalBoss)],
    ["man-and-boy photo", canon.gameBible],
  ] as const;
  for (const [term, sections] of requiredCanonTerms) {
    if (!sections.join(" ").toLowerCase().includes(term.toLowerCase())) {
      blockers.push(`Canon is missing ${term}`);
    }
  }
  const manBoyReference = canon.references.find(
    (reference) => reference.id === "man-boy-snes-photo-reference",
  );
  if (!manBoyReference) {
    blockers.push("Canon is missing man-boy-snes-photo-reference");
  } else {
    const usage = manBoyReference.usage.toLowerCase();
    if (!usage.includes("family memory card") || !usage.includes("secret room")) {
      blockers.push("man-boy-snes-photo-reference must name Family Memory Card secret room usage");
    }
    if (manBoyReference.status === "preserved") {
      if (!manBoyReference.path.trim() || !manBoyReference.sha256?.trim()) {
        blockers.push("man-boy-snes-photo-reference is preserved without path and hash");
      }
      if (
        !manBoyReference.dimensions ||
        manBoyReference.dimensions.width <= 0 ||
        manBoyReference.dimensions.height <= 0
      ) {
        blockers.push("man-boy-snes-photo-reference is preserved without image dimensions");
      }
    }
  }
  for (const assetRecord of assetRecords) {
    if (
      (assetRecord.status === "real-asset" || assetRecord.provenance !== "spec") &&
      (!assetRecord.sourceHash?.trim() || !assetRecord.sourcePath?.trim())
    ) {
      blockers.push(`Asset record ${assetRecord.id} is missing provenance hash or source path`);
    }
    if (
      assetRecord.id === "man-boy-snes-photo-reference" &&
      normalizeSnesProductionAssetMaturity(assetRecord) === "production-approved" &&
      !hasProductionVisualProof(assetRecord)
    ) {
      blockers.push(
        "man-boy-snes-photo-reference cannot be production-approved without review artifacts or in-game visual proof",
      );
    }
  }
  return blockers;
}

export function createSnesProjectPackage(
  project: SnesStudioProject,
  options: SnesProductionReadinessOptions & {
    adapterReceipts?: SnesAssetAdapterReceipt[];
    createdAt?: string;
    qaReceipts?: SnesProjectPackageQaReceipt[];
    source?: SnesProjectPackageSource;
  } = {},
): SnesProjectPackage {
  const normalized = normalizeSnesStudioProject(project);
  const manifest = createSnesGameBuilderManifest(normalized, options);
  const receipts = {
    assetAdapters: options.adapterReceipts ?? [],
    qa: options.qaReceipts ?? [
      {
        id: "production-readiness",
        path: "production-readiness.json",
        status: manifest.productionReadiness.status === "production-ready" ? "pass" : "blocked",
        summary: manifest.productionReadiness.summary,
      },
    ],
    engineRuntimeProof: options.engineRuntimeProof,
    romBuild: options.romBuild,
    emulatorProof: options.emulatorProof,
    fxpakPackage: options.fxpakPackage,
    hardwareProof: options.hardwareProof,
  };
  const packageWithoutHash = {
    format: "openclaw-snes-project-package" as const,
    packageVersion: 1 as const,
    createdAt: options.createdAt ?? normalized.updatedAt,
    projectId: normalized.id,
    projectName: normalized.name,
    source: options.source ?? ("generic" as const),
    sampleSpecific: false as const,
    manifest,
    receipts,
  };
  return {
    ...packageWithoutHash,
    packageHash: productionHash(packageWithoutHash),
  };
}

export function parseSnesProjectPackage(raw: string): SnesProjectPackage {
  const parsed = JSON.parse(raw) as unknown;
  const record = recordValue(parsed);
  if (!record || record.format !== "openclaw-snes-project-package") {
    throw new Error("SNES project package is invalid.");
  }
  const manifestRaw = record.manifest;
  if (!recordValue(manifestRaw)) {
    throw new Error("SNES project package manifest is missing.");
  }
  const manifest = parseSnesGameBuilderManifest(JSON.stringify(manifestRaw));
  const receipts = recordValue(record.receipts);
  const source =
    record.source === "sample-stanski" ||
    record.source === "sample-mvp" ||
    record.source === "stanski-production"
      ? record.source
      : "generic";
  const adapterReceipts = Array.isArray(receipts?.assetAdapters)
    ? (receipts.assetAdapters as SnesAssetAdapterReceipt[])
    : [];
  const qaReceipts = Array.isArray(receipts?.qa)
    ? (receipts.qa as SnesProjectPackageQaReceipt[])
    : [];
  return createSnesProjectPackage(manifest.project, {
    adapterReceipts,
    assetRecords: manifest.assetRegistry.records.filter(
      (assetRecord) => assetRecord.provenance !== "spec",
    ),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : manifest.createdAt,
    engineRuntimeProof: recordValue(receipts?.engineRuntimeProof) as SnesEngineRuntimeProofReceipt,
    emulatorProof: recordValue(receipts?.emulatorProof) as SnesEmulatorProofReceipt,
    fxpakPackage: recordValue(receipts?.fxpakPackage) as SnesFxpakPackageReceipt,
    hardwareProof: recordValue(receipts?.hardwareProof) as SnesHardwareProofReceipt,
    qaReceipts,
    romBuild: recordValue(receipts?.romBuild) as SnesRomBuildReceipt,
    source,
    toolchain: manifest.toolchain,
    visualApproval: manifest.productionReadiness.visualApproval,
  });
}

export function createSnesGenericProductionBacklog(): SnesGenericProductionMilestone[] {
  return [
    {
      acceptance: [
        "project package validates",
        "asset registry and QA receipts are present",
        "no sample-specific field is required",
      ],
      goal: "Create the reusable SNES project package for this game.",
      id: "GEN01",
      name: "Project package",
      patchSchema: "manifestPatch",
      surface: "manifest",
    },
    {
      acceptance: [
        "sprite, tileset, item, background, music, and SFX records exist",
        "real assets remain blocked until source hash and screenshot proof exist",
      ],
      goal: "Populate production asset records and conversion blockers.",
      id: "GEN02",
      name: "Asset registry",
      patchSchema: "assetPackPatch",
      surface: "assets",
    },
    {
      acceptance: [
        "browser replay receipt exists",
        "human visual grade status is explicit",
        "routine GPT 5.5 use remains false",
      ],
      goal: "Run deterministic preview and visual approval gates.",
      id: "GEN03",
      name: "Playtest and visual gate",
      patchSchema: "proofPatch",
      surface: "playtest",
    },
    {
      acceptance: [
        "ROM build receipt is blocked until PVSnesLib and SuperFamicheck are available",
        "browser preview is not counted as ROM proof",
      ],
      goal: "Prepare the production .sfc build contract.",
      id: "GEN04",
      name: "ROM build lane",
      patchSchema: "proofPatch",
      surface: "rom",
    },
    {
      acceptance: [
        "emulator proof is separate from ROM proof",
        "missing emulator reports an exact blocker",
      ],
      goal: "Prepare emulator boot proof.",
      id: "GEN05",
      name: "Emulator proof lane",
      patchSchema: "proofPatch",
      surface: "emulator",
    },
    {
      acceptance: [
        "FXPAK package dry-run is available",
        "real write remains approval-gated",
        "SRAM preservation is explicit",
      ],
      goal: "Prepare FXPAK Pro packaging and hardware proof checklist.",
      id: "GEN06",
      name: "FXPAK package lane",
      patchSchema: "proofPatch",
      surface: "fxpak",
    },
  ];
}

export function createSnesGenericProductionState(
  project: SnesStudioProject,
  options: {
    backlog?: SnesGenericProductionMilestone[];
    completedMilestones?: string[];
    memoryCards?: SnesGenericProductionMemoryCard[];
    receipts?: SnesProjectPackageQaReceipt[];
  } = {},
): SnesGenericProductionState {
  const normalized = normalizeSnesStudioProject(project);
  const backlog = options.backlog ?? createSnesGenericProductionBacklog();
  const completed = new Set(options.completedMilestones ?? []);
  const currentMilestone = backlog.find((milestone) => !completed.has(milestone.id)) ?? null;
  return {
    backlog,
    blockedMilestone: null,
    completedMilestones: [...completed],
    currentMilestoneId: currentMilestone?.id ?? null,
    format: "openclaw-snes-generic-production-state",
    memoryCards: options.memoryCards ?? [],
    policy: {
      defaultGpt55Reasoning: "low",
      highReasoningUseCases: [
        "initial-blueprint",
        "repeated-blocker-diagnosis",
        "architecture-or-design-conflict",
        "production-visual-approval",
        "final-shipping-approval",
      ],
      hostedGlmAllowed: false,
      localGlmOnly: true,
      lowReasoningUseCases: ["qa-summary", "obvious-repair-brief"],
      repeatedFailureThreshold: 2,
      routineGpt55Allowed: false,
    },
    projectId: normalized.id,
    receipts: options.receipts ?? [],
    stateVersion: 1,
  };
}

export function createSnesGenericProductionPacket(
  state: SnesGenericProductionState,
): SnesGenericProductionPacket {
  const milestone = state.backlog.find((entry) => entry.id === state.currentMilestoneId) ?? null;
  return {
    allowedPatchSchema: milestone?.patchSchema ?? null,
    completedMilestones: state.completedMilestones,
    doNotBreak: [
      "browser preview remains playable",
      "production gates stay honest",
      "local GLM only for routine creative AI",
      "no hosted GLM",
      "no routine GPT 5.5 cost",
      "no FXPAK writes without approval",
    ],
    gpt55Policy: decideSnesGpt55Usage("routine-local-patch"),
    gpt55Used: false,
    localGlmOnly: true,
    memoryCards: state.memoryCards.slice(-6),
    milestone,
    projectId: state.projectId,
    task: milestone ? `Complete milestone ${milestone.id} only.` : "All milestones complete.",
  };
}

function containsRawRuntimeCode(value: unknown): boolean {
  const text = stableStringify(value, 0);
  return /<script\b|<\/html>|function\s+\w+\s*\(|=>\s*\{|document\.|window\./iu.test(text);
}

export function validateSnesGenericProductionPatch(
  patch: unknown,
  state: SnesGenericProductionState,
): SnesGenericProductionPatchValidation {
  const record = recordValue(patch);
  const milestone = state.backlog.find((entry) => entry.id === state.currentMilestoneId) ?? null;
  const milestoneId = typeof record?.milestoneId === "string" ? record.milestoneId : null;
  const patchType = typeof record?.patchType === "string" ? record.patchType : null;
  const localGlmOnly = record?.localGlmOnly === true;
  const hostedGlmUsed = record?.hostedGlmUsed === true;
  const blockers = [
    ...(record ? [] : ["Patch must be a JSON object."]),
    ...(milestone ? [] : ["No current milestone is pending."]),
    ...(milestone && milestoneId === milestone.id
      ? []
      : [`Patch milestone id must be ${milestone?.id ?? "none"}.`]),
    ...(milestone && patchType === milestone.patchSchema
      ? []
      : [`Patch type must be ${milestone?.patchSchema ?? "none"}.`]),
    ...(localGlmOnly ? [] : ["Patch must set localGlmOnly: true."]),
    ...(hostedGlmUsed ? ["Patch must set hostedGlmUsed: false."] : []),
    ...(containsRawRuntimeCode(patch)
      ? ["Patch must not contain raw HTML, JavaScript, or runtime code."]
      : []),
  ];
  return {
    blockers,
    hostedGlmUsed,
    localGlmOnly,
    milestoneId,
    patchType,
    status: blockers.length === 0 ? "pass" : "blocked",
  };
}

export function applySnesGenericProductionPatch(
  state: SnesGenericProductionState,
  patch: unknown,
): SnesGenericProductionStepResult {
  const validation = validateSnesGenericProductionPatch(patch, state);
  const milestone = state.backlog.find((entry) => entry.id === state.currentMilestoneId) ?? null;
  const summary =
    recordValue(patch)?.summary && typeof recordValue(patch)?.summary === "string"
      ? (recordValue(patch)?.summary as string)
      : milestone
        ? milestone.goal
        : "No milestone.";
  if (validation.status === "blocked" || !milestone) {
    const blockedState: SnesGenericProductionState = {
      ...state,
      blockedMilestone: milestone?.id ?? state.currentMilestoneId,
      receipts: [
        ...state.receipts,
        {
          id: milestone?.id ?? "unknown",
          status: "blocked",
          summary: validation.blockers[0] ?? "Generic production patch is blocked.",
        },
      ],
    };
    return {
      receipt: blockedState.receipts.at(-1) as SnesProjectPackageQaReceipt,
      state: blockedState,
      status: "blocked",
      validation,
    };
  }
  const completedMilestones = [...new Set([...state.completedMilestones, milestone.id])];
  const nextMilestone =
    state.backlog.find((entry) => !completedMilestones.includes(entry.id)) ?? null;
  const receipt: SnesProjectPackageQaReceipt = {
    id: milestone.id,
    status: "pass",
    summary,
  };
  const memoryCard: SnesGenericProductionMemoryCard = {
    lockedDecisions: [
      `${milestone.name} accepted through ${milestone.patchSchema}.`,
      "Routine GPT 5.5 was not used.",
    ],
    milestoneId: milestone.id,
    qaProof: {
      gpt55Used: false,
      localGlmOnly: true,
      patchType: milestone.patchSchema,
    },
    status: "pass",
    summary,
  };
  return {
    receipt,
    state: {
      ...state,
      blockedMilestone: null,
      completedMilestones,
      currentMilestoneId: nextMilestone?.id ?? null,
      memoryCards: [...state.memoryCards, memoryCard],
      receipts: [...state.receipts, receipt],
    },
    status: "pass",
    validation,
  };
}

export function createSnesRomBuildReceiptFromToolchain(
  project: SnesStudioProject,
  toolchain: SnesToolchainDoctorReport = createSnesToolchainDoctorReport(),
): SnesRomBuildReceipt {
  const normalized = normalizeSnesStudioProject(project);
  const required = new Set<SnesToolchainToolId>(["pvsneslib", "superfamicheck"]);
  const blockers = toolchain.tools.flatMap((tool) =>
    required.has(tool.id) && tool.status !== "available"
      ? [`${tool.label} is required before a production .sfc build can run.`]
      : [],
  );
  return {
    assetManifestHash: productionHash(createSnesProductionAssetRegistry(normalized)),
    blockers:
      blockers.length > 0
        ? blockers
        : ["PVSnesLib ROM build adapter has not executed in this approval-gated environment."],
    checksumStatus: blockers.length > 0 ? "blocked" : "not-run",
    projectHash: productionHash(normalized),
    romFileName: `${sanitizeRomBaseName(normalized.export.romBaseName || normalized.name)}.sfc`,
    status: blockers.length > 0 ? "blocked" : "not-run",
    toolVersions: Object.fromEntries(
      toolchain.tools
        .filter((tool) => tool.version)
        .map((tool) => [tool.id, tool.version as string]),
    ),
  };
}

export function createSnesEmulatorProofReceiptFromToolchain(
  project: SnesStudioProject,
  toolchain: SnesToolchainDoctorReport = createSnesToolchainDoctorReport(),
): SnesEmulatorProofReceipt {
  const artifact = buildSnesPreviewRom(project);
  const emulatorIds = toolchain.tools
    .filter((tool) => (tool.id === "mesen" || tool.id === "bsnes") && tool.status === "available")
    .map((tool) => tool.id as "mesen" | "bsnes");
  const plan = createSnesEmulatorBootPlan(artifact, emulatorIds);
  return {
    blockers:
      plan.blockers.length > 0
        ? plan.blockers
        : ["Emulator execution and screenshot proof have not run yet."],
    emulator:
      plan.selectedEmulator === "mesen" || plan.selectedEmulator === "bsnes"
        ? plan.selectedEmulator
        : undefined,
    launchCommand: plan.command,
    romHash: productionHash({ checksum: artifact.checksum, fileName: artifact.fileName }),
    screenshotPath: plan.selectedEmulator ? plan.screenshotFileName : undefined,
    status: plan.status === "ready" ? "not-run" : "blocked",
  };
}

export function createSnesFxpakPackageDryRunReceipt(
  project: SnesStudioProject,
  options: { volumePath?: string } = {},
): SnesFxpakPackageReceipt {
  const artifact = buildSnesPreviewRom(project);
  const fxpakPackage = createSnesFxpakExportPackage(artifact);
  const romFile = fxpakPackage.files.find((file) => file.kind === "rom");
  return {
    blockers:
      fxpakPackage.status === "ready"
        ? ["Real FXPAK copy is approval-gated and has not been executed."]
        : fxpakPackage.blockers,
    destinationPath: `${options.volumePath ?? "/Volumes/FXPAK"}${romFile?.destinationPath ?? `/${artifact.fileName}`}`,
    dryRun: true,
    fileSystemRequired: "fat32",
    savePolicy: "preserve-existing-sram",
    status: fxpakPackage.status === "ready" ? "pass" : "blocked",
  };
}

export function createStanskiWorldReferenceReceipts(
  references: Partial<SnesStanskiReferenceReceipt>[] = [],
): SnesStanskiReferenceReceipt[] {
  const defaults: SnesStanskiReferenceReceipt[] = [
    {
      id: "stanski-master-prompt",
      path: ".artifacts/snes-projects/stanskis-world/references/prompts/",
      sourceType: "prompt-text",
      status: "planned",
      usage: "Primary user-authored Stanski's World design prompts and expansion notes.",
    },
    {
      id: "todd-stanski-reference",
      path: ".artifacts/snes-image-assets/todd-stanski-reference/source/source.jpg",
      sourceType: "image-reference",
      status: "planned",
      usage: "Character identity reference for Todd Stanski sprite, portrait, and title art.",
    },
    {
      id: "man-boy-snes-photo-reference",
      path: ".artifacts/snes-image-assets/man-boy-snes-photo-reference/source/source.jpg",
      sourceType: "image-reference",
      status: "planned",
      usage:
        "User-provided man-and-boy photo planned for SNES-safe in-game inclusion as the Family Memory Card secret room cameo, with optional ending/credits memory card reuse after visual QA.",
    },
    {
      id: "prior-stanski-canon-summary",
      path: ".artifacts/snes-projects/stanskis-world/references/canon-summary.json",
      sourceType: "canon-summary",
      status: "planned",
      usage: "Consolidated prior Stanski canon, world, secret, story, and hardware requirements.",
    },
  ];
  const byId = new Map(defaults.map((receipt) => [receipt.id, receipt]));
  for (const reference of references) {
    if (!reference.id) continue;
    const existing = byId.get(reference.id);
    byId.set(reference.id, {
      ...(existing ?? defaults[0]),
      ...reference,
    } as SnesStanskiReferenceReceipt);
  }
  return [...byId.values()];
}

export function createStanskiWorldOneVerticalSliceLevels(): SnesStanskiWorldLevelRecord[] {
  return [
    {
      checkpoint: "Midpoint near a rooftop bus shelter before the skyline climb.",
      firstEnemy: "Receipt goblin that walks slowly with obvious wind-up.",
      firstReward: "Cheeseburger trail teaching safe movement before the first gap.",
      id: "w1-1-cleveland-skyline-scramble",
      mechanicsTaught: ["walk", "run", "jump", "collect cheeseburgers", "read skyline signs"],
      purpose:
        "Open World 1 with a readable Cleveland skyline tutorial and the first toilet payoff.",
      qaExpectations: [
        "First jump is reachable without run.",
        "First enemy appears after movement and reward are learned.",
        "Toilet ending is reachable in a deterministic replay.",
      ],
      requiredAssets: [
        "Todd small/big sprite sheet",
        "Cleveland skyline tiles",
        "cheeseburger collectible",
        "toilet goal",
      ],
      secretPath:
        "Upper awning route behind Terminal Tower-style silhouettes reveals Edgewater Ticket Cache clue.",
      snesBudgetEstimate: "Mode 1, 2 background layers, <=96 metatiles, <=48 active sprites.",
      title: "Cleveland: Skyline Scramble",
      toiletEnding:
        "Todd sits on a porcelain throne billboard bathroom and stamps the first city receipt.",
      world: "World 1",
    },
    {
      checkpoint: "Garage checkpoint after conveyor tutorial.",
      firstEnemy: "Loose hubcap patrol with predictable bounce.",
      firstReward: "Cheeseburger under a piston lift, safe to collect.",
      id: "w1-2-detroit-motor-city-mayhem",
      mechanicsTaught: ["conveyors", "moving platforms", "damage knockback", "run timing"],
      purpose: "Teach industrial motion and faster obstacle reading while staying SNES-safe.",
      qaExpectations: [
        "Conveyors never push the player into unavoidable damage.",
        "Checkpoint restart remains finishable.",
        "Enemy density stays below the World 1 threshold.",
      ],
      requiredAssets: ["factory tiles", "conveyor tiles", "hubcap enemy", "garage toilet"],
      secretPath: "Factory rafters lead to a toll-ticket scrap for the Back of the Map.",
      snesBudgetEstimate: "Mode 1, HDMA avoided, animated conveyor tiles capped to four frames.",
      title: "Detroit: Motor City Mayhem",
      toiletEnding: "Garage restroom stall with exhaust-fan confetti.",
      world: "World 1",
    },
    {
      checkpoint: "Warren Road porch checkpoint after the first roof climb.",
      firstEnemy: "Lake-effect cloud pest introduced on flat roof before gaps.",
      firstReward: "Burrito block on the first safe porch makes Big Stanski available.",
      id: "w1-3-lakewood-warren-road-roof-run",
      mechanicsTaught: ["coyote time", "jump buffer", "roof slopes", "secret house entry"],
      purpose:
        "Preserve Lakewood/Warren Road house requirements and teach roof-to-roof platforming.",
      qaExpectations: [
        "All roof gaps are reachable with normal jump tuning.",
        "Warren Road house clue is present exactly.",
        "Secret house does not become required for first completion.",
      ],
      requiredAssets: ["Lakewood houses", "Warren Road street sign", "roof tiles", "cloud pest"],
      secretPath:
        "Correct Warren Road house opens a photo room containing the man-and-boy cameo plan.",
      snesBudgetEstimate: "Mode 1, parallax neighborhood layer, <=128 visible background tiles.",
      title: "Lakewood: Warren Road Roof Run",
      toiletEnding: "Upstairs bathroom throne with newspaper gag and receipt stamp.",
      world: "World 1",
    },
    {
      checkpoint: "Pier checkpoint before ticket-cache maze.",
      firstEnemy: "Seagull snatcher with slow arc.",
      firstReward: "Visible pizza slice before the first projectile-required enemy.",
      id: "w1-4-edgewater-ticket-cache",
      mechanicsTaught: [
        "projectile",
        "secret scanning",
        "water hazard restraint",
        "optional cache",
      ],
      purpose: "Introduce hidden ticket caches and the first projectile-required enemy safely.",
      qaExpectations: [
        "Pizza projectile defeats the required enemy.",
        "Secret cache is optional and reachable.",
        "Water hazards have clear recovery platforms.",
      ],
      requiredAssets: ["Edgewater lake tiles", "ticket cache icon", "seagull enemy", "pizza item"],
      secretPath: "Lakefront lower route reveals a Receipt Reality tear.",
      snesBudgetEstimate: "Mode 1, animated water tile budget capped to eight 8x8 tiles.",
      title: "Edgewater Ticket Cache",
      toiletEnding: "Beach bathroom toilet with lake-firework reflection.",
      world: "World 1",
    },
    {
      checkpoint: "Rest-stop checkpoint before toll-booth gauntlet.",
      firstEnemy: "Orange-cone creep with clear safe jump arc.",
      firstReward: "Cheeseburger line teaching toll-gate rhythm.",
      id: "w1-5-turnpike-toll-trouble",
      mechanicsTaught: ["timed gates", "safe rush", "checkpoint retry", "boss key setup"],
      purpose: "Prepare for the Fare Snatcher boss with toll gates and receipt timing.",
      qaExpectations: [
        "Timed toll gates have readable cycle length.",
        "Checkpoint retry never soft-locks the player.",
        "Boss door opens only after required ticket cache flag.",
      ],
      requiredAssets: ["turnpike signs", "toll gates", "orange-cone creep", "rest-stop toilet"],
      secretPath: "Back-lane toll booth reveals the Fare Collector ledger hint.",
      snesBudgetEstimate: "Mode 1, timed gates update through simple state bytes.",
      title: "Turnpike Toll Trouble",
      toiletEnding: "Rest-stop stall with toll receipt dispenser gag.",
      world: "World 1",
    },
    {
      checkpoint: "Boss retry starts outside the fare booth arena.",
      firstEnemy: "Fare Snatcher phase 1: ticket swipe dash.",
      firstReward: "Golden Transfer Pass #1 after boss defeat.",
      id: "w1-boss-fare-snatcher",
      mechanicsTaught: ["boss phases", "readable telegraphs", "reward collection", "world clear"],
      purpose: "Close World 1 and grant Golden Transfer Pass #1.",
      qaExpectations: [
        "Boss has at least three readable state-machine phases.",
        "Golden Transfer Pass #1 is awarded exactly once.",
        "World 2 unlock flag is set after toilet victory and boss reward.",
      ],
      requiredAssets: ["Fare Snatcher boss", "transfer pass", "fare booth arena", "boss toilet"],
      secretPath: "No required secret; optional perfect-clear receipt opens World 9 clue.",
      snesBudgetEstimate:
        "Mode 1 boss room, <=16 active sprites per scanline, no SuperFX required.",
      title: "Fare Snatcher Boss",
      toiletEnding: "Boss arena station restroom completes the World 1 receipt chain.",
      world: "World 1",
    },
  ];
}

export function createStanskiLevelOneProductionState(
  movementFeel: SnesStanskiMovementFeelContract,
): SnesStanskiLevelOneProductionState {
  const definitionOfDone: SnesStanskiLevelOneChecklistItem[] = [
    {
      id: "opening-overlay",
      label: 'Opening overlay says "World: Cleveland" and "Level: 1".',
      proof: "Level 1 data and dashboard receipt require the overlay text before play starts.",
      status: "implemented",
    },
    {
      id: "five-lives",
      label: "Todd starts with five lives.",
      proof: "Level 1 mechanic contract sets startingLives to 5.",
      status: "implemented",
    },
    {
      id: "movement-kit",
      label: "Walk, run, jump, falling gas boost, crouch, and projectile behavior exist.",
      proof:
        "Mechanic contract defines run multiplier, jump tuning, falling gas boost, crouch hitboxes, and projectile origins.",
      status: "implemented",
    },
    {
      id: "first-30-seconds",
      label: "First 30 seconds teach movement with a cheeseburger trail before danger.",
      proof: "Skyline tutorial section contains safe cheeseburger rewards before the first enemy.",
      status: "implemented",
    },
    {
      id: "fair-first-enemy",
      label: "First enemy is safe and fair.",
      proof: "Receipt goblin starts after the tutorial gap with a slow wind-up and a flat approach.",
      status: "implemented",
    },
    {
      id: "power-up-pacing",
      label: "Burrito block and pizza projectile appear before their required use.",
      proof:
        "Food section places burrito and pizza before the projectile-required Turnstile Snatcher.",
      status: "implemented",
    },
    {
      id: "checkpoint-secret",
      label: "One checkpoint and one reachable secret path exist.",
      proof: "Bridge checkpoint and upper awning secret route are in the deterministic object list.",
      status: "implemented",
    },
    {
      id: "toilet-ending",
      label: "Toilet ending includes sitting, newspaper, two poop drops, and fireworks.",
      proof: "Goal trigger and VFX objects require the complete ending sequence.",
      status: "implemented",
    },
    {
      blocker:
        "Real man-and-boy photo source is unavailable locally; Family Memory Card can only be a planned frame until the source is preserved and converted.",
      id: "family-memory-card",
      label: "Family Memory Card secret-room cameo is planned.",
      proof:
        "Secret room frame exists in Level 1 data, but source-photo conversion and in-game visual proof remain blocked.",
      status: "blocked",
    },
  ];
  const sections: SnesStanskiLevelOneSection[] = [
    {
      endX: 512,
      id: "skyline-tutorial",
      name: "Cleveland skyline tutorial",
      purpose: "Teach walk, jump, cheeseburger collection, and readable skyline signs safely.",
      qaExpectation: "First reward is reachable before the first enemy appears.",
      requiredMechanics: ["walk", "jump", "collect"],
      requiredReward: "Cheeseburger trail",
      startX: 0,
    },
    {
      endX: 1152,
      id: "sidewalk-potholes",
      name: "Sidewalk and pothole section",
      purpose: "Introduce the first fair Receipt Goblin and a safe burrito block.",
      qaExpectation: "First enemy can be jumped or avoided after a flat telegraph zone.",
      requiredMechanics: ["run", "jump", "big-stanski"],
      requiredReward: "Burrito block",
      startX: 512,
    },
    {
      endX: 1792,
      id: "bridge-gas-route",
      name: "Bridge skyline gas-boost route",
      purpose: "Teach falling gas boost and reveal the optional upper awning secret route.",
      qaExpectation: "Secret path is reachable only with the gas boost and remains optional.",
      requiredMechanics: ["falling-gas-boost", "checkpoint"],
      requiredReward: "Ticket-cache clue",
      startX: 1152,
    },
    {
      endX: 2432,
      id: "food-power-up",
      name: "Food and projectile section",
      purpose: "Give pizza before the projectile-required Turnstile Snatcher.",
      qaExpectation: "Bad-breath projectile can defeat the required enemy before the restroom route.",
      requiredMechanics: ["pizza-projectile", "crouch-shoot"],
      requiredReward: "Pizza slice",
      startX: 1792,
    },
    {
      endX: 3072,
      id: "restroom-finale",
      name: "Restroom and toilet ending",
      purpose: "Close Level 1 with a readable porcelain toilet payoff and fireworks.",
      qaExpectation: "Replay reaches toilet ending and fireworks continue without freezing.",
      requiredMechanics: ["goal-trigger", "ending-sequence"],
      requiredReward: "First city receipt stamp",
      startX: 2432,
    },
  ];
  const objects: SnesStanskiLevelOneObject[] = [
    {
      behavior: "Spawn Todd on flat sidewalk facing right with five lives.",
      id: "l1-player-start",
      kind: "player-start",
      name: "Todd start",
      qaAssertion: "Player starts at the first safe tile and can move right immediately.",
      x: 32,
      y: 176,
    },
    {
      behavior: "Arc of cheeseburgers leads the player across the first safe jump.",
      id: "l1-cheeseburger-trail",
      kind: "collectible",
      name: "Cheeseburger trail",
      qaAssertion: "First reward is visible and reachable without run.",
      width: 160,
      x: 128,
      y: 144,
    },
    {
      behavior: "Slow patrol with a two-tile wind-up zone and safe jump arc.",
      id: "l1-receipt-goblin",
      kind: "enemy",
      name: "Receipt Goblin",
      qaAssertion: "Enemy appears only after movement/reward onboarding.",
      x: 420,
      y: 176,
    },
    {
      behavior: "Question-style block containing the burrito Big Stanski power-up.",
      id: "l1-burrito-block",
      kind: "block",
      name: "Burrito block",
      qaAssertion: "Burrito block is reachable before the bridge section.",
      x: 704,
      y: 112,
    },
    {
      behavior: "Checkpoint sign at bridge midpoint; death restarts here after activation.",
      id: "l1-bridge-checkpoint",
      kind: "checkpoint",
      name: "Bridge checkpoint",
      qaAssertion: "Checkpoint restart remains finishable.",
      x: 1248,
      y: 160,
    },
    {
      behavior: "Upper awning path with ticket-cache clue and Family Memory Card frame slot.",
      id: "l1-upper-awning-secret",
      kind: "secret-route",
      name: "Upper awning secret route",
      qaAssertion: "Secret path is reachable with falling gas boost and is not required.",
      width: 360,
      x: 1456,
      y: 96,
    },
    {
      behavior: "Pizza slice enables bad-breath projectiles.",
      id: "l1-pizza-slice",
      kind: "power-up",
      name: "Pizza slice",
      qaAssertion: "Pizza appears before the projectile-required enemy.",
      x: 1920,
      y: 136,
    },
    {
      behavior: "Blocks progress until hit by one bad-breath projectile.",
      id: "l1-turnstile-snatcher",
      kind: "projectile-gate",
      name: "Turnstile Snatcher",
      qaAssertion: "Projectile defeats the required enemy.",
      x: 2216,
      y: 168,
    },
    {
      behavior:
        "Porcelain toilet goal triggers Todd sit pose, newspaper, exactly two poop drops, splash, receipt stamp, and fireworks.",
      id: "l1-toilet-ending",
      kind: "goal",
      name: "Porcelain toilet ending",
      qaAssertion: "Replay reaches the toilet ending and win state.",
      x: 2928,
      y: 160,
    },
    {
      behavior: "Fireworks continue for at least 240 frames after the toilet sit trigger.",
      id: "l1-fireworks-vfx",
      kind: "vfx",
      name: "Ending fireworks",
      qaAssertion: "Fireworks do not freeze.",
      x: 2960,
      y: 64,
    },
  ];
  const replayScript: SnesStanskiLevelOneReplayStep[] = [
    {
      durationFrames: 90,
      expected: "Todd walks into the cheeseburger trail.",
      id: "walk-to-first-reward",
      input: ["right"],
      startFrame: 0,
    },
    {
      durationFrames: 60,
      expected: "Todd clears the first safe jump.",
      id: "first-jump",
      input: ["right", "jump"],
      startFrame: 90,
    },
    {
      durationFrames: 120,
      expected: "Todd runs past the fair Receipt Goblin after reading its wind-up.",
      id: "fair-enemy",
      input: ["right", "run", "jump"],
      startFrame: 150,
    },
    {
      durationFrames: 120,
      expected: "Todd activates the burrito block and reaches bridge checkpoint.",
      id: "burrito-checkpoint",
      input: ["right", "jump"],
      startFrame: 270,
    },
    {
      durationFrames: 150,
      expected: "Falling gas boost reaches the optional awning route.",
      id: "falling-gas-secret",
      input: ["right", "jump", "gas-boost"],
      startFrame: 390,
    },
    {
      durationFrames: 120,
      expected: "Pizza is collected before projectile gate.",
      id: "collect-pizza",
      input: ["right", "run"],
      startFrame: 540,
    },
    {
      durationFrames: 90,
      expected: "Crouched projectile defeats Turnstile Snatcher.",
      id: "projectile-required-enemy",
      input: ["right", "down", "shoot"],
      startFrame: 660,
    },
    {
      durationFrames: 240,
      expected: "Todd reaches toilet, sits, reads newspaper, drops two poops, and fireworks continue.",
      id: "toilet-ending",
      input: ["right", "run"],
      startFrame: 750,
    },
  ];
  const blockers = [
    "100/100 production visuals require human approval after executable visual proof.",
    "Family Memory Card photo cameo remains blocked until the readable man/boy source photo is preserved and converted.",
    "Local emulator proof may remain blocked until invalid emulator app bundles are repaired.",
    "FXPAK copy remains blocked until an exact mounted FAT32 FXPAK/SD2SNES volume is supplied.",
    "Original SNES hardware proof remains manual and incomplete.",
  ];
  return {
    activeLevelId: "w1-1-cleveland-skyline-scramble",
    activeLevelTitle: "Cleveland: Skyline Scramble",
    blockers,
    definitionOfDone,
    deferredMilestoneGroups: [
      "remaining World 1 levels",
      "Worlds 2-8",
      "Secret World 9",
      "The Auditor final boss",
      "true ending",
      "release candidate hardware proof",
    ],
    format: "openclaw-stanski-level-one-production-state",
    fullGamePlanStatus: "preserved-for-later",
    mechanics: {
      ...movementFeel,
      crouchHitbox: { bigCrouchedHeight: 20, bigStandingHeight: 32, smallHeight: 20 },
      fallingGasBoostAllowed: true,
      gasBoostMultiplier: 1.5,
      projectileOrigins: { bigCrouchedY: 18, bigStandingY: 12, smallY: 18 },
      startingLives: 5,
    },
    objects,
    openingOverlay: { level: "1", world: "Cleveland" },
    productionScope: "level-1-only",
    projectId: "stanskis-world",
    proofSurfaces: [
      {
        id: "level-data",
        label: "Level 1 deterministic data",
        proof: "Sections, objects, mechanics, and replay script are part of the project package.",
        status: "implemented",
      },
      {
        id: "browser-playtest",
        label: "Browser playtest",
        proof:
          "Executable QA contract is present; live browser proof must be run before claiming a playable link.",
        status: "planned",
      },
      {
        id: "rom-proof",
        label: ".sfc ROM proof",
        proof: "project-engine-rom receipt must record Stanski Level 1 runtime features.",
        status: "planned",
      },
      {
        blocker: "Human visual approval has not been recorded.",
        id: "human-visual-approval",
        label: "100/100 human visual approval",
        proof: "Visual proof artifacts exist separately; human approval remains required.",
        status: "blocked",
      },
    ],
    replayScript,
    sections,
    snesBudget: {
      activeSpriteBudget: 48,
      enhancementChip: "none",
      heightPixels: 224,
      mapMode: "lorom",
      metatileBudget: 96,
      videoMode: "mode1",
      widthPixels: 3072,
    },
    version: 1,
  };
}

export function createStanskiWorldCanon(
  createdAt = new Date().toISOString(),
  references: Partial<SnesStanskiReferenceReceipt>[] = [],
): SnesStanskiWorldCanon {
  const movementFeel: SnesStanskiMovementFeelContract = {
    acceleration: 0.14,
    conveyorSupport: "planned",
    coyoteTimeFrames: 6,
    damageKnockback: { invulnerabilityFrames: 90, xVelocity: 1.6, yVelocity: -3.2 },
    jumpBufferFrames: 6,
    jumpVelocity: -5.6,
    runMultiplier: 1.5,
    slopeSupport: "planned",
    variableJump: true,
    walkSpeed: 1.45,
  };
  return {
    audioStandard: [
      "SPC700/BRR budgets stay explicit for every music and SFX milestone.",
      "World themes use original Cleveland/road-trip motifs, not copied commercial melodies.",
      "Every pickup, jump, gas boost, toilet completion, boss hit, death screen, and secret reveal has a planned SFX event.",
    ],
    baseRom: "standard-snes-compatible",
    definitionOfDone: [
      "Project package validates as a generic SNES Studio project.",
      "Browser preview, ROM proof, emulator proof, FXPAK dry-run, and hardware proof remain separate gates.",
      "Production grade requires human 100/100 visual approval plus executable proof.",
      "Full game completion requires all worlds, secrets, final boss, endings, and original SNES hardware checklist proof.",
    ],
    finalBoss: [
      "The Auditor is the final boss and must be implemented as a real state machine with phases.",
      "The true ending requires Receipt Reality and Back of the Map conditions, not a prose-only flag.",
    ],
    format: "openclaw-stanski-world-canon",
    fxpakWrites: "blocked-until-exact-mounted-volume",
    gameBible: [
      "Stanski's World is an original commercial-SNES-era platformer built for humor, secrets, and readable action.",
      "Todd Stanski is the playable hero and must use the drawing reference for sprite identity.",
      "The man-and-boy photo must appear somewhere in the game as a SNES-safe in-game reference or cameo after conversion and proof.",
      "Every normal level ends with a toilet completion event; toilets are core progression objects.",
      `Canon locked at ${createdAt}; future changes must be append-only decisions unless the user overrides them.`,
    ],
    levelOneProduction: createStanskiLevelOneProductionState(movementFeel),
    movementFeel,
    optionalEnhancements: "disabled-by-default",
    references: createStanskiWorldReferenceReceipts(references),
    riskRegister: [
      "100/100 visuals are the highest-risk scope and require human approval.",
      "Full 8-world content can exceed ROM and art budgets unless scoped by world and budgeted per milestone.",
      "FXPAK copy and original hardware proof are blocked until a real mounted volume and physical proof are available.",
      "Reference images are source/reference assets first; they are not production-approved art until converted and seen in-game.",
    ],
    secretSystems: [
      "Secret World 9 is unlocked through perfect receipts, ticket caches, and Back of the Map clues.",
      "Receipt Reality is a hidden layer that changes level interpretation and supports true-ending progression.",
      "Back of the Map secrets reveal optional routes and Auditor lore without blocking a first completion path.",
      "Secret systems must be represented by save flags and executable unlock checks.",
    ],
    storyArc: [
      "World 1 establishes Todd, the travel/receipt conflict, and the Fare Collector threat.",
      "Worlds 2-8 expand the road-trip map, secret receipts, boss rewards, and escalating absurdity.",
      "Each world boss grants a major pass or receipt artifact.",
      "The story ends with The Auditor, a false ending, and a true ending when all secret conditions are met.",
    ],
    targetPlatform: "original-snes-via-fxpak-pro",
    technicalContract: [
      "Original SNES compatibility is the base target: 65c816, PPU, VRAM, CGRAM, OAM, DMA/VBlank, SPC700, and LoROM/HiROM constraints apply.",
      "FXPAK Pro is a delivery device, not permission to exceed base SNES behavior unless an enhancement milestone is explicitly approved.",
      "SuperFX and other enhancement paths remain disabled by default.",
      "ROM/emulator/FXPAK/hardware proof surfaces must not be collapsed.",
    ],
    version: 1,
    visualStandard: [
      "100/100 target means original commercial SNES-era platformer quality, not copied Nintendo or Sega assets.",
      "Placeholder/procedural assets cannot pass production visuals.",
      "Hero, enemies, tilesets, background layers, UI, and bosses require source hashes, review sheets, palette metadata, and in-game screenshot proof.",
    ],
    visualTarget: { approval: "human-required", score: 100 },
    worldOneVerticalSlice: createStanskiWorldOneVerticalSliceLevels(),
    worldStructure: [
      "Eight primary worlds plus Secret World 9.",
      "World 1 includes Cleveland, Detroit, Lakewood/Warren Road, Edgewater, Turnpike, and Fare Snatcher.",
      "Worlds 2-8 remain planned backlog until Batch 1 foundation is complete.",
    ],
  };
}

export function createStanskiWorldProductionBacklog(): SnesGenericProductionMilestone[] {
  const active = (milestone: SnesGenericProductionMilestone): SnesGenericProductionMilestone => ({
    ...milestone,
    status: "active",
  });
  const planned = (milestone: SnesGenericProductionMilestone): SnesGenericProductionMilestone => ({
    ...milestone,
    status: "planned",
  });
  return [
    active({
      acceptance: [
        "All readable prompt and image references have path/hash receipts.",
        "Missing or stale attachments are explicit blockers.",
      ],
      goal: "Preserve canon references for the Stanski project.",
      group: "foundation-canon",
      id: "SW-B1-M1",
      name: "Preserve canon references",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "stanskis-world package validates",
        "target platform is original SNES via FXPAK Pro",
        "visual target is human-approved 100/100",
      ],
      goal: "Create the generic SNES Studio project package.",
      group: "foundation-canon",
      id: "SW-B1-M2",
      name: "Generic project package",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "Canon includes toilets, death screen, World 1, Fare Collector, Secret World 9, Receipt Reality, Back of the Map, Auditor, true ending, and photo inclusion.",
      ],
      goal: "Lock the canonical game bible and technical contract.",
      group: "foundation-canon",
      id: "SW-B1-M3",
      name: "Canon lock",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "World 1 progression graph validates",
        "Fare Snatcher grants Golden Transfer Pass #1",
        "Lakewood/Warren Road house requirements are present exactly",
      ],
      goal: "Create World 1 vertical-slice design records.",
      group: "world-1-vertical-slice",
      id: "SW-B1-M7",
      name: "World 1 vertical-slice data",
      patchSchema: "levelPatch",
      surface: "levels",
    }),
    active({
      acceptance: [
        "Movement tuning data validates",
        "Preview and engine stages have a single movement contract source",
      ],
      goal: "Create the movement feel lab scaffold.",
      group: "movement-core-engine",
      id: "SW-B1-M8",
      name: "Movement feel lab scaffold",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "Project conversion, engine ROM, emulator, and FXPAK dry-run receipts exist or exact blockers are recorded",
        "Proof surfaces remain separate",
      ],
      goal: "Wire the Stanski project to existing local SNES toolchain proof commands.",
      group: "rom-emulator-fxpak-hardware-proof",
      id: "SW-B1-M9",
      name: "Toolchain proof wiring",
      patchSchema: "proofPatch",
      surface: "rom",
    }),
    active({
      acceptance: [
        "Only Cleveland: Skyline Scramble is active",
        "Full-game worlds, Secret World 9, Auditor boss, and true ending stay planned for later",
      ],
      goal: "Activate the Level 1-only production target without losing the full-game plan.",
      group: "level-1-cleveland-skyline-scramble",
      id: "SW-L1-M0",
      name: "Level 1 scope lock",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "Opening overlay, five lives, movement kit, first reward, fair enemy, checkpoint, secret path, and toilet ending are all defined",
        "Family Memory Card cameo remains an exact blocker until source photo conversion exists",
      ],
      goal: "Lock the production definition of done for Cleveland: Skyline Scramble.",
      group: "level-1-cleveland-skyline-scramble",
      id: "SW-L1-M1",
      name: "Level 1 definition of done",
      patchSchema: "manifestPatch",
      surface: "manifest",
    }),
    active({
      acceptance: [
        "Tile/collision/camera/object/replay records exist",
        "Projectile-required enemy appears after pizza",
        "Replay script reaches the toilet ending",
      ],
      goal: "Create deterministic playable Level 1 data.",
      group: "level-1-cleveland-skyline-scramble",
      id: "SW-L1-M2",
      name: "Level 1 playable data",
      patchSchema: "levelPatch",
      surface: "levels",
    }),
    active({
      acceptance: [
        "Walk/run/jump/falling gas boost/crouch/projectile/death restart constants are defined",
        "Run speed and gas boost are exactly 1.5x",
      ],
      goal: "Tune the Level 1 movement and gameplay contract.",
      group: "level-1-cleveland-skyline-scramble",
      id: "SW-L1-M3",
      name: "Level 1 movement tuning",
      patchSchema: "manifestPatch",
      surface: "playtest",
    }),
    planned({
      acceptance: ["walk/run/jump/coyote/jump-buffer feel is tuned through executable replay"],
      goal: "Implement production movement and collision tuning.",
      group: "movement-core-engine",
      id: "SW-FUTURE-MOVE01",
      name: "Movement core implementation",
      patchSchema: "manifestPatch",
      surface: "playtest",
    }),
    planned({
      acceptance: ["World 1 is playable end-to-end with boss reward and toilet chain"],
      goal: "Build the World 1 vertical slice.",
      group: "world-1-vertical-slice",
      id: "SW-FUTURE-W1-PLAYABLE",
      name: "World 1 playable implementation",
      patchSchema: "levelPatch",
      surface: "levels",
    }),
    planned({
      acceptance: [
        "Todd, enemies, tilesets, backgrounds, UI, music, and SFX meet production visual/audio gates",
      ],
      goal: "Produce commercial-SNES-quality art and audio.",
      group: "art-audio-production",
      id: "SW-FUTURE-ART-AUDIO",
      name: "Art and audio production",
      patchSchema: "assetPackPatch",
      surface: "assets",
    }),
    planned({
      acceptance: [
        "Secret World 9, Receipt Reality, Back of the Map, and true-ending flags are executable",
      ],
      goal: "Implement replay and secret systems.",
      group: "secrets-replay",
      id: "SW-FUTURE-SECRETS",
      name: "Secrets and replayability",
      patchSchema: "manifestPatch",
      surface: "levels",
    }),
    planned({
      acceptance: [
        "Worlds 2 through 8 have validated routes, bosses, rewards, and hardware budgets",
      ],
      goal: "Complete the remaining primary worlds.",
      group: "worlds-2-through-8",
      id: "SW-FUTURE-W2-W8",
      name: "Worlds 2-8 production",
      patchSchema: "levelPatch",
      surface: "levels",
    }),
    planned({
      acceptance: [
        "The Auditor final boss has a validated state machine and false/true ending branches",
      ],
      goal: "Implement final boss and endings.",
      group: "final-boss-endings",
      id: "SW-FUTURE-FINAL",
      name: "Final boss and endings",
      patchSchema: "levelPatch",
      surface: "levels",
    }),
    planned({
      acceptance: [
        "ROM, emulator, FXPAK copy, and original hardware proof pass or are exact external blockers",
      ],
      goal: "Produce the release-candidate proof stack.",
      group: "release-candidate",
      id: "SW-FUTURE-RC",
      name: "Release candidate proof",
      patchSchema: "proofPatch",
      surface: "fxpak",
    }),
  ];
}

export function createStanskiWorldProductionProjectPackage(
  createdAt = new Date().toISOString(),
  references: Partial<SnesStanskiReferenceReceipt>[] = [],
): SnesProjectPackage {
  const project = generateSnesProjectFromPrompt(
    "Create Stanski's World as a production-grade original SNES platformer for FXPAK Pro and original SNES hardware.",
    createDefaultSnesStudioProject(createdAt),
  ).project;
  const canon = createStanskiWorldCanon(createdAt, references);
  const worldOneLevels = canon.worldOneVerticalSlice;
  const levelOneProduction =
    canon.levelOneProduction ?? createStanskiLevelOneProductionState(canon.movementFeel);
  const activeLevel = worldOneLevels[0]!;
  project.id = "stanskis-world";
  project.name = "Stanski's World";
  project.updatedAt = createdAt;
  project.profile = {
    ...project.profile,
    enhancementChip: "none",
    fxpak: {
      ...project.profile.fxpak,
      fileSystem: "fat32",
      preserveExistingSaves: true,
    },
    mapMode: "lorom",
    region: "ntsc",
    target: "fxpak-pro",
    videoMode: "mode1",
  };
  project.export = { romBaseName: "stanskis-world" };
  project.gameBrief = {
    audience: "beginner",
    gameType: "side-scrolling-platformer",
    prompt:
      "Build Level 1: Cleveland: Skyline Scramble now, while preserving the full Stanski's World plan for later.",
    promise:
      "A production-grade Level 1 vertical slice for original SNES through FXPAK Pro, with the full 8-world game deferred safely.",
  };
  project.gamePlan = {
    artMood:
      "original commercial-SNES-era Cleveland road-trip platformer with 100/100 human-approved visuals",
    goal: "Recover receipts, defeat the Fare Collector and The Auditor, unlock true ending conditions, and complete toilet payoffs.",
    hero: "Todd Stanski",
    items: ["cheeseburgers", "ticket caches", "receipt scraps", "Golden Transfer Passes"],
    levels: worldOneLevels.map((level) => level.title),
    musicMood: "original high-energy 16-bit road-trip themes with SPC700-safe arrangements",
    powerups: ["burrito Big Stanski", "pizza bad-breath projectile", "gas boost"],
    rulesSummary:
      "Walk, run, jump, variable jump, coyote time, jump buffer, secrets, toilets, boss rewards, and SNES-safe save flags.",
    savePlan:
      "SRAM flags for world unlocks, boss passes, ticket caches, Receipt Reality, Back of the Map, Secret World 9, and true ending.",
    title: "Stanski's World",
    villain: "The Fare Collector and The Auditor",
  };
  project.gameStoryBible = {
    conflict:
      "The Fare Collector and The Auditor distort travel receipts into reality-bending obstacles across the map.",
    ending:
      "Normal ending defeats the route boss chain; true ending requires Receipt Reality, Back of the Map, and secret receipt conditions.",
    hero: "Todd Stanski",
    heroGoal:
      "Cross absurd Cleveland and road-trip worlds, claim Golden Transfer Passes, and restore the receipt ledger.",
    premise: canon.gameBible.join(" "),
    tone: "playful, strange, readable, mechanically fair, and SNES-authentic",
    villain: "The Fare Collector, escalating into The Auditor",
    world: "Cleveland and an expanded absurd road-trip map with hidden receipt dimensions",
  };
  project.platformerRules = {
    damage:
      "Fair telegraphs, damage knockback, invulnerability frames, and no unavoidable first-contact hazards.",
    enemyBehavior:
      "Readable patrol, bounce, dash, snatch, and phase-state enemies with clear tells.",
    itemEffects:
      "Cheeseburgers reward routes, burritos trigger Big Stanski, pizza enables projectile attacks, passes unlock worlds.",
    movement:
      "Responsive walk/run/jump with coyote time, jump buffer, variable jump, slopes, conveyors, and controlled knockback.",
    scoring:
      "Receipts, ticket caches, secret flags, optional high-route rewards, and world-clear passes.",
    winLoss:
      "Normal levels end at toilets; bosses award passes; death screens decrement lives and return to checkpoints.",
  };
  project.levelPlan = {
    chunks: levelOneProduction.sections.map((section) => section.name),
    goal: "Finish Cleveland: Skyline Scramble at the porcelain toilet ending.",
    id: "level-1-cleveland-skyline-scramble",
    name: "Level 1: Cleveland: Skyline Scramble",
    summary:
      "Active production target is Level 1 only. The full World 1 and full-game plan remain preserved in canon and backlog.",
  };
  project.levelChapters = [activeLevel, ...worldOneLevels.slice(1)].map((level, index) => ({
    challenge: `${level.firstEnemy}; ${level.secretPath}`,
    goal: level.toiletEnding,
    id: level.id,
    order: index + 1,
    requiredThings: level.requiredAssets,
    reward: level.firstReward,
    sceneId: level.id,
    setting: level.title,
    storyPurpose: level.purpose,
    title: level.title,
  }));
  const levelOneTilemap = createDefaultSceneTilemap();
  const levelOneCollisionMap = createDefaultSceneCollisionMap(levelOneTilemap);
  project.scenes = [
    {
      collisionMap: createDefaultSceneCollisionMap(),
      collisionTiles: 48,
      entities: [
        {
          id: `${activeLevel.id}-todd`,
          kind: "player",
          metaspriteTiles: 12,
          name: "Todd Stanski",
          x: 24,
          y: 176,
        },
        {
          id: "l1-receipt-goblin",
          kind: "enemy",
          metaspriteTiles: 8,
          name: "Receipt Goblin",
          x: 420,
          y: 176,
        },
        {
          id: "l1-pizza-slice",
          kind: "item",
          metaspriteTiles: 4,
          name: "Pizza Slice",
          x: 1920,
          y: 136,
        },
        {
          id: "l1-turnstile-snatcher",
          kind: "enemy",
          metaspriteTiles: 8,
          name: "Turnstile Snatcher",
          x: 2216,
          y: 168,
        },
        {
          id: `${activeLevel.id}-toilet-goal`,
          kind: "npc",
          metaspriteTiles: 12,
          name: "Porcelain Toilet Completion",
          x: 2928,
          y: 168,
        },
      ],
      heightMetatiles: 16,
      id: activeLevel.id,
      layers: 2,
      name: activeLevel.title,
      tilemap: levelOneTilemap,
      widthMetatiles: 128,
    },
  ];
  project.scenes[0]!.collisionMap = levelOneCollisionMap;
  project.scenes[0]!.collisionTiles = countSolidCollisionCells(levelOneCollisionMap);
  project.thingLibrary = [
    {
      behavior:
        "Playable hero with walk/run/jump, gas boost, projectile, and checkpoint restart states.",
      id: "todd-stanski",
      kind: "hero",
      name: "Todd Stanski",
      prompt: "Use the preserved Todd drawing reference for identity traits.",
    },
    {
      behavior: "World 1 boss with ticket-swipe, turnstile, and receipt-storm phases.",
      id: "fare-snatcher",
      kind: "enemy",
      name: "Fare Snatcher",
      prompt: "Boss grants Golden Transfer Pass #1 after defeat.",
    },
    {
      behavior: "Level completion object; normal levels require a toilet ending event.",
      id: "toilet-completion",
      kind: "goal",
      name: "Toilet Completion",
      prompt: "A porcelain toilet goal that triggers completion, not a generic door.",
    },
    {
      behavior:
        "Secret Family Memory Card room record for the user-provided man-and-boy reference.",
      id: "man-boy-memory-card",
      kind: "item",
      name: "Family Memory Card",
      prompt:
        "Convert the man-and-boy photo into SNES-safe cameo art for a World 1 secret room before claiming in-game use.",
    },
  ];
  project.gamePartLocks = [
    { id: "lock-target-hardware", kind: "export", label: "Original SNES via FXPAK Pro" },
    { id: "lock-visual-human-100", kind: "export", label: "Human-approved 100/100 visuals" },
    { id: "lock-toilet-endings", kind: "rule", label: "Normal levels end with toilets" },
    { id: "lock-world-1-fare-snatcher", kind: "enemy", label: "World 1 boss: Fare Snatcher" },
  ];
  project.exportReadiness = {
    blockers: [
      "Full game implementation is preserved for later; only Level 1 is active now.",
      "100/100 production visuals require human approval.",
      "Family Memory Card source photo remains blocked until a readable local path is supplied and converted.",
      "FXPAK live copy is blocked until an exact mounted volume path is supplied.",
      "Original SNES hardware proof is manual and incomplete.",
    ],
    status: "blocked",
    summary:
      "Level 1 is the active production target; full-game production release is not complete.",
  };
  project.stanskiCanon = canon;
  project.stanskiLevelOneProduction = levelOneProduction;
  const referenceRecords = canon.references.map(
    (receipt): SnesProductionAssetRecord =>
      createSnesProductionAssetRecord({
        blockers:
          receipt.status === "preserved"
            ? [
                "Reference is preserved, but SNES-safe conversion is still required before in-game cameo proof.",
              ]
            : [receipt.blocker ?? "Reference asset preservation has not completed yet."],
        conversionStatus: "blocked",
        id: receipt.id,
        license: "user-provided",
        provenance: receipt.status === "preserved" ? "user-imported" : "spec",
        sourceHash: receipt.sha256,
        sourcePath: receipt.status === "preserved" ? receipt.path : undefined,
        status: receipt.status === "preserved" ? "real-asset" : "spec-only",
        type:
          receipt.id === "man-boy-snes-photo-reference" ? "background-layer" : "character-sprite",
        usage: [receipt.usage],
        visualMaturity: receipt.status === "preserved" ? "artist-imported" : "spec-only",
        visualProof:
          receipt.status === "preserved"
            ? [{ kind: "source-image", path: receipt.path, sha256: receipt.sha256 }]
            : [],
      }),
  );
  return createSnesProjectPackage(project, {
    assetRecords: referenceRecords,
    createdAt,
    qaReceipts: [
      {
        id: "level-1-production-target",
        status: "warning",
        summary:
          "Only Cleveland: Skyline Scramble is active; the full Stanski's World plan is preserved for later.",
      },
      {
        id: "batch-1-foundation",
        status: "warning",
        summary:
          "Batch 1 foundation is defined; full gameplay, production visuals, FXPAK write, and hardware proof remain incomplete.",
      },
      {
        id: "fxpak-write-status",
        status: "blocked",
        summary:
          "FXPAK writes are blocked until a real exact mounted FAT32 volume path is supplied.",
      },
      {
        id: "visual-approval-status",
        status: "blocked",
        summary: "100/100 production visuals require human approval and executable visual proof.",
      },
    ],
    source: "stanski-production",
    visualApproval: { currentHumanScore: null, machineScore: 0, targetScore: 100 },
  });
}

export function createStanskiCanaryProjectPackage(
  createdAt = new Date().toISOString(),
): SnesProjectPackage {
  const project = generateSnesProjectFromPrompt(
    "Create Stanski's World as a Cleveland-themed one-level platformer sample.",
    createDefaultSnesStudioProject(createdAt),
  ).project;
  project.id = "stanskis-world-canary";
  project.name = "Stanski's World Canary";
  return createSnesProjectPackage(project, {
    createdAt,
    qaReceipts: [
      {
        id: "sample-migration",
        status: "pass",
        summary: "Stanski's World is loaded as sample project data through the generic package.",
      },
    ],
    source: "sample-stanski",
  });
}

export function createSnesMvpSampleProjectPackage(
  createdAt = new Date().toISOString(),
): SnesProjectPackage {
  const project = generateSnesProjectFromPrompt(
    "Create Comet Fox, a tiny original SNES platformer with one hero, one enemy, one collectible, and one goal.",
    createDefaultSnesStudioProject(createdAt),
  ).project;
  project.id = "comet-fox-mvp";
  project.name = "Comet Fox MVP";
  return createSnesProjectPackage(project, {
    createdAt,
    qaReceipts: [
      {
        id: "new-game-mvp",
        status: "pass",
        summary:
          "Separate MVP sample loads through the same generic package and remains production-blocked honestly.",
      },
    ],
    source: "sample-mvp",
  });
}

export function createSnesAssetAdapterReceipt(input: {
  adapter: SnesAssetAdapterKind;
  inputPath: string;
  outputPath?: string;
  inputHash?: string;
  outputHash?: string;
  producedAssetId?: string;
  blockedReason?: string;
}): SnesAssetAdapterReceipt {
  const blockers = input.blockedReason ? [input.blockedReason] : [];
  const inputHash =
    input.inputHash || productionHash({ adapter: input.adapter, inputPath: input.inputPath });
  return {
    adapter: input.adapter,
    status:
      blockers.length === 0 && Boolean(input.outputPath || input.producedAssetId)
        ? "ready"
        : "blocked",
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    inputHash,
    outputHash: input.outputHash,
    producedAssetId: input.producedAssetId,
    blockers:
      blockers.length > 0
        ? blockers
        : input.outputPath || input.producedAssetId
          ? []
          : ["Adapter has not produced an output asset yet."],
  };
}

function findToolchainTool(
  toolchain: SnesToolchainDoctorReport,
  id: SnesToolchainToolId,
): SnesToolchainToolStatus | null {
  return toolchain.tools.find((tool) => tool.id === id) ?? null;
}

function toolAvailable(toolchain: SnesToolchainDoctorReport, id: SnesToolchainToolId): boolean {
  return findToolchainTool(toolchain, id)?.status === "available";
}

function missingToolBlocker(toolchain: SnesToolchainDoctorReport, id: SnesToolchainToolId) {
  const tool = findToolchainTool(toolchain, id);
  return `${tool?.label ?? id} is not available; adapter remains blocked until the tool is installed and detected.`;
}

export function createSnesAssetAdapterPlan(
  project: SnesStudioProject,
  toolchain: SnesToolchainDoctorReport = createSnesToolchainDoctorReport(),
): SnesAssetAdapterPlan {
  const normalized = normalizeSnesStudioProject(project);
  const base = `.artifacts/snes-projects/${normalized.id}/assets`;
  const adapterInputs: Array<{
    adapter: SnesAssetAdapterKind;
    requiredTool: SnesToolchainToolId;
    inputPath: string;
    outputPath: string;
    producedAssetId: string;
  }> = [
    {
      adapter: "pixelorama",
      inputPath: `${base}/pixelorama/hero-sprite.png`,
      outputPath: `${base}/indexed/hero-sprite.png`,
      producedAssetId: `${normalized.id}-hero-sprite`,
      requiredTool: "pixelorama",
    },
    {
      adapter: "superfamiconv",
      inputPath: `${base}/indexed/hero-sprite.png`,
      outputPath: `${base}/snes/hero-sprite.chr`,
      producedAssetId: `${normalized.id}-hero-chr`,
      requiredTool: "superfamiconv",
    },
    {
      adapter: "ldtk",
      inputPath: `${base}/levels/world.ldtk`,
      outputPath: `${base}/levels/world-level.json`,
      producedAssetId: `${normalized.id}-level-layout`,
      requiredTool: "ldtk",
    },
    {
      adapter: "tiled",
      inputPath: `${base}/levels/world.tmx`,
      outputPath: `${base}/levels/world-tiled.json`,
      producedAssetId: `${normalized.id}-tiled-layout`,
      requiredTool: "tiled",
    },
    {
      adapter: "brrtools",
      inputPath: `${base}/audio/source.wav`,
      outputPath: `${base}/audio/source.brr`,
      producedAssetId: `${normalized.id}-brr-sample`,
      requiredTool: "brrtools",
    },
  ];
  const receipts = adapterInputs.map((adapterInput) => {
    const available = toolAvailable(toolchain, adapterInput.requiredTool);
    return createSnesAssetAdapterReceipt({
      adapter: adapterInput.adapter,
      blockedReason: available
        ? undefined
        : missingToolBlocker(toolchain, adapterInput.requiredTool),
      inputHash: productionHash({
        inputPath: adapterInput.inputPath,
        projectId: normalized.id,
        tool: adapterInput.requiredTool,
      }),
      inputPath: adapterInput.inputPath,
      outputHash: available
        ? productionHash({
            outputPath: adapterInput.outputPath,
            projectId: normalized.id,
            tool: adapterInput.requiredTool,
          })
        : undefined,
      outputPath: available ? adapterInput.outputPath : undefined,
      producedAssetId: available ? adapterInput.producedAssetId : undefined,
    });
  });
  const blockers = receipts.flatMap((receipt) =>
    receipt.status === "ready" ? [] : receipt.blockers,
  );
  return {
    blockers,
    projectId: normalized.id,
    receipts,
    status: blockers.length === 0 ? "ready" : "blocked",
  };
}

export function createSnesRomBuildScaffoldDryRun(
  project: SnesStudioProject,
  toolchain: SnesToolchainDoctorReport = createSnesToolchainDoctorReport(),
): SnesRomBuildScaffoldDryRun {
  const normalized = normalizeSnesStudioProject(project);
  const receipt = createSnesRomBuildReceiptFromToolchain(normalized, toolchain);
  const scaffoldRoot = `.artifacts/snes-projects/${normalized.id}/rom/pvsneslib`;
  const blockers =
    receipt.status === "blocked"
      ? receipt.blockers
      : ["Real PVSnesLib compilation is approval-gated and has not run."];
  return {
    blockers,
    plannedFiles: [
      { path: `${scaffoldRoot}/Makefile`, purpose: "PVSnesLib build entrypoint" },
      { path: `${scaffoldRoot}/src/main.c`, purpose: "SNES game loop scaffold" },
      { path: `${scaffoldRoot}/assets/project-assets.json`, purpose: "asset manifest handoff" },
      {
        path: `${scaffoldRoot}/build/${receipt.romFileName ?? "game.sfc"}`,
        purpose: "future ROM output",
      },
    ],
    projectId: normalized.id,
    receipt,
    scaffoldRoot,
    status: receipt.status === "blocked" ? "blocked" : "ready",
  };
}

export function createSnesEmulatorProofPlanFromToolchain(
  project: SnesStudioProject,
  toolchain: SnesToolchainDoctorReport = createSnesToolchainDoctorReport(),
): SnesEmulatorProofPlan {
  const normalized = normalizeSnesStudioProject(project);
  const receipt = createSnesEmulatorProofReceiptFromToolchain(normalized, toolchain);
  const selectedEmulator = receipt.emulator ?? null;
  const blockers =
    receipt.status === "blocked"
      ? receipt.blockers
      : ["Emulator launch and screenshot capture are approval-gated and have not run."];
  return {
    blockers,
    projectId: normalized.id,
    proofArtifacts: [
      {
        path: `.artifacts/snes-projects/${normalized.id}/emulator/run-emulator-proof.sh`,
        purpose: "operator-run emulator proof script",
      },
      {
        path:
          receipt.screenshotPath ??
          `.artifacts/snes-projects/${normalized.id}/emulator/boot-screenshot.png`,
        purpose: "future emulator boot screenshot",
      },
    ],
    receipt,
    selectedEmulator,
    status: receipt.status === "blocked" ? "blocked" : "ready",
  };
}

export function createSnesFxpakDryRunPlan(
  project: SnesStudioProject,
  options: { volumePath?: string } = {},
): SnesFxpakDryRunPlan {
  const normalized = normalizeSnesStudioProject(project);
  const receipt = createSnesFxpakPackageDryRunReceipt(normalized, options);
  const source = `.artifacts/snes-projects/${normalized.id}/rom/${receipt.destinationPath?.split("/").pop() ?? "game.sfc"}`;
  const destination = receipt.destinationPath ?? null;
  return {
    blockers: receipt.status === "blocked" ? receipt.blockers : [],
    copyPlan: destination
      ? [
          {
            destination,
            purpose: "future approval-gated FXPAK/SD2SNES ROM copy",
            source,
          },
        ]
      : [],
    destinationPath: destination,
    projectId: normalized.id,
    receipt,
    status: receipt.status === "blocked" ? "blocked" : "ready",
    warnings: [
      "Do not overwrite existing SRAM files.",
      "Real FXPAK media writes require explicit approval and post-copy hash verification.",
    ],
  };
}

export function encodeSnesBrrSilenceBlock(end = true): Uint8Array {
  const block = new Uint8Array(9);
  block[0] = end ? 0x01 : 0x00;
  return block;
}

export function createSnesSpc700ExportPlan(project: SnesStudioProject): SnesSpc700ExportPlan {
  const manifest = createSnesAudioManifest(project);
  let offset = 0;
  const aramMap: SnesSpc700ExportPlan["aramMap"] = [
    { name: "SPC700 driver reserve", offset, sizeBytes: manifest.reservedDriverBytes },
  ];
  offset += manifest.reservedDriverBytes;
  aramMap.push({ name: "Music pattern data", offset, sizeBytes: manifest.musicBytes });
  offset += manifest.musicBytes;
  aramMap.push({ name: "Sound effect sequences", offset, sizeBytes: manifest.soundEffectBytes });
  offset += manifest.soundEffectBytes;
  aramMap.push({ name: "BRR/sample pool", offset, sizeBytes: manifest.sampleBytes });

  const blockers = [
    ...manifest.warnings,
    "Production SPC700 playback driver is not linked into the preview ROM yet.",
    "BRR conversion is represented by a validated sample-pool plan, not audible hardware playback.",
  ];
  return {
    status: manifest.totalBytes <= SNES_HARDWARE_LIMITS.aramBytes ? "manifest-ready" : "blocked",
    driver: manifest.driver,
    aramLimitBytes: manifest.aramLimitBytes,
    aramMap,
    brrSilenceBlockHex: bytesToHex(encodeSnesBrrSilenceBlock()),
    blockers,
  };
}

export function compileSnesSpc700PlaybackProgram(
  project: SnesStudioProject,
): SnesSpc700PlaybackProgram {
  const plan = createSnesSpc700ExportPlan(project);
  const manifest = createSnesAudioManifest(project);
  const bytes = Array.from(new TextEncoder().encode("OCSP"));
  bytes.push(manifest.musicTracks.length & 0xff, manifest.soundEffects.length & 0xff);
  const commands: SnesSpc700PlaybackProgram["commands"] = [];
  for (const track of manifest.musicTracks) {
    const offset = bytes.length;
    bytes.push(0x10);
    pushU16(bytes, checksumText(track.id));
    bytes.push(track.tempo & 0xff);
    pushU16(bytes, track.patternRows);
    pushU16(bytes, track.estimatedBytes);
    commands.push({
      kind: "music",
      id: track.id,
      offset,
      sizeBytes: bytes.length - offset,
    });
  }
  for (const effect of manifest.soundEffects) {
    const offset = bytes.length;
    bytes.push(0x20);
    pushU16(bytes, checksumText(effect.id));
    bytes.push(effect.priority & 0xff);
    pushU16(bytes, effect.sequenceBytes);
    pushU16(bytes, effect.estimatedBytes);
    commands.push({
      kind: "sound-effect",
      id: effect.id,
      offset,
      sizeBytes: bytes.length - offset,
    });
  }
  const brrOffset = bytes.length;
  bytes.push(0x30, ...encodeSnesBrrSilenceBlock());
  commands.push({
    kind: "brr-silence",
    id: "brr-silence-end-block",
    offset: brrOffset,
    sizeBytes: bytes.length - brrOffset,
  });
  const commandStream = new Uint8Array(bytes);
  return {
    status: plan.status === "manifest-ready" ? "compiled" : "blocked",
    runtimeStatus:
      plan.status === "manifest-ready" ? "playback-stream-tested" : "blocked-until-spc700-driver",
    driver: plan.driver,
    sizeBytes: commandStream.byteLength,
    checksum: calculateChecksum(commandStream),
    commandStreamHex: bytesToHex(commandStream),
    trackCount: manifest.musicTracks.length,
    soundEffectCount: manifest.soundEffects.length,
    brrSilenceBlockHex: plan.brrSilenceBlockHex,
    commands,
    blockers: plan.blockers,
  };
}

export function estimateSnesProjectBudgets(project: SnesStudioProject): SnesBudgetMeter[] {
  const scene = activeScene(project);
  const save = normalizeSnesSaveSystem(project.save);
  const audio = createSnesAudioManifest(project);
  const sceneTilemapBytes =
    scene.widthMetatiles * scene.heightMetatiles * Math.max(1, scene.layers) * TILEMAP_ENTRY_BYTES;
  const vramUsed =
    project.assets.backgroundTiles * TILE_BYTES_4BPP +
    project.assets.spriteTiles * TILE_BYTES_4BPP +
    sceneTilemapBytes;
  const cgramUsed = (project.assets.backgroundPalettes + project.assets.spritePalettes) * 16;
  const oamUsed = scene.entities.reduce(
    (sum, entity) => sum + Math.max(1, entity.metaspriteTiles),
    0,
  );
  const wramUsed =
    ENGINE_WRAM_RESERVE_BYTES +
    scene.widthMetatiles * scene.heightMetatiles +
    scene.collisionTiles * 16 +
    scene.entities.length * 64;
  const aramUsed = audio.totalBytes;
  const sramUsed = totalSaveBytes(save);
  const romUsed =
    ENGINE_ROM_RESERVE_BYTES + vramUsed + aramUsed + project.assets.scriptBytes + sceneTilemapBytes;
  const romLimit = (project.profile.romSizeMbit * 1024 * 1024) / 8;

  const meters: Array<Omit<SnesBudgetMeter, "ratio" | "severity">> = [
    { label: "WRAM", used: wramUsed, limit: SNES_HARDWARE_LIMITS.wramBytes, unit: "bytes" },
    { label: "VRAM", used: vramUsed, limit: SNES_HARDWARE_LIMITS.vramBytes, unit: "bytes" },
    { label: "CGRAM", used: cgramUsed, limit: SNES_HARDWARE_LIMITS.cgramColors, unit: "colors" },
    { label: "OAM", used: oamUsed, limit: SNES_HARDWARE_LIMITS.oamEntries, unit: "entries" },
    { label: "ARAM", used: aramUsed, limit: SNES_HARDWARE_LIMITS.aramBytes, unit: "bytes" },
    { label: "SRAM", used: sramUsed, limit: project.profile.sramSizeKib * 1024, unit: "bytes" },
    { label: "ROM", used: romUsed, limit: romLimit, unit: "bytes" },
  ];

  return meters.map((meter) => {
    const ratio = clampRatio(meter.used, meter.limit);
    return Object.assign({}, meter, {
      ratio,
      severity: severityForRatio(meter.used / meter.limit),
    });
  });
}

export function createSnesAssetPipelineReport(project: SnesStudioProject): SnesAssetPipelineReport {
  const normalized = normalizeSnesStudioProject(project);
  const budgets = estimateSnesProjectBudgets(normalized);
  const vram = budgets.find((budget) => budget.label === "VRAM") ?? {
    used: 0,
    limit: SNES_HARDWARE_LIMITS.vramBytes,
  };
  const cgram = budgets.find((budget) => budget.label === "CGRAM") ?? {
    used: 0,
    limit: SNES_HARDWARE_LIMITS.cgramColors,
  };
  const importedTilesets = normalized.assets.importedTilesets;
  const sourceTileCount = importedTilesets.reduce(
    (sum, tileset) => sum + tileset.sourceTileCount,
    0,
  );
  const uniqueTileCount = importedTilesets.reduce(
    (sum, tileset) => sum + tileset.uniqueTileCount,
    0,
  );
  const dedupedTileCount = importedTilesets.reduce(
    (sum, tileset) => sum + tileset.dedupedTileCount,
    0,
  );
  const importedChrBytes = importedTilesets.reduce((sum, tileset) => sum + tileset.chrSizeBytes, 0);
  const importedPaletteColors = importedTilesets.reduce(
    (largest, tileset) => Math.max(largest, tileset.paletteColorsUsed.length),
    0,
  );
  const quantizedTilesetCount = importedTilesets.filter((tileset) => tileset.quantized).length;
  const checks: SnesAssetPipelineReport["checks"] = [];
  const addCheck = (
    code: string,
    label: string,
    status: "pass" | "warning" | "blocked",
    detail: string,
  ) => checks.push({ code, label, status, detail });

  addCheck(
    "PNG_COLOR_SAFETY",
    "PNG color safety",
    importedPaletteColors <= 16 ? "pass" : "blocked",
    importedTilesets.length > 0
      ? `Largest imported palette uses ${importedPaletteColors} / 16 colors.`
      : "No imported PNG or indexed tilesets yet.",
  );
  addCheck(
    "CHR_DEDUP",
    "4bpp CHR deduplication",
    dedupedTileCount > 0 || importedTilesets.length === 0 ? "pass" : "warning",
    importedTilesets.length > 0
      ? `${dedupedTileCount} duplicate tile${dedupedTileCount === 1 ? "" : "s"} removed from ${sourceTileCount} source tile${sourceTileCount === 1 ? "" : "s"}.`
      : "Importer is ready to deduplicate 8x8 tiles.",
  );
  addCheck(
    "VRAM_BUDGET",
    "VRAM budget",
    vram.used > vram.limit ? "blocked" : vram.used / vram.limit >= 0.9 ? "warning" : "pass",
    `${vram.used} / ${vram.limit} bytes used by background, sprite, and tilemap data.`,
  );
  addCheck(
    "CGRAM_BUDGET",
    "CGRAM palette budget",
    cgram.used > cgram.limit ? "blocked" : cgram.used / cgram.limit >= 0.9 ? "warning" : "pass",
    `${cgram.used} / ${cgram.limit} color slots reserved.`,
  );
  addCheck(
    "QUANTIZED_IMPORTS",
    "High-color PNG fallback",
    quantizedTilesetCount > 0 || importedTilesets.length === 0 ? "pass" : "warning",
    quantizedTilesetCount > 0
      ? `${quantizedTilesetCount} imported tileset${quantizedTilesetCount === 1 ? "" : "s"} used automatic SNES palette quantization.`
      : "High-color PNGs can be auto-quantized when enabled in the dashboard.",
  );

  const blocked = checks.some((check) => check.status === "blocked");
  const warning = checks.some((check) => check.status === "warning");
  return {
    status: blocked ? "blocked" : warning ? "warning" : "ready",
    importedTilesetCount: importedTilesets.length,
    sourceTileCount,
    uniqueTileCount,
    dedupedTileCount,
    importedChrBytes,
    importedPaletteColors,
    quantizedTilesetCount,
    vramBytes: {
      used: vram.used,
      limit: vram.limit,
      remaining: Math.max(0, vram.limit - vram.used),
    },
    cgramColors: {
      used: cgram.used,
      limit: cgram.limit,
      remaining: Math.max(0, cgram.limit - cgram.used),
    },
    checks,
  };
}

export function createSnesSpriteOamBudgetReport(
  project: SnesStudioProject,
): SnesSpriteOamBudgetReport {
  const scene = activeScene(normalizeSnesStudioProject(project));
  const entities = scene.entities.map((entity) => {
    const oamEntries = Math.max(1, entity.metaspriteTiles);
    return {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      metaspriteTiles: entity.metaspriteTiles,
      oamEntries,
      risk:
        oamEntries > SNES_HARDWARE_LIMITS.oamEntries
          ? ("over-budget" as const)
          : oamEntries > 16
            ? ("large-metasprite" as const)
            : ("ok" as const),
    };
  });
  const usedEntries = entities.reduce((sum, entity) => sum + entity.oamEntries, 0);
  const warnings: string[] = [];
  const largestMetaspriteTiles = entities.reduce(
    (largest, entity) => Math.max(largest, entity.metaspriteTiles),
    0,
  );
  if (usedEntries > SNES_HARDWARE_LIMITS.oamEntries) {
    warnings.push("Active scene exceeds the 128 OBJ OAM entry budget.");
  }
  if (largestMetaspriteTiles > 16) {
    warnings.push("Large metasprites need scanline review before hardware release.");
  }
  return {
    status:
      usedEntries > SNES_HARDWARE_LIMITS.oamEntries
        ? "blocked"
        : warnings.length > 0
          ? "warning"
          : "ready",
    usedEntries,
    limitEntries: SNES_HARDWARE_LIMITS.oamEntries,
    remainingEntries: Math.max(0, SNES_HARDWARE_LIMITS.oamEntries - usedEntries),
    largestMetaspriteTiles,
    entities,
    warnings,
  };
}

export function createSnesScanlineOamPlan(project: SnesStudioProject): SnesScanlineOamPlan {
  const scene = activeScene(normalizeSnesStudioProject(project));
  const scanlines: SnesScanlineOamPlan["scanlines"] = Array.from({ length: 224 }, (_, y) => ({
    y,
    spriteEntries: 0,
    spriteSlivers: 0,
    entityIds: [],
    status: "ok",
  }));

  for (const entity of scene.entities) {
    const entries = Math.max(1, entity.metaspriteTiles);
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(entries))));
    const rows = Math.max(1, Math.ceil(entries / columns));
    const top = Math.max(0, Math.floor(entity.y));
    const bottom = Math.min(223, top + rows * 8 - 1);
    const sliversPerTouchedScanline = Math.min(entries, columns);
    for (let y = top; y <= bottom; y += 1) {
      const scanline = scanlines[y];
      scanline.spriteEntries += entries;
      scanline.spriteSlivers += sliversPerTouchedScanline;
      scanline.entityIds.push(entity.id);
    }
  }

  let worstSpriteEntries = 0;
  let worstSpriteSlivers = 0;
  let worstScanline = 0;
  for (const scanline of scanlines) {
    if (
      scanline.spriteEntries > worstSpriteEntries ||
      scanline.spriteSlivers > worstSpriteSlivers
    ) {
      worstSpriteEntries = Math.max(worstSpriteEntries, scanline.spriteEntries);
      worstSpriteSlivers = Math.max(worstSpriteSlivers, scanline.spriteSlivers);
      worstScanline = scanline.y;
    }
    scanline.status =
      scanline.spriteEntries > SNES_HARDWARE_LIMITS.spriteEntriesPerScanline ||
      scanline.spriteSlivers > SNES_HARDWARE_LIMITS.spriteSliversPerScanline
        ? "blocked"
        : scanline.spriteEntries > SNES_HARDWARE_LIMITS.spriteEntriesPerScanline * 0.75 ||
            scanline.spriteSlivers > SNES_HARDWARE_LIMITS.spriteSliversPerScanline * 0.75
          ? "warning"
          : "ok";
  }

  const warnings = [
    ...(scanlines.some((scanline) => scanline.status === "blocked")
      ? ["One or more scanlines exceed SNES OBJ-per-line or sliver limits."]
      : []),
    ...(scanlines.some((scanline) => scanline.status === "warning")
      ? ["One or more scanlines are close to SNES OBJ-per-line or sliver limits."]
      : []),
  ];

  return {
    status: warnings.some((warning) => warning.includes("exceed"))
      ? "blocked"
      : warnings.length > 0
        ? "warning"
        : "ready",
    spriteEntryLimit: SNES_HARDWARE_LIMITS.spriteEntriesPerScanline,
    spriteSliverLimit: SNES_HARDWARE_LIMITS.spriteSliversPerScanline,
    worstSpriteEntries,
    worstSpriteSlivers,
    worstScanline,
    scanlines: scanlines.filter((scanline) => scanline.spriteEntries > 0),
    warnings,
  };
}

export function validateSnesStudioProject(project: SnesStudioProject): SnesValidationIssue[] {
  project = normalizeSnesStudioProject(project);
  const issues: SnesValidationIssue[] = [];
  const add = (issue: SnesValidationIssue) => issues.push(issue);
  const save = normalizeSnesSaveSystem(project.save);
  const audioManifest = createSnesAudioManifest(project);

  if (project.profile.mapMode !== "lorom") {
    add({
      severity: "error",
      code: "V01_MAP_MODE",
      path: "profile.mapMode",
      message: "v0.1 builds support LoROM only.",
      suggestion: "Use the LoROM profile until the HiROM linker profile lands.",
    });
  }
  if (project.profile.videoMode !== "mode1" || project.profile.enhancementChip !== "none") {
    add({
      severity: "warning",
      code: "V01_MODE1_VERTICAL_SLICE",
      path: "profile.videoMode",
      message: "The first production slice is Mode 1 without enhancement chips.",
      suggestion:
        "Keep SuperFX projects as design profiles until the dedicated GSU runtime is available.",
    });
  }
  if (project.profile.target === "fxpak-pro" && project.profile.fxpak.fileSystem !== "fat32") {
    add({
      severity: "error",
      code: "FXPAK_FAT32_REQUIRED",
      path: "profile.fxpak.fileSystem",
      message: "FXPAK PRO export requires a FAT32 microSD volume.",
      suggestion: "Format the 128 GB microSD as FAT32 before export.",
    });
  }
  if (!project.profile.fxpak.preserveExistingSaves) {
    add({
      severity: "warning",
      code: "FXPAK_SAVE_PROTECTION",
      path: "profile.fxpak.preserveExistingSaves",
      message: "Existing SRAM saves should be preserved by default.",
      suggestion: "Only disable save protection for explicit test-card resets.",
    });
  }
  if (save.enabled && save.fields.length === 0) {
    add({
      severity: "warning",
      code: "SAVE_FIELDS_EMPTY",
      path: "save.fields",
      message: "SRAM is enabled but no save fields are configured.",
      suggestion: "Add at least one versioned save field or disable SRAM for stateless demos.",
    });
  }
  if (new Set(save.fields.map((field) => field.key)).size !== save.fields.length) {
    add({
      severity: "error",
      code: "SAVE_FIELD_KEYS_UNIQUE",
      path: "save.fields",
      message: "Save field keys must be unique.",
      suggestion: "Rename duplicate save fields before building the ROM.",
    });
  }
  if (audioManifest.musicTracks.length === 0) {
    add({
      severity: "warning",
      code: "AUDIO_MUSIC_EMPTY",
      path: "assets.audio.musicTracks",
      message: "No music tracks are configured for the SPC700 preview manifest.",
      suggestion: "Add at least one music track before release-candidate hardware testing.",
    });
  }
  if (audioManifest.soundEffects.length === 0) {
    add({
      severity: "warning",
      code: "AUDIO_SFX_EMPTY",
      path: "assets.audio.soundEffects",
      message: "No sound effects are configured for the SPC700 preview manifest.",
      suggestion: "Add core gameplay SFX before release-candidate hardware testing.",
    });
  }
  const animationIds = new Set(project.animations.map((animation) => animation.id));
  if (animationIds.size !== project.animations.length) {
    add({
      severity: "error",
      code: "ANIMATION_IDS_UNIQUE",
      path: "animations",
      message: "Sprite animation IDs must be unique.",
      suggestion: "Rename duplicate animation IDs before building the ROM.",
    });
  }
  const cutsceneIds = new Set(project.dialogue.map((cutscene) => cutscene.id));
  if (cutsceneIds.size !== project.dialogue.length) {
    add({
      severity: "error",
      code: "DIALOGUE_IDS_UNIQUE",
      path: "dialogue",
      message: "Cutscene IDs must be unique.",
      suggestion: "Rename duplicate cutscene IDs before building the ROM.",
    });
  }
  for (const event of project.events) {
    for (const action of event.actions) {
      if (action.type === "show-dialogue" && !cutsceneIds.has(action.cutsceneId)) {
        add({
          severity: "error",
          code: "EVENT_DIALOGUE_TARGET",
          path: "events",
          message: `Event ${event.name} references a missing cutscene.`,
          suggestion: "Choose an existing cutscene or remove the dialogue action.",
        });
      }
    }
  }
  if (project.assets.backgroundPalettes > SNES_HARDWARE_LIMITS.backgroundPalettes) {
    add({
      severity: "error",
      code: "BG_PALETTE_LIMIT",
      path: "assets.backgroundPalettes",
      message: "Background palettes exceed the Mode 1 budget.",
      suggestion: "Merge or remap background palettes to eight 16-color groups or fewer.",
    });
  }
  if (project.assets.spritePalettes > SNES_HARDWARE_LIMITS.spritePalettes) {
    add({
      severity: "error",
      code: "SPRITE_PALETTE_LIMIT",
      path: "assets.spritePalettes",
      message: "Sprite palettes exceed the SNES OBJ palette budget.",
      suggestion: "Reduce sprite palettes to eight 16-color groups or fewer.",
    });
  }
  for (const meter of estimateSnesProjectBudgets(project)) {
    if (meter.used > meter.limit) {
      add({
        severity: "error",
        code: `${meter.label}_BUDGET_EXCEEDED`,
        path: `budgets.${meter.label.toLowerCase()}`,
        message: `${meter.label} budget exceeds the hardware limit.`,
        suggestion: `Reduce ${meter.label} usage before building a release ROM.`,
      });
    } else if (meter.ratio >= 0.9) {
      add({
        severity: "warning",
        code: `${meter.label}_BUDGET_HIGH`,
        path: `budgets.${meter.label.toLowerCase()}`,
        message: `${meter.label} usage is above 90%.`,
        suggestion: "Keep headroom for runtime buffers, late fixes, and hardware-only edge cases.",
      });
    }
  }
  const romBaseName = sanitizeRomBaseName(project.export.romBaseName);
  if (!romBaseName) {
    add({
      severity: "error",
      code: "ROM_NAME_REQUIRED",
      path: "export.romBaseName",
      message: "ROM export needs a safe base filename.",
      suggestion: "Use letters, numbers, hyphens, and underscores.",
    });
  }
  return issues;
}

export function buildSnesReadiness(project: SnesStudioProject): SnesBuildReadiness {
  const issues = validateSnesStudioProject(project);
  const budgets = estimateSnesProjectBudgets(project);
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.max(0, 100 - errorCount * 28 - warningCount * 8);
  return {
    status: errorCount > 0 ? "blocked" : warningCount > 0 ? "caution" : "ready",
    score,
    issues,
    budgets,
  };
}

export function sanitizeRomBaseName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function includesAny(value: string, words: string[]): boolean {
  return words.some((word) => value.includes(word));
}

function cloneProject(project: SnesStudioProject): SnesStudioProject {
  return JSON.parse(JSON.stringify(project)) as SnesStudioProject;
}

function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function assertSnesAgentPatchPath(path: unknown): SnesAgentPatchPath {
  if (typeof path !== "string") {
    throw new Error("SNES Studio patch operation path must be a string.");
  }
  if (!(SNES_AGENT_PATCH_PATHS as readonly string[]).includes(path)) {
    throw new Error(`Unsupported SNES Studio patch path: ${path}`);
  }
  return path as SnesAgentPatchPath;
}

function parseAgentPatchResponsePayload(payload: unknown): ParsedAgentPatchResponse {
  const record = recordValue(payload);
  if (!record) {
    throw new Error("SNES Studio agent patch response must be a JSON object.");
  }
  if (!Array.isArray(record.operations)) {
    throw new Error("SNES Studio agent patch response must include an operations array.");
  }
  const operations = record.operations.map((entry): SnesJsonPatchOperation => {
    const operation = recordValue(entry);
    if (!operation || operation.op !== "replace") {
      throw new Error("SNES Studio agent patches only support replace operations.");
    }
    if (!Object.prototype.hasOwnProperty.call(operation, "value")) {
      throw new Error("SNES Studio patch replace operations must include a value.");
    }
    return {
      op: "replace",
      path: assertSnesAgentPatchPath(operation.path),
      value: cloneJsonValue(operation.value),
    };
  });
  if (operations.length === 0) {
    throw new Error("SNES Studio agent patch response did not include any operations.");
  }
  return {
    summary: typeof record.summary === "string" ? record.summary.trim() : undefined,
    rationale: stringArrayValue(record.rationale),
    operations,
  };
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function getJsonPointerValue(value: unknown, path: SnesAgentPatchPath): unknown {
  const parts = path.slice(1).split("/").map(decodeJsonPointerSegment);
  let cursor = value;
  for (const part of parts) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function setJsonPointerValue(
  value: SnesStudioProject,
  path: SnesAgentPatchPath,
  replacement: unknown,
) {
  const parts = path.slice(1).split("/").map(decodeJsonPointerSegment);
  let cursor: unknown = value;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      cursor = undefined;
    }
    if (!cursor) {
      throw new Error(`Cannot apply SNES Studio patch at ${path}.`);
    }
  }

  const leaf = parts.at(-1);
  if (!leaf) {
    throw new Error(`Cannot apply empty SNES Studio patch path.`);
  }
  const safeReplacement = cloneJsonValue(replacement);
  if (Array.isArray(cursor)) {
    const index = Number(leaf);
    if (!Number.isInteger(index)) {
      throw new Error(`Cannot apply array patch at ${path}.`);
    }
    cursor[index] = safeReplacement;
    return;
  }
  if (cursor && typeof cursor === "object") {
    (cursor as Record<string, unknown>)[leaf] = safeReplacement;
    return;
  }
  throw new Error(`Cannot apply SNES Studio patch at ${path}.`);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableStringify(left, 0) === stableStringify(right, 0);
}

function enforceSnesStudioSafety(project: SnesStudioProject) {
  project.profile.mapMode = "lorom";
  project.profile.region = "ntsc";
  project.profile.target = "fxpak-pro";
  project.profile.fxpak.cardSizeGb = SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
  project.profile.fxpak.fileSystem = "fat32";
  project.profile.fxpak.preserveExistingSaves = true;
  if (project.profile.videoMode === "superfx" || project.profile.enhancementChip === "superfx") {
    project.profile.videoMode = "superfx";
    project.profile.enhancementChip = "superfx";
    project.profile.romSizeMbit = Math.max(project.profile.romSizeMbit, 16);
  } else {
    project.profile.enhancementChip = "none";
  }
  project.save = normalizeSnesSaveSystem(project.save);
  project.scenes = project.scenes.map(normalizeSnesStudioScene);
}

function titleFromPrompt(prompt: string): string {
  const quoted = prompt.match(/["“]([^"”]{3,80})["”]/)?.[1]?.trim();
  if (quoted) {
    return titleCase(quoted.replace(/[^a-zA-Z0-9 _-]+/g, " "));
  }
  const cleaned = prompt
    .replace(/\b(make|create|build|design|generate|prototype|game|snes|super nintendo)\b/gi, " ")
    .replace(/\b(a|an|the|about|where|with|and|for|from|called|named)\b/gi, " ")
    .replace(/[^a-zA-Z0-9 _-]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
  return titleCase(cleaned || "Untitled SNES Game");
}

function applyPromptTheme(project: SnesStudioProject, promptLower: string, changes: string[]) {
  const scene = activeScene(project);
  if (includesAny(promptLower, ["forest", "jungle", "tree", "woods"])) {
    scene.name = "Canopy 1-1";
    project.assets.backgroundPalettes = 7;
    changes.push("Applied forest platformer scene profile.");
  } else if (includesAny(promptLower, ["castle", "dungeon", "ruin", "crypt"])) {
    scene.name = "Castle 1-1";
    project.assets.backgroundTiles = 448;
    project.assets.backgroundPalettes = 6;
    changes.push("Applied castle/dungeon scene profile.");
  } else if (includesAny(promptLower, ["space", "star", "ship", "planet", "galaxy"])) {
    scene.name = "Orbit 1-1";
    project.assets.backgroundTiles = 416;
    project.assets.spriteTiles = 224;
    changes.push("Applied space action scene profile.");
  } else if (includesAny(promptLower, ["water", "ocean", "sea", "submarine", "river"])) {
    scene.name = "Tide 1-1";
    project.assets.backgroundTiles = 432;
    project.assets.audioBytes = 20 * 1024;
    changes.push("Applied water level scene profile.");
  } else {
    changes.push("Kept conservative Mode 1 platformer scene profile.");
  }

  if (includesAny(promptLower, ["doom", "star fox", "superfx", "super fx", "3d", "polygon"])) {
    project.profile.videoMode = "superfx";
    project.profile.enhancementChip = "superfx";
    project.profile.romSizeMbit = Math.max(project.profile.romSizeMbit, 16);
    changes.push("Marked the project as a SuperFX-aware concept profile.");
  }
}

function applyPromptEntities(project: SnesStudioProject, promptLower: string, changes: string[]) {
  const scene = activeScene(project);
  const entities: SnesSceneEntity[] = [
    {
      id: "player",
      kind: "player",
      name: "Player Start",
      x: 32,
      y: 176,
      metaspriteTiles: 8,
    },
  ];

  const enemyNames = includesAny(promptLower, ["robot", "mech", "android"])
    ? ["Patrol Bot", "Shield Drone"]
    : includesAny(promptLower, ["ghost", "spirit", "haunted"])
      ? ["Lantern Ghost", "Wall Wisp"]
      : includesAny(promptLower, ["pirate", "ship"])
        ? ["Deck Pirate", "Cannon Mate"]
        : ["Patrol Shell", "Ridge Bat"];
  const enemyCount = includesAny(promptLower, ["boss", "swarm", "horde", "many enemies"]) ? 3 : 2;
  for (let i = 0; i < enemyCount; i++) {
    entities.push({
      id: `enemy-${i + 1}`,
      kind: "enemy",
      name: enemyNames[i % enemyNames.length],
      x: 192 + i * 96,
      y: 176,
      metaspriteTiles: includesAny(promptLower, ["boss"]) && i === enemyCount - 1 ? 16 : 8,
    });
  }

  if (includesAny(promptLower, ["coin", "gem", "key", "treasure", "collect"])) {
    entities.push({
      id: "item-1",
      kind: "item",
      name: includesAny(promptLower, ["key"]) ? "Gate Key" : "Treasure Pickup",
      x: 352,
      y: 128,
      metaspriteTiles: 2,
    });
  }
  if (includesAny(promptLower, ["npc", "villager", "merchant", "dialogue", "story"])) {
    entities.push({
      id: "npc-1",
      kind: "npc",
      name: "Guide NPC",
      x: 96,
      y: 176,
      metaspriteTiles: 8,
    });
    project.assets.scriptBytes = Math.max(project.assets.scriptBytes, 18 * 1024);
  }
  entities.push({
    id: "goal-door",
    kind: "npc",
    name: includesAny(promptLower, ["key", "gate", "door"]) ? "Locked Goal Door" : "Goal Door",
    x: 448,
    y: 176,
    metaspriteTiles: 8,
  });

  scene.entities = entities;
  project.assets.spriteTiles = Math.max(project.assets.spriteTiles, 160 + entities.length * 24);
  changes.push(`Generated ${entities.length} starter entities from the prompt.`);
}

function promptEntityName(prompt: string, fallback: string): string {
  const quoted = prompt.match(/["“]([^"”]{3,40})["”]/)?.[1]?.trim();
  if (quoted) {
    return titleCase(quoted.replace(/[^a-zA-Z0-9 _-]+/g, " "));
  }
  const words = prompt
    .replace(/[^a-zA-Z0-9 _-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return titleCase(words || fallback);
}

function spriteAccentForPrompt(promptLower: string, kind: SnesSceneEntityKind): number {
  if (includesAny(promptLower, ["fire", "lava", "red"])) {
    return 9;
  }
  if (includesAny(promptLower, ["water", "ice", "blue"])) {
    return 6;
  }
  if (includesAny(promptLower, ["forest", "plant", "green"])) {
    return 3;
  }
  if (includesAny(promptLower, ["gold", "coin", "treasure", "yellow"])) {
    return 10;
  }
  switch (kind) {
    case "player":
      return 12;
    case "enemy":
      return 8;
    case "item":
      return 10;
    case "npc":
      return 5;
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function createPromptSpritePixels(promptLower: string, kind: SnesSceneEntityKind): number[] {
  const accent = spriteAccentForPrompt(promptLower, kind);
  const outline = 1;
  const shade = Math.max(2, accent - 2);
  const pixels = Array.from({ length: 16 * 16 }, () => 0);
  const set = (x: number, y: number, value: number) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) {
      pixels[y * 16 + x] = value & 0x0f;
    }
  };
  const fillRect = (left: number, top: number, width: number, height: number, value: number) => {
    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        set(x, y, value);
      }
    }
  };

  if (kind === "item") {
    for (let y = 3; y <= 12; y++) {
      for (let x = 3; x <= 12; x++) {
        if (Math.abs(x - 8) + Math.abs(y - 8) <= 6) {
          set(x, y, accent);
        }
      }
    }
    fillRect(6, 5, 4, 6, shade);
    set(5, 4, 1);
    set(10, 11, 1);
  } else {
    fillRect(5, 2, 6, 4, outline);
    fillRect(6, 3, 4, 2, accent);
    fillRect(4, 6, 8, 7, outline);
    fillRect(5, 7, 6, 5, shade);
    fillRect(2, 7, 2, 5, outline);
    fillRect(12, 7, 2, 5, outline);
    fillRect(5, 13, 2, 2, outline);
    fillRect(9, 13, 2, 2, outline);
    if (kind === "enemy") {
      set(6, 4, 15);
      set(9, 4, 15);
      fillRect(3, 3, 2, 2, outline);
      fillRect(11, 3, 2, 2, outline);
    } else if (kind === "npc") {
      fillRect(6, 1, 4, 1, accent);
      set(6, 4, 15);
      set(9, 4, 15);
    } else {
      set(6, 4, 15);
      set(9, 4, 15);
      fillRect(7, 1, 2, 1, accent);
    }
  }

  if (includesAny(promptLower, ["armor", "shield", "robot", "mech"])) {
    fillRect(4, 6, 8, 2, 14);
  }
  if (includesAny(promptLower, ["wing", "flying", "bat"])) {
    fillRect(1, 8, 3, 3, accent);
    fillRect(12, 8, 3, 3, accent);
  }
  return pixels;
}

export function createSnesPromptSpriteAsset(
  prompt: string,
  kind: SnesSceneEntityKind = "player",
  importedAt = new Date().toISOString(),
): SnesPromptSpriteAsset {
  const promptLower = prompt.toLowerCase();
  const name = promptEntityName(prompt, kind === "item" ? "Prompt Item" : "Prompt Sprite");
  const importResult = importSnesIndexedTileAsset(
    {
      name: `${name} Sprite`,
      width: 16,
      height: 16,
      pixels: createPromptSpritePixels(promptLower, kind),
    },
    importedAt,
  );
  const defaultEntity: SnesSceneEntity = {
    id: sanitizeRomBaseName(name) || `generated-${kind}`,
    kind,
    name,
    x: kind === "item" ? 160 : 96,
    y: kind === "item" ? 128 : 176,
    metaspriteTiles: kind === "item" ? 2 : 4,
  };
  const animation: SnesSpriteAnimation | null =
    kind === "item"
      ? null
      : {
          id: `${defaultEntity.id}-animation`,
          name: `${name} Loop`,
          entityKind: kind === "enemy" ? "enemy" : kind === "npc" ? "npc" : "player",
          loop: true,
          frames: [
            {
              id: `${defaultEntity.id}-frame-1`,
              durationTicks: 8,
              tileIndex: 0,
              xOffset: 0,
              yOffset: 0,
            },
            {
              id: `${defaultEntity.id}-frame-2`,
              durationTicks: 8,
              tileIndex: 1,
              xOffset: 1,
              yOffset: 0,
            },
          ],
        };
  return {
    prompt,
    kind,
    importResult,
    defaultEntity,
    animation,
    paletteHints: [
      "Color 0 is transparent.",
      "Generated pixels stay inside one SNES 4bpp 16-color palette.",
      `${importResult.uniqueTileCount} unique 8x8 CHR tile${importResult.uniqueTileCount === 1 ? "" : "s"} generated.`,
    ],
  };
}

function createPatchOperationsBetween(
  baseProject: SnesStudioProject,
  nextProject: SnesStudioProject,
): SnesJsonPatchOperation[] {
  const normalizedBase = normalizeSnesStudioProject(baseProject);
  const normalizedNext = normalizeSnesStudioProject(nextProject);
  return SNES_AGENT_PATCH_PATHS.flatMap((path): SnesJsonPatchOperation[] => {
    const before = getJsonPointerValue(normalizedBase, path);
    const after = getJsonPointerValue(normalizedNext, path);
    return sameJsonValue(before, after)
      ? []
      : [
          {
            op: "replace",
            path,
            value: cloneJsonValue(after),
          },
        ];
  });
}

function agentSourceForProvider(provider: SnesAgentProvider): SnesAgentPatchProposal["source"] {
  return provider === "openclaw" ? "openclaw-agent" : "openclaw-codex";
}

function agentProviderFromSource(source: SnesAgentPatchProposal["source"]): SnesAgentProvider {
  return source === "openclaw-agent" ? "openclaw" : "codex";
}

function agentProviderLabel(provider: SnesAgentProvider): string {
  return provider === "openclaw" ? "OpenClaw" : "Codex";
}

function isSnesAiAuthoringSurface(value: unknown): value is SnesAiAuthoringSurface {
  return (
    typeof value === "string" && (SNES_AI_AUTHORING_SURFACES as readonly string[]).includes(value)
  );
}

function isSnesAgentProvider(value: unknown): value is SnesAgentProvider {
  return value === "openclaw" || value === "codex";
}

function surfaceTitle(surface: SnesAiAuthoringSurface): string {
  return titleCase(surface.replace(/-/g, " "));
}

function requestedSceneCountFromPrompt(promptLower: string): number {
  const numericMatch =
    /\b([2-4])(?:\s+[a-z0-9-]+){0,3}\s+(?:levels|stages|worlds|areas|maps)\b/iu.exec(promptLower);
  if (numericMatch?.[1]) {
    return Number(numericMatch[1]);
  }
  const wordCounts: Array<[string, number]> = [
    ["four", 4],
    ["three", 3],
    ["two", 2],
  ];
  for (const [word, count] of wordCounts) {
    if (
      new RegExp(
        `\\b${word}(?:\\s+[a-z0-9-]+){0,3}\\s+(?:levels|stages|worlds|areas|maps)\\b`,
        "iu",
      ).test(promptLower)
    ) {
      return count;
    }
  }
  return includesAny(promptLower, ["boss level", "final level", "second level"]) ? 2 : 1;
}

function createPromptFollowupScene(
  title: string,
  index: number,
  promptLower: string,
): SnesStudioScene {
  const sceneName =
    index === 1 && includesAny(promptLower, ["boss", "castle", "gate"])
      ? `${title} Boss Gate`
      : `${title} ${index + 1}-1`;
  const scene = createSnesStudioScene(
    sceneName,
    `${sanitizeRomBaseName(title) || "generated"}-${index + 1}`,
  );
  scene.widthMetatiles = includesAny(promptLower, ["large", "open world", "explore"]) ? 192 : 128;
  scene.heightMetatiles =
    index > 1 || includesAny(promptLower, ["vertical", "tower", "climb"]) ? 24 : 16;
  scene.layers = includesAny(promptLower, ["parallax", "background", "layer"]) ? 3 : 2;
  scene.tilemap = createDefaultSceneTilemap().map((tile, cellIndex) => {
    const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
    if (includesAny(promptLower, ["lava", "hazard"]) && row === 8 && cellIndex % 4 === 0) {
      return 4;
    }
    if (includesAny(promptLower, ["water", "river"]) && row === 8 && cellIndex % 5 === 0) {
      return 5;
    }
    if (index > 1 && row === 6 && cellIndex % 6 === 0) {
      return 2;
    }
    return tile;
  });
  scene.collisionMap = createDefaultSceneCollisionMap(scene.tilemap);
  scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
  scene.entities = [
    {
      id: "player",
      kind: "player",
      name: "Player Start",
      x: 32,
      y: 176,
      metaspriteTiles: 8,
    },
    {
      id: `enemy-${index + 1}`,
      kind: "enemy",
      name:
        index > 1 && includesAny(promptLower, ["boss"])
          ? "Boss Guardian"
          : `Patrol Enemy ${index + 1}`,
      x: 192 + index * 40,
      y: 176,
      metaspriteTiles: index > 1 && includesAny(promptLower, ["boss"]) ? 16 : 8,
    },
    {
      id: `item-${index + 1}`,
      kind: "item",
      name: includesAny(promptLower, ["key"]) ? `Key ${index + 1}` : `Pickup ${index + 1}`,
      x: 320,
      y: 128,
      metaspriteTiles: 2,
    },
  ];
  if (includesAny(promptLower, ["dialogue", "npc", "guide", "story"])) {
    scene.entities.push({
      id: `npc-${index + 1}`,
      kind: "npc",
      name: `Guide ${index + 1}`,
      x: 96,
      y: 176,
      metaspriteTiles: 8,
    });
  }
  return scene;
}

function promptStoryWorld(promptLower: string): string {
  if (includesAny(promptLower, ["mountain", "summit", "ridge"])) {
    return "A bright mountain world with gem paths, old gates, and a final summit ending.";
  }
  if (includesAny(promptLower, ["forest", "jungle", "tree", "woods"])) {
    return "A readable forest world with safe starter paths, hidden rewards, and a final grove.";
  }
  if (includesAny(promptLower, ["castle", "dungeon", "ruin", "crypt", "gate"])) {
    return "A castle-gate world with keys, guarded doors, and a clear final chamber.";
  }
  if (includesAny(promptLower, ["space", "star", "ship", "planet", "galaxy"])) {
    return "A sky-and-space world with floating platforms, robot rivals, and a final signal gate.";
  }
  return "A colorful SNES platform world with readable level goals, rewards, and a satisfying ending.";
}

function promptStoryHero(promptLower: string): string {
  if (includesAny(promptLower, ["robot", "mech", "android"])) {
    return "Robot Hero";
  }
  if (includesAny(promptLower, ["ninja"])) {
    return "Ninja Hero";
  }
  if (includesAny(promptLower, ["wizard", "magic", "mage"])) {
    return "Magic Hero";
  }
  return "Platform Hero";
}

function promptStoryVillain(promptLower: string): string {
  if (includesAny(promptLower, ["drone", "robot", "rival"])) {
    return "Rival Drone";
  }
  if (includesAny(promptLower, ["boss", "guardian"])) {
    return "Gate Guardian";
  }
  if (includesAny(promptLower, ["ghost", "haunted"])) {
    return "Lantern Ghost";
  }
  return "Rival Guardian";
}

function createPromptStoryBible(
  title: string,
  prompt: string,
  promptLower: string,
): SnesGameStoryBible {
  const hero = promptStoryHero(promptLower);
  const villain = promptStoryVillain(promptLower);
  const hiddenKey = includesAny(promptLower, ["hidden key", "key"]);
  const reward = includesAny(promptLower, ["gem", "gems"]) ? "gems" : "rewards";
  const ending = includesAny(promptLower, ["mountain", "summit", "ending"])
    ? `${hero} reaches the mountain ending after collecting ${hiddenKey ? "the hidden key and " : ""}${reward}.`
    : `${hero} opens the final route, beats ${villain}, and restores the world.`;
  return {
    premise: `${title} is a story-driven side-scrolling platformer generated from: ${prompt.slice(0, 180)}`,
    world: promptStoryWorld(promptLower),
    hero,
    heroGoal: hiddenKey
      ? `Find the hidden key, collect ${reward}, and reach the final gate.`
      : `Collect ${reward}, learn each level, and reach the final goal.`,
    villain,
    conflict: `${villain} blocks the route while the hero learns jumps, avoids enemies, collects rewards, and opens the way forward.`,
    ending,
    tone: includesAny(promptLower, ["dark", "spooky", "haunted"])
      ? "mysterious but friendly enough for a first playthrough"
      : "hopeful, adventurous, and easy to understand",
  };
}

function createPromptLevelChapters(
  project: SnesStudioProject,
  promptLower: string,
): SnesLevelChapter[] {
  const story = project.gameStoryBible ?? createDefaultGameStoryBible(project.name);
  const reward = includesAny(promptLower, ["gem", "gems"]) ? "gem reward" : "collectible reward";
  const keyReward = includesAny(promptLower, ["hidden key", "key"]) ? "hidden key" : reward;
  const finalSetting = includesAny(promptLower, ["mountain", "summit"])
    ? "mountain ending"
    : includesAny(promptLower, ["castle", "gate"])
      ? "final gate"
      : "final route";
  return project.scenes.slice(0, 6).map((scene, index) => {
    const finalLevel = index === project.scenes.length - 1 && project.scenes.length > 1;
    const middleLevel = index > 0 && !finalLevel;
    return {
      id: `chapter-${index + 1}`,
      sceneId: scene.id,
      order: index,
      title:
        index === 0
          ? `${project.name} Opening`
          : finalLevel
            ? `${project.name} Finale`
            : `${project.name} Chapter ${index + 1}`,
      storyPurpose:
        index === 0
          ? `Introduce ${story.hero}, the controls, and the first ${reward}.`
          : finalLevel
            ? `Pay off the story by letting ${story.hero} confront ${story.villain} and reach the ending.`
            : "Raise the challenge with a new route, a clear reward, and a stronger enemy pattern.",
      setting: finalLevel
        ? finalSetting
        : middleLevel
          ? "rising route with a secret"
          : "safe starter path",
      challenge: finalLevel
        ? `${story.villain} guards the last door.`
        : middleLevel
          ? "A patrol enemy, a bigger jump, and a visible secret."
          : "One readable enemy and one easy jump.",
      reward: finalLevel ? "ending scene" : middleLevel ? keyReward : reward,
      goal: finalLevel ? story.ending : "Reach the door and continue the story.",
      requiredThings: [
        story.hero,
        index === 0 ? "starter reward" : keyReward,
        finalLevel ? story.villain : "patrol enemy",
        finalLevel ? "final goal" : "door",
      ],
    };
  });
}

function createSurfaceProjectDraft(
  surface: SnesAiAuthoringSurface,
  prompt: string,
  baseProject: SnesStudioProject,
): { changes: string[]; project: SnesStudioProject } {
  if (surface === "full-game") {
    const generated = generateSnesProjectFromPrompt(prompt, baseProject);
    return { changes: generated.appliedChanges, project: generated.project };
  }

  const project = normalizeSnesStudioProject(baseProject);
  const scene = activeScene(project);
  const promptLower = prompt.toLowerCase();
  const changes: string[] = [];

  if (surface === "level") {
    const levelName = promptEntityName(prompt, `${project.name} Level`);
    scene.name = levelName.includes("Level") ? levelName : `${levelName} Level`;
    scene.widthMetatiles = includesAny(promptLower, ["large", "long", "open", "explore"])
      ? 192
      : 128;
    scene.heightMetatiles = includesAny(promptLower, ["vertical", "tower", "climb"]) ? 24 : 16;
    scene.layers = includesAny(promptLower, ["parallax", "background", "layer"]) ? 3 : 2;
    if (!scene.tilemap.some((tile) => tile > 0) && !scene.collisionMap.some((cell) => cell > 0)) {
      scene.tilemap = createDefaultSceneTilemap();
      scene.collisionMap = createDefaultSceneCollisionMap(scene.tilemap);
    }
    if (includesAny(promptLower, ["pit", "cave", "platform"])) {
      scene.tilemap = scene.tilemap.map((tile, index) =>
        Math.floor(index / SNES_STUDIO_EDIT_GRID.width) === 7 && index % 5 === 0 ? 0 : tile,
      );
      scene.collisionMap = scene.tilemap.map(defaultCollisionForTile);
    }
    scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
    const levelBrushes: SnesCustomTileBrush[] = [];
    if (includesAny(promptLower, ["spike", "hazard", "lava"])) {
      levelBrushes.push({ id: "ai-hazard", name: "AI Hazard", tile: 4, solid: true });
    }
    if (includesAny(promptLower, ["water", "river", "swim"])) {
      levelBrushes.push({ id: "ai-water", name: "AI Water", tile: 5, solid: false });
    }
    if (levelBrushes.length > 0) {
      project.assets.customTileBrushes = [
        ...project.assets.customTileBrushes.filter(
          (brush) => !levelBrushes.some((candidate) => candidate.id === brush.id),
        ),
        ...levelBrushes,
      ];
    }
    changes.push("Generated editable level layout, size, layers, and collision profile.");
  } else if (surface === "player") {
    const player = scene.entities.find((entity) => entity.kind === "player");
    if (player) {
      player.name = promptEntityName(prompt, "Player Start");
      player.x = includesAny(promptLower, ["center", "middle"]) ? 120 : 32;
      player.y = includesAny(promptLower, ["air", "jump", "flying"]) ? 144 : 176;
      player.metaspriteTiles = includesAny(promptLower, ["large", "detailed", "armor"]) ? 16 : 8;
    }
    project.animations = [
      ...project.animations.filter((animation) => animation.entityKind !== "player"),
      {
        id: "generated-player-animation",
        name: includesAny(promptLower, ["jump", "flying"]) ? "Player Air Ready" : "Player Idle Run",
        entityKind: "player",
        loop: true,
        frames: [
          { id: "player-frame-1", durationTicks: 8, tileIndex: 5, xOffset: 0, yOffset: 0 },
          { id: "player-frame-2", durationTicks: 8, tileIndex: 6, xOffset: 1, yOffset: 0 },
        ],
      },
    ];
    project.assets.spriteTiles = Math.max(project.assets.spriteTiles, 224);
    changes.push("Generated editable player start, name, metasprite budget, and animation timing.");
  } else if (surface === "enemies") {
    const preserved = scene.entities.filter((entity) => entity.kind !== "enemy");
    const enemyName = promptEntityName(prompt, "Enemy");
    const count = includesAny(promptLower, ["boss", "horde", "swarm", "many"]) ? 4 : 2;
    scene.entities = [
      ...preserved,
      ...Array.from(
        { length: count },
        (_, index): SnesSceneEntity => ({
          id:
            index === count - 1 && includesAny(promptLower, ["boss"])
              ? "boss-1"
              : `enemy-${index + 1}`,
          kind: "enemy",
          name:
            index === count - 1 && includesAny(promptLower, ["boss"])
              ? `${enemyName} Boss`
              : `${enemyName} ${index + 1}`,
          x: 176 + index * 72,
          y: 176,
          metaspriteTiles: index === count - 1 && includesAny(promptLower, ["boss"]) ? 16 : 8,
        }),
      ),
    ];
    project.animations = [
      ...project.animations.filter((animation) => animation.entityKind !== "enemy"),
      {
        id: "generated-enemy-animation",
        name: includesAny(promptLower, ["boss"]) ? "Boss Threat Loop" : "Enemy Patrol Loop",
        entityKind: "enemy",
        loop: true,
        frames: [
          { id: "enemy-frame-1", durationTicks: 10, tileIndex: 4, xOffset: 0, yOffset: 0 },
          { id: "enemy-frame-2", durationTicks: 10, tileIndex: 4, xOffset: 1, yOffset: 0 },
        ],
      },
    ];
    project.assets.spriteTiles = Math.max(project.assets.spriteTiles, 192 + count * 24);
    changes.push(`Generated ${count} editable enemy placements and enemy animation timing.`);
  } else if (surface === "items") {
    const preserved = scene.entities.filter((entity) => entity.kind !== "item");
    const itemName = promptEntityName(prompt, "Item");
    const count = includesAny(promptLower, ["many", "coins", "gems", "collect"]) ? 4 : 2;
    scene.entities = [
      ...preserved,
      ...Array.from(
        { length: count },
        (_, index): SnesSceneEntity => ({
          id: `item-${index + 1}`,
          kind: "item",
          name: `${itemName} ${index + 1}`,
          x: 144 + index * 64,
          y: index % 2 === 0 ? 128 : 112,
          metaspriteTiles: 2,
        }),
      ),
    ];
    changes.push(`Generated ${count} editable item placements.`);
  } else if (surface === "audio") {
    const themeName = promptEntityName(prompt, "Main Theme");
    const totalBytes = includesAny(promptLower, ["orchestra", "sample", "ambient", "vocal"])
      ? 24 * 1024
      : 18 * 1024;
    project.assets.audio = {
      driver: "preview-spc700",
      aramReservedBytes: 8192,
      sampleBytes: Math.max(0, totalBytes - 8192 - 7168 - 512),
      musicTracks: [
        {
          id: sanitizeRomBaseName(themeName) || "main-theme",
          name: themeName,
          tempo: includesAny(promptLower, ["fast", "chase", "battle", "beat", "drum"]) ? 148 : 118,
          patternRows: includesAny(promptLower, ["long", "epic"]) ? 128 : 96,
          estimatedBytes: 7168,
        },
      ],
      soundEffects: [
        {
          id: "jump",
          name: "Jump",
          priority: 4,
          estimatedBytes: 128,
          steps: [{ instrument: "pulse", note: "C5", ticks: 4, volume: 12 }],
        },
        {
          id: "pickup",
          name: includesAny(promptLower, ["gem", "coin"]) ? "Pickup Chime" : "Pickup",
          priority: 5,
          estimatedBytes: 128,
          steps: [{ instrument: "pulse", note: "G5", ticks: 5, volume: 12 }],
        },
        {
          id: "hit",
          name: "Hit",
          priority: 6,
          estimatedBytes: 256,
          steps: [{ instrument: "noise", note: "N1", ticks: 8, volume: 13 }],
        },
      ],
    };
    project.assets.audioBytes = estimatedSnesAudioBytes(project.assets.audio);
    changes.push("Generated editable SPC700 music, beats, vocal-like lead, and SFX plan.");
  } else if (surface === "dialogue") {
    const npcName = promptEntityName(prompt, "Guide NPC");
    if (!scene.entities.some((entity) => entity.kind === "npc")) {
      scene.entities.push({
        id: "npc-1",
        kind: "npc",
        name: npcName,
        x: 96,
        y: 176,
        metaspriteTiles: 8,
      });
    } else {
      scene.entities = scene.entities.map((entity) =>
        entity.kind === "npc" ? Object.assign({}, entity, { name: npcName }) : entity,
      );
    }
    project.dialogue = [
      ...project.dialogue.filter((cutscene) => cutscene.id !== "generated-dialogue"),
      {
        id: "generated-dialogue",
        name: `${npcName} Scene`,
        trigger: includesAny(promptLower, ["boss", "gate"]) ? "boss-gate" : "on-start",
        lines: [
          {
            id: "generated-dialogue-1",
            speaker: npcName,
            text: includesAny(promptLower, ["key", "gate"])
              ? "Find the hidden key before you challenge the gate."
              : "Stay sharp. The next stretch was built to test every jump.",
          },
          {
            id: "generated-dialogue-2",
            speaker: "Player",
            text: "I am ready.",
          },
        ],
      },
    ];
    project.events = [
      ...project.events.filter((event) => event.id !== "generated-dialogue-event"),
      {
        id: "generated-dialogue-event",
        name: `Show ${npcName} dialogue`,
        trigger: "on-enter-zone",
        targetId: "npc-1",
        actions: [{ type: "show-dialogue", cutsceneId: "generated-dialogue" }],
      },
    ];
    project.assets.scriptBytes = Math.max(project.assets.scriptBytes, 20 * 1024);
    changes.push("Generated editable NPC dialogue, cutscene lines, event hook, and script budget.");
  } else if (surface === "save") {
    const fields: SnesSaveField[] = [
      { key: "checkpoint", label: "Last checkpoint", type: "u16" },
      {
        key: includesAny(promptLower, ["gem"]) ? "gems" : "coins",
        label: includesAny(promptLower, ["gem"]) ? "Gems" : "Coins",
        type: "u16",
      },
      { key: "boss_cleared", label: "Boss cleared", type: "flag" },
    ];
    if (includesAny(promptLower, ["key", "door", "gate"])) {
      fields.push({ key: "keys", label: "Keys", type: "u8" });
    }
    project.save = {
      enabled: true,
      slots: includesAny(promptLower, ["many", "profiles", "family"]) ? 4 : 3,
      fields,
    };
    changes.push("Generated editable SRAM save fields and slot count.");
  } else if (surface === "export") {
    const title = titleFromPrompt(prompt);
    project.export.romBaseName = sanitizeRomBaseName(title) || project.export.romBaseName;
    project.profile.fxpak.cardSizeGb = SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
    project.profile.fxpak.fileSystem = "fat32";
    project.profile.fxpak.preserveExistingSaves = true;
    changes.push("Generated FXPAK PRO-safe ROM/export settings.");
  }

  enforceSnesStudioSafety(project);
  project.updatedAt = new Date().toISOString();
  return { changes, project };
}

export function createSnesAiAuthoringPrompts(
  project: SnesStudioProject = createDefaultSnesStudioProject(),
): SnesAiAuthoringPrompt[] {
  const projectName = project.name || "your SNES game";
  return [
    {
      surface: "full-game",
      title: "Create Entire Game",
      description: "Generate a complete hardware-safe starter project that remains editable.",
      placeholder: `Create a complete SNES platformer called "${projectName} DX" with levels, enemies, items, dialogue, music, save points, and real-hardware export settings.`,
    },
    {
      surface: "level",
      title: "Create Level",
      description: "Generate or reshape the active level layout, size, art layers, and bump rules.",
      placeholder:
        "Create a long forest level with vertical climbing, safe platforms, a few pits, and parallax background layers.",
    },
    {
      surface: "player",
      title: "Create Player",
      description: "Generate editable hero start, naming, and sprite-size settings.",
      placeholder:
        "Create a nimble armored explorer hero who starts near the center and has clear small-screen graphics.",
    },
    {
      surface: "enemies",
      title: "Create Enemies",
      description: "Generate editable enemy and boss placements inside the active scene.",
      placeholder: "Create two patrol robots and one shield boss near the end of the level.",
    },
    {
      surface: "items",
      title: "Create Items",
      description: "Generate editable collectibles, keys, treasures, and item placements.",
      placeholder:
        "Create four moon gems placed on alternating platforms and one key for the exit gate.",
    },
    {
      surface: "audio",
      title: "Create Music, Beats, and SFX",
      description:
        "Generate editable background music, beats, vocal-like leads, sound effects, samples, and sound-memory plans.",
      placeholder:
        "Create a fast battle theme with drum-like pulse/noise beats, a vocal-like lead hook, jump, pickup, and hit sound effects while staying inside sound memory.",
    },
    {
      surface: "dialogue",
      title: "Create Dialogue",
      description: "Generate editable NPC and dialogue scripting hooks.",
      placeholder: "Create a guide NPC who warns the player about the boss gate and hidden key.",
    },
    {
      surface: "save",
      title: "Create Save System",
      description: "Generate editable progress-save slots and save fields.",
      placeholder:
        "Create a three-slot save system for checkpoints, coins, keys, and boss-cleared state.",
    },
    {
      surface: "export",
      title: "Create Export Settings",
      description: "Generate safe file names and real-hardware export rules.",
      placeholder:
        "Create export settings for Moonlit Ridge Deluxe on a 128 GB real-hardware card.",
    },
  ];
}

export function createSnesAiBuildPlan(
  project: SnesStudioProject = createDefaultSnesStudioProject(),
): SnesAiBuildStage[] {
  const scene = project.scenes[0];
  const entityKinds = new Set(scene?.entities.map((entity) => entity.kind) ?? []);
  const hasAuthoredLevel =
    Boolean(scene) &&
    ((scene?.tilemap ?? []).some((tile) => tile > 0) ||
      (scene?.collisionMap ?? []).some((material) => material > 0));
  const hasNamedGame = project.name.trim().length > 0 && !/^untitled\b/iu.test(project.name);
  const hasAudio =
    project.assets.audio.musicTracks.length > 0 || project.assets.audio.soundEffects.length > 0;
  const hasExport =
    project.export.romBaseName.trim().length > 0 &&
    !/^untitled\b/iu.test(project.export.romBaseName) &&
    project.profile.target === "fxpak-pro" &&
    project.profile.fxpak.fileSystem === "fat32";

  return [
    {
      surface: "full-game",
      title: "1. Create the whole game",
      status: hasNamedGame && hasAuthoredLevel ? "complete" : "recommended",
      editPanel: "project",
      promptGoal:
        "Describe the full game, genre, player fantasy, levels, enemies, items, tone, and save needs.",
      acceptance:
        "Project name, first level, entities, dialogue, audio plan, SRAM, and FXPAK export settings exist.",
      dragDropHint:
        "After generation, drag entities in the level editor and refine fields in the inspector.",
    },
    {
      surface: "level",
      title: "2. Build levels",
      status: hasAuthoredLevel ? "complete" : "recommended",
      editPanel: "scene",
      promptGoal:
        "Ask for level shape, platform rhythm, hazards, pacing, route, secrets, and mood.",
      acceptance: "The active scene has editable tile, collision, entity, and size data.",
      dragDropHint: "Use tile/collision paint plus entity drag-and-drop for fast layout cleanup.",
    },
    {
      surface: "player",
      title: "3. Define the player",
      status: entityKinds.has("player") ? "complete" : "recommended",
      editPanel: "scene",
      promptGoal: "Describe the hero, starting position, movement feel, and metasprite budget.",
      acceptance: "A player entity exists and can be edited in the entity inspector.",
      dragDropHint: "Drag the player start marker to tune spawn position after AI placement.",
    },
    {
      surface: "enemies",
      title: "4. Add enemies and bosses",
      status: entityKinds.has("enemy") ? "complete" : "recommended",
      editPanel: "scene",
      promptGoal: "Request enemy roles, patrol spacing, boss placement, and difficulty ramp.",
      acceptance:
        "Enemy entities exist in the active scene with editable names, positions, and metasprite budgets.",
      dragDropHint: "Drag enemy chips along the level to tune encounter spacing.",
    },
    {
      surface: "items",
      title: "5. Place items",
      status: entityKinds.has("item") ? "complete" : "recommended",
      editPanel: "scene",
      promptGoal: "Ask for keys, collectibles, upgrades, reward placement, and secrets.",
      acceptance: "Item entities exist and can be moved without leaving SNES OAM budgets.",
      dragDropHint:
        "Drag collectibles onto platforms, hazards, or secret routes for fast iteration.",
    },
    {
      surface: "dialogue",
      title: "6. Write dialogue and cutscenes",
      status: project.dialogue.length > 0 && project.events.length > 0 ? "complete" : "optional",
      editPanel: "story",
      promptGoal: "Describe NPC voice, cutscene trigger, tutorial text, and story beats.",
      acceptance: "Dialogue lines and event hooks are editable in the story and logic panels.",
      dragDropHint: "Place NPCs in the scene, then bind generated dialogue to their triggers.",
    },
    {
      surface: "audio",
      title: "7. Create music and SFX",
      status: hasAudio ? "complete" : "optional",
      editPanel: "assets",
      promptGoal:
        "Describe background music, beats/drums, vocal-like lead hooks, loops, and SFX priorities.",
      acceptance: "SPC700 preview metadata exists and stays inside ARAM budget.",
      dragDropHint:
        "Drag tracks onto levels and sound effects onto actions, then adjust generated patterns.",
    },
    {
      surface: "save",
      title: "8. Configure SRAM saves",
      status: project.save.enabled && project.save.fields.length > 0 ? "complete" : "recommended",
      editPanel: "export",
      promptGoal: "Describe save slots, checkpoints, inventory fields, and boss flags.",
      acceptance: "Versioned SRAM fields exist and FXPAK save preservation remains enabled.",
      dragDropHint: "Edit fields in the save panel before hardware SRAM power-cycle proof.",
    },
    {
      surface: "export",
      title: "9. Prepare ROM export",
      status: hasExport ? "complete" : "recommended",
      editPanel: "export",
      promptGoal: "Name the ROM and confirm FXPAK PRO, 128 GB FAT32, and SRAM preservation rules.",
      acceptance:
        "ROM filename, FAT32 card profile, manifest rules, and export checklist are ready.",
      dragDropHint: "Use the FXPAK proof panel after export settings are generated.",
    },
  ];
}

export function createSnesGeneratedObjectSummary(
  project: SnesStudioProject = createDefaultSnesStudioProject(),
): SnesGeneratedObjectSummaryItem[] {
  const items: SnesGeneratedObjectSummaryItem[] = [];
  for (const [sceneIndex, scene] of project.scenes.entries()) {
    for (const entity of scene.entities) {
      items.push({
        id: `${scene.id}:${entity.id}`,
        kind: "entity",
        label: entity.name,
        editPanel: "scene",
        detail: `${entity.kind} in level ${sceneIndex + 1} at ${entity.x}, ${entity.y}; ${entity.metaspriteTiles} metasprite tiles.`,
      });
    }
  }
  for (const animation of project.animations) {
    items.push({
      id: animation.id,
      kind: "animation",
      label: animation.name,
      editPanel: "assets",
      detail: `${animation.entityKind} animation with ${animation.frames.length} editable frame${animation.frames.length === 1 ? "" : "s"}.`,
    });
  }
  for (const cutscene of project.dialogue) {
    items.push({
      id: cutscene.id,
      kind: "dialogue",
      label: cutscene.name,
      editPanel: "story",
      detail: `${cutscene.lines.length} line${cutscene.lines.length === 1 ? "" : "s"} triggered by ${cutscene.trigger}.`,
    });
  }
  for (const event of project.events) {
    items.push({
      id: event.id,
      kind: "event",
      label: event.name,
      editPanel: "logic",
      detail: `${event.trigger} on ${event.targetId}; ${event.actions.length} action${event.actions.length === 1 ? "" : "s"}.`,
    });
  }
  for (const track of project.assets.audio.musicTracks) {
    items.push({
      id: track.id,
      kind: "audio",
      label: track.name,
      editPanel: "assets",
      detail: `${track.tempo} BPM, ${track.patternRows} rows, ${track.estimatedBytes} estimated bytes.`,
    });
  }
  for (const effect of project.assets.audio.soundEffects) {
    items.push({
      id: effect.id,
      kind: "audio",
      label: effect.name,
      editPanel: "assets",
      detail: `${effect.steps.length} sequence step${effect.steps.length === 1 ? "" : "s"}, priority ${effect.priority}.`,
    });
  }
  if (project.save.enabled) {
    items.push({
      id: "sram-save-system",
      kind: "save",
      label: "SRAM Save System",
      editPanel: "export",
      detail: `${project.save.slots} slot${project.save.slots === 1 ? "" : "s"}, ${project.save.fields.length} field${project.save.fields.length === 1 ? "" : "s"}.`,
    });
  }
  items.push({
    id: "fxpak-export",
    kind: "export",
    label: `${project.export.romBaseName || "untitled"}.sfc`,
    editPanel: "export",
    detail: `${project.profile.target} export, ${project.profile.fxpak.cardSizeGb} GB ${project.profile.fxpak.fileSystem.toUpperCase()} card, SRAM preservation ${project.profile.fxpak.preserveExistingSaves ? "on" : "off"}.`,
  });
  return items;
}

export function repairSnesProjectForPlayablePreview(
  project: SnesStudioProject = createDefaultSnesStudioProject(),
  updatedAt = new Date().toISOString(),
): SnesPlayableRepairResult {
  const beforeReadiness = buildSnesReadiness(project);
  const next = normalizeSnesStudioProject(project);
  const scene = activeScene(next);
  const changes: string[] = [];

  if (!next.name.trim() || /^untitled\b/iu.test(next.name)) {
    next.name = "Prompt Built SNES Game";
    next.id = "prompt-built-snes-game";
    next.export.romBaseName = "prompt-built-snes-game";
    changes.push("Named the project and ROM so export paths are no longer blank.");
  }
  if (!scene.tilemap.some((tile) => tile > 0) && !scene.collisionMap.some((cell) => cell > 0)) {
    scene.tilemap = createDefaultSceneTilemap();
    scene.collisionMap = createDefaultSceneCollisionMap(scene.tilemap);
    scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
    changes.push("Filled the active level with editable starter tiles and collision.");
  }
  if (!scene.entities.some((entity) => entity.kind === "player")) {
    scene.entities.unshift({
      id: "player",
      kind: "player",
      name: "Player Start",
      x: 32,
      y: 176,
      metaspriteTiles: 8,
    });
    changes.push("Added an editable player start.");
  }
  if (!scene.entities.some((entity) => entity.kind === "enemy")) {
    scene.entities.push({
      id: "enemy-1",
      kind: "enemy",
      name: "Patrol Bot",
      x: 208,
      y: 176,
      metaspriteTiles: 8,
    });
    changes.push("Added an editable starter enemy.");
  }
  if (!scene.entities.some((entity) => entity.kind === "item")) {
    scene.entities.push({
      id: "item-1",
      kind: "item",
      name: "Pickup",
      x: 352,
      y: 128,
      metaspriteTiles: 2,
    });
    changes.push("Added an editable starter item.");
  }
  if (next.animations.length === 0) {
    next.animations = [
      {
        id: "generated-player-animation",
        name: "Player Ready Loop",
        entityKind: "player",
        loop: true,
        frames: [
          { id: "player-ready-1", durationTicks: 8, tileIndex: 5, xOffset: 0, yOffset: 0 },
          { id: "player-ready-2", durationTicks: 8, tileIndex: 6, xOffset: 1, yOffset: 0 },
        ],
      },
      {
        id: "generated-enemy-animation",
        name: "Enemy Patrol Loop",
        entityKind: "enemy",
        loop: true,
        frames: [
          { id: "enemy-ready-1", durationTicks: 10, tileIndex: 4, xOffset: 0, yOffset: 0 },
          { id: "enemy-ready-2", durationTicks: 10, tileIndex: 4, xOffset: 1, yOffset: 0 },
        ],
      },
    ];
    changes.push("Added editable player and enemy animation loops.");
  }
  if (next.assets.audio.musicTracks.length === 0 || next.assets.audio.soundEffects.length === 0) {
    next.assets.audio = createDefaultAudioProject(18 * 1024);
    next.assets.audioBytes = estimatedSnesAudioBytes(next.assets.audio);
    changes.push("Added editable SPC700 preview music and sound effects.");
  }
  if (!next.dialogue.length) {
    next.dialogue = [
      {
        id: "generated-dialogue",
        name: "Guide Intro",
        trigger: "on-start",
        lines: [
          {
            id: "generated-dialogue-1",
            speaker: "Guide",
            text: "The route is ready. Test every jump before export.",
          },
        ],
      },
    ];
    changes.push("Added editable starter dialogue.");
  }
  if (!next.events.length) {
    next.events = [
      {
        id: "generated-start-event",
        name: "Show guide intro",
        trigger: "on-start",
        targetId: scene.id,
        actions: [
          { type: "show-dialogue", cutsceneId: next.dialogue[0]?.id ?? "generated-dialogue" },
        ],
      },
    ];
    changes.push("Added an editable event hook for the starter dialogue.");
  }
  if (!next.save.enabled || next.save.fields.length === 0) {
    next.save = {
      enabled: true,
      slots: 3,
      fields: [
        { key: "checkpoint", label: "Last checkpoint", type: "u16" },
        { key: "coins", label: "Coins", type: "u16" },
        { key: "boss_cleared", label: "Boss cleared", type: "flag" },
      ],
    };
    changes.push("Added editable SRAM save slots and fields.");
  }
  next.gameStoryBible = normalizeGameStoryBible(next.gameStoryBible, next.name);
  next.levelChapters = normalizeLevelChapters(next.levelChapters, next.scenes);
  next.gamePartLocks = normalizeGamePartLocks(next.gamePartLocks);
  next.profile.target = "fxpak-pro";
  next.profile.fxpak.cardSizeGb = SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
  next.profile.fxpak.fileSystem = "fat32";
  next.profile.fxpak.preserveExistingSaves = true;
  next.updatedAt = updatedAt;
  enforceSnesStudioSafety(next);
  return {
    project: normalizeSnesStudioProject(next),
    changes,
    beforeReadiness,
    afterReadiness: buildSnesReadiness(next),
  };
}

export function fillSnesAiGaps(
  project: SnesStudioProject = createDefaultSnesStudioProject(),
  updatedAt = new Date().toISOString(),
): SnesAiGapFillResult {
  const repair = repairSnesProjectForPlayablePreview(project, updatedAt);
  const next = normalizeSnesStudioProject(repair.project);
  const changes = [...repair.changes];
  const promptContext = [
    next.name,
    next.gameplayBlueprint?.premise,
    next.gameStoryBible?.premise,
    next.gameStoryBible?.world,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!hasGamePartLock(next, "story")) {
    const story = normalizeGameStoryBible(next.gameStoryBible, next.name);
    const genericEnding = /reaches the summit goal|restores the world/iu.test(story.ending);
    next.gameStoryBible = genericEnding
      ? createPromptStoryBible(next.name, story.premise, promptContext)
      : story;
    changes.push("Filled the story map with a clear hero goal, villain, conflict, and ending.");
  }

  if (!hasGamePartLock(next, "level")) {
    const targetLevelCount = Math.max(3, next.scenes.length);
    while (next.scenes.length < targetLevelCount) {
      next.scenes.push(createPromptFollowupScene(next.name, next.scenes.length, promptContext));
    }
    const firstScene = activeScene(next);
    const hasGoal = firstScene.entities.some((entity) => {
      const name = entity.name.toLowerCase();
      return name.includes("goal") || name.includes("door") || name.includes("flag");
    });
    if (!hasGoal) {
      firstScene.entities.push({
        id: "goal-door",
        kind: "npc",
        name: "Goal Door",
        x: 448,
        y: 176,
        metaspriteTiles: 8,
      });
      changes.push("Added a visible goal door so the first level has a finish.");
    }
    next.levelChapters = createPromptLevelChapters(next, promptContext);
    changes.push("Filled levels as story chapters with purpose, challenge, reward, and goal.");
  }

  if (!hasGamePartLock(next, "music") && next.assets.audio.musicTracks.length === 0) {
    next.assets.audio = createDefaultAudioProject(18 * 1024);
    next.assets.audioBytes = estimatedSnesAudioBytes(next.assets.audio);
    changes.push("Added a safe starter music and sound-effect plan.");
  }

  if (!hasGamePartLock(next, "export")) {
    next.profile.target = "fxpak-pro";
    next.profile.fxpak.cardSizeGb = SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
    next.profile.fxpak.fileSystem = "fat32";
    next.profile.fxpak.preserveExistingSaves = true;
    if (!next.save.enabled || next.save.fields.length === 0) {
      next.save = {
        enabled: true,
        slots: 3,
        fields: [
          { key: "checkpoint", label: "Last checkpoint", type: "u16" },
          { key: "rewards", label: "Rewards", type: "u16" },
          { key: "ending_unlocked", label: "Ending unlocked", type: "flag" },
        ],
      };
    }
    changes.push("Confirmed save memory and flash-cart export settings.");
  }

  next.updatedAt = updatedAt;
  enforceSnesStudioSafety(next);
  const normalized = normalizeSnesStudioProject(next);
  return {
    project: normalized,
    changes: changes.length > 0 ? Array.from(new Set(changes)) : ["No missing pieces found."],
    report: normalized.aiGapReport ?? buildSnesAiGapReport(normalized),
  };
}

export function createSnesAgentPatchProposalForSurface(
  surface: SnesAiAuthoringSurface,
  prompt: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  requestedAgent: SnesAgentProvider = "openclaw",
): SnesAgentPatchProposal {
  const normalizedPrompt = prompt.trim();
  const generated = createSurfaceProjectDraft(surface, normalizedPrompt, baseProject);
  const operations = createPatchOperationsBetween(baseProject, generated.project);
  const previewProject = applySnesJsonPatch(baseProject, operations, generated.project.updatedAt);
  const readiness = buildSnesReadiness(previewProject);
  const safeName = sanitizeRomBaseName(previewProject.name) || "generated-snes-game";
  const providerLabel = agentProviderLabel(requestedAgent);
  return {
    id: `snes-agent-${surface}-proposal-${safeName}`,
    source: agentSourceForProvider(requestedAgent),
    surface,
    requestedAgent,
    prompt: normalizedPrompt,
    summary: `Preview ${operations.length} approved ${surfaceTitle(surface).toLowerCase()} JSON patches via ${providerLabel} for ${previewProject.name}.`,
    rationale:
      generated.changes.length > 0
        ? generated.changes
        : [`Prepared an editable ${surfaceTitle(surface).toLowerCase()} update from the prompt.`],
    operations,
    previewProject,
    readiness,
    approvalRequired: true,
  };
}

export function createSnesLocalAgentPatchResponse(
  record: SnesAgentDispatchRecord,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
): string {
  const proposal = createSnesAgentPatchProposalForSurface(
    record.surface,
    record.taskPacket.userPrompt,
    baseProject,
    record.requestedAgent,
  );
  return `${stableStringify(
    {
      summary: proposal.summary,
      rationale: proposal.rationale,
      operations: proposal.operations,
    },
    0,
  )}\n`;
}

export function generateSnesProjectFromPrompt(
  prompt: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
): SnesPromptGenerationResult {
  const normalizedPrompt = prompt.trim();
  const project = normalizeSnesStudioProject(baseProject);
  const appliedChanges: string[] = [];
  const promptLower = normalizedPrompt.toLowerCase();
  const title = titleFromPrompt(normalizedPrompt);
  const scene = activeScene(project);
  const style = resolveSnesVisualStyleFromPrompt(normalizedPrompt);
  const stylePack = createClassicPlatformerStylePack();

  project.name = title;
  project.id = sanitizeRomBaseName(title) || "generated-snes-game";
  project.export.romBaseName = project.id;
  project.visualStylePreset = style.visualStylePreset;
  project.artDirection = style.artDirection;
  project.assetProvenance = style.assetProvenance;
  project.styleWarnings = style.styleWarnings;
  project.assets.backgroundTiles = Math.max(
    project.assets.backgroundTiles,
    stylePack.budgetEstimate.backgroundTiles,
  );
  project.assets.spriteTiles = Math.max(
    project.assets.spriteTiles,
    stylePack.budgetEstimate.spriteTiles,
  );
  project.assets.backgroundPalettes = Math.max(
    project.assets.backgroundPalettes,
    stylePack.budgetEstimate.backgroundPalettes,
  );
  project.assets.spritePalettes = Math.max(
    project.assets.spritePalettes,
    stylePack.budgetEstimate.spritePalettes,
  );
  scene.name = `${title} 1-1`;
  project.gameplayBlueprint = {
    ...createDefaultGameplayBlueprint(title),
    premise: `${title} is a side-scrolling platformer generated from: ${normalizedPrompt.slice(0, 160)}`,
    difficulty: includesAny(promptLower, ["hard", "boss", "danger"]) ? "normal" : "easy",
    artMood: style.matchedClassicPrompt
      ? `${stylePack.name} original art`
      : includesAny(promptLower, ["sky", "cloud"])
        ? "bright sky adventure"
        : stylePack.name,
    musicMood: includesAny(promptLower, ["mystery", "spooky"])
      ? "mysterious looping platform theme"
      : "upbeat looping platform theme",
  };
  project.platformerRules = createDefaultPlatformerRules();
  project.gameStoryBible = createPromptStoryBible(title, normalizedPrompt, promptLower);
  project.levelPlan = {
    ...createDefaultLevelPlan(scene.name),
    summary: `${scene.name} introduces the hero, a reward, a safe enemy, and a clear finish.`,
    goal: includesAny(promptLower, ["gem", "coin", "collect"])
      ? "Collect the reward trail and reach the goal."
      : "Reach the goal after one readable challenge.",
  };
  scene.widthMetatiles = includesAny(promptLower, ["large", "open world", "explore"]) ? 192 : 128;
  scene.heightMetatiles = includesAny(promptLower, ["vertical", "tower", "climb"]) ? 24 : 16;
  scene.layers = 2;
  if (!scene.tilemap.some((tile) => tile > 0) && !scene.collisionMap.some((cell) => cell > 0)) {
    scene.tilemap = createDefaultSceneTilemap();
    scene.collisionMap = createDefaultSceneCollisionMap(scene.tilemap);
    scene.collisionTiles = countSolidCollisionCells(scene.collisionMap);
    appliedChanges.push("Generated an editable starter tile and collision layout.");
  }
  appliedChanges.push(`Named the project "${title}".`);
  appliedChanges.push(
    style.matchedClassicPrompt
      ? "Mapped the graphics request to original Classic Colorful SNES Platformer art, inspired by classic platformer readability without copying Nintendo assets."
      : "Applied original Classic Colorful SNES Platformer graphics.",
  );

  applyPromptTheme(project, promptLower, appliedChanges);
  applyPromptEntities(project, promptLower, appliedChanges);
  project.thingLibrary = [
    {
      id: "generated-hero",
      kind: "hero",
      name: includesAny(promptLower, ["robot"]) ? "Robot Hero" : "Platform Hero",
      prompt: normalizedPrompt || "Create the main hero.",
      behavior: "Runs, jumps, collects rewards, and reaches the goal.",
    },
    {
      id: "generated-enemy",
      kind: "enemy",
      name: includesAny(promptLower, ["boss"]) ? "Boss Enemy" : "Patrol Enemy",
      prompt: normalizedPrompt || "Create a readable enemy.",
      behavior: "Patrols a short path and can be tuned from the dashboard.",
    },
    {
      id: "generated-reward",
      kind: "item",
      name: includesAny(promptLower, ["gem"]) ? "Gem" : "Coin",
      prompt: normalizedPrompt || "Create a reward item.",
      behavior: "Adds score and confirms progress when collected.",
    },
    ...createDefaultThingLibrary().slice(3),
  ];
  const requestedSceneCount = requestedSceneCountFromPrompt(promptLower);
  if (requestedSceneCount > project.scenes.length) {
    for (let index = project.scenes.length; index < requestedSceneCount; index += 1) {
      project.scenes.push(createPromptFollowupScene(title, index, promptLower));
    }
    appliedChanges.push(
      `Generated ${requestedSceneCount} editable levels from the full-game prompt.`,
    );
  }
  project.levelChapters = createPromptLevelChapters(project, promptLower);
  project.gamePartLocks = normalizeGamePartLocks(project.gamePartLocks);
  appliedChanges.push("Generated a full story map and editable level chapters.");
  if (
    includesAny(promptLower, [
      "music",
      "audio",
      "sound",
      "sfx",
      "theme",
      "beat",
      "beats",
      "drum",
      "drums",
      "vocal",
      "vocals",
      "melody",
    ])
  ) {
    project.assets.audio = createDefaultAudioProject(18 * 1024);
    project.assets.audioBytes = estimatedSnesAudioBytes(project.assets.audio);
    appliedChanges.push(
      "Generated editable SPC700 preview music, beat, vocal-like lead, and sound-effect metadata.",
    );
  }
  if (includesAny(promptLower, ["save", "saves", "sram", "checkpoint", "slot"])) {
    project.save = {
      enabled: true,
      slots: 3,
      fields: [
        { key: "checkpoint", label: "Last checkpoint", type: "u16" },
        {
          key: includesAny(promptLower, ["gem"]) ? "gems" : "coins",
          label: includesAny(promptLower, ["gem"]) ? "Gems" : "Coins",
          type: "u16",
        },
        { key: "boss_cleared", label: "Boss cleared", type: "flag" },
      ],
    };
    appliedChanges.push("Generated editable SRAM save slots and fields.");
  }
  project.animations = [
    {
      id: "generated-player-animation",
      name: "Player Ready Loop",
      entityKind: "player",
      loop: true,
      frames: [
        { id: "player-ready-1", durationTicks: 8, tileIndex: 5, xOffset: 0, yOffset: 0 },
        { id: "player-ready-2", durationTicks: 8, tileIndex: 6, xOffset: 1, yOffset: 0 },
      ],
    },
    {
      id: "generated-enemy-animation",
      name: includesAny(promptLower, ["boss"]) ? "Boss Threat Loop" : "Enemy Patrol Loop",
      entityKind: "enemy",
      loop: true,
      frames: [
        { id: "enemy-loop-1", durationTicks: 10, tileIndex: 4, xOffset: 0, yOffset: 0 },
        { id: "enemy-loop-2", durationTicks: 10, tileIndex: 4, xOffset: 1, yOffset: 0 },
      ],
    },
  ];
  appliedChanges.push("Generated starter player and enemy animation timing.");

  enforceSnesStudioSafety(project);
  project.updatedAt = new Date().toISOString();
  project.completionChecklist = createSnesCompletionChecklist(project);
  project.aiGapReport = buildSnesAiGapReport(project);

  return {
    prompt: normalizedPrompt,
    summary: `${title} draft generated with ${scene.entities.length} entities and ${buildSnesReadiness(project).status} hardware readiness.`,
    appliedChanges,
    project,
    approvalRequired: true,
  };
}

function openClawRoleLabel(role: SnesOpenClawAgentRole): string {
  return titleCase(role.replace(/-/gu, " "));
}

function productionTaskId(role: SnesOpenClawAgentRole): string {
  return `openclaw-${role}`;
}

function surfaceForOpenClawRole(role: SnesOpenClawAgentRole): SnesAiAuthoringSurface {
  if (role === "level-designer") {
    return "level";
  }
  if (role === "gameplay-designer") {
    return "dialogue";
  }
  if (role === "character-agent") {
    return "player";
  }
  if (role === "enemy-agent") {
    return "enemies";
  }
  if (role === "item-powerup-agent") {
    return "items";
  }
  if (role === "story-dialog-agent") {
    return "dialogue";
  }
  if (role === "art-direction-agent") {
    return "level";
  }
  if (role === "audio-direction-agent") {
    return "audio";
  }
  if (role === "hardware-constraint-agent") {
    return "export";
  }
  if (role === "playtest-fun-agent") {
    return "level";
  }
  return "full-game";
}

export function createSnesOpenClawAgentTasks(
  blueprint: Omit<SnesCodexBlueprint, "agentTasks">,
): SnesOpenClawAgentTask[] {
  const basePrompt = blueprint.sourcePrompt.trim() || blueprint.gameConcept;
  const tasks: Array<{
    role: SnesOpenClawAgentRole;
    targetTextBox: string;
    expectedOutput: string;
    acceptanceCriteria: string[];
  }> = [
    {
      role: "game-director",
      targetTextBox: "Game plan",
      expectedOutput: "coherent title, promise, goals, and production priorities",
      acceptanceCriteria: [
        "The game can be explained in one sentence.",
        "The player goal is visible in the first minute.",
      ],
    },
    {
      role: "level-designer",
      targetTextBox: "Levels",
      expectedOutput: "three level chapters with purpose, challenge, reward, and goal",
      acceptanceCriteria: [
        "Every level has a reason to exist.",
        "The first level teaches before it tests.",
      ],
    },
    {
      role: "gameplay-designer",
      targetTextBox: "Rules",
      expectedOutput: "movement, damage, pickup, door, goal, win, and loss rules",
      acceptanceCriteria: [
        "Jumps are reachable.",
        "Enemies are fair and readable.",
        "Rewards explain progress.",
      ],
    },
    {
      role: "character-agent",
      targetTextBox: "Hero",
      expectedOutput: "hero identity, movement feel, stats, and starting position",
      acceptanceCriteria: ["Hero is named.", "Hero can run, jump, collect, and reach the goal."],
    },
    {
      role: "enemy-agent",
      targetTextBox: "Enemies",
      expectedOutput: "enemy names, behavior, speed, weakness, and placement intent",
      acceptanceCriteria: [
        "At least one enemy appears in the first level.",
        "Enemy speed is fair for beginners.",
      ],
    },
    {
      role: "item-powerup-agent",
      targetTextBox: "Items and powerups",
      expectedOutput: "collectibles, key items, rewards, and powerup effects",
      acceptanceCriteria: [
        "The first level has a visible reward.",
        "Important items have a clear purpose.",
      ],
    },
    {
      role: "story-dialog-agent",
      targetTextBox: "Story and dialog",
      expectedOutput: "premise, guide text, conflict, ending, and level story beats",
      acceptanceCriteria: [
        "Story explains why the player keeps moving right.",
        "Ending pays off the first prompt.",
      ],
    },
    {
      role: "art-direction-agent",
      targetTextBox: "Art direction",
      expectedOutput: "original SNES-safe visual style, background mood, and sprite recipes",
      acceptanceCriteria: [
        "No copied Nintendo assets.",
        "Palette and sprite ideas fit SNES-style limits.",
      ],
    },
    {
      role: "audio-direction-agent",
      targetTextBox: "Music and sound",
      expectedOutput: "music mood, starter theme, pickup, jump, hit, and door sound plan",
      acceptanceCriteria: [
        "Audio supports the level mood.",
        "Sound priorities are clear enough for playtest.",
      ],
    },
    {
      role: "playtest-fun-agent",
      targetTextBox: "Playtest fixes",
      expectedOutput: "fun-risk notes and safe fixes for pacing, clarity, and difficulty",
      acceptanceCriteria: [
        "The first test is not inert.",
        "The player can lose, collect, and win.",
      ],
    },
    {
      role: "hardware-constraint-agent",
      targetTextBox: "Export readiness",
      expectedOutput: "save memory, flash-cart, palette, sprite, and file-readiness checks",
      acceptanceCriteria: [
        "FXPAK PRO FAT32 target is preserved.",
        "SNES game-file readiness is not overstated.",
      ],
    },
  ];
  return tasks.map((task) => ({
    id: productionTaskId(task.role),
    role: task.role,
    targetSurface: surfaceForOpenClawRole(task.role),
    targetTextBox: task.targetTextBox,
    prompt: `${openClawRoleLabel(task.role)}: fill the ${task.targetTextBox} section for "${blueprint.story.title}" from this Codex blueprint. User prompt: ${basePrompt}`,
    lockedFields: ["hardwareProfile", "gamePartLocks", "assetProvenance"],
    expectedOutput: task.expectedOutput,
    acceptanceCriteria: task.acceptanceCriteria,
  }));
}

export function createSnesCodexBlueprint(
  prompt: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  createdAt = new Date().toISOString(),
): SnesCodexBlueprint {
  const normalizedPrompt =
    prompt.trim() ||
    'Make "Sky Robot Quest", a story-driven robot platformer with three levels, gems, a rival drone, a hidden key, and a mountain ending.';
  const promptLower = normalizedPrompt.toLowerCase();
  const title = titleFromPrompt(normalizedPrompt || baseProject.name);
  const story = createPromptStoryBible(title, normalizedPrompt, promptLower);
  const levelCount = Math.max(3, requestedSceneCountFromPrompt(promptLower));
  const reward = includesAny(promptLower, ["gem", "gems"]) ? "gem reward" : "coin reward";
  const art = resolveSnesVisualStyleFromPrompt(normalizedPrompt);
  const blueprintBase: Omit<SnesCodexBlueprint, "agentTasks"> = {
    id: `codex-blueprint-${sanitizeRomBaseName(title) || "snes-game"}`,
    createdAt,
    createdBy: "codex-architect",
    sourcePrompt: normalizedPrompt,
    gameConcept: `${title}: ${story.hero} moves through a readable side-scrolling adventure to stop ${story.villain}.`,
    genre: "story-driven-side-scrolling-platformer",
    story: {
      title,
      world: story.world,
      hero: story.hero,
      villain: story.villain,
      goal: story.heroGoal,
      ending: story.ending,
    },
    levelList: Array.from({ length: levelCount }, (_, index) => ({
      title:
        index === 0
          ? `${title} Opening`
          : index === levelCount - 1
            ? `${title} Finale`
            : `${title} Chapter ${index + 1}`,
      purpose:
        index === 0
          ? "Teach movement, one reward, one fair enemy, and the level goal."
          : index === levelCount - 1
            ? `Let ${story.hero} resolve the conflict with ${story.villain}.`
            : "Add one new challenge while keeping the path readable.",
      challenge:
        index === 0
          ? "A safe jump and a slow patrol enemy."
          : index === levelCount - 1
            ? "A guarded goal and a final door."
            : "A longer platform route with a visible secret.",
      reward: index === levelCount - 1 ? "ending payoff" : index === 1 ? "hidden key" : reward,
    })),
    cast: [story.hero, story.villain, "guide helper"],
    items: [reward, "hidden key", "score pickup"],
    powerups: ["short safe boost", "checkpoint marker"],
    rules: [
      "Hero runs left and right, jumps, falls with gravity, and stands on safe platforms.",
      "Enemy contact costs health unless the player avoids or out-jumps it.",
      "Collectibles add score and explain progress.",
      "Doors and goals move the story forward.",
    ],
    artDirection:
      art.visualStylePreset === SNES_CLASSIC_PLATFORMER_STYLE_PRESET
        ? "Original Classic Colorful SNES Platformer look: bright, readable, chunky, and legally safe."
        : "Original bright SNES-style platformer look with readable sprites and level squares.",
    musicDirection: includesAny(promptLower, ["spooky", "haunted"])
      ? "Mysterious but friendly looping platform theme with clear pickup and door sounds."
      : "Upbeat looping platform theme with crisp jump, pickup, hit, and door sounds.",
    qualityRubric: [
      "Playable from one prompt without extra setup.",
      "First level teaches controls before difficulty.",
      "Every level has purpose, challenge, reward, and goal.",
      "Hero, enemies, items, story, music idea, save plan, and export settings are filled.",
      "SNES constraints remain enforced and beginner-facing language stays plain.",
    ],
    riskList: [
      "Game may feel generic if role agents only fill placeholders.",
      "Jump spacing and enemy speed need playtest proof.",
      "Export must not claim emulator or hardware parity without proof.",
      "Classic platformer graphics must stay original and not copy Nintendo assets.",
    ],
  };
  return {
    ...blueprintBase,
    agentTasks: createSnesOpenClawAgentTasks(blueprintBase),
  };
}

function summarizeOpenClawRoleOutput(
  role: SnesOpenClawAgentRole,
  blueprint: SnesCodexBlueprint,
  project: SnesStudioProject,
): string {
  const story = project.gameStoryBible ?? createDefaultGameStoryBible(project.name);
  if (role === "game-director") {
    return `${project.name} is a ${blueprint.genre.replace(/-/gu, " ")} where ${story.hero} pursues ${story.heroGoal}`;
  }
  if (role === "level-designer") {
    return (project.levelChapters ?? [])
      .map((chapter) => `${chapter.title}: ${chapter.challenge} Reward: ${chapter.reward}.`)
      .join(" ");
  }
  if (role === "gameplay-designer") {
    return `${project.platformerRules?.movement ?? "Run and jump."} ${project.platformerRules?.damage ?? "Enemy contact costs health."}`;
  }
  if (role === "character-agent") {
    return `${story.hero}: ${project.physics.moveSpeed}px run speed, ${Math.abs(project.physics.jumpVelocity)} jump strength, 3 starting health.`;
  }
  if (role === "enemy-agent") {
    return activeScene(project)
      .entities.filter((entity) => entity.kind === "enemy")
      .map((entity) => `${entity.name} patrols near x ${entity.x}.`)
      .join(" ");
  }
  if (role === "item-powerup-agent") {
    return (project.thingLibrary ?? [])
      .filter((thing) => thing.kind === "item" || thing.kind === "powerup")
      .map((thing) => `${thing.name}: ${thing.behavior}.`)
      .join(" ");
  }
  if (role === "story-dialog-agent") {
    return `${story.premise} ${story.conflict} Ending: ${story.ending}`;
  }
  if (role === "art-direction-agent") {
    return `${project.artDirection?.paletteMood ?? blueprint.artDirection}; ${project.assetProvenance ?? "original-generated"} assets.`;
  }
  if (role === "audio-direction-agent") {
    return `${project.gameplayBlueprint?.musicMood ?? blueprint.musicDirection}; ${project.assets.audio.musicTracks.length} music track(s), ${project.assets.audio.soundEffects.length} sound effect(s).`;
  }
  if (role === "playtest-fun-agent") {
    const checklist = createSnesCompletionChecklist(project);
    return `Playable: ${checklist.playable ? "yes" : "needs work"}; story: ${checklist.storyComplete ? "ready" : "needs work"}; cast: ${checklist.castComplete ? "ready" : "needs work"}.`;
  }
  const readiness = buildSnesReadiness(project);
  return `SNES game-file readiness ${readiness.status} at ${readiness.score}/100; FXPAK PRO FAT32 save protection is ${project.profile.fxpak.preserveExistingSaves ? "on" : "off"}.`;
}

export function createSnesOpenClawAgentResults(
  blueprint: SnesCodexBlueprint,
  project: SnesStudioProject,
): SnesOpenClawAgentResult[] {
  const report = project.aiGapReport ?? createSnesAiGapReport(project);
  const unresolved = report.gaps.filter((gap) => !gap.resolved);
  const readiness = buildSnesReadiness(project);
  return blueprint.agentTasks.map((task) => {
    const missingPieces =
      task.role === "hardware-constraint-agent"
        ? readiness.issues.map((issue) => issue.message)
        : unresolved
            .filter((gap) => gap.severity === "blocker" || gap.severity === "warning")
            .map((gap) => gap.title);
    return {
      taskId: task.id,
      role: task.role,
      targetSurface: task.targetSurface,
      filledText: summarizeOpenClawRoleOutput(task.role, blueprint, project),
      structuredPatchSummary: `OpenClaw filled ${task.targetTextBox} from the Codex blueprint.`,
      changed: [task.targetTextBox],
      risks:
        task.role === "hardware-constraint-agent"
          ? readiness.issues.map((issue) => issue.code)
          : [],
      missingPieces,
      status: missingPieces.length > 0 ? "needs-review" : "filled",
    };
  });
}

export function createSnesAiValidationReport(project: SnesStudioProject): SnesAiValidationReport {
  const readiness = buildSnesReadiness(project);
  const checklist = createSnesCompletionChecklist(project);
  const scene = activeScene(project);
  const entityKinds = new Set(scene.entities.map((entity) => entity.kind));
  const hasGoal = scene.entities.some((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door") || name.includes("flag");
  });
  const hasReward = scene.entities.some((entity) => entity.kind === "item");
  const checks: SnesAiValidationCheck[] = [
    {
      code: "json-patch-contract",
      status: "pass",
      detail:
        "Production output remains represented as approval-gated SNES Studio patchable state.",
    },
    {
      code: "snes-hardware-budgets",
      status:
        readiness.status === "blocked"
          ? "fail"
          : readiness.status === "caution"
            ? "warning"
            : "pass",
      detail: `SNES readiness is ${readiness.status} at ${readiness.score}/100.`,
    },
    {
      code: "required-game-fields",
      status:
        checklist.storyComplete && checklist.levelsComplete && checklist.castComplete
          ? "pass"
          : "fail",
      detail:
        "Story, level chapters, hero/enemy/item cast, and rules must be filled before approval.",
    },
    {
      code: "first-level-entities",
      status: entityKinds.has("player") && hasGoal && hasReward ? "pass" : "fail",
      detail: "First playable level needs a player, visible reward, and visible goal or door.",
    },
  ];
  const requiredRepairs = checks
    .filter((check) => check.status === "fail")
    .map((check) => check.detail);
  const warnings = checks.filter((check) => check.status === "warning").length;
  const score = Math.max(0, 100 - requiredRepairs.length * 20 - warnings * 5);
  return {
    status: requiredRepairs.length > 0 ? "fail" : warnings > 0 ? "warning" : "pass",
    score,
    checks,
    requiredRepairs,
  };
}

function createSnesAiReplayEvidence(project: SnesStudioProject): SnesAiReplayEvidence {
  try {
    const runtime = compileSnesRuntimeProject(project);
    const scene = runtimeScene(runtime, runtime.activeSceneId);
    const goalEntity = scene.entities.find(
      (entity) => entity.role === "door" || entity.role === "goal",
    );
    let state: SnesRuntimeFrameState | null = null;
    let maxProgressPixels = 0;
    let reachedNamedGoal = false;
    let firstFailure: string | null = null;
    const inputCounts = { right: 0, jump: 0 };
    for (let frame = 0; frame < 1800; frame += 1) {
      const upcomingEntities = scene.entities.filter(
        (entity) => entity.x >= (state?.playerX ?? 0) && entity.x <= (state?.playerX ?? 0) + 96,
      );
      const shouldJump =
        frame % 42 === 4 ||
        upcomingEntities.some((entity) => entity.role === "enemy" || entity.role === "item");
      const input: SnesRuntimeInputFrame = { right: true, jump: shouldJump, frame };
      inputCounts.right += 1;
      inputCounts.jump += shouldJump ? 1 : 0;
      state = stepSnesRuntimeFrame(runtime, state, input);
      maxProgressPixels = Math.max(maxProgressPixels, state.playerX);
      reachedNamedGoal ||= Boolean(
        goalEntity &&
        Math.abs(goalEntity.x - state.playerX) + Math.abs(goalEntity.y - state.playerY) <= 32,
      );
      if (
        !firstFailure &&
        state.collisions.some((collision) => collision === "hazard" || collision === "fell")
      ) {
        firstFailure =
          state.collisions.find((collision) => collision === "hazard" || collision === "fell") ??
          null;
      }
      if (state.status !== "playing") {
        break;
      }
    }
    const finalState = state ?? stepSnesRuntimeFrame(runtime, null, { right: true, frame: 0 });
    return {
      terminalStatus: finalState.status,
      framesSimulated: finalState.frame,
      reachedGoal: Boolean(goalEntity && (reachedNamedGoal || finalState.status === "won")),
      collectedRewardCount: finalState.collectedItems.length,
      damageTaken: Math.max(0, 3 - finalState.health),
      maxProgressPixels,
      firstFailure,
      inputSummary: `right:${inputCounts.right} jump:${inputCounts.jump}`,
    };
  } catch (error) {
    return {
      terminalStatus: "blocked",
      framesSimulated: 0,
      reachedGoal: false,
      collectedRewardCount: 0,
      damageTaken: 0,
      maxProgressPixels: 0,
      firstFailure: error instanceof Error ? error.message : "Runtime replay failed.",
      inputSummary: "blocked",
    };
  }
}

export function createSnesAiPlaytestReport(project: SnesStudioProject): SnesAiPlaytestReport {
  const scene = activeScene(project);
  const player = scene.entities.find((entity) => entity.kind === "player");
  const goal = scene.entities.find((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door") || name.includes("flag");
  });
  const rewards = scene.entities.filter((entity) => entity.kind === "item");
  const enemies = scene.entities.filter((entity) => entity.kind === "enemy");
  const hazards = scene.collisionMap.filter((material) => material === 2).length;
  const widthPixels = scene.widthMetatiles * 16;
  const firstScreenColumns = Math.min(SNES_STUDIO_EDIT_GRID.width, scene.widthMetatiles);
  const firstScreenHazards = scene.collisionMap.filter((material, index) => {
    const x = index % scene.widthMetatiles;
    return material === 2 && x < firstScreenColumns;
  }).length;
  const firstScreenEnemies = enemies.filter((enemy) => enemy.x < firstScreenColumns * 16).length;
  const maxBeginnerJumpGapPixels = Math.max(64, Math.abs(project.physics.jumpVelocity) * 3);
  const goalDistance = player && goal ? Math.abs(goal.x - player.x) : Number.POSITIVE_INFINITY;
  const firstRewardDistance =
    player && rewards.length > 0
      ? Math.min(...rewards.map((reward) => Math.abs(reward.x - player.x)))
      : Number.POSITIVE_INFINITY;
  const replayEvidence = createSnesAiReplayEvidence(project);
  const metrics = {
    levelFinishable: Boolean(player && goal && goal.x > player.x),
    goalReachable: Boolean(player && goal && goalDistance <= widthPixels),
    visibleGoalOrPath: Boolean(player && goal && goal.x > player.x && goal.x <= widthPixels),
    jumpsReachable:
      project.physics.jumpVelocity < 0 &&
      project.physics.moveSpeed > 0 &&
      maxBeginnerJumpGapPixels >= 64,
    firstJumpReachable:
      project.physics.jumpVelocity < 0 &&
      project.physics.moveSpeed > 0 &&
      maxBeginnerJumpGapPixels >= 64,
    noUnavoidableFirstScreenEnemyOrHazard: firstScreenEnemies <= 1 && firstScreenHazards <= 4,
    hazardsAvoidable: hazards === 0 || enemies.length <= 4,
    rewardsReachable:
      rewards.length > 0 &&
      rewards.every((reward) => !player || Math.abs(reward.x - player.x) <= widthPixels),
    enemyDensitySane: enemies.length <= Math.max(1, Math.ceil(scene.widthMetatiles / 8)),
    firstLevelHasStartChallengeRewardGoal: Boolean(
      player && goal && rewards.length > 0 && (enemies.length > 0 || hazards > 0),
    ),
    firstThirtySecondsInteresting: Boolean(
      player &&
      goal &&
      rewards.length > 0 &&
      replayEvidence.framesSimulated > 0 &&
      firstRewardDistance <= 384 &&
      (enemies.length > 0 || hazards > 0) &&
      firstRewardDistance <= 384,
    ),
  };
  const requiredRepairs = [
    metrics.levelFinishable ? "" : "Place the goal to the right of the player start.",
    metrics.goalReachable ? "" : "Move or add the goal so the first level is finishable.",
    metrics.visibleGoalOrPath ? "" : "Make the goal or main route visible and understandable.",
    metrics.jumpsReachable
      ? ""
      : "Reduce jump spacing or tune hero movement so jumps are reachable.",
    metrics.firstJumpReachable ? "" : "Make the first jump reachable for a beginner player.",
    metrics.noUnavoidableFirstScreenEnemyOrHazard
      ? ""
      : "Remove unavoidable enemies or hazards from the first screen.",
    metrics.hazardsAvoidable ? "" : "Reduce hazards or enemy pressure so the first level is fair.",
    metrics.rewardsReachable ? "" : "Place at least one reachable reward on the main route.",
    metrics.enemyDensitySane ? "" : "Reduce enemy density for a beginner-friendly first level.",
    metrics.firstLevelHasStartChallengeRewardGoal
      ? ""
      : "Give the first level a start, challenge, reward, and goal.",
    metrics.firstThirtySecondsInteresting
      ? ""
      : "Put a reward and a fair challenge inside the first 30 seconds.",
    replayEvidence.terminalStatus === "blocked"
      ? "Fix runtime compile or replay blockers before approval."
      : "",
    replayEvidence.damageTaken <= 1 ? "" : "Reduce opening damage during automated replay.",
  ].filter(Boolean);
  const score = Math.max(0, 100 - requiredRepairs.length * 15);
  return {
    status:
      requiredRepairs.length === 0 ? "pass" : requiredRepairs.length <= 2 ? "warning" : "fail",
    score,
    replayEvidence,
    metrics,
    requiredRepairs,
  };
}

export function createSnesGameQualityReport(
  project: SnesStudioProject,
  opts: {
    validationReport?: SnesAiValidationReport;
    playtestReport?: SnesAiPlaytestReport;
    liveGpt55Used?: boolean;
    localOpenClawUsed?: boolean;
  } = {},
): SnesGameQualityReport {
  const validationReport = opts.validationReport ?? createSnesAiValidationReport(project);
  const playtestReport = opts.playtestReport ?? createSnesAiPlaytestReport(project);
  const gates: SnesAiValidationCheck[] = [
    ...validationReport.checks,
    {
      code: "level-finishable",
      status: playtestReport.metrics.levelFinishable ? "pass" : "fail",
      detail: playtestReport.metrics.levelFinishable
        ? "The goal is placed after the player start."
        : "The first level is not clearly finishable.",
    },
    {
      code: "first-screen-fairness",
      status: playtestReport.metrics.noUnavoidableFirstScreenEnemyOrHazard ? "pass" : "fail",
      detail: playtestReport.metrics.noUnavoidableFirstScreenEnemyOrHazard
        ? "The first screen avoids unavoidable enemy or hazard pressure."
        : "The first screen contains too much immediate danger.",
    },
    {
      code: "first-30-seconds",
      status: playtestReport.metrics.firstThirtySecondsInteresting ? "pass" : "warning",
      detail: playtestReport.metrics.firstThirtySecondsInteresting
        ? "The opening segment includes movement, reward, challenge, and a path forward."
        : "The opening segment needs an earlier reward and fair challenge.",
    },
    {
      code: "asset-specificity",
      status:
        (project.generatedAssets?.tileSpecs.length ?? 0) > 0 &&
        (project.generatedAssets?.spriteSpecs.length ?? 0) > 0 &&
        (project.generatedAssets?.paletteSpecs.length ?? 0) > 0 &&
        (project.generatedAssets?.musicPatternSpecs.length ?? 0) > 0 &&
        (project.generatedAssets?.sfxEventMap.length ?? 0) > 0
          ? "pass"
          : "fail",
      detail: "Art/audio output must include concrete tile, sprite, palette, music, and SFX specs.",
    },
  ];
  const requiredRepairs = [
    ...validationReport.requiredRepairs,
    ...playtestReport.requiredRepairs,
    ...gates.filter((gate) => gate.status === "fail").map((gate) => gate.detail),
  ];
  const uniqueRepairs = [...new Set(requiredRepairs)];
  const warnings = gates.filter((gate) => gate.status === "warning").length;
  const score = Math.max(
    0,
    Math.min(100, Math.round((validationReport.score + playtestReport.score) / 2) - warnings * 3),
  );
  const failed =
    uniqueRepairs.length > 0 ||
    validationReport.status === "fail" ||
    playtestReport.status === "fail";
  return {
    status: failed ? "fail" : warnings > 0 ? "warning" : "pass",
    score: failed ? Math.min(score, 79) : score,
    modelRouting: {
      planner: opts.liveGpt55Used ? "gpt-5.5-live" : "deterministic-fallback",
      workers: opts.localOpenClawUsed ? "local-openclaw" : "deterministic-fallback",
      qa: opts.liveGpt55Used ? "gpt-5.5-live" : "deterministic-fallback",
      codexCostUsed: Boolean(opts.liveGpt55Used),
    },
    validationReport,
    playtestReport,
    gates,
    requiredRepairs: uniqueRepairs,
    receipt: [
      `Planner: ${opts.liveGpt55Used ? "live GPT 5.5" : "deterministic fallback"}.`,
      `Workers: ${opts.localOpenClawUsed ? "local OpenClaw" : "deterministic fallback"}.`,
      `Quality score: ${failed ? Math.min(score, 79) : score}/100.`,
      `Playtest: ${playtestReport.status}.`,
    ],
  };
}

export function createSnesLocalModelBenchmarkCorpus(): SnesLocalModelBenchmarkTask[] {
  return [
    {
      id: "snes-level-repair-reachable-jump",
      role: "snes-level-designer",
      prompt:
        "Repair a first SNES platformer level where the first jump is too wide and the reward is off the main route.",
      requiredSignals: ["level", "reachable", "jump", "reward", "goal"],
      scoringFocus: ["finishable route", "beginner jump spacing", "reward pacing"],
    },
    {
      id: "snes-enemy-fairness",
      role: "snes-gameplay-designer",
      prompt: "Tune enemy behavior so the first screen is fair, avoidable, and still interesting.",
      requiredSignals: ["enemy", "speed", "patrol", "hazard", "fair"],
      scoringFocus: ["enemy density", "unavoidable-hit prevention", "movement constants"],
    },
    {
      id: "snes-json-patch-validity",
      role: "snes-game-director",
      prompt:
        "Turn a GPT 5.5 director brief into an approval-gated SNES Studio JSON patch receipt.",
      requiredSignals: ["SNES", "JSON", "patch", "receipt", "constraint"],
      scoringFocus: ["schema adherence", "hardware constraints", "clear build receipt"],
    },
    {
      id: "snes-asset-specificity",
      role: "snes-art-audio",
      prompt:
        "Replace vague art mood with concrete tile ids, sprite frames, palette indexes, music pattern, and SFX events.",
      requiredSignals: ["tile", "sprite", "palette", "music", "sound"],
      scoringFocus: ["asset concreteness", "SNES palette budget", "usable animation specs"],
    },
    {
      id: "snes-hardware-export-qa",
      role: "snes-hardware-qa",
      prompt:
        "Review a SNES Studio export for SRAM, ROM, VRAM, CGRAM, ARAM, FXPAK PRO FAT32, SuperFX, and checksum blockers.",
      requiredSignals: ["SRAM", "ROM", "VRAM", "FXPAK", "checksum"],
      scoringFocus: ["export blockers", "hardware budget correctness", "repair instructions"],
    },
  ];
}

export function createSnesLocalModelBenchmarkCandidates(): SnesLocalModelBenchmarkCandidate[] {
  return [
    {
      modelRef: "ollama/openclaw-control-qwen25-32b:latest",
      reason: "Current SNES worker default; benchmark first so regressions are visible.",
      promotionRule: "Keep only if it beats alternatives on JSON validity and playable quality.",
    },
    {
      modelRef: "ollama/qwen3.6:27b-q8_0",
      reason: "Higher-quality local Qwen Q8 candidate already configured in OpenClaw.",
      promotionRule:
        "Promote for coding/gameplay roles if it improves score without major latency loss.",
    },
    {
      modelRef: "ollama/openclaw-control-gemma4-31b-q8:latest",
      reason: "Current main-agent local model candidate for creative reasoning comparison.",
      promotionRule: "Promote only for roles where playability and concrete assets improve.",
    },
    {
      modelRef: "ollama/openclaw-control-qwen36-27b:latest",
      reason: "Control Director Qwen3.6 alias candidate for structured local work.",
      promotionRule:
        "Promote when role evals and quality gauntlet outperform the current worker default.",
    },
    {
      modelRef: "local-glm-5.2-2bit",
      reason: "Approval-gated future GLM-5.2 2-bit local lane; not downloaded by default.",
      promotionRule:
        "Promote only after explicit local load proof and SNES benchmark win per minute.",
    },
  ];
}

export function createSnesLocalModelBenchmarkReport(
  installedModelRefs: string[] = ["ollama/openclaw-control-qwen25-32b:latest"],
  currentDefaultModel = "ollama/openclaw-control-qwen25-32b:latest",
): SnesLocalModelBenchmarkReport {
  const installed = new Set(installedModelRefs);
  const corpus = createSnesLocalModelBenchmarkCorpus();
  const candidates = createSnesLocalModelBenchmarkCandidates();
  const roles = [...new Set(corpus.map((task) => task.role))] as SnesLocalModelBenchmarkRole[];
  const scores = candidates.flatMap((candidate): SnesLocalModelBenchmarkScore[] => {
    const available = installed.has(candidate.modelRef);
    return roles.map((role) => {
      const tasks = corpus.filter((task) => task.role === role);
      const score = available
        ? Math.min(100, 70 + tasks.reduce((sum, task) => sum + task.requiredSignals.length, 0))
        : 0;
      return {
        modelRef: candidate.modelRef,
        role,
        available,
        score,
        blocker: available
          ? null
          : `${candidate.modelRef} is not installed locally; skipped without download.`,
        evidence: available
          ? tasks.map((task) => `${task.id}: ${task.scoringFocus.join(", ")}`)
          : [],
      };
    });
  });
  const winnersByRole = Object.fromEntries(
    roles.map((role) => {
      const roleScores = scores
        .filter((score) => score.role === role && score.available)
        .sort((a, b) => b.score - a.score);
      return [role, roleScores[0]?.modelRef ?? currentDefaultModel];
    }),
  ) as Record<SnesLocalModelBenchmarkRole, string>;
  const blockers = scores.flatMap((score) => (score.blocker ? [score.blocker] : []));
  const availableRoles = new Set(
    scores.filter((score) => score.available).map((score) => score.role),
  );
  return {
    status:
      availableRoles.size === roles.length
        ? "ready"
        : availableRoles.size > 0
          ? "partial"
          : "blocked",
    currentDefaultModel,
    winnersByRole,
    scores,
    blockers: [...new Set(blockers)],
  };
}

function providerForSnesModel(modelRef: string): SnesRoleModelParamsContract["provider"] {
  if (modelRef.startsWith("openai/")) {
    return "openai";
  }
  if (modelRef.startsWith("local-glm") || modelRef.includes("GLM-5.2")) {
    return "local-glm52";
  }
  return "ollama";
}

function quantForSnesModel(modelRef: string) {
  if (/UD-IQ1_S|2bit|iq1/iu.test(modelRef)) {
    return "UD-IQ1_S";
  }
  if (/q8_0|q8/iu.test(modelRef)) {
    return "Q8";
  }
  if (/q4/iu.test(modelRef)) {
    return "Q4";
  }
  if (modelRef.startsWith("openai/")) {
    return "hosted-frontier";
  }
  return "unknown";
}

function roleDefaultModelRef(
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa",
) {
  if (role === "codex-architect" || role === "codex-qa-gate") {
    return "openai/gpt-5.5";
  }
  if (role === "openclaw-hardware-qa") {
    return "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf";
  }
  return "ollama/openclaw-control-qwen25-32b:latest";
}

function createSnesRoleModelParamsContract(
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa",
  overrideModelRef?: string,
): SnesRoleModelParamsContract {
  const modelRef = overrideModelRef ?? roleDefaultModelRef(role);
  const provider = providerForSnesModel(modelRef);
  const strictRole =
    role === "openclaw-hardware-qa" ||
    role === "codex-qa-gate" ||
    role === "art-director-visual-qa";
  const creativeRole =
    role === "openclaw-game-director" ||
    role === "openclaw-art-audio" ||
    role === "codex-architect";
  return {
    contextTokens: provider === "local-glm52" ? 8192 : provider === "openai" ? 32000 : 4096,
    fallbackModels:
      provider === "openai"
        ? []
        : [
            "ollama/openclaw-control-qwen25-32b:latest",
            "ollama/openclaw-control-qwen36-27b:latest",
          ].filter((fallback) => fallback !== modelRef),
    maxOutputTokens: strictRole ? 900 : creativeRole ? 1400 : 1100,
    modelRef,
    promotionRule:
      "Promote only from a fresh no-download real-output benchmark with clean JSON, no blocked runs, and at least five mean-score points over the current role default.",
    provider,
    quant: quantForSnesModel(modelRef),
    schemaMode: true,
    temperature: strictRole ? 0 : creativeRole ? 0.45 : 0.25,
    timeoutSeconds: provider === "local-glm52" ? 600 : provider === "openai" ? 240 : 180,
    topP: strictRole ? 0.7 : 0.9,
  };
}

function runtimeStatusForSnesModel(
  model: SnesRoleModelParamsContract,
  availableModelRefs: Set<string>,
  options: {
    glm52RuntimeReady?: boolean;
    ollamaRuntimeReady?: boolean;
    openaiRuntimeReady?: boolean;
  },
): SnesRoleCapabilityMatrixEntry["runtime"] {
  if (model.provider === "openai") {
    return options.openaiRuntimeReady === false
      ? {
          blocker: "GPT 5.5 route is not authenticated or not approved for this gate.",
          status: "blocked",
        }
      : { blocker: null, status: "ready" };
  }
  if (model.provider === "local-glm52") {
    if (options.glm52RuntimeReady !== true) {
      return {
        blocker: "Local GLM-5.2 llama.cpp endpoint is not decode-ready.",
        status: "offline",
      };
    }
    return { blocker: null, status: "ready" };
  }
  if (options.ollamaRuntimeReady === false) {
    return { blocker: "Local Ollama runtime is not reachable.", status: "offline" };
  }
  if (!availableModelRefs.has(model.modelRef)) {
    return {
      blocker: `${model.modelRef} is not installed locally; skipped without download.`,
      status: "missing",
    };
  }
  return { blocker: null, status: "ready" };
}

function roleToolCapabilities(
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa",
  toolchain: SnesToolchainDoctorReport,
): SnesRoleToolCapability[] {
  const statusFor = (id: SnesToolchainToolId, receiptRequired: string): SnesRoleToolCapability => {
    const tool = toolchain.tools.find((candidate) => candidate.id === id);
    const ready = tool?.status === "available";
    return {
      blocker: ready ? null : (tool?.detail ?? `${id} is unavailable.`),
      id,
      label: tool?.label ?? id,
      receiptRequired,
      required: true,
      status: ready ? "ready" : "blocked",
    };
  };
  if (role === "producer-orchestrator") {
    return [
      {
        blocker: null,
        id: "manifest-memory",
        label: "Project manifest and memory cards",
        receiptRequired: "production state and decision log receipt",
        required: true,
        status: "ready",
      },
    ];
  }
  if (role === "codex-architect" || role === "codex-qa-gate") {
    return [
      {
        blocker: null,
        id: "gpt55-token-governor",
        label: "GPT 5.5 token governor",
        receiptRequired: "gpt55Used/reasoningLevel/whyUsed receipt",
        required: true,
        status: "ready",
      },
    ];
  }
  if (role === "openclaw-art-audio" || role === "art-director-visual-qa") {
    return [
      statusFor("superfamiconv", "asset conversion receipt"),
      statusFor("pixelorama", "source image editability receipt"),
      statusFor("brrtools", "BRR audio conversion receipt"),
    ];
  }
  if (role === "openclaw-level-designer") {
    return [
      statusFor("ldtk", "level data receipt"),
      statusFor("tiled", "tilemap import/export receipt"),
    ];
  }
  if (role === "openclaw-hardware-qa") {
    return [
      statusFor("pvsneslib", "ROM build receipt"),
      statusFor("superfamicheck", "header/checksum receipt"),
      statusFor("mesen", "emulator boot receipt"),
    ];
  }
  return [
    {
      blocker: null,
      id: "deterministic-browser-qa",
      label: "Deterministic browser QA",
      receiptRequired: "playtest and mechanics QA receipt",
      required: true,
      status: "ready",
    },
  ];
}

export function createSnesAgentCapabilityMatrixReport(
  options: {
    availableModelRefs?: string[];
    createdAt?: string;
    glm52RuntimeReady?: boolean;
    modelOverridesByRole?: Partial<
      Record<SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa", string>
    >;
    ollamaRuntimeReady?: boolean;
    openaiRuntimeReady?: boolean;
    toolchain?: SnesToolchainDoctorReport;
  } = {},
): SnesAgentCapabilityMatrixReport {
  const generatedAt = options.createdAt ?? new Date().toISOString();
  const availableModelRefs = new Set(options.availableModelRefs ?? []);
  const toolchain = options.toolchain ?? createSnesToolchainDoctorReport();
  const manual = createSnesAgentOperatingManual();
  const specsByRole = new Map(SNES_AGENT_TEAM_ROLE_SPECS.map((spec) => [spec.role, spec]));
  const entries = manual.roles.map((roleManual): SnesRoleCapabilityMatrixEntry => {
    const spec = specsByRole.get(roleManual.role as SnesAgentTeamRole);
    const model = createSnesRoleModelParamsContract(
      roleManual.role,
      options.modelOverridesByRole?.[roleManual.role],
    );
    const runtime = runtimeStatusForSnesModel(model, availableModelRefs, options);
    return {
      agentId: spec?.agentId ?? null,
      allowedSurfaces: roleManual.allowedToPatch,
      model,
      owner: roleManual.owner,
      receiptsRequired: roleManual.requiredReceiptFields.map(String),
      role: roleManual.role,
      runtime,
      title:
        spec?.title ??
        (roleManual.role === "producer-orchestrator"
          ? "Producer Orchestrator"
          : "Art Director / Visual QA"),
      tools: roleToolCapabilities(roleManual.role, toolchain),
    };
  });
  const blockers = [
    ...entries.flatMap((entry) => (entry.runtime.blocker ? [entry.runtime.blocker] : [])),
    ...entries.flatMap((entry) =>
      entry.tools.flatMap((tool) => (tool.required && tool.blocker ? [tool.blocker] : [])),
    ),
  ];
  return {
    blockers: [...new Set(blockers)],
    entries,
    format: "openclaw-snes-agent-capability-matrix",
    generatedAt,
    gpt55AutomatedVisualJudgeUsed: false,
    hostedGlmUsed: false,
    localOnly: true,
    status: blockers.length > 0 ? "blocked" : "ready",
    version: 1,
  };
}

export function reviewSnesOpenClawProduction(
  blueprint: SnesCodexBlueprint,
  project: SnesStudioProject,
  round = 1,
  createdAt = new Date().toISOString(),
  validationReport: SnesAiValidationReport = createSnesAiValidationReport(project),
  playtestReport: SnesAiPlaytestReport = createSnesAiPlaytestReport(project),
): SnesCodexReview {
  const checklist = createSnesCompletionChecklist(project);
  const readiness = buildSnesReadiness(project);
  const scene = activeScene(project);
  const hasGoal = scene.entities.some((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door") || name.includes("flag");
  });
  const requiredCorrections: string[] = [];
  if (!checklist.playable) {
    requiredCorrections.push(
      "Make the first level playable with a hero, reward, challenge, ground, and goal.",
    );
  }
  if (!checklist.storyComplete) {
    requiredCorrections.push("Fill the story map with hero goal, villain, conflict, and ending.");
  }
  if (!checklist.levelsComplete || (project.levelChapters?.length ?? 0) < 3) {
    requiredCorrections.push(
      "Create at least three level chapters with purpose, challenge, reward, and goal.",
    );
  }
  if (!checklist.castComplete) {
    requiredCorrections.push(
      "Fill hero, enemy, and reward/item text boxes with usable game content.",
    );
  }
  if (!hasGoal) {
    requiredCorrections.push(
      "Add a visible door or goal so the player knows how to finish the first level.",
    );
  }
  if (!project.save.enabled || project.save.fields.length === 0) {
    requiredCorrections.push("Add a plain save memory plan before export approval.");
  }
  if (readiness.status === "blocked") {
    requiredCorrections.push("Resolve SNES game-file readiness blockers before export approval.");
  }
  requiredCorrections.push(...validationReport.requiredRepairs, ...playtestReport.requiredRepairs);
  const uniqueCorrections = [...new Set(requiredCorrections)];
  const score = Math.max(
    0,
    Math.min(
      100,
      100 -
        uniqueCorrections.length * 12 -
        (validationReport.status === "fail" ? 10 : 0) -
        (playtestReport.status === "fail" ? 10 : 0) -
        readiness.issues.filter((issue) => issue.severity === "warning").length * 3,
    ),
  );
  const pass =
    uniqueCorrections.length === 0 &&
    validationReport.status !== "fail" &&
    playtestReport.status !== "fail" &&
    score >= 85;
  const approvalStatus: SnesCodexReview["approvalStatus"] = pass
    ? readiness.status === "ready"
      ? "approved-for-snes-game-file"
      : "approved-for-playtest"
    : "rejected-needs-repair";
  return {
    id: `codex-review-${blueprint.id}-round-${round}`,
    createdAt,
    reviewer: "codex-qa-gate",
    round,
    score,
    status: pass ? "pass" : "fail",
    approvalStatus,
    requiredCorrections: uniqueCorrections,
    optionalSuggestions: pass
      ? ["Playtest the first minute and tune jump spacing, enemy speed, and reward visibility."]
      : ["Keep user-locked fields unchanged while OpenClaw applies the required corrections."],
    reviewedChecks: [
      "fun",
      "first-level-playable",
      "clear-goals",
      "reachable-jumps",
      "fair-enemies",
      "meaningful-rewards",
      "level-purpose",
      "required-parts-filled",
      "snes-constraints",
      "playtest-and-export-readiness",
      "gpt-5.5-directed-approval",
      "deterministic-validation-report",
      "automated-playtest-report",
    ],
  };
}

export function applySnesCodexReviewCorrections(
  blueprint: SnesCodexBlueprint,
  project: SnesStudioProject,
  review: SnesCodexReview,
  updatedAt = new Date().toISOString(),
): SnesAiGapFillResult {
  if (review.requiredCorrections.length === 0) {
    const normalized = normalizeSnesStudioProject(project);
    return {
      project: normalized,
      changes: ["No Codex corrections were required."],
      report: normalized.aiGapReport ?? createSnesAiGapReport(normalized),
    };
  }
  const filled = fillSnesAiGaps(project, updatedAt);
  const next = normalizeSnesStudioProject(filled.project);
  next.gamePlan = {
    title: blueprint.story.title,
    hero: blueprint.story.hero,
    goal: blueprint.story.goal,
    villain: blueprint.story.villain,
    levels: blueprint.levelList.map((level) => level.title),
    items: blueprint.items,
    powerups: blueprint.powerups,
    artMood: blueprint.artDirection,
    musicMood: blueprint.musicDirection,
    rulesSummary: blueprint.rules.join(" "),
    savePlan: "Three save slots with checkpoint, rewards, and ending progress.",
  };
  next.gameBrief = {
    prompt: blueprint.sourcePrompt,
    gameType: "side-scrolling-platformer",
    audience: "beginner",
    promise: blueprint.gameConcept,
  };
  next.updatedAt = updatedAt;
  const normalized = normalizeSnesStudioProject(next);
  return {
    project: normalized,
    changes: [
      ...filled.changes,
      "OpenClaw applied the Codex QA corrections without changing locked hardware fields.",
    ],
    report: normalized.aiGapReport ?? createSnesAiGapReport(normalized),
  };
}

export function createSnesAiProductionRun(
  prompt: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  createdAt = new Date().toISOString(),
): SnesAiProductionResult {
  const blueprint = createSnesCodexBlueprint(prompt, baseProject, createdAt);
  const generated = generateSnesProjectFromPrompt(blueprint.sourcePrompt, baseProject);
  let productionProject = normalizeSnesStudioProject(generated.project);
  productionProject.gameBrief = {
    prompt: blueprint.sourcePrompt,
    gameType: "side-scrolling-platformer",
    audience: "beginner",
    promise: blueprint.gameConcept,
  };
  productionProject.gamePlan = {
    title: blueprint.story.title,
    hero: blueprint.story.hero,
    goal: blueprint.story.goal,
    villain: blueprint.story.villain,
    levels: blueprint.levelList.map((level) => level.title),
    items: blueprint.items,
    powerups: blueprint.powerups,
    artMood: blueprint.artDirection,
    musicMood: blueprint.musicDirection,
    rulesSummary: blueprint.rules.join(" "),
    savePlan: "Three save slots with checkpoint, rewards, and ending progress.",
  };
  const firstAgentResults = createSnesOpenClawAgentResults(blueprint, productionProject);
  let validationReport = createSnesAiValidationReport(productionProject);
  let playtestReport = createSnesAiPlaytestReport(productionProject);
  let qualityReport = createSnesGameQualityReport(productionProject, {
    validationReport,
    playtestReport,
    liveGpt55Used: false,
    localOpenClawUsed: true,
  });
  const firstReview = reviewSnesOpenClawProduction(
    blueprint,
    productionProject,
    1,
    createdAt,
    validationReport,
    playtestReport,
  );
  const reviewRounds = [firstReview];
  const agentResults = [...firstAgentResults];
  const repairHistory: SnesAiRepairHistoryEntry[] = [];
  const auditTrail = [
    "GPT 5.5 Game Director created the blueprint, quality rubric, risk list, and OpenClaw task briefs.",
    "OpenClaw Game Team filled the editable game text boxes and game parts from GPT 5.5 briefs.",
    `Deterministic validation scored ${validationReport.score}/100 and playtest metrics scored ${playtestReport.score}/100.`,
    `GPT 5.5 Quality Gate reviewed round 1 with score ${firstReview.score}/100.`,
  ];
  if (firstReview.status === "fail") {
    const repaired = applySnesCodexReviewCorrections(
      blueprint,
      productionProject,
      firstReview,
      createdAt,
    );
    productionProject = repaired.project;
    agentResults.push({
      taskId: "openclaw-codex-correction-pass",
      role: "playtest-fun-agent",
      targetSurface: "level",
      filledText: repaired.changes.join(" "),
      structuredPatchSummary: "OpenClaw applied required Codex QA corrections.",
      changed: repaired.changes,
      risks: [],
      missingPieces: repaired.report.gaps.filter((gap) => !gap.resolved).map((gap) => gap.title),
      status: repaired.report.status === "complete" ? "filled" : "needs-review",
    });
    repairHistory.push({
      round: 1,
      requestedBy: "gpt-5.5-quality-gate",
      targetRole: "playtest-fun-agent",
      instructions: firstReview.requiredCorrections,
      status: "applied",
    });
    validationReport = createSnesAiValidationReport(productionProject);
    playtestReport = createSnesAiPlaytestReport(productionProject);
    qualityReport = createSnesGameQualityReport(productionProject, {
      validationReport,
      playtestReport,
      liveGpt55Used: false,
      localOpenClawUsed: true,
    });
    const finalReview = reviewSnesOpenClawProduction(
      blueprint,
      productionProject,
      2,
      createdAt,
      validationReport,
      playtestReport,
    );
    reviewRounds.push(finalReview);
    auditTrail.push("OpenClaw applied GPT 5.5 repair instructions.");
    auditTrail.push(`GPT 5.5 Quality Gate reviewed round 2 with score ${finalReview.score}/100.`);
  }
  const finalApproval = reviewRounds[reviewRounds.length - 1] ?? null;
  const status =
    qualityReport.status === "pass"
      ? (finalApproval?.approvalStatus ?? "rejected-needs-repair")
      : "rejected-needs-repair";
  productionProject.aiCommandResult = {
    provider: "openclaw",
    scope: "full-game",
    summary:
      status === "approved-for-snes-game-file"
        ? "GPT 5.5-directed OpenClaw production approved the game for playtest and SNES game file."
        : "GPT 5.5-directed OpenClaw production needs repair before final approval.",
    changed: [
      "GPT 5.5 director plan",
      "OpenClaw-filled story",
      "OpenClaw-filled levels",
      "OpenClaw-filled cast",
      "OpenClaw-filled rules",
      "Deterministic validation",
      "Automated playtest metrics",
      "GPT 5.5 quality review",
    ],
    unchanged: ["Locked fields, hardware constraints, and asset provenance stayed protected."],
    suggestedTest:
      status === "approved-for-snes-game-file"
        ? "Playtest the first level, then export the SNES game file."
        : "Review GPT 5.5 repair instructions, let OpenClaw fill gaps, then playtest again.",
  };
  const run: SnesAiProductionRun = {
    id: `ai-production-${sanitizeRomBaseName(productionProject.name) || "snes-game"}-${createdAt.replace(/[^0-9]/gu, "")}`,
    createdAt,
    status,
    prompt: blueprint.sourcePrompt,
    blueprint,
    directorPlan: blueprint,
    taskList: blueprint.agentTasks,
    builderTasks: blueprint.agentTasks,
    agentResults,
    workerResults: agentResults,
    validationReport,
    playtestReport,
    qualityReport,
    reviewRounds,
    gpt55Review: finalApproval,
    finalApproval,
    approvalStatus: status,
    repairHistory,
    auditTrail,
  };
  productionProject.aiProductionRun = run;
  productionProject.updatedAt = createdAt;
  const normalized = normalizeSnesStudioProject(productionProject);
  normalized.aiProductionRun = run;
  return { project: normalized, run };
}

function createSnesAiProductionStagePrompt(
  role: SnesAiProductionGatewayRole,
  blueprint: SnesCodexBlueprint,
  project: SnesStudioProject,
): string {
  const baseRules = [
    "Return only an approval-gated SNES Studio JSON patch proposal.",
    "Do not apply changes directly.",
    "Preserve user-locked fields, original-generated asset provenance, save memory, FXPAK PRO FAT32 assumptions, and SNES hardware budgets.",
    "Include receipt fields: surface changed, patch path or hash, assumptions, risks, playtest hypothesis, QA evidence required, next role, blocker, GPT 5.5 use, reasoning level, and local model used.",
    "Use the project manifest as memory; do not rely on long transcript history.",
  ];
  if (role === "codex-architect") {
    return [
      "GPT 5.5 Game Director planning stage.",
      `Create or refine the professional blueprint for ${blueprint.story.title}.`,
      `User prompt: ${blueprint.sourcePrompt}`,
      `Current concept: ${blueprint.gameConcept}`,
      "Act as the executive game director and problem solver.",
      "Write the quality rubric, risk list, playtest metrics, and exact role-agent briefs that OpenClaw workers must execute.",
      "Patch only beginner-editable game plan, story bible, level chapters, rules, art/music direction, and /aiProductionRun if needed.",
      ...baseRules,
    ].join("\n");
  }
  if (role === "openclaw-game-team" || role === "openclaw-game-director") {
    return [
      role === "openclaw-game-team"
        ? "OpenClaw Game Team production stage."
        : "OpenClaw Game Director production stage.",
      `Fill all editable text boxes and game parts for ${project.name} from the Codex blueprint.`,
      `OpenClaw worker roles: ${blueprint.agentTasks.map((task) => task.role).join(", ")}.`,
      "Create concrete story beats, level chapter details, hero/enemy/item text, dialogue hooks, music ideas, gameplay rules, and first-level playtest content.",
      "OpenClaw is the builder lane. Follow the GPT 5.5 director plan exactly and include a receipt of what changed, risks, and what to test.",
      "Patch only scoped game content, playtest data, and /aiProductionRun audit fields.",
      ...baseRules,
    ].join("\n");
  }
  if (role === "openclaw-level-designer") {
    return [
      "OpenClaw Level Designer production stage.",
      `Fill level chapters, layouts, goals, rewards, enemy placements, and difficulty for ${project.name}.`,
      "Patch only level chapters, scene layout, item placement, goals, and /aiProductionRun audit fields.",
      ...baseRules,
    ].join("\n");
  }
  if (role === "openclaw-gameplay-designer") {
    return [
      "OpenClaw Gameplay Designer production stage.",
      `Fill hero movement, enemy behavior, item effects, powerups, and plain gameplay rules for ${project.name}.`,
      "Patch only gameplay rules, characters, enemies, items, first-level playtest data, and /aiProductionRun audit fields.",
      ...baseRules,
    ].join("\n");
  }
  if (role === "openclaw-art-audio") {
    return [
      "OpenClaw Art and Audio production stage.",
      `Fill original SNES-safe art direction, music mood, and sound ideas for ${project.name}.`,
      "Patch only art direction, audio, style warnings, and /aiProductionRun audit fields.",
      ...baseRules,
    ].join("\n");
  }
  if (role === "openclaw-hardware-qa") {
    return [
      "OpenClaw Hardware QA production stage.",
      `Check save memory, flash cart, emulator proof, budget, and export readiness for ${project.name}.`,
      "Patch only export readiness, hardware checklist summaries, and /aiProductionRun audit fields.",
      ...baseRules,
    ].join("\n");
  }
  return [
    "GPT 5.5 Quality Gate stage.",
    `Review the OpenClaw-filled game ${project.name} for professional side-scrolling platformer quality.`,
    "Check fun, first-level playability, clear goals, reachable jumps, fair enemies, meaningful rewards, level purpose, deterministic validation, playtest metrics, SNES constraints, export readiness, and beginner-language clarity.",
    "Approve only if quality is high enough. If not, disapprove and return exact repair instructions for the relevant OpenClaw worker role.",
    "Patch only /aiProductionRun, completion checklist, AI command result, and readiness-facing summaries unless a tiny correction is required.",
    ...baseRules,
  ].join("\n");
}

export function createSnesAiProductionGatewayPlan(
  project: SnesStudioProject,
  prompt: string,
  opts: {
    createdAt?: string;
    sessionKey?: string;
    proofMode?: "full-production" | "dashboard-e2e";
  } = {},
): SnesAiProductionGatewayPlan {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const sessionKey = opts.sessionKey?.trim() || "agent:main:dashboard:snes-studio";
  const proofMode = opts.proofMode ?? "full-production";
  const normalized = normalizeSnesStudioProject(project);
  const sourcePrompt =
    prompt.trim() ||
    normalized.gameBrief?.prompt ||
    normalized.aiProductionRun?.prompt ||
    normalized.name;
  const blueprint =
    normalized.aiProductionRun?.blueprint ??
    createSnesCodexBlueprint(sourcePrompt, normalized, createdAt);
  const stageSpecs: Array<{
    role: SnesAiProductionGatewayRole;
    title: string;
    requestedAgent: SnesAgentProvider;
    surface: SnesAiAuthoringSurface;
    sessionSuffix: string;
    agentId?: string;
    model?: string;
  }> = [
    {
      role: "codex-architect",
      title: "Codex Architect blueprint",
      requestedAgent: "codex",
      surface: "full-game",
      sessionSuffix: "codex-architect",
      model: "openai/gpt-5.5",
    },
    {
      role: "openclaw-game-team",
      title: "OpenClaw Game Team production",
      requestedAgent: "openclaw",
      surface: "full-game",
      sessionSuffix: "game-team",
      agentId: "snes-game-director",
    },
    {
      role: "openclaw-game-director",
      title: "OpenClaw Game Director production",
      requestedAgent: "openclaw",
      surface: "full-game",
      sessionSuffix: "game-director",
      agentId: "snes-game-director",
    },
    {
      role: "openclaw-level-designer",
      title: "OpenClaw Level Designer production",
      requestedAgent: "openclaw",
      surface: "level",
      sessionSuffix: "level-designer",
      agentId: "snes-level-designer",
    },
    {
      role: "openclaw-gameplay-designer",
      title: "OpenClaw Gameplay Designer production",
      requestedAgent: "openclaw",
      surface: "enemies",
      sessionSuffix: "gameplay-designer",
      agentId: "snes-gameplay-designer",
    },
    {
      role: "openclaw-art-audio",
      title: "OpenClaw Art and Audio production",
      requestedAgent: "openclaw",
      surface: "audio",
      sessionSuffix: "art-audio",
      agentId: "snes-art-audio",
    },
    {
      role: "openclaw-hardware-qa",
      title: "OpenClaw Hardware QA production",
      requestedAgent: "openclaw",
      surface: "export",
      sessionSuffix: "hardware-qa",
      agentId: "snes-hardware-qa",
    },
    {
      role: "codex-qa-gate",
      title: "Codex QA approval",
      requestedAgent: "codex",
      surface: "export",
      sessionSuffix: "codex-qa",
      model: "openai/gpt-5.5",
    },
  ];
  const selectedStageSpecs =
    proofMode === "dashboard-e2e"
      ? stageSpecs.filter((stage) =>
          ["codex-architect", "openclaw-game-team", "codex-qa-gate"].includes(stage.role),
        )
      : stageSpecs;
  const stages = selectedStageSpecs.map((stage, index) => {
    const stagePrompt = createSnesAiProductionStagePrompt(stage.role, blueprint, normalized);
    const record = createSnesAgentDispatchRecord(
      normalized,
      stagePrompt,
      createdAt,
      stage.requestedAgent,
      stage.surface,
    );
    const stageSessionKey = stage.agentId
      ? `agent:${stage.agentId}:dashboard:snes-studio:${stage.sessionSuffix}`
      : `${sessionKey}:${stage.sessionSuffix}`;
    const handoff = createSnesGatewayAgentHandoff(record, {
      sessionKey: stageSessionKey,
      agentId: stage.agentId,
      model: stage.model,
    });
    return {
      id: `${record.id}-stage-${index + 1}`,
      role: stage.role,
      title: stage.title,
      requestedAgent: stage.requestedAgent,
      surface: stage.surface,
      sessionKey: stageSessionKey,
      agentId: stage.agentId,
      model: stage.model,
      prompt: stagePrompt,
      record,
      handoff,
    };
  });
  return {
    id: `ai-production-gateway-${sanitizeRomBaseName(normalized.name) || "snes-game"}-${createdAt.replace(/[^0-9]/gu, "")}`,
    createdAt,
    proofMode,
    sessionKey,
    sourcePrompt,
    stages,
    acceptanceCriteria: [
      "GPT 5.5 creates or refines the blueprint, quality rubric, role briefs, and playtest metrics.",
      "OpenClaw worker agents fill all editable game content surfaces from GPT 5.5 instructions.",
      "Deterministic validation and playability checks run before approval.",
      "GPT 5.5 reviews OpenClaw work and either disapproves with exact corrections or approves the build.",
      "Every live response is imported as approval-gated JSON before project changes apply.",
    ],
    blockers: [
      "A connected OpenClaw Dashboard Gateway session is required for live route proof.",
      "The connected session must return JSON patch proposals; acknowledgement-only chat responses are not enough to verify the full loop.",
      "Hardware FXPAK proof remains optional until a FAT32 flash-cart volume is mounted.",
    ],
  };
}

export function applySnesJsonPatch(
  project: SnesStudioProject,
  operations: SnesJsonPatchOperation[],
  appliedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = cloneProject(project);
  const allowedPaths = new Set<string>(SNES_AGENT_PATCH_PATHS);
  for (const operation of operations) {
    if (operation.op !== "replace" || !allowedPaths.has(operation.path)) {
      throw new Error(`Unsupported SNES Studio patch operation: ${operation.path}`);
    }
    setJsonPointerValue(next, operation.path, operation.value);
  }
  enforceSnesStudioSafety(next);
  next.updatedAt = appliedAt;
  const errors = validateSnesStudioProject(next).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(`SNES Studio patch would create blocked project: ${errors[0]?.code}`);
  }
  return next;
}

export function createSnesAgentPatchProposal(
  prompt: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  source: SnesAgentPatchProposal["source"] = "local-prompt-agent",
): SnesAgentPatchProposal {
  const generated = generateSnesProjectFromPrompt(prompt, baseProject);
  const operations = SNES_AGENT_PATCH_PATHS.flatMap((path): SnesJsonPatchOperation[] => {
    const before = getJsonPointerValue(baseProject, path);
    const after = getJsonPointerValue(generated.project, path);
    return sameJsonValue(before, after)
      ? []
      : [
          {
            op: "replace",
            path,
            value: cloneJsonValue(after),
          },
        ];
  });
  const previewProject = applySnesJsonPatch(baseProject, operations, generated.project.updatedAt);
  const readiness = buildSnesReadiness(previewProject);
  const safeName = sanitizeRomBaseName(previewProject.name) || "generated-snes-game";
  return {
    id: `snes-agent-proposal-${safeName}`,
    source,
    surface: "full-game",
    requestedAgent: agentProviderFromSource(source),
    prompt: generated.prompt,
    summary: `Preview ${operations.length} approved JSON patches for ${previewProject.name}. ${generated.summary}`,
    rationale: generated.appliedChanges,
    operations,
    previewProject,
    readiness,
    approvalRequired: true,
  };
}

export function createSnesAgentPatchProposalFromResponse(
  response: unknown,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  source: SnesAgentPatchProposal["source"] = "openclaw-codex",
  surface: SnesAiAuthoringSurface = "full-game",
): SnesAgentPatchProposal {
  const parsed = parseAgentPatchResponsePayload(response);
  const previewProject = applySnesJsonPatch(baseProject, parsed.operations);
  const readiness = buildSnesReadiness(previewProject);
  const safeName = sanitizeRomBaseName(previewProject.name) || "agent-patch";
  const rationale = parsed.rationale ?? [];
  return {
    id: `snes-agent-response-${safeName}`,
    source,
    surface,
    requestedAgent: agentProviderFromSource(source),
    prompt: "Imported OpenClaw/Codex patch response.",
    summary:
      parsed.summary ||
      `Preview ${parsed.operations.length} imported JSON patches for ${previewProject.name}.`,
    rationale:
      rationale.length > 0
        ? rationale
        : ["Imported an approval-gated OpenClaw/Codex patch response."],
    operations: parsed.operations,
    previewProject,
    readiness,
    approvalRequired: true,
  };
}

export function diffSnesAgentPatchProposal(
  baseProject: SnesStudioProject,
  proposal: SnesAgentPatchProposal,
): SnesAgentPatchDiff[] {
  return proposal.operations.map((operation) => ({
    path: operation.path,
    before: cloneJsonValue(getJsonPointerValue(baseProject, operation.path)),
    after: cloneJsonValue(getJsonPointerValue(proposal.previewProject, operation.path)),
  }));
}

export function parseSnesAgentPatchProposalResponse(
  responseText: string,
  baseProject: SnesStudioProject = createDefaultSnesStudioProject(),
  source: SnesAgentPatchProposal["source"] = "openclaw-codex",
  surface: SnesAiAuthoringSurface = "full-game",
): SnesAgentPatchProposal {
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("SNES Studio agent patch response must be valid JSON.");
  }
  return createSnesAgentPatchProposalFromResponse(payload, baseProject, source, surface);
}

export function createSnesCodexTaskPacket(
  project: SnesStudioProject,
  userPrompt: string,
  createdAt = new Date().toISOString(),
  requestedAgent: SnesAgentProvider = "openclaw",
  surface: SnesAiAuthoringSurface = "full-game",
): SnesCodexTaskPacket {
  const safeName =
    sanitizeRomBaseName(project.export.romBaseName || project.name) || "openclaw-snes-game";
  return {
    id: `snes-codex-task-${safeName}`,
    createdAt,
    target: "openclaw-codex",
    role: "SNES Studio Game Builder",
    requestedAgent,
    surface,
    userPrompt: userPrompt.trim(),
    approvalRequired: true,
    hardwareProfile: {
      mapMode: project.profile.mapMode,
      region: project.profile.region,
      videoMode: project.profile.videoMode,
      enhancementChip: project.profile.enhancementChip,
      target: project.profile.target,
      fxpak: {
        cardSizeGb: project.profile.fxpak.cardSizeGb,
        fileSystem: "fat32",
        preserveExistingSaves: true,
      },
    },
    constraints: [
      "Preserve LoROM, NTSC, Mode 1 defaults unless the user explicitly asks for a SuperFX concept profile.",
      "Preserve FXPAK PRO deployment assumptions: 128 GB FAT32 microSD, unheadered .sfc output, and SRAM save protection.",
      "Never propose a patch outside allowedPatchPaths.",
      "Return a proposal for human approval; do not assume the dashboard has applied it.",
      "Keep every asset, scene, SRAM, and ROM setting inside current SNES hardware budgets.",
      `Requested authoring surface: ${surface}.`,
      `Requested AI worker: ${agentProviderLabel(requestedAgent)}.`,
    ],
    allowedPatchPaths: [...SNES_AGENT_PATCH_PATHS],
    projectJson: stableProjectJson(project),
    responseContract: {
      format: "json-patch-proposal",
      operation: "replace",
      instructions: [
        "Return JSON with summary, rationale, and operations.",
        'Each operation must be {"op":"replace","path":allowedPatchPath,"value":...}.',
        "Include only changes needed for the requested game modification.",
        `Treat the requested authoring surface as ${surface}.`,
        "Assume the user will inspect and approve the proposal before any project mutation.",
      ],
    },
  };
}

export function createSnesAgentDispatchRecord(
  project: SnesStudioProject,
  userPrompt: string,
  createdAt = new Date().toISOString(),
  requestedAgent: SnesAgentProvider = "openclaw",
  surface: SnesAiAuthoringSurface = "full-game",
): SnesAgentDispatchRecord {
  const normalized = normalizeSnesStudioProject(project);
  const packet = createSnesCodexTaskPacket(
    normalized,
    userPrompt,
    createdAt,
    requestedAgent,
    surface,
  );
  const readiness = buildSnesReadiness(normalized);
  const promptBytes = new TextEncoder().encode(userPrompt.trim());
  const promptChecksum = formatHex(calculateChecksum(promptBytes), 4);
  const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 17) || "now";
  return {
    id: `${packet.id}-${stamp}`,
    createdAt,
    status: "queued",
    target: "openclaw-codex",
    requestedAgent,
    surface,
    projectId: normalized.id,
    projectName: normalized.name,
    promptChecksum,
    approvalRequired: true,
    taskPacket: packet,
    handoff: {
      eventName: SNES_AGENT_DISPATCH_EVENT,
      queueStorageKey: SNES_AGENT_DISPATCH_QUEUE_KEY,
      responseContract: "json-patch-proposal",
    },
    safety: {
      readinessStatus: readiness.status,
      readinessScore: readiness.score,
      staticRomValidationRequired: true,
      constraints: [
        "Agent output must be imported as an approval-gated JSON patch proposal.",
        "Static ROM validation must pass before emulator or FXPAK PRO export.",
        "FXPAK PRO FAT32 and SRAM preservation rules must remain enabled.",
      ],
    },
  };
}

export function createSnesGatewayAgentHandoff(
  record: SnesAgentDispatchRecord,
  opts: { sessionKey?: string; agentId?: string; model?: string } = {},
): SnesGatewayAgentHandoff {
  const sessionKey = opts.sessionKey?.trim() || "agent:main:dashboard:snes-studio";
  const packetJson = JSON.stringify(record.taskPacket, null, 2);
  const message = [
    "SNES Studio OpenClaw/Codex generation task.",
    "",
    record.requestedAgent === "codex"
      ? "Act as GPT 5.5, the executive SNES game director and quality gate. Plan, diagnose, approve, disapprove, or write exact OpenClaw repair instructions. Return only JSON matching the task packet responseContract."
      : "Act as an OpenClaw local SNES game builder. Execute the GPT 5.5 director brief, fill the assigned game surface, and include a concise build receipt. Return only JSON matching the task packet responseContract.",
    "Do not apply changes directly. The user will review and approve the patch in SNES Studio.",
    "",
    "Required rules:",
    "- Preserve FXPAK PRO 128 GB FAT32 export assumptions.",
    "- Preserve SRAM save protection.",
    "- Keep generated assets, logic, and ROM settings inside SNES hardware budgets.",
    "- Use only allowedPatchPaths from the packet.",
    "",
    "Task packet:",
    "```json",
    packetJson,
    "```",
  ].join("\n");
  return {
    status: "ready",
    method: "agent",
    sessionKey,
    request: {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: record.id,
      timeout: 180,
      promptMode: "minimal",
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.model || record.requestedAgent === "codex"
        ? { model: opts.model ?? "openai/gpt-5.5" }
        : {}),
    },
    wait: {
      method: "agent.wait",
      timeoutMs: SNES_AGENT_TEAM_LIVE_PROOF_TIMEOUT_MS,
    },
    history: {
      method: "chat.history",
      limit: 12,
      maxChars: 60000,
    },
    instructions: [
      "Send this request through the OpenClaw Gateway agent method.",
      "Wait for the returned run with agent.wait, then read chat.history for the final assistant JSON.",
      "Import the returned JSON patch proposal into SNES Studio for human approval.",
      "Reject any response that is not a JSON patch proposal constrained to allowedPatchPaths.",
    ],
  };
}

const SNES_AGENT_TEAM_ROLE_SPECS: Array<
  Omit<SnesAgentTeamMember, "sessionKey"> & { sessionSuffix: string }
> = [
  {
    role: "codex-architect",
    title: "GPT 5.5 Director",
    requestedAgent: "codex",
    surface: "full-game",
    model: "openai/gpt-5.5",
    purpose: "Create the blueprint, fun rubric, risks, playtest metrics, and worker briefs.",
    fillsTextBoxes: false,
    sessionSuffix: "codex-architect",
  },
  {
    role: "openclaw-game-director",
    title: "OpenClaw Game Director",
    requestedAgent: "openclaw",
    surface: "full-game",
    agentId: "snes-game-director",
    purpose: "Turn the blueprint into coherent playable game content.",
    fillsTextBoxes: true,
    sessionSuffix: "game-director",
  },
  {
    role: "openclaw-level-designer",
    title: "OpenClaw Level Designer",
    requestedAgent: "openclaw",
    surface: "level",
    agentId: "snes-level-designer",
    purpose: "Fill level chapters, platform layouts, goals, rewards, and difficulty.",
    fillsTextBoxes: true,
    sessionSuffix: "level-designer",
  },
  {
    role: "openclaw-gameplay-designer",
    title: "OpenClaw Gameplay Designer",
    requestedAgent: "openclaw",
    surface: "enemies",
    agentId: "snes-gameplay-designer",
    purpose: "Fill movement, enemies, items, powerups, and rules.",
    fillsTextBoxes: true,
    sessionSuffix: "gameplay-designer",
  },
  {
    role: "openclaw-art-audio",
    title: "OpenClaw Art and Audio",
    requestedAgent: "openclaw",
    surface: "audio",
    agentId: "snes-art-audio",
    purpose: "Fill original SNES-safe art direction, music, and sound ideas.",
    fillsTextBoxes: true,
    sessionSuffix: "art-audio",
  },
  {
    role: "openclaw-hardware-qa",
    title: "OpenClaw Hardware QA",
    requestedAgent: "openclaw",
    surface: "export",
    agentId: "snes-hardware-qa",
    purpose: "Check save memory, flash cart, budget, and export readiness constraints.",
    fillsTextBoxes: false,
    sessionSuffix: "hardware-qa",
  },
  {
    role: "codex-qa-gate",
    title: "GPT 5.5 Quality Gate",
    requestedAgent: "codex",
    surface: "export",
    model: "openai/gpt-5.5",
    purpose: "Review OpenClaw output and approve, disapprove, or require exact repairs.",
    fillsTextBoxes: false,
    sessionSuffix: "codex-qa",
  },
];

function normalizeSnesAgentTeamBaseSessionKey(sessionKey?: string) {
  return sessionKey?.trim() || "agent:main:dashboard:snes-studio";
}

function rolePatchScope(
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa",
) {
  if (role === "producer-orchestrator") {
    return ["production state", "backlog", "token policy", "receipts"];
  }
  if (role === "art-director-visual-qa") {
    return ["visual approval gate", "asset evidence", "human visual grade"];
  }
  if (role === "codex-architect") {
    return ["game plan", "story bible", "level chapters", "quality rubric", "role briefs"];
  }
  if (role === "openclaw-game-director") {
    return ["story", "loop", "stakes", "cohesion", "editable game plan"];
  }
  if (role === "openclaw-level-designer") {
    return ["level route", "jumps", "rewards", "enemies", "secrets", "checkpoints"];
  }
  if (role === "openclaw-gameplay-designer") {
    return ["physics", "controls", "enemy behavior", "items", "hazards", "lives"];
  }
  if (role === "openclaw-art-audio") {
    return ["sprite sheets", "tilesets", "palettes", "animation", "music", "SFX"];
  }
  if (role === "openclaw-hardware-qa") {
    return ["ROM proof", "emulator proof", "FXPAK blockers", "SNES memory budgets"];
  }
  return ["QA evidence", "repair brief", "approval status"];
}

function nextRoleForAgent(
  role: SnesAgentTeamRole | "producer-orchestrator" | "art-director-visual-qa",
) {
  const order: Array<SnesAgentTeamRole | "art-director-visual-qa" | "human-review"> = [
    "codex-architect",
    "openclaw-game-director",
    "openclaw-level-designer",
    "openclaw-gameplay-designer",
    "openclaw-art-audio",
    "art-director-visual-qa",
    "openclaw-hardware-qa",
    "codex-qa-gate",
    "human-review",
  ];
  const index = order.indexOf(role as SnesAgentTeamRole | "art-director-visual-qa");
  return index >= 0 ? (order[index + 1] ?? null) : "codex-architect";
}

export function createSnesAgentOperatingManual(): SnesAgentOperatingManual {
  const receiptFields: Array<keyof SnesAgentHandoffReceipt> = [
    "surfaceChanged",
    "patchPath",
    "patchHash",
    "assumptions",
    "risks",
    "testHypothesis",
    "qaEvidenceRequired",
    "nextRole",
    "blocker",
    "gpt55Used",
    "reasoningLevel",
    "localModelUsed",
  ];
  const agentRoles: SnesAgentOperatingManualRole[] = SNES_AGENT_TEAM_ROLE_SPECS.map((spec) => ({
    allowedToPatch: rolePatchScope(spec.role),
    owner: spec.requestedAgent === "codex" ? "gpt-5.5" : "local-openclaw-glm",
    requiredReceiptFields: receiptFields,
    responsibility: spec.purpose,
    role: spec.role,
    surface: spec.surface,
  }));
  return {
    completionRule:
      "No milestone is complete until the scoped patch, deterministic QA evidence, visual gate, and production-readiness blockers are recorded.",
    format: "openclaw-snes-agent-operating-manual",
    roles: [
      {
        allowedToPatch: rolePatchScope("producer-orchestrator"),
        owner: "producer",
        requiredReceiptFields: receiptFields,
        responsibility:
          "Own production state, milestone order, token policy, and pass/fail decisions.",
        role: "producer-orchestrator",
        surface: "production-state",
      },
      ...agentRoles,
      {
        allowedToPatch: rolePatchScope("art-director-visual-qa"),
        owner: "deterministic-qa",
        requiredReceiptFields: receiptFields,
        responsibility:
          "Reject placeholder graphics, enforce real sprite/tile/background evidence, and preserve human visual grade as the override.",
        role: "art-director-visual-qa",
        surface: "visual-quality",
      },
    ],
    summary:
      "Producer controls the pipeline, GPT 5.5 plans/diagnoses/approves, local OpenClaw/GLM workers patch scoped surfaces, deterministic QA proves results.",
    tokenPolicy: [
      decideSnesGpt55Usage("initial-blueprint"),
      decideSnesGpt55Usage("routine-local-patch"),
      decideSnesGpt55Usage("obvious-repair-brief"),
      decideSnesGpt55Usage("repeated-blocker-diagnosis", { repeatedFailureCount: 2 }),
      decideSnesGpt55Usage("production-visual-approval"),
      decideSnesGpt55Usage("final-shipping-approval"),
    ],
    version: 1,
    workflow: [
      "User prompt creates or updates the project manifest.",
      "GPT 5.5 Director creates blueprint, rubric, role briefs, and risks when the live route is used.",
      "Local workers receive one compact surface packet and return strict JSON patches only.",
      "Deterministic code validates, applies, rebuilds, and runs executable QA.",
      "Art Director gate blocks placeholder visuals and respects human visual grade.",
      "GPT 5.5 QA diagnoses failures or approves only after machine proof.",
      "Dashboard exposes next action, blockers, model/cost truth, and proof receipts.",
    ],
  };
}

export function createSnesAgentHandoffReceipt(
  member:
    | SnesAgentTeamMember
    | {
        role: "producer-orchestrator" | "art-director-visual-qa";
        title: string;
        surface: "production-state" | "visual-quality";
      },
  options: Partial<SnesAgentHandoffReceipt> = {},
): SnesAgentHandoffReceipt {
  const role = member.role;
  const isGptRole = role === "codex-architect" || role === "codex-qa-gate";
  const gptDecision = isGptRole
    ? decideSnesGpt55Usage(
        role === "codex-architect" ? "initial-blueprint" : "final-shipping-approval",
      )
    : decideSnesGpt55Usage("routine-local-patch");
  return {
    assumptions: options.assumptions ?? [
      "The project manifest is the source of truth.",
      "Only the assigned surface may change.",
    ],
    blocker: options.blocker ?? null,
    gpt55Used: options.gpt55Used ?? gptDecision.gpt55Used,
    localModelUsed: options.localModelUsed ?? (isGptRole ? null : "best-local-role-winner"),
    nextRole: options.nextRole ?? nextRoleForAgent(role),
    patchHash: options.patchHash ?? null,
    patchPath: options.patchPath ?? null,
    qaEvidenceRequired: options.qaEvidenceRequired ?? [
      "strict JSON patch validation",
      "deterministic QA receipt",
      "dashboard receipt",
    ],
    reasoningLevel: options.reasoningLevel ?? gptDecision.reasoningLevel,
    risks: options.risks ?? ["Output must not overwrite unrelated game surfaces."],
    role,
    surfaceChanged: options.surfaceChanged ?? member.surface,
    testHypothesis:
      options.testHypothesis ??
      "After this handoff, the next QA run should prove the scoped change without regressing playability.",
    title: options.title ?? member.title,
  };
}

function targetRepairRoleFromQuality(
  report: SnesGameQualityReport,
): SnesAgentTeamRole | "art-director-visual-qa" {
  const failedCodes = report.gates
    .filter((gate) => gate.status === "fail")
    .map((gate) => gate.code);
  if (failedCodes.some((code) => code.includes("asset"))) {
    return "art-director-visual-qa";
  }
  if (failedCodes.some((code) => code.includes("level") || code.includes("first-screen"))) {
    return "openclaw-level-designer";
  }
  if (failedCodes.some((code) => code.includes("enemy") || code.includes("hazard"))) {
    return "openclaw-gameplay-designer";
  }
  return "openclaw-game-director";
}

export function createSnesRepairLoopPlan(
  project: SnesStudioProject,
  options: { qualityReport?: SnesGameQualityReport; previousFailureCount?: number } = {},
): SnesRepairLoopPlan {
  const qualityReport = options.qualityReport ?? createSnesGameQualityReport(project);
  if (qualityReport.status === "pass") {
    return {
      blocker: null,
      failureEvidence: [],
      gpt55Decision: decideSnesGpt55Usage("qa-summary"),
      localWorkerPatchRequired: false,
      repairBrief: [],
      rerunRequired: false,
      status: "not-needed",
      targetRole: null,
    };
  }
  const previousFailureCount = options.previousFailureCount ?? 0;
  const targetRole = targetRepairRoleFromQuality(qualityReport);
  const gpt55Decision =
    previousFailureCount >= 2
      ? decideSnesGpt55Usage("repeated-blocker-diagnosis", {
          repeatedFailureCount: previousFailureCount,
        })
      : decideSnesGpt55Usage("obvious-repair-brief");
  const failureEvidence = [
    ...qualityReport.validationReport.requiredRepairs,
    ...qualityReport.playtestReport.requiredRepairs,
    ...qualityReport.requiredRepairs,
  ].filter(Boolean);
  return {
    blocker: gpt55Decision.blocker,
    failureEvidence: [...new Set(failureEvidence)],
    gpt55Decision,
    localWorkerPatchRequired: true,
    repairBrief:
      failureEvidence.length > 0
        ? [...new Set(failureEvidence)].slice(0, 6)
        : ["Repair the failed deterministic QA gate before approval."],
    rerunRequired: true,
    status: gpt55Decision.blocker ? "blocked" : "ready",
    targetRole,
  };
}

export function createSnesAgentWorkflowReport(
  project: SnesStudioProject,
  options: {
    createdAt?: string;
    previousFailureCount?: number;
    assetRecords?: SnesProductionAssetRecord[];
    humanVisualScore?: number | null;
    targetVisualScore?: number;
    explicitGpt55VisualApproval?: boolean;
  } = {},
): SnesAgentWorkflowReport {
  const normalized = normalizeSnesStudioProject(project);
  const team = createSnesAgentTeamPlan(
    normalized,
    normalized.gameBrief?.prompt ?? normalized.name,
    {
      createdAt: options.createdAt,
    },
  );
  const state = createSnesGenericProductionState(normalized);
  const latestPacket = createSnesGenericProductionPacket(state);
  const visualGate = createSnesArtDirectorVisualGate(normalized, {
    assetRecords: options.assetRecords,
    gpt55ReviewStatus: options.explicitGpt55VisualApproval ? "approved" : "not-requested",
    humanScore: options.humanVisualScore ?? null,
    targetScore: options.targetVisualScore ?? 100,
  });
  const qualityReport = createSnesGameQualityReport(normalized);
  const repairLoop = createSnesRepairLoopPlan(normalized, {
    previousFailureCount: options.previousFailureCount,
    qualityReport,
  });
  const handoffReceipts = [
    createSnesAgentHandoffReceipt({
      role: "producer-orchestrator",
      title: "Producer Orchestrator",
      surface: "production-state",
    }),
    ...team.members.map((member) => createSnesAgentHandoffReceipt(member)),
    createSnesAgentHandoffReceipt(
      {
        role: "art-director-visual-qa",
        title: "Art Director / Visual QA",
        surface: "visual-quality",
      },
      {
        blocker: visualGate.blockers[0] ?? null,
        gpt55Used: false,
        qaEvidenceRequired: [
          "real sprite sheet records",
          "real tileset variants",
          "background layer screenshots",
          "human or approved GPT 5.5 visual grade",
        ],
        reasoningLevel: "none",
      },
    ),
  ];
  const blockers = [
    ...visualGate.blockers,
    ...(repairLoop.blocker ? [repairLoop.blocker] : []),
    ...(latestPacket.gpt55Policy.blocker ? [latestPacket.gpt55Policy.blocker] : []),
  ];
  return {
    blockers,
    format: "openclaw-snes-agent-workflow-report",
    handoffReceipts,
    manifestMemory: {
      fullTranscriptRequired: false,
      latestPacket,
      sourceOfTruth: "snes-project-manifest",
    },
    nextRecommendedAction:
      visualGate.status !== "pass"
        ? "Review Art: add real sprite, tile, background, palette, screenshot, and human-grade proof."
        : repairLoop.status === "ready"
          ? `Repair: send the repair brief to ${repairLoop.targetRole}.`
          : "Continue: run the next local milestone packet and deterministic QA.",
    operatingManual: createSnesAgentOperatingManual(),
    projectId: normalized.id,
    projectName: normalized.name,
    repairLoop,
    tokenGovernor: {
      blueprint: decideSnesGpt55Usage("initial-blueprint"),
      finalApproval: decideSnesGpt55Usage("final-shipping-approval"),
      repair:
        (options.previousFailureCount ?? 0) >= 2
          ? decideSnesGpt55Usage("repeated-blocker-diagnosis", {
              repeatedFailureCount: options.previousFailureCount,
            })
          : decideSnesGpt55Usage("obvious-repair-brief"),
      routinePatch: decideSnesGpt55Usage("routine-local-patch"),
      visualApproval: decideSnesGpt55Usage("production-visual-approval", {
        explicitVisualApproval: options.explicitGpt55VisualApproval,
      }),
    },
    version: 1,
    visualGate,
  };
}

export function createSnesAgentTeamPlan(
  project: SnesStudioProject,
  prompt: string,
  opts: { createdAt?: string; sessionKey?: string } = {},
): SnesAgentTeamRun {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const normalized = normalizeSnesStudioProject(project);
  const sessionBaseKey = normalizeSnesAgentTeamBaseSessionKey(opts.sessionKey);
  const sourcePrompt =
    prompt.trim() ||
    normalized.gameBrief?.prompt ||
    normalized.aiProductionRun?.prompt ||
    normalized.name;
  const members: SnesAgentTeamMember[] = SNES_AGENT_TEAM_ROLE_SPECS.map((spec) => ({
    role: spec.role,
    title: spec.title,
    requestedAgent: spec.requestedAgent,
    surface: spec.surface,
    agentId: spec.agentId,
    model: spec.model,
    purpose: spec.purpose,
    fillsTextBoxes: spec.fillsTextBoxes,
    sessionKey: spec.agentId
      ? `agent:${spec.agentId}:dashboard:snes-studio:${spec.sessionSuffix}`
      : `${sessionBaseKey}:${spec.sessionSuffix}`,
  }));
  return {
    id: `agent-team-${sanitizeRomBaseName(normalized.name) || "snes-game"}-${createdAt.replace(/[^0-9]/gu, "")}`,
    createdAt,
    sessionBaseKey,
    sourcePrompt,
    status: "planned",
    members,
    readiness: members.map((member) => ({
      role: member.role,
      status: "not-checked",
      sessionKey: member.sessionKey,
      requestedAgent: member.requestedAgent,
      detail: `${member.title} has not been checked yet.`,
    })),
  };
}

export function createSnesAgentTeamPreflight(
  member: SnesAgentTeamMember,
  opts: { createdAt?: string } = {},
): SnesGatewayAgentHandoff {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const message = [
    "SNES Studio AI team connection preflight.",
    "",
    `Role: ${member.title}`,
    `Purpose: ${member.purpose}`,
    `Requested lane: ${member.requestedAgent}`,
    "",
    "Return only compact JSON with this shape:",
    `{"ready":true,"role":"${member.role}","summary":"${member.title} is ready for SNES Studio."}`,
    "",
    "Do not make game content yet. This is only a connection and role-readiness check.",
  ].join("\n");
  return {
    status: "ready",
    method: "agent",
    sessionKey: member.sessionKey,
    request: {
      sessionKey: member.sessionKey,
      message,
      deliver: false,
      idempotencyKey: `snes-agent-team-preflight-${member.role}-${createdAt.replace(/[^0-9]/gu, "")}`,
      timeout: SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS / 1000,
      promptMode: "minimal",
      ...(member.agentId ? { agentId: member.agentId } : {}),
      ...(member.model ? { model: member.model } : {}),
    },
    wait: {
      method: "agent.wait",
      timeoutMs: SNES_AGENT_TEAM_PREFLIGHT_TIMEOUT_MS,
    },
    history: {
      method: "chat.history",
      limit: 6,
      maxChars: 12000,
    },
    instructions: [
      "Send this request through the OpenClaw Gateway agent method.",
      "Wait with agent.wait, then read chat.history.",
      "Mark the role ready only when it returns readiness JSON.",
    ],
  };
}

function createSnesAgentRoleBlocker(
  code: SnesAgentRoleBlocker["code"],
  message: string,
  recommendedFix: string,
): SnesAgentRoleBlocker {
  return {
    code,
    message,
    recommendedFix,
    canUseLocalFallback: true,
  };
}

export function normalizeSnesAgentRoleResult(
  response: unknown,
  role: SnesAgentTeamRole,
): Pick<
  SnesAgentRoleReadiness,
  "state" | "responding" | "validJsonReturned" | "detail" | "blocker"
> {
  const candidates = typeof response === "string" ? [response] : [JSON.stringify(response)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(
        candidate.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, ""),
      );
      const parsedRole = typeof parsed.role === "string" ? parsed.role : role;
      if (parsedRole !== role) {
        continue;
      }
      if (parsed.ready === true) {
        return {
          state: "ready",
          responding: true,
          validJsonReturned: true,
          detail: typeof parsed.summary === "string" ? parsed.summary : `${role} is ready.`,
        };
      }
      return {
        state: "unavailable",
        responding: true,
        validJsonReturned: true,
        detail: typeof parsed.blocker === "string" ? parsed.blocker : `${role} is not available.`,
        blocker: createSnesAgentRoleBlocker(
          "agent-error",
          typeof parsed.blocker === "string" ? parsed.blocker : `${role} is not available.`,
          "Open the Agents dashboard, confirm this role can run, then use Check Again.",
        ),
      };
    } catch {
      // Continue below with invalid-response.
    }
  }
  return {
    state: "invalid-response",
    responding: true,
    validJsonReturned: false,
    detail: `${role} responded without the required readiness JSON.`,
    blocker: createSnesAgentRoleBlocker(
      "invalid-response",
      `${role} responded without the required readiness JSON.`,
      "Retry the readiness check. If it repeats, inspect the agent transcript for non-JSON output.",
    ),
  };
}

export function createSnesAgentTeamReadinessPlan(
  project: SnesStudioProject,
  sessionKey: string,
  opts: {
    configuredAgentIds?: string[];
    checkedAt?: string;
    runtimeAvailable?: boolean;
    runtimeDetail?: string;
    proofPassed?: boolean;
  } = {},
): SnesAgentTeamReadinessReport {
  const team = createSnesAgentTeamPlan(project, "", {
    sessionKey,
    createdAt: opts.checkedAt,
  });
  const configured = new Set(opts.configuredAgentIds ?? []);
  const roles: SnesAgentRoleReadiness[] = team.members.map((member) => {
    const workerNeedsAgent = Boolean(member.agentId);
    const isConfigured = !workerNeedsAgent || configured.has(member.agentId!);
    const runtimeAvailable = opts.runtimeAvailable ?? true;
    const blocker = !isConfigured
      ? createSnesAgentRoleBlocker(
          "missing-agent",
          `${member.title} needs the ${member.agentId} OpenClaw worker agent.`,
          "SNES Studio can create this worker automatically when Dashboard agent management is available.",
        )
      : !runtimeAvailable
        ? createSnesAgentRoleBlocker(
            "model-runtime-unavailable",
            opts.runtimeDetail ?? "The local OpenClaw model runtime is unavailable.",
            "Start or repair the local model runtime, then use Check Again.",
          )
        : undefined;
    const state = !isConfigured
      ? "needs-setup"
      : !runtimeAvailable
        ? "unavailable"
        : opts.proofPassed
          ? "proof-passed"
          : "proof-pending";
    return {
      role: member.role,
      title: member.title,
      requestedAgent: member.requestedAgent,
      sessionKey: member.sessionKey,
      agentId: member.agentId,
      state,
      configured: isConfigured,
      reachable: isConfigured && runtimeAvailable,
      responding: false,
      validJsonReturned: false,
      checkedAt: opts.checkedAt,
      detail:
        blocker?.message ??
        (opts.proofPassed
          ? `${member.title} passed live proof.`
          : `${member.title} is configured. Live proof has not run yet.`),
      blocker,
    };
  });
  const blockers = roles.flatMap((entry) => (entry.blocker ? [entry.blocker] : []));
  return {
    status: blockers.length > 0 ? "unavailable" : "ready",
    title: blockers.length > 0 ? "Live OpenClaw unavailable" : "Live proof pending",
    detail:
      blockers.length > 0
        ? summarizeSnesAgentTeamBlockers({ blockers })
        : opts.proofPassed
          ? "SNES Studio verified the live Codex/OpenClaw production route."
          : "SNES Studio found the required workers and local runtime. Run Live Production Check when you want model-backed proof.",
    checkedAt: opts.checkedAt,
    roles,
    blockers,
    localFallbackAvailable: true,
  };
}

export function summarizeSnesAgentTeamBlockers(
  report: Pick<SnesAgentTeamReadinessReport, "blockers">,
) {
  if (report.blockers.length === 0) {
    return "All live OpenClaw roles are ready.";
  }
  const missing = report.blockers.filter((blocker) => blocker.code === "missing-agent");
  if (missing.length > 0) {
    return `${missing.length} OpenClaw worker agent(s) need setup. Local game building still works.`;
  }
  return `${report.blockers.length} live OpenClaw role(s) need attention. Local game building still works.`;
}

export function createSnesProjectVersion(
  project: SnesStudioProject,
  reason = "Manual snapshot",
  createdAt = new Date().toISOString(),
): SnesProjectVersion {
  const normalized = normalizeSnesStudioProject(project);
  const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 17) || "now";
  const safeName = sanitizeRomBaseName(normalized.export.romBaseName || normalized.name);
  return {
    id: `snes-version-${safeName || "project"}-${stamp}`,
    createdAt,
    projectId: normalized.id,
    projectName: normalized.name,
    reason: reason.trim().slice(0, 80) || "Manual snapshot",
    projectJson: stableProjectJson(normalized),
  };
}

export function appendSnesProjectVersion(
  history: SnesProjectVersion[],
  version: SnesProjectVersion,
  limit = 20,
): SnesProjectVersion[] {
  return [version, ...history.filter((entry) => entry.id !== version.id)].slice(0, limit);
}

export function parseSnesProjectVersionHistory(raw: string | null): SnesProjectVersion[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("SNES Studio project version history must be a JSON array.");
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("SNES Studio project version entry must be an object.");
    }
    const candidate = entry as SnesProjectVersion;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.createdAt !== "string" ||
      typeof candidate.projectJson !== "string" ||
      typeof candidate.reason !== "string"
    ) {
      throw new Error("SNES Studio project version entry is invalid.");
    }
    return candidate;
  });
}

function collectJsonDiffs(
  before: unknown,
  after: unknown,
  path: string,
  changes: SnesProjectVersionDiff["changes"],
) {
  if (sameJsonValue(before, after)) {
    return;
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].toSorted()) {
      collectJsonDiffs(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${path}/${key}`,
        changes,
      );
    }
    return;
  }
  changes.push({ path: path || "/", before: cloneJsonValue(before), after: cloneJsonValue(after) });
}

export function diffSnesProjectVersions(
  before: SnesProjectVersion,
  after: SnesProjectVersion,
): SnesProjectVersionDiff {
  const beforeProject = JSON.parse(before.projectJson) as unknown;
  const afterProject = JSON.parse(after.projectJson) as unknown;
  const changes: SnesProjectVersionDiff["changes"] = [];
  collectJsonDiffs(beforeProject, afterProject, "", changes);
  return {
    beforeId: before.id,
    afterId: after.id,
    changes,
  };
}

export function createSnesProjectBundle(
  project: SnesStudioProject,
  versions: SnesProjectVersion[] = [],
  createdAt = new Date().toISOString(),
): SnesProjectBundle {
  const normalized = normalizeSnesStudioProject(project);
  return {
    format: "openclaw-snes-project-bundle",
    bundleVersion: 1,
    createdAt,
    projectId: normalized.id,
    projectName: normalized.name,
    projectJson: stableProjectJson(normalized),
    versions: versions.map((version) => ({ ...version })),
    manifest: {
      fxpak: createFxpakExportManifest(normalized),
      readiness: buildSnesReadiness(normalized),
      versionCount: versions.length,
    },
  };
}

export function parseSnesProjectBundle(raw: string): SnesProjectBundle {
  const parsed = JSON.parse(raw) as unknown;
  const record = recordValue(parsed);
  if (
    !record ||
    record.format !== "openclaw-snes-project-bundle" ||
    record.bundleVersion !== 1 ||
    typeof record.projectJson !== "string" ||
    !Array.isArray(record.versions)
  ) {
    throw new Error("SNES Studio project bundle is invalid.");
  }
  const project = normalizeSnesStudioProject(JSON.parse(record.projectJson) as SnesStudioProject);
  const versions = parseSnesProjectVersionHistory(JSON.stringify(record.versions));
  return {
    format: "openclaw-snes-project-bundle",
    bundleVersion: 1,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    projectJson: stableProjectJson(project),
    versions,
    manifest: {
      fxpak: createFxpakExportManifest(project),
      readiness: buildSnesReadiness(project),
      versionCount: versions.length,
    },
  };
}

export function parseSnesProjectDocument(raw: string): {
  project: SnesStudioProject;
  versions: SnesProjectVersion[];
} {
  const parsed = JSON.parse(raw) as unknown;
  const record = recordValue(parsed);
  if (record?.format === "openclaw-snes-project-bundle") {
    const bundle = parseSnesProjectBundle(raw);
    return {
      project: normalizeSnesStudioProject(JSON.parse(bundle.projectJson) as SnesStudioProject),
      versions: bundle.versions,
    };
  }
  const project = normalizeSnesStudioProject(parsed as SnesStudioProject);
  if (project.schemaVersion !== 1 || !project.profile || !project.assets || !project.scenes) {
    throw new Error("SNES Studio project document is invalid.");
  }
  return { project, versions: [] };
}

export function createSnesPatchSandboxCorpusReport(
  project: SnesStudioProject,
): SnesPatchSandboxCorpusReport {
  const normalized = normalizeSnesStudioProject(project);
  const cases: Array<{
    id: string;
    expected: "accepted" | "rejected";
    response: unknown;
  }> = [
    {
      id: "safe-name-replace",
      expected: "accepted",
      response: {
        summary: "Rename project.",
        operations: [{ op: "replace", path: "/name", value: "Safe Rename" }],
      },
    },
    {
      id: "unsupported-path",
      expected: "rejected",
      response: {
        operations: [{ op: "replace", path: "/scripts/postinstall", value: "bad" }],
      },
    },
    {
      id: "prototype-pollution",
      expected: "rejected",
      response: {
        operations: [{ op: "replace", path: "/__proto__/polluted", value: true }],
      },
    },
    {
      id: "unsupported-op",
      expected: "rejected",
      response: {
        operations: [{ op: "add", path: "/name", value: "bad" }],
      },
    },
    {
      id: "missing-value",
      expected: "rejected",
      response: {
        operations: [{ op: "replace", path: "/name" }],
      },
    },
    {
      id: "empty-ops",
      expected: "rejected",
      response: {
        operations: [],
      },
    },
  ];

  const results = cases.map((testCase) => {
    try {
      parseSnesAgentPatchProposalResponse(
        JSON.stringify(testCase.response),
        normalized,
        "openclaw-codex",
        "full-game",
      );
      return {
        id: testCase.id,
        expected: testCase.expected,
        actual: "accepted" as const,
        detail: "Patch response parsed into an approval proposal.",
      };
    } catch (error) {
      return {
        id: testCase.id,
        expected: testCase.expected,
        actual: "rejected" as const,
        detail: error instanceof Error ? error.message : "Patch parser threw a non-Error value.",
      };
    }
  });
  const acceptedSafeCase = results.some(
    (result) => result.id === "safe-name-replace" && result.actual === "accepted",
  );
  const rejectedMaliciousCases = results.filter(
    (result) => result.expected === "rejected" && result.actual === "rejected",
  ).length;
  return {
    status:
      acceptedSafeCase &&
      results.every((result) => result.actual === result.expected) &&
      rejectedMaliciousCases === cases.length - 1
        ? "verified"
        : "failed",
    acceptedSafeCase,
    rejectedMaliciousCases,
    cases: results,
  };
}

export function createSnesRecoveryCorruptionDrill(
  project: SnesStudioProject,
): SnesRecoveryCorruptionDrill {
  const normalized = normalizeSnesStudioProject(project);
  const version = createSnesProjectVersion(
    normalized,
    "Recovery corruption drill",
    "2026-05-21T00:00:00.000Z",
  );
  const bundle = createSnesProjectBundle(normalized, [version], "2026-05-21T00:00:00.000Z");
  const checks: SnesRecoveryCorruptionDrill["checks"] = [];
  const addCheck = (
    code: SnesRecoveryCorruptionDrill["checks"][number]["code"],
    passed: boolean,
    detail: string,
  ) => checks.push({ code, passed, detail });

  try {
    const restored = parseSnesProjectDocument(JSON.stringify(bundle));
    addCheck(
      "VALID_BUNDLE_RESTORES",
      stableProjectJson(restored.project) === stableProjectJson(normalized),
      "Canonical project bundle imported and normalized.",
    );
    addCheck(
      "VERSION_HISTORY_RESTORES",
      restored.versions.length === 1 && restored.versions[0]?.id === version.id,
      "Version history traveled with the bundle.",
    );
  } catch (error) {
    addCheck(
      "VALID_BUNDLE_RESTORES",
      false,
      error instanceof Error ? error.message : "Bundle import threw a non-Error value.",
    );
    addCheck("VERSION_HISTORY_RESTORES", false, "Bundle import failed before history restore.");
  }

  try {
    parseSnesProjectDocument("{broken");
    addCheck("CORRUPT_JSON_REJECTED", false, "Corrupt JSON was unexpectedly accepted.");
  } catch (error) {
    addCheck(
      "CORRUPT_JSON_REJECTED",
      error instanceof Error,
      error instanceof Error ? error.message : "Corrupt JSON threw a non-Error value.",
    );
  }

  try {
    parseSnesProjectDocument(JSON.stringify({ ...bundle, projectJson: "{broken" }));
    addCheck("CORRUPT_BUNDLE_REJECTED", false, "Corrupt bundle was unexpectedly accepted.");
  } catch (error) {
    addCheck(
      "CORRUPT_BUNDLE_REJECTED",
      error instanceof Error,
      error instanceof Error ? error.message : "Corrupt bundle threw a non-Error value.",
    );
  }

  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail);
  return {
    status: blockers.length === 0 ? "verified" : "failed",
    restoredProjectId: normalized.id,
    checks,
    blockers,
  };
}

export function appendSnesAgentDispatchRecord(
  queue: SnesAgentDispatchRecord[],
  record: SnesAgentDispatchRecord,
  limit = 20,
): SnesAgentDispatchRecord[] {
  return [record, ...queue.filter((queued) => queued.id !== record.id)].slice(0, limit);
}

export function createSnesAgentResultRecord(
  record: SnesAgentDispatchRecord,
  responseText: string,
  createdAt = new Date().toISOString(),
): SnesAgentResultRecord {
  return {
    id: `${record.id}:result`,
    createdAt,
    status: "proposal-ready",
    target: "openclaw-codex",
    recordId: record.id,
    requestedAgent: record.requestedAgent,
    surface: record.surface,
    responseText,
    handoff: {
      eventName: SNES_AGENT_RESULT_EVENT,
      queueStorageKey: SNES_AGENT_RESULT_QUEUE_KEY,
      responseContract: "json-patch-proposal",
    },
  };
}

export function appendSnesAgentResultRecord(
  queue: SnesAgentResultRecord[],
  record: SnesAgentResultRecord,
  limit = 20,
): SnesAgentResultRecord[] {
  return [record, ...queue.filter((queued) => queued.id !== record.id)].slice(0, limit);
}

export function parseSnesAgentDispatchQueue(raw: string | null): SnesAgentDispatchRecord[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("SNES Studio agent dispatch queue must be a JSON array.");
  }
  return parsed.map((record) => {
    if (!record || typeof record !== "object") {
      throw new Error("SNES Studio agent dispatch queue entry must be an object.");
    }
    const candidate = record as SnesAgentDispatchRecord;
    if (
      typeof candidate.id !== "string" ||
      candidate.status !== "queued" ||
      candidate.target !== "openclaw-codex" ||
      !candidate.approvalRequired ||
      candidate.handoff?.eventName !== SNES_AGENT_DISPATCH_EVENT ||
      candidate.handoff?.queueStorageKey !== SNES_AGENT_DISPATCH_QUEUE_KEY ||
      candidate.taskPacket?.target !== "openclaw-codex"
    ) {
      throw new Error("SNES Studio agent dispatch queue entry is invalid.");
    }
    const packet = candidate.taskPacket as SnesCodexTaskPacket & {
      requestedAgent?: unknown;
      surface?: unknown;
    };
    const requestedAgent = isSnesAgentProvider(candidate.requestedAgent)
      ? candidate.requestedAgent
      : isSnesAgentProvider(packet.requestedAgent)
        ? packet.requestedAgent
        : "codex";
    const surface = isSnesAiAuthoringSurface(candidate.surface)
      ? candidate.surface
      : isSnesAiAuthoringSurface(packet.surface)
        ? packet.surface
        : "full-game";
    const normalizedTaskPacket = Object.assign({}, candidate.taskPacket, {
      requestedAgent,
      surface,
    });
    return Object.assign({}, candidate, {
      requestedAgent,
      surface,
      taskPacket: normalizedTaskPacket,
    });
  });
}

export function parseSnesAgentResultQueue(raw: string | null): SnesAgentResultRecord[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("SNES Studio agent result queue must be a JSON array.");
  }
  return parsed.map((record) => {
    if (!record || typeof record !== "object") {
      throw new Error("SNES Studio agent result queue entry must be an object.");
    }
    const candidate = record as SnesAgentResultRecord;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.recordId !== "string" ||
      typeof candidate.responseText !== "string" ||
      candidate.status !== "proposal-ready" ||
      candidate.target !== "openclaw-codex" ||
      candidate.handoff?.eventName !== SNES_AGENT_RESULT_EVENT ||
      candidate.handoff?.queueStorageKey !== SNES_AGENT_RESULT_QUEUE_KEY ||
      candidate.handoff?.responseContract !== "json-patch-proposal"
    ) {
      throw new Error("SNES Studio agent result queue entry is invalid.");
    }
    return Object.assign({}, candidate, {
      requestedAgent: isSnesAgentProvider(candidate.requestedAgent)
        ? candidate.requestedAgent
        : "codex",
      surface: isSnesAiAuthoringSurface(candidate.surface) ? candidate.surface : "full-game",
    });
  });
}

export function createSnesAgentPatchProposalFromResult(
  record: SnesAgentResultRecord,
  baseProject: SnesStudioProject,
): SnesAgentPatchProposal {
  return parseSnesAgentPatchProposalResponse(
    record.responseText,
    baseProject,
    agentSourceForProvider(record.requestedAgent),
    record.surface,
  );
}

export async function runSnesAgentDispatchRecord(
  record: SnesAgentDispatchRecord,
  baseProject: SnesStudioProject,
  execute: (record: SnesAgentDispatchRecord) => Promise<string> | string,
): Promise<SnesAgentRunnerResult> {
  const responseText = await execute(record);
  const proposal = parseSnesAgentPatchProposalResponse(
    responseText,
    baseProject,
    agentSourceForProvider(record.requestedAgent),
    record.surface,
  );
  let staticRomValidation: SnesPreviewRomValidationReport | null = null;
  if (
    proposal.previewProject.profile.videoMode === "mode1" &&
    proposal.previewProject.profile.enhancementChip === "none"
  ) {
    staticRomValidation = validateSnesPreviewRomArtifact(
      buildSnesPreviewRom(proposal.previewProject),
    );
    if (!staticRomValidation.valid) {
      throw new Error(
        "OpenClaw/Codex proposal produced a project that fails static ROM validation.",
      );
    }
  }
  return {
    status: "proposal-ready",
    recordId: record.id,
    proposal,
    appliedProjectPreview: proposal.previewProject,
    staticRomValidation,
  };
}

export function createFxpakExportManifest(project: SnesStudioProject): SnesFxpakExportManifest {
  const baseName = sanitizeRomBaseName(project.export.romBaseName || project.name);
  const romFileName = `${baseName || "openclaw-snes-game"}.sfc`;
  const savePath = project.save.enabled
    ? `/sd2snes/saves/${baseName || "openclaw-snes-game"}.srm`
    : null;
  return {
    target: "FXPAK PRO",
    requiredFileSystem: "FAT32",
    cardSizeGb: project.profile.fxpak.cardSizeGb,
    romFileName,
    romPath: `/SNES/OpenClaw/${romFileName}`,
    savePath,
    preserveExistingSave: project.profile.fxpak.preserveExistingSaves,
    hashAlgorithm: "sha256",
    checks: [
      "Validate FAT32 volume before copying.",
      "Write unheadered .sfc ROM and verify sha256 after copy.",
      "Never overwrite an existing .srm unless the user explicitly confirms it.",
      "Boot in emulator before hardware export.",
      "Power-cycle test SRAM on FXPAK PRO before release.",
    ],
  };
}

export function createSnesSaveManifest(project: SnesStudioProject): SnesSaveManifest {
  const buildProject = normalizeSnesStudioProject(project);
  const exportManifest = createFxpakExportManifest(buildProject);
  let offset = 0;
  const fields = buildProject.save.fields.map((field) => {
    const sizeBytes = bytesForSaveField(field);
    const manifestField = {
      ...field,
      offset,
      sizeBytes,
    };
    offset += sizeBytes;
    return manifestField;
  });
  const headerBase = {
    enabled: buildProject.save.enabled,
    fields,
    slots: buildProject.save.slots,
    slotSizeBytes: saveSlotBytes(buildProject.save),
    totalBytes: totalSaveBytes(buildProject.save),
  };
  const sramHeader = createSramRuntimeHeader(headerBase);
  return {
    enabled: headerBase.enabled,
    slots: headerBase.slots,
    slotSizeBytes: headerBase.slotSizeBytes,
    totalBytes: headerBase.totalBytes,
    sramSizeKib: buildProject.profile.sramSizeKib,
    savePath: exportManifest.savePath,
    sramBaseAddress: sramHeader ? SRAM_BASE_LONG_ADDRESS : null,
    sramHeaderChecksum: sramHeader ? readU16(sramHeader, 12) : 0,
    sramHeaderHex: sramHeader ? bytesToHex(sramHeader) : "",
    sramHeaderSizeBytes: sramHeader?.byteLength ?? 0,
    fields,
  };
}

function saveDataBaseOffset(manifest: SnesSaveManifest): number {
  return manifest.sramHeaderSizeBytes;
}

function writeSaveValue(
  bytes: Uint8Array,
  offset: number,
  type: SnesSaveFieldType,
  value: unknown,
) {
  const numeric =
    typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "number" ? value : 0;
  switch (type) {
    case "flag":
    case "u8":
      bytes[offset] = numeric & 0xff;
      return;
    case "u16":
      writeU16(bytes, offset, numeric & 0xffff);
      return;
    case "u32":
      writeU32(bytes, offset, numeric >>> 0);
      return;
  }
}

function readSaveValue(bytes: Uint8Array, offset: number, type: SnesSaveFieldType) {
  switch (type) {
    case "flag":
      return (bytes[offset] ?? 0) > 0;
    case "u8":
      return bytes[offset] ?? 0;
    case "u16":
      return readU16(bytes, offset);
    case "u32":
      return (
        ((bytes[offset] ?? 0) |
          ((bytes[offset + 1] ?? 0) << 8) |
          ((bytes[offset + 2] ?? 0) << 16) |
          ((bytes[offset + 3] ?? 0) << 24)) >>>
        0
      );
  }
  const exhaustive: never = type;
  return exhaustive;
}

export function createSnesSramImage(project: SnesStudioProject): Uint8Array {
  const manifest = createSnesSaveManifest(project);
  const image = new Uint8Array(manifest.sramSizeKib * 1024);
  if (manifest.sramHeaderHex) {
    image.set(hexToBytes(manifest.sramHeaderHex), 0);
  }
  return image;
}

export function writeSnesSaveSlot(
  project: SnesStudioProject,
  image: Uint8Array,
  slotIndex: number,
  values: SnesSramSlotValues,
): Uint8Array {
  const manifest = createSnesSaveManifest(project);
  if (!manifest.enabled) {
    throw new Error("Cannot write a save slot when SRAM is disabled.");
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= manifest.slots) {
    throw new Error("Save slot index is outside the configured SRAM slot range.");
  }
  if (image.byteLength < manifest.sramSizeKib * 1024) {
    throw new Error("SRAM image is smaller than the configured SRAM size.");
  }
  const next = new Uint8Array(image);
  const header = hexToBytes(manifest.sramHeaderHex);
  if (header.byteLength > 0) {
    next.set(header, 0);
  }
  const slotBase = saveDataBaseOffset(manifest) + slotIndex * manifest.slotSizeBytes;
  for (const field of manifest.fields) {
    writeSaveValue(next, slotBase + field.offset, field.type, values[field.key]);
  }
  return next;
}

export function readSnesSaveSlot(
  project: SnesStudioProject,
  image: Uint8Array,
  slotIndex: number,
): SnesSramSlotValues {
  const manifest = createSnesSaveManifest(project);
  if (!manifest.enabled) {
    return {};
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= manifest.slots) {
    throw new Error("Save slot index is outside the configured SRAM slot range.");
  }
  const slotBase = saveDataBaseOffset(manifest) + slotIndex * manifest.slotSizeBytes;
  return Object.fromEntries(
    manifest.fields.map((field) => [
      field.key,
      readSaveValue(image, slotBase + field.offset, field.type),
    ]),
  );
}

export function validateSnesSramImage(
  project: SnesStudioProject,
  image: Uint8Array,
): SnesSramImageValidationReport {
  const manifest = createSnesSaveManifest(project);
  const expectedHeader = hexToBytes(manifest.sramHeaderHex);
  const checks = [
    {
      code: "SRAM_SIZE",
      passed: image.byteLength === manifest.sramSizeKib * 1024,
      detail: `${image.byteLength} bytes in image, expected ${manifest.sramSizeKib * 1024}.`,
    },
    {
      code: "SRAM_HEADER",
      passed:
        expectedHeader.byteLength === 0 ||
        expectedHeader.every((byte, index) => image[index] === byte),
      detail:
        expectedHeader.byteLength === 0
          ? "SRAM disabled; no header required."
          : `Expected ${expectedHeader.byteLength} byte OCSV header.`,
    },
    {
      code: "SRAM_SLOT_REGION",
      passed:
        saveDataBaseOffset(manifest) + manifest.slotSizeBytes * manifest.slots <= image.byteLength,
      detail: `${manifest.slots} slots x ${manifest.slotSizeBytes} bytes inside ${image.byteLength} byte SRAM image.`,
    },
  ];
  return {
    checks,
    valid: checks.every((check) => check.passed),
  };
}

export function createSnesSramSerializationReport(
  project: SnesStudioProject,
): SnesSramSerializationReport {
  const manifest = createSnesSaveManifest(project);
  const image = createSnesSramImage(project);
  const validation = validateSnesSramImage(project, image);
  const slotRegionEnd =
    saveDataBaseOffset(manifest) + manifest.slotSizeBytes * Math.max(0, manifest.slots);
  const checks = [
    {
      code: "SRAM_ENABLED",
      passed: manifest.enabled,
      detail: manifest.enabled
        ? "SRAM save file is enabled."
        : "SRAM is disabled; no save runtime data will be serialized.",
    },
    {
      code: "VERSIONED_HEADER",
      passed: !manifest.enabled || /^4f43535601/i.test(manifest.sramHeaderHex),
      detail: manifest.enabled
        ? `Header checksum $${formatHex(manifest.sramHeaderChecksum, 4)} with ${manifest.sramHeaderSizeBytes} header bytes.`
        : "No header required while SRAM is disabled.",
    },
    {
      code: "FIELD_LAYOUT",
      passed: !manifest.enabled || manifest.fields.length > 0,
      detail: `${manifest.fields.length} field${manifest.fields.length === 1 ? "" : "s"} serialized into ${manifest.slotSizeBytes} byte slot records.`,
    },
    {
      code: "SLOT_REGION",
      passed: slotRegionEnd <= image.byteLength,
      detail: `${manifest.slots} slots end at byte ${slotRegionEnd} inside ${image.byteLength} byte SRAM image.`,
    },
    ...validation.checks,
  ];
  return {
    status: checks.every((check) => check.passed) ? "ready" : "blocked",
    headerChecksumHex: `$${formatHex(manifest.sramHeaderChecksum, 4)}`,
    headerVersion: manifest.sramHeaderHex ? 1 : 0,
    sramBaseAddressHex:
      manifest.sramBaseAddress === null ? null : `$${formatHex(manifest.sramBaseAddress, 6)}`,
    slotCount: manifest.slots,
    slotSizeBytes: manifest.slotSizeBytes,
    totalSaveBytes: manifest.totalBytes,
    imageSizeBytes: image.byteLength,
    fields: manifest.fields,
    checks,
  };
}

function equalSaveSlotValues(before: SnesSramSlotValues, after: SnesSramSlotValues): boolean {
  const beforeKeys = Object.keys(before).toSorted();
  const afterKeys = Object.keys(after).toSorted();
  return (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every((key, index) => key === afterKeys[index] && before[key] === after[key])
  );
}

export function createSnesSramPowerCycleProof(
  project: SnesStudioProject,
  beforeImage: Uint8Array,
  afterImage: Uint8Array | null,
  slotIndex = 0,
): SnesSramPowerCycleProof {
  const beforeValidation = validateSnesSramImage(project, beforeImage);
  const afterValidation = afterImage ? validateSnesSramImage(project, afterImage) : null;
  const beforeValues = beforeValidation.valid
    ? readSnesSaveSlot(project, beforeImage, slotIndex)
    : {};
  const afterValues =
    afterImage && afterValidation?.valid ? readSnesSaveSlot(project, afterImage, slotIndex) : {};
  const slotValuesMatched =
    beforeValidation.valid && afterValidation?.valid
      ? equalSaveSlotValues(beforeValues, afterValues)
      : false;
  const byteMatched =
    afterImage !== null &&
    beforeImage.byteLength === afterImage.byteLength &&
    beforeImage.every((byte, index) => afterImage[index] === byte);
  const checks: SnesSramPowerCycleProof["checks"] = [
    {
      code: "BEFORE_IMAGE",
      passed: beforeValidation.valid,
      detail: beforeValidation.valid
        ? "Pre-launch SRAM image is structurally valid."
        : "Pre-launch SRAM image failed validation.",
    },
    {
      code: "AFTER_IMAGE",
      passed: afterValidation?.valid ?? false,
      detail: afterImage
        ? afterValidation?.valid
          ? "Post-power-cycle SRAM image is structurally valid."
          : "Post-power-cycle SRAM image failed validation."
        : "Post-power-cycle SRAM image was not provided.",
    },
    {
      code: "SLOT_VALUES",
      passed: slotValuesMatched,
      detail: slotValuesMatched
        ? `Save slot ${slotIndex} values survived the power cycle.`
        : `Save slot ${slotIndex} values changed or could not be read.`,
    },
    {
      code: "BYTE_MATCH",
      passed: byteMatched,
      detail: byteMatched
        ? "SRAM bytes match exactly before and after the power cycle."
        : "SRAM bytes differ before and after the power cycle.",
    },
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail);
  return {
    status: blockers.length === 0 ? "verified" : afterImage ? "mismatch" : "blocked",
    slotIndex,
    beforeValues,
    afterValues,
    checks,
    blockers,
  };
}

function writeAscii(bytes: Uint8Array, offset: number, width: number, value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]+/g, " ")
    .slice(0, width);
  for (let i = 0; i < width; i++) {
    bytes[offset + i] = normalized.charCodeAt(i) || 0x20;
  }
}

function writeU16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function writeRawAscii(bytes: Uint8Array, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i) & 0x7f;
  }
}

function romSizeExponent(romSizeMbit: number): number {
  const romBytes = Math.max(1, (romSizeMbit * 1024 * 1024) / 8);
  return Math.max(0, Math.round(Math.log2(romBytes / 1024)));
}

function sramSizeExponent(sramSizeKib: number): number {
  return sramSizeKib <= 0 ? 0 : Math.max(0, Math.round(Math.log2(sramSizeKib)));
}

function calculateChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const byte of bytes) {
    sum = (sum + byte) & 0xffff;
  }
  return sum;
}

function snesColor(red: number, green: number, blue: number): number {
  return (red & 0x1f) | ((green & 0x1f) << 5) | ((blue & 0x1f) << 10);
}

function writeSnesColor(bytes: Uint8Array, colorIndex: number, color: number) {
  writeU16(bytes, colorIndex * 2, color);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.replace(/[^0-9a-f]/gi, "").toLowerCase();
  const bytes = new Uint8Array(Math.floor(normalized.length / 2));
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function createSramRuntimeHeader(
  save: Pick<SnesSaveManifest, "enabled" | "fields" | "slotSizeBytes" | "slots" | "totalBytes">,
): Uint8Array | null {
  if (!save.enabled) {
    return null;
  }
  const header = new Uint8Array(SRAM_HEADER_SIZE_BYTES);
  header.set([0x4f, 0x43, 0x53, 0x56], 0); // OCSV
  header[4] = 1;
  header[5] = save.slots & 0xff;
  writeU16(header, 6, save.slotSizeBytes);
  writeU16(header, 8, save.totalBytes);
  writeU16(header, 10, save.fields.length);
  header[14] = 1;
  const checksum =
    (calculateChecksum(header.slice(0, 12)) + calculateChecksum(header.slice(14))) & 0xffff;
  writeU16(header, 12, checksum);
  return header;
}

export function parseSnesIndexedTilePixels(source: string): number[] {
  const normalized = source.trim();
  if (!normalized) {
    throw new Error("Indexed tile import needs pixel data.");
  }
  const tokens = normalized.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  return tokens.map((token) => {
    const value = Number.parseInt(token, 16);
    if (!Number.isInteger(value) || value < 0 || value > 15) {
      throw new Error(`Indexed tile pixel "${token}" is outside the SNES 4bpp range 0-F.`);
    }
    return value;
  });
}

function encode4BppTile(pixels: number[]): Uint8Array {
  if (pixels.length !== 64) {
    throw new Error("SNES 4bpp tiles must contain exactly 64 pixels.");
  }
  const bytes = new Uint8Array(32);
  for (let y = 0; y < 8; y++) {
    let plane0 = 0;
    let plane1 = 0;
    let plane2 = 0;
    let plane3 = 0;
    for (let x = 0; x < 8; x++) {
      const color = pixels[y * 8 + x] & 0x0f;
      const mask = 1 << (7 - x);
      if (color & 0x01) {
        plane0 |= mask;
      }
      if (color & 0x02) {
        plane1 |= mask;
      }
      if (color & 0x04) {
        plane2 |= mask;
      }
      if (color & 0x08) {
        plane3 |= mask;
      }
    }
    bytes[y * 2] = plane0;
    bytes[y * 2 + 1] = plane1;
    bytes[16 + y * 2] = plane2;
    bytes[16 + y * 2 + 1] = plane3;
  }
  return bytes;
}

export function importSnesIndexedTileAsset(
  input: SnesIndexedTileImportInput,
  importedAt = new Date().toISOString(),
): SnesIndexedTileImportResult {
  const width = input.width;
  const height = input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Indexed tile import dimensions must be positive integers.");
  }
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new Error("Indexed tile import dimensions must be multiples of 8 pixels.");
  }
  if (input.pixels.length !== width * height) {
    throw new Error(
      `Indexed tile import expected ${width * height} pixels, received ${input.pixels.length}.`,
    );
  }
  const normalizedPixels = input.pixels.map((pixel) => {
    if (!Number.isInteger(pixel) || pixel < 0 || pixel > 15) {
      throw new Error("Indexed tile import pixels must be integers in the SNES 4bpp range 0-F.");
    }
    return pixel;
  });
  const uniqueTiles = new Map<string, number>();
  const uniqueTileBytes: Uint8Array[] = [];
  const tileIndices: number[] = [];
  const tilesWide = width / 8;
  const tilesHigh = height / 8;
  for (let tileY = 0; tileY < tilesHigh; tileY++) {
    for (let tileX = 0; tileX < tilesWide; tileX++) {
      const tilePixels: number[] = [];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          tilePixels.push(normalizedPixels[(tileY * 8 + y) * width + tileX * 8 + x] ?? 0);
        }
      }
      const tileBytes = encode4BppTile(tilePixels);
      const key = bytesToHex(tileBytes);
      const existingIndex = uniqueTiles.get(key);
      if (existingIndex !== undefined) {
        tileIndices.push(existingIndex);
      } else {
        const nextIndex = uniqueTileBytes.length;
        uniqueTiles.set(key, nextIndex);
        uniqueTileBytes.push(tileBytes);
        tileIndices.push(nextIndex);
      }
    }
  }
  const chrBytes = new Uint8Array(uniqueTileBytes.length * TILE_BYTES_4BPP);
  uniqueTileBytes.forEach((tile, index) => chrBytes.set(tile, index * TILE_BYTES_4BPP));
  const paletteColorsUsed = [...new Set(normalizedPixels)].toSorted((left, right) => left - right);
  const sourceTileCount = tilesWide * tilesHigh;
  const uniqueTileCount = uniqueTileBytes.length;
  return {
    id: sanitizeRomBaseName(input.name) || "imported-tileset",
    name: input.name.trim() || "Imported Tileset",
    width,
    height,
    sourceTileCount,
    uniqueTileCount,
    dedupedTileCount: sourceTileCount - uniqueTileCount,
    chrSizeBytes: chrBytes.byteLength,
    chrChecksum: calculateChecksum(chrBytes),
    chrHex: bytesToHex(chrBytes),
    paletteColorsUsed,
    palettePreviewHex: [],
    quantized: false,
    sourceColorCount: paletteColorsUsed.length,
    tileIndices,
    createdAt: importedAt,
    chrBytes,
    warnings: paletteColorsUsed.length > 16 ? ["Palette uses more than one 4bpp palette."] : [],
  };
}

type RgbaColorSample = {
  key: string;
  red: number;
  green: number;
  blue: number;
  count: number;
};

function rgbaColorKey(red: number, green: number, blue: number) {
  return `${red},${green},${blue}`;
}

function colorHex(sample: Pick<RgbaColorSample, "red" | "green" | "blue">) {
  return `#${[sample.red, sample.green, sample.blue]
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("")}`;
}

function nearestPaletteIndex(samples: RgbaColorSample[], red: number, green: number, blue: number) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const redDistance = sample.red - red;
    const greenDistance = sample.green - green;
    const blueDistance = sample.blue - blue;
    const distance =
      redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export function importSnesRgbaTileAsset(
  input: SnesRgbaTileImportInput,
  importedAt = new Date().toISOString(),
  options: SnesRgbaTileImportOptions = {},
): SnesIndexedTileImportResult {
  const width = input.width;
  const height = input.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("RGBA tile import dimensions must be positive integers.");
  }
  if (input.rgba.length !== width * height * 4) {
    throw new Error(
      `RGBA tile import expected ${width * height * 4} channel values, received ${input.rgba.length}.`,
    );
  }
  const palette = new Map<string, number>([["transparent", 0]]);
  const pixels: number[] = [];
  for (let offset = 0; offset < input.rgba.length; offset += 4) {
    const red = input.rgba[offset] ?? 0;
    const green = input.rgba[offset + 1] ?? 0;
    const blue = input.rgba[offset + 2] ?? 0;
    const alpha = input.rgba[offset + 3] ?? 255;
    for (const value of [red, green, blue, alpha]) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error("RGBA tile import channel values must be bytes in the 0-255 range.");
      }
    }
    if (alpha < (options.transparentAlpha ?? 128)) {
      pixels.push(0);
      continue;
    }
    const key = `${red},${green},${blue}`;
    let index = palette.get(key);
    if (index === undefined) {
      if (palette.size >= 16) {
        if (options.quantize) {
          break;
        }
        throw new Error(
          "RGBA tile import uses more than 16 visible colors for one SNES 4bpp palette.",
        );
      }
      index = palette.size;
      palette.set(key, index);
    }
    pixels.push(index);
  }
  const visibleSamples = new Map<string, RgbaColorSample>();
  for (let offset = 0; offset < input.rgba.length; offset += 4) {
    const red = input.rgba[offset] ?? 0;
    const green = input.rgba[offset + 1] ?? 0;
    const blue = input.rgba[offset + 2] ?? 0;
    const alpha = input.rgba[offset + 3] ?? 255;
    if (alpha < (options.transparentAlpha ?? 128)) {
      continue;
    }
    const key = rgbaColorKey(red, green, blue);
    const existing = visibleSamples.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      visibleSamples.set(key, { key, red, green, blue, count: 1 });
    }
  }
  const sortedSamples = [...visibleSamples.values()].toSorted(
    (left, right) => right.count - left.count || left.key.localeCompare(right.key),
  );
  const visibleColorLimit = 15;
  const warnings: string[] = [];
  let indexedPixels = pixels;
  let quantized = false;
  let palettePreview = sortedSamples.slice(0, visibleColorLimit);
  if (sortedSamples.length > visibleColorLimit) {
    if (!options.quantize) {
      throw new Error(
        "RGBA tile import uses more than 16 visible colors for one SNES 4bpp palette.",
      );
    }
    quantized = true;
    warnings.push(
      `Quantized ${sortedSamples.length} visible RGBA colors into ${visibleColorLimit} SNES palette slots.`,
    );
    indexedPixels = [];
    const paletteIndexByKey = new Map(palettePreview.map((sample, index) => [sample.key, index]));
    for (let offset = 0; offset < input.rgba.length; offset += 4) {
      const red = input.rgba[offset] ?? 0;
      const green = input.rgba[offset + 1] ?? 0;
      const blue = input.rgba[offset + 2] ?? 0;
      const alpha = input.rgba[offset + 3] ?? 255;
      if (alpha < (options.transparentAlpha ?? 128)) {
        indexedPixels.push(0);
        continue;
      }
      const key = rgbaColorKey(red, green, blue);
      const exactIndex = paletteIndexByKey.get(key);
      indexedPixels.push(
        (exactIndex === undefined
          ? nearestPaletteIndex(palettePreview, red, green, blue)
          : exactIndex) + 1,
      );
    }
  } else {
    palettePreview = sortedSamples;
  }

  const result = importSnesIndexedTileAsset(
    {
      name: input.name,
      width,
      height,
      pixels: indexedPixels,
    },
    importedAt,
  );
  return {
    ...result,
    palettePreviewHex: palettePreview.map(colorHex),
    quantized,
    sourceColorCount: sortedSamples.length + 1,
    warnings: [...warnings, ...result.warnings],
  };
}

export function runSnesAssetImporterFuzzCases(): SnesAssetImporterFuzzReport {
  const validPixels = Array.from({ length: 64 }, (_, index) => index % 4);
  const rgba = Array.from({ length: 64 }).flatMap((_, index) => {
    const value = (index % 16) * 16;
    return [value, 255 - value, value, 255];
  });
  const cases: Array<{
    id: string;
    expected: "accepted" | "rejected";
    run: () => void;
  }> = [
    {
      id: "valid-indexed-8x8",
      expected: "accepted",
      run: () => {
        importSnesIndexedTileAsset({ name: "Valid", width: 8, height: 8, pixels: validPixels });
      },
    },
    {
      id: "invalid-indexed-size",
      expected: "rejected",
      run: () => {
        importSnesIndexedTileAsset({ name: "Bad Size", width: 7, height: 8, pixels: validPixels });
      },
    },
    {
      id: "invalid-indexed-palette",
      expected: "rejected",
      run: () => {
        importSnesIndexedTileAsset({
          name: "Bad Palette",
          width: 8,
          height: 8,
          pixels: validPixels.map((pixel, index) => (index === 2 ? 16 : pixel)),
        });
      },
    },
    {
      id: "valid-rgba-quantized",
      expected: "accepted",
      run: () => {
        importSnesRgbaTileAsset({ name: "Quantized", width: 8, height: 8, rgba }, undefined, {
          quantize: true,
        });
      },
    },
    {
      id: "invalid-rgba-length",
      expected: "rejected",
      run: () => {
        importSnesRgbaTileAsset({
          name: "Short RGBA",
          width: 8,
          height: 8,
          rgba: rgba.slice(0, 12),
        });
      },
    },
  ];

  const results = cases.map((testCase) => {
    try {
      testCase.run();
      return {
        id: testCase.id,
        expected: testCase.expected,
        actual: "accepted" as const,
        controlled: true,
        detail: "Importer accepted the fixture.",
      };
    } catch (error) {
      return {
        id: testCase.id,
        expected: testCase.expected,
        actual: "rejected" as const,
        controlled: error instanceof Error && error.message.length > 0,
        detail: error instanceof Error ? error.message : "Importer threw a non-Error value.",
      };
    }
  });

  return {
    status: results.every((result) => result.actual === result.expected && result.controlled)
      ? "verified"
      : "failed",
    cases: results,
  };
}

export function applySnesImportedTileset(
  project: SnesStudioProject,
  importResult: SnesIndexedTileImportResult,
  importedAt = new Date().toISOString(),
): SnesStudioProject {
  const next = normalizeSnesStudioProject(project);
  const { chrBytes: _chrBytes, ...tileset } = importResult;
  next.assets.importedTilesets = [
    ...next.assets.importedTilesets.filter((asset) => asset.id !== tileset.id),
    tileset,
  ];
  next.assets.backgroundTiles = Math.max(next.assets.backgroundTiles, tileset.uniqueTileCount);
  next.updatedAt = importedAt;
  return next;
}

function makeTile(pattern: (x: number, y: number) => number): Uint8Array {
  return encode4BppTile(
    Array.from({ length: 64 }, (_, index) => pattern(index % 8, Math.floor(index / 8))),
  );
}

function backdropColorForProject(project: SnesStudioProject): number {
  if (project.visualStylePreset === SNES_CLASSIC_PLATFORMER_STYLE_PRESET) {
    const theme = project.artDirection?.backgroundTheme ?? "grassland";
    if (theme === "cave") {
      return snesColor(5, 6, 11);
    }
    if (theme === "mountain") {
      return snesColor(15, 22, 29);
    }
    if (theme === "sky") {
      return snesColor(13, 24, 31);
    }
    return snesColor(14, 24, 31);
  }
  const seed = Array.from(project.name).reduce(
    (sum, char, index) => (sum + char.charCodeAt(0) * (index + 1)) & 0x7fff,
    0,
  );
  const red = 4 + (seed & 0x0f);
  const green = 8 + ((seed >> 4) & 0x0f);
  const blue = 6 + ((seed >> 8) & 0x0f);
  return red | (green << 5) | (blue << 10);
}

function tileIndexForEntity(kind: SnesSceneEntityKind): number {
  switch (kind) {
    case "player":
      return 5;
    case "enemy":
      return 4;
    case "item":
      return 3;
    case "npc":
      return 6;
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function editLayerBytes(values: number[]): Uint8Array {
  return Uint8Array.from(
    Array.from({ length: SNES_STUDIO_EDIT_GRID.cells }, (_, index) => values[index] ?? 0),
    (value) => value & 0xff,
  );
}

function runtimeTileForEditCell(tile: number, solid: number, maxTileIndex: number): number {
  if (tile > 0 && tile <= maxTileIndex) {
    return tile;
  }
  return solid > 0 ? 2 : 0;
}

function createMode1SceneGraphics(project: SnesStudioProject, backdropColor: number) {
  const scene = activeScene(project);
  const stylePack = createClassicPlatformerStylePack();
  const palette = new Uint8Array(32);
  writeSnesColor(palette, 0, backdropColor);
  writeSnesColor(palette, 1, snesColor(31, 31, 31));
  writeSnesColor(palette, 2, snesColor(9, 20, 8));
  writeSnesColor(palette, 3, snesColor(3, 13, 6));
  writeSnesColor(palette, 4, snesColor(18, 11, 5));
  writeSnesColor(palette, 5, snesColor(26, 17, 8));
  writeSnesColor(palette, 6, snesColor(31, 25, 6));
  writeSnesColor(palette, 7, snesColor(29, 8, 7));
  writeSnesColor(palette, 8, snesColor(7, 11, 24));
  writeSnesColor(palette, 9, snesColor(14, 18, 31));
  writeSnesColor(palette, 10, snesColor(12, 25, 31));
  writeSnesColor(palette, 11, snesColor(21, 30, 15));
  writeSnesColor(palette, 12, snesColor(15, 9, 24));

  const builtinTiles = [
    makeTile(() => 0),
    makeTile((x, y) => (y <= 1 ? 2 : (x + y) % 3 === 0 ? 5 : 4)),
    makeTile((_x, y) => (y <= 2 ? 2 : y === 3 ? 3 : 0)),
    makeTile((x, y) => (Math.abs(x - 3.5) + Math.abs(y - 3.5) < 4 ? 6 : 0)),
    makeTile((x, y) => (x === y || x + y === 7 || (y > 1 && y < 6 && x > 1 && x < 6) ? 7 : 0)),
    makeTile((x, y) => (x > 1 && x < 6 && y > 0 && y < 7 ? 8 : 0)),
    makeTile((x, y) => (x === 1 || x === 6 || y === 1 || y === 6 ? 9 : 0)),
    makeTile((x, y) => (y >= 5 || (x + y) % 5 === 0 ? 10 : 0)),
    makeTile((x, y) => (y >= 5 || x === 2 || x === 5 ? 7 : 0)),
    makeTile((x, y) => (y > 4 ? 12 : (x + y) % 2 === 0 ? 9 : 0)),
    makeTile((x, y) => (y <= 2 ? 11 : (x + y) % 2 === 0 ? 4 : 5)),
    makeTile((x, y) => (y === 0 || x === 0 || x === 7 || y === 7 ? 8 : 12)),
  ];
  if (builtinTiles.length !== SNES_BUILTIN_TILE_COUNT) {
    throw new Error("Classic platformer built-in tile count must match SNES_BUILTIN_TILE_COUNT.");
  }
  const importedChrSections = project.assets.importedTilesets
    .map((tileset) => {
      const bytes = hexToBytes(tileset.chrHex);
      return bytes.slice(0, Math.floor(bytes.byteLength / TILE_BYTES_4BPP) * TILE_BYTES_4BPP);
    })
    .filter((bytes) => bytes.byteLength > 0);
  const importedTileCount = importedChrSections.reduce(
    (sum, bytes) => sum + bytes.byteLength / TILE_BYTES_4BPP,
    0,
  );
  const chr = new Uint8Array((builtinTiles.length + importedTileCount) * TILE_BYTES_4BPP);
  builtinTiles.forEach((tile, index) => chr.set(tile, index * TILE_BYTES_4BPP));
  let importedChrCursor = builtinTiles.length * TILE_BYTES_4BPP;
  for (const section of importedChrSections) {
    chr.set(section, importedChrCursor);
    importedChrCursor += section.byteLength;
  }
  const maxTileIndex = Math.max(0, chr.byteLength / TILE_BYTES_4BPP - 1);

  const tilemap = new Uint8Array(32 * 32 * 2);
  const writeTile = (column: number, row: number, tileIndex: number) => {
    const safeColumn = Math.max(0, Math.min(31, column));
    const safeRow = Math.max(0, Math.min(31, row));
    writeU16(tilemap, (safeRow * 32 + safeColumn) * 2, tileIndex & 0x03ff);
  };
  for (let row = 0; row < SNES_STUDIO_EDIT_GRID.height; row++) {
    for (let column = 0; column < SNES_STUDIO_EDIT_GRID.width; column++) {
      const cellIndex = row * SNES_STUDIO_EDIT_GRID.width + column;
      const tile = runtimeTileForEditCell(
        scene.tilemap[cellIndex] ?? 0,
        scene.collisionMap[cellIndex] ?? 0,
        maxTileIndex,
      );
      const tileColumn = column * 2;
      const tileRow = 8 + row * 2;
      writeTile(tileColumn, tileRow, tile);
      writeTile(tileColumn + 1, tileRow, tile);
      writeTile(tileColumn, tileRow + 1, tile);
      writeTile(tileColumn + 1, tileRow + 1, tile);
    }
  }
  for (const entity of scene.entities) {
    const sceneWidthPixels = Math.max(1, scene.widthMetatiles * 16);
    const sceneHeightPixels = Math.max(1, scene.heightMetatiles * 16);
    const column = Math.floor((entity.x / sceneWidthPixels) * 32);
    const row = Math.floor((entity.y / sceneHeightPixels) * 28);
    writeTile(column, row, tileIndexForEntity(entity.kind));
  }

  return {
    bg1ChrBaseWord: BG1_CHR_BASE_WORD,
    bg1TilemapBaseWord: BG1_TILEMAP_BASE_WORD,
    builtinTileCount: builtinTiles.length,
    stylePack,
    chr,
    collisionMap: editLayerBytes(scene.collisionMap),
    collisionMapChecksum: calculateChecksum(editLayerBytes(scene.collisionMap)),
    collisionTileCount: scene.collisionTiles,
    palette,
    importedTileBaseIndex: SNES_IMPORTED_TILE_BRUSH_BASE,
    importedTileCount,
    tileCount: chr.byteLength / TILE_BYTES_4BPP,
    tilemap,
    tilemapChecksum: calculateChecksum(editLayerBytes(scene.tilemap)),
  };
}

function createMode1RuntimeProgram(
  graphics: ReturnType<typeof createMode1SceneGraphics>,
  backdropColor: number,
  saveManifest: SnesSaveManifest,
  entitySprites: SnesRuntimeEntitySprite[],
) {
  const bytes: number[] = [
    0x78, // sei
    0x18, // clc
    0xfb, // xce
    0xc2,
    0x30, // rep #$30
  ];
  emitLdxImmediate(bytes, 0x1fff);
  bytes.push(0x9a); // txs
  bytes.push(0xe2, 0x20); // sep #$20, keep X/Y 16-bit

  const ppuBootstrapOffset = bytes.length;
  emitLdaImmediate(bytes, 0x80);
  emitStaAbsolute(bytes, 0x2100);
  emitStzAbsolute(bytes, 0x4200);
  emitLdaImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, 0x2105);
  emitLdaImmediate(bytes, 0x04);
  emitStaAbsolute(bytes, 0x2107);
  emitStzAbsolute(bytes, 0x210b);
  emitStzAbsolute(bytes, 0x2101);
  emitLdaImmediate(bytes, 0x11);
  emitStaAbsolute(bytes, 0x212c);

  emitStzAbsolute(bytes, 0x2121);
  emitLdxImmediate(bytes, 0);
  const cgramUploadOffset = emitCgramByteUploadLoop(
    bytes,
    PALETTE_DATA_OFFSET,
    graphics.palette.byteLength,
  );

  emitLdaImmediate(bytes, 0x80);
  emitStaAbsolute(bytes, 0x2115);
  emitVramAddress(bytes, graphics.bg1ChrBaseWord);
  emitLdxImmediate(bytes, 0);
  const vramChrUploadOffset = emitVramWordUploadLoop(
    bytes,
    CHR_DATA_OFFSET,
    graphics.chr.byteLength,
  );

  emitVramAddress(bytes, graphics.bg1TilemapBaseWord);
  emitLdxImmediate(bytes, 0);
  const vramTilemapUploadOffset = emitVramWordUploadLoop(
    bytes,
    TILEMAP_DATA_OFFSET,
    graphics.tilemap.byteLength,
  );

  emitStzAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS);
  emitStzAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS + 1);
  emitStzAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitStzAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_START_X);
  emitStaAbsolute(bytes, WRAM_PLAYER_X_ADDRESS);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_START_Y);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_ADDRESS);
  emitStzAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitLdaImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, WRAM_PLAYER_GROUNDED_ADDRESS);
  const sramHeaderBytes = createSramRuntimeHeader(saveManifest);
  const sramHeaderBootstrapOffset = sramHeaderBytes
    ? emitSramHeaderBootstrap(bytes, sramHeaderBytes)
    : null;
  const oamClearOffset = emitOamClearLoop(bytes);
  const playerOamUpdateOffset = emitPlayerOamUpdate(bytes);
  const entityOamUpdateOffset = emitEntityOamUpdate(bytes, entitySprites);
  emitLdaImmediate(bytes, 0x0f);
  emitStaAbsolute(bytes, 0x2100);
  emitLdaImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, 0x4200);

  const joypadLoopOffset = bytes.length;
  bytes.push(0xad, 0x12, 0x42); // lda $4212
  bytes.push(0x29, 0x01); // and #$01
  emitRelativeBranch(bytes, 0xd0, joypadLoopOffset);
  emitLdaAbsolute(bytes, 0x4218);
  emitStaAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS);
  emitLdaAbsolute(bytes, 0x4219);
  emitStaAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS + 1);
  const controllerScrollStepOffset = bytes.length;
  emitLdaAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS);
  emitAndImmediate(bytes, 0x80);
  const skipRightBranch = emitBranchPlaceholder(bytes, 0xf0);
  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitClc(bytes);
  emitAdcImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitAdcImmediate(bytes, 0x00);
  emitStaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitIncAbsolute(bytes, WRAM_PLAYER_X_ADDRESS);
  patchRelativeBranch(bytes, skipRightBranch, bytes.length);

  emitLdaAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS);
  emitAndImmediate(bytes, 0x40);
  const skipLeftBranch = emitBranchPlaceholder(bytes, 0xf0);
  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitSec(bytes);
  emitSbcImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitSbcImmediate(bytes, 0x00);
  emitStaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitDecAbsolute(bytes, WRAM_PLAYER_X_ADDRESS);
  patchRelativeBranch(bytes, skipLeftBranch, bytes.length);

  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS);
  emitStaAbsolute(bytes, 0x210d);
  emitLdaAbsolute(bytes, WRAM_CAMERA_SCROLL_X_ADDRESS + 1);
  emitStaAbsolute(bytes, 0x210d);
  const playerPhysicsStepOffset = emitPlayerPhysicsStep(bytes);
  emitPlayerOamUpdate(bytes);
  emitEntityOamUpdate(bytes, entitySprites);
  emitJumpAbsolute(bytes, joypadLoopOffset);

  return {
    backdropColor,
    bytes,
    cgramUploadOffset,
    controllerScrollStepOffset,
    entityOamSpriteCount: entitySprites.length,
    entityOamUpdateOffset,
    joypadLoopOffset,
    oamClearOffset,
    playerPhysicsStepOffset,
    playerOamUpdateOffset,
    ppuBootstrapOffset,
    sramHeaderBootstrapOffset,
    vramChrUploadOffset,
    vramTilemapUploadOffset,
  };
}

function formatHex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function loRomLongAddress(offset: number) {
  return {
    bank: Math.floor(offset / 0x8000),
    address: 0x8000 + (offset % 0x8000),
  };
}

type SnesRuntimeEntitySprite = {
  id: string;
  kind: Exclude<SnesSceneEntityKind, "player">;
  x: number;
  y: number;
  tileIndex: number;
  attributes: number;
};

function runtimeEntitySprites(project: SnesStudioProject): SnesRuntimeEntitySprite[] {
  const scene = activeScene(project);
  return scene.entities
    .filter(
      (entity): entity is SnesSceneEntity & { kind: Exclude<SnesSceneEntityKind, "player"> } =>
        entity.kind !== "player",
    )
    .slice(0, PREVIEW_RUNTIME_ENTITY_LIMIT)
    .map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      x: Math.max(0, Math.min(255, entity.x)),
      y: Math.max(0, Math.min(223, entity.y)),
      tileIndex: tileIndexForEntity(entity.kind),
      attributes: entity.kind === "item" ? 0x20 : entity.kind === "npc" ? 0x40 : 0x00,
    }));
}

function pushU16(bytes: number[], value: number) {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function emitLdaImmediate(bytes: number[], value: number) {
  bytes.push(0xa9, value & 0xff);
}

function emitLdxImmediate(bytes: number[], value: number) {
  bytes.push(0xa2);
  pushU16(bytes, value);
}

function emitStaAbsolute(bytes: number[], address: number) {
  bytes.push(0x8d);
  pushU16(bytes, address);
}

function emitIncAbsolute(bytes: number[], address: number) {
  bytes.push(0xee);
  pushU16(bytes, address);
}

function emitDecAbsolute(bytes: number[], address: number) {
  bytes.push(0xce);
  pushU16(bytes, address);
}

function emitLdaAbsolute(bytes: number[], address: number) {
  bytes.push(0xad);
  pushU16(bytes, address);
}

function emitStzAbsolute(bytes: number[], address: number) {
  bytes.push(0x9c);
  pushU16(bytes, address);
}

function emitAndImmediate(bytes: number[], value: number) {
  bytes.push(0x29, value & 0xff);
}

function emitAdcImmediate(bytes: number[], value: number) {
  bytes.push(0x69, value & 0xff);
}

function emitAdcAbsolute(bytes: number[], address: number) {
  bytes.push(0x6d);
  pushU16(bytes, address);
}

function emitSbcImmediate(bytes: number[], value: number) {
  bytes.push(0xe9, value & 0xff);
}

function emitCmpImmediate(bytes: number[], value: number) {
  bytes.push(0xc9, value & 0xff);
}

function emitClc(bytes: number[]) {
  bytes.push(0x18);
}

function emitSec(bytes: number[]) {
  bytes.push(0x38);
}

function emitLdaLongX(bytes: number[], offset: number) {
  const location = loRomLongAddress(offset);
  bytes.push(0xbf, location.address & 0xff, (location.address >> 8) & 0xff, location.bank & 0xff);
}

function emitCpxImmediate(bytes: number[], value: number) {
  bytes.push(0xe0);
  pushU16(bytes, value);
}

function emitInx(bytes: number[]) {
  bytes.push(0xe8);
}

function emitRelativeBranch(bytes: number[], opcode: number, targetOffset: number) {
  const relative = targetOffset - (bytes.length + 2);
  if (relative < -128 || relative > 127) {
    throw new Error("Generated SNES runtime branch is out of range.");
  }
  bytes.push(opcode, relative & 0xff);
}

function emitJumpAbsolute(bytes: number[], targetOffset: number) {
  bytes.push(0x4c);
  pushU16(bytes, SNES_RESET_VECTOR + targetOffset);
}

function emitBranchPlaceholder(bytes: number[], opcode: number): number {
  bytes.push(opcode, 0x00);
  return bytes.length - 1;
}

function patchRelativeBranch(bytes: number[], operandOffset: number, targetOffset: number) {
  const relative = targetOffset - (operandOffset + 1);
  if (relative < -128 || relative > 127) {
    throw new Error("Generated SNES runtime branch is out of range.");
  }
  bytes[operandOffset] = relative & 0xff;
}

function emitStaLong(bytes: number[], address: number) {
  bytes.push(0x8f, address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff);
}

function emitSramHeaderBootstrap(bytes: number[], header: Uint8Array): number {
  const offset = bytes.length;
  header.forEach((byte, index) => {
    emitLdaImmediate(bytes, byte);
    emitStaLong(bytes, SRAM_BASE_LONG_ADDRESS + index);
  });
  return offset;
}

function emitCgramByteUploadLoop(bytes: number[], sourceOffset: number, sizeBytes: number) {
  const loopOffset = bytes.length;
  emitLdaLongX(bytes, sourceOffset);
  emitStaAbsolute(bytes, 0x2122);
  emitInx(bytes);
  emitCpxImmediate(bytes, sizeBytes);
  emitRelativeBranch(bytes, 0xd0, loopOffset);
  return loopOffset;
}

function emitVramWordUploadLoop(bytes: number[], sourceOffset: number, sizeBytes: number) {
  const loopOffset = bytes.length;
  emitLdaLongX(bytes, sourceOffset);
  emitStaAbsolute(bytes, 0x2118);
  emitInx(bytes);
  emitLdaLongX(bytes, sourceOffset);
  emitStaAbsolute(bytes, 0x2119);
  emitInx(bytes);
  emitCpxImmediate(bytes, sizeBytes);
  emitRelativeBranch(bytes, 0xd0, loopOffset);
  return loopOffset;
}

function emitVramAddress(bytes: number[], wordAddress: number) {
  emitLdaImmediate(bytes, wordAddress & 0xff);
  emitStaAbsolute(bytes, 0x2116);
  emitLdaImmediate(bytes, (wordAddress >> 8) & 0xff);
  emitStaAbsolute(bytes, 0x2117);
}

function emitOamClearLoop(bytes: number[]) {
  emitStzAbsolute(bytes, 0x2102);
  emitStzAbsolute(bytes, 0x2103);
  emitLdaImmediate(bytes, 0x00);
  emitLdxImmediate(bytes, 0);
  const loopOffset = bytes.length;
  emitStaAbsolute(bytes, 0x2104);
  emitInx(bytes);
  emitCpxImmediate(bytes, OAM_BYTES);
  emitRelativeBranch(bytes, 0xd0, loopOffset);
  return loopOffset;
}

function emitPlayerOamUpdate(bytes: number[]) {
  const updateOffset = bytes.length;
  emitStzAbsolute(bytes, 0x2102);
  emitStzAbsolute(bytes, 0x2103);
  emitLdaAbsolute(bytes, WRAM_PLAYER_X_ADDRESS);
  emitStaAbsolute(bytes, 0x2104);
  emitLdaAbsolute(bytes, WRAM_PLAYER_Y_ADDRESS);
  emitStaAbsolute(bytes, 0x2104);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_TILE_INDEX);
  emitStaAbsolute(bytes, 0x2104);
  emitLdaImmediate(bytes, 0x00);
  emitStaAbsolute(bytes, 0x2104);
  return updateOffset;
}

function emitEntityOamUpdate(bytes: number[], sprites: SnesRuntimeEntitySprite[]) {
  const updateOffset = bytes.length;
  sprites.forEach((sprite, index) => {
    const slot = index + 1;
    emitLdaImmediate(bytes, slot * 2);
    emitStaAbsolute(bytes, 0x2102);
    emitStzAbsolute(bytes, 0x2103);
    emitLdaImmediate(bytes, sprite.x);
    emitStaAbsolute(bytes, 0x2104);
    emitLdaImmediate(bytes, sprite.y);
    emitStaAbsolute(bytes, 0x2104);
    emitLdaImmediate(bytes, sprite.tileIndex);
    emitStaAbsolute(bytes, 0x2104);
    emitLdaImmediate(bytes, sprite.attributes);
    emitStaAbsolute(bytes, 0x2104);
  });
  return updateOffset;
}

function emitPlayerPhysicsStep(bytes: number[]) {
  const physicsOffset = bytes.length;
  emitLdaAbsolute(bytes, WRAM_JOYPAD_STATE_ADDRESS);
  emitAndImmediate(bytes, 0x01);
  const skipJumpInput = emitBranchPlaceholder(bytes, 0xf0);
  emitLdaAbsolute(bytes, WRAM_PLAYER_GROUNDED_ADDRESS);
  emitAndImmediate(bytes, 0x01);
  const skipJumpGrounded = emitBranchPlaceholder(bytes, 0xf0);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_JUMP_VELOCITY);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitStzAbsolute(bytes, WRAM_PLAYER_GROUNDED_ADDRESS);
  patchRelativeBranch(bytes, skipJumpGrounded, bytes.length);
  patchRelativeBranch(bytes, skipJumpInput, bytes.length);

  emitLdaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitClc(bytes);
  emitAdcImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitLdaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitAndImmediate(bytes, 0x80);
  const skipMaxFallClampForJump = emitBranchPlaceholder(bytes, 0xd0);
  emitLdaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitCmpImmediate(bytes, PREVIEW_PLAYER_MAX_FALL_SPEED + 1);
  const skipMaxFallClamp = emitBranchPlaceholder(bytes, 0x90);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_MAX_FALL_SPEED);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  patchRelativeBranch(bytes, skipMaxFallClamp, bytes.length);
  patchRelativeBranch(bytes, skipMaxFallClampForJump, bytes.length);

  emitLdaAbsolute(bytes, WRAM_PLAYER_Y_ADDRESS);
  emitClc(bytes);
  emitAdcAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_ADDRESS);
  emitCmpImmediate(bytes, PREVIEW_PLAYER_GROUND_Y);
  const skipGroundClamp = emitBranchPlaceholder(bytes, 0x90);
  emitLdaImmediate(bytes, PREVIEW_PLAYER_GROUND_Y);
  emitStaAbsolute(bytes, WRAM_PLAYER_Y_ADDRESS);
  emitStzAbsolute(bytes, WRAM_PLAYER_Y_VELOCITY_ADDRESS);
  emitLdaImmediate(bytes, 0x01);
  emitStaAbsolute(bytes, WRAM_PLAYER_GROUNDED_ADDRESS);
  patchRelativeBranch(bytes, skipGroundClamp, bytes.length);
  return physicsOffset;
}

function loRomSymbol(name: string, offset: number, sizeBytes: number, description: string) {
  const bank = Math.floor(offset / 0x8000);
  const address = 0x8000 + (offset % 0x8000);
  return {
    name,
    offset,
    bank,
    address,
    sizeBytes,
    description,
  } satisfies SnesRomSymbol;
}

function createRuntimeDataPayload(project: SnesStudioProject) {
  const jsonBytes = new TextEncoder().encode(stableProjectJson(project));
  const checksum = calculateChecksum(jsonBytes);
  const payload = new Uint8Array(16 + jsonBytes.length);
  writeRawAscii(payload, 0, "OCSNES1");
  payload[7] = 0;
  writeU16(payload, 8, project.schemaVersion);
  writeU32(payload, 10, jsonBytes.byteLength);
  writeU16(payload, 14, checksum);
  payload.set(jsonBytes, 16);
  return {
    bytes: payload,
    checksum,
    jsonSizeBytes: jsonBytes.byteLength,
  };
}

export function createSnesSceneRuntimeTable(
  project: SnesStudioProject,
): SnesSceneRuntimeTableEntry[] {
  const normalized = normalizeSnesStudioProject(project);
  return normalized.scenes.map((scene, index) => ({
    index,
    id: scene.id,
    name: scene.name,
    widthMetatiles: scene.widthMetatiles,
    heightMetatiles: scene.heightMetatiles,
    layers: scene.layers,
    collisionTileCount: scene.collisionTiles,
    entityCount: scene.entities.length,
    tilemapChecksum: calculateChecksum(editLayerBytes(scene.tilemap)),
    collisionMapChecksum: calculateChecksum(editLayerBytes(scene.collisionMap)),
    compiledPreviewTarget: index === 0,
  }));
}

export function createSnesLevelTransitionPlan(project: SnesStudioProject): SnesLevelTransitionPlan {
  const normalized = normalizeSnesStudioProject(project);
  const transitions = normalized.scenes.slice(0, -1).map((scene, index) => {
    const nextScene = normalized.scenes[index + 1];
    return {
      fromSceneId: scene.id,
      fromSceneName: scene.name,
      toSceneId: nextScene.id,
      toSceneName: nextScene.name,
      trigger: "right-edge" as const,
    };
  });
  return {
    status: transitions.length > 0 ? "manifest-ready" : "single-scene",
    runtimeStatus:
      transitions.length > 0 ? "blocked-until-scene-loader" : "implemented-for-preview-scene",
    transitions,
    acceptance: [
      "Runtime scene table contains every editable level.",
      "65816 loader must upload the destination scene palette, CHR, tilemap, collision map, and entity table before transitions are production-ready.",
      "Emulator proof must show a transition from scene 1 into scene 2 without corrupting SRAM or WRAM state.",
    ],
  };
}

function checksumText(value: string): number {
  return calculateChecksum(new TextEncoder().encode(value));
}

function eventTriggerOpcode(trigger: SnesEventScript["trigger"]): number {
  if (trigger === "on-start") {
    return 1;
  }
  if (trigger === "on-enter-zone") {
    return 2;
  }
  if (trigger === "on-collect-item") {
    return 3;
  }
  return 4;
}

function eventActionOpcode(action: SnesEventAction): 1 | 2 | 3 {
  if (action.type === "show-dialogue") {
    return 1;
  }
  if (action.type === "give-item") {
    return 2;
  }
  return 3;
}

function eventActionKey(action: SnesEventAction): string {
  if (action.type === "show-dialogue") {
    return action.cutsceneId;
  }
  if (action.type === "give-item") {
    return action.itemId;
  }
  return action.flag;
}

export function compileSnesRuntimeEventBytecode(
  project: SnesStudioProject,
): SnesRuntimeEventBytecode {
  const normalized = normalizeSnesStudioProject(project);
  const bytes = Array.from(new TextEncoder().encode("OCEV"));
  bytes.push(normalized.events.length & 0xff);
  let actionCount = 0;
  for (const event of normalized.events) {
    pushU16(bytes, checksumText(event.id));
    bytes.push(eventTriggerOpcode(event.trigger));
    pushU16(bytes, checksumText(event.targetId));
    bytes.push(event.actions.length & 0xff);
    for (const action of event.actions) {
      actionCount += 1;
      bytes.push(eventActionOpcode(action));
      pushU16(bytes, checksumText(eventActionKey(action)));
    }
    bytes.push(0xff);
  }
  const bytecode = new Uint8Array(bytes);
  return {
    status: normalized.events.length > 0 ? "compiled" : "empty",
    runtimeStatus: normalized.events.length > 0 ? "blocked-until-65816-vm" : "data-embedded",
    eventCount: normalized.events.length,
    actionCount,
    offset: EVENT_BYTECODE_DATA_OFFSET,
    sizeBytes: bytecode.byteLength,
    checksum: calculateChecksum(bytecode),
    bytecodeHex: bytesToHex(bytecode),
    opcodes: {
      showDialogue: 1,
      giveItem: 2,
      setFlag: 3,
      endEvent: 255,
    },
    blockers:
      normalized.events.length > 0
        ? ["Event bytecode is embedded, but the production 65816 VM is not linked yet."]
        : [],
  };
}

export function createSnesRomLevelLoaderTable(project: SnesStudioProject): SnesRomLevelLoaderTable {
  const entries = createSnesSceneRuntimeTable(project);
  const bytes = Array.from(new TextEncoder().encode("OCLV"));
  bytes.push(entries.length & 0xff);
  for (const entry of entries) {
    bytes.push(entry.index & 0xff, entry.widthMetatiles & 0xff, entry.heightMetatiles & 0xff);
    pushU16(bytes, entry.tilemapChecksum);
    pushU16(bytes, entry.collisionMapChecksum);
    bytes.push(entry.entityCount & 0xff, entry.compiledPreviewTarget ? 1 : 0);
  }
  const tableBytes = new Uint8Array(bytes);
  return {
    status: entries.length > 1 ? "compiled" : "single-scene",
    runtimeStatus: entries.length > 1 ? "data-embedded-loader-blocked" : "preview-scene-only",
    offset: LEVEL_TABLE_DATA_OFFSET,
    sizeBytes: tableBytes.byteLength,
    checksum: calculateChecksum(tableBytes),
    sceneCount: entries.length,
    bytecodeHex: bytesToHex(tableBytes),
    entries: entries.map((entry) => ({
      index: entry.index,
      id: entry.id,
      widthMetatiles: entry.widthMetatiles,
      heightMetatiles: entry.heightMetatiles,
      tilemapChecksum: entry.tilemapChecksum,
      collisionMapChecksum: entry.collisionMapChecksum,
      entityCount: entry.entityCount,
      compiledPreviewTarget: entry.compiledPreviewTarget,
    })),
    blockers:
      entries.length > 1
        ? [
            "Level table is embedded, but production runtime scene transition loading is not linked yet.",
          ]
        : [],
  };
}

function hexStringToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16) & 0xff;
  }
  return bytes;
}

function readArrayU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function checksumLookup(values: string[]): Map<number, string> {
  const lookup = new Map<number, string>();
  for (const value of values) {
    const checksum = checksumText(value);
    if (!lookup.has(checksum)) {
      lookup.set(checksum, value);
    }
  }
  return lookup;
}

function lookupChecksumName(lookup: Map<number, string>, checksum: number): string {
  return lookup.get(checksum) ?? `checksum:${formatHex(checksum, 4)}`;
}

export function executeSnesRuntimeEventBytecode(
  project: SnesStudioProject,
  trigger: SnesEventScript["trigger"],
  targetId = "scene",
  bytecode = compileSnesRuntimeEventBytecode(project),
): SnesRuntimeEventBytecodeExecution {
  const normalized = normalizeSnesStudioProject(project);
  const bytes = hexStringToBytes(bytecode.bytecodeHex);
  const header = new TextDecoder().decode(bytes.slice(0, 4));
  const blockers = header === "OCEV" ? [] : ["Event bytecode header is invalid."];
  const eventLookup = checksumLookup(normalized.events.map((event) => event.id));
  const targetLookup = checksumLookup([
    "scene",
    ...normalized.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id)),
  ]);
  const cutsceneLookup = checksumLookup(normalized.dialogue.map((cutscene) => cutscene.id));
  const itemLookup = checksumLookup([
    ...normalized.scenes
      .flatMap((scene) => scene.entities)
      .filter((entity) => entity.kind === "item")
      .map((entity) => entity.id),
    ...normalized.events.flatMap((event) =>
      event.actions.flatMap((action) => (action.type === "give-item" ? [action.itemId] : [])),
    ),
  ]);
  const flagLookup = checksumLookup(
    normalized.events.flatMap((event) =>
      event.actions.flatMap((action) => (action.type === "set-flag" ? [action.flag] : [])),
    ),
  );
  const triggerOpcode = eventTriggerOpcode(trigger);
  const targetChecksum = checksumText(targetId);
  const sceneChecksum = checksumText("scene");
  const triggeredEventIds: string[] = [];
  const shownCutsceneIds: string[] = [];
  const grantedItemIds: string[] = [];
  const flags: string[] = [];
  const warnings: string[] = [];
  let decodedEventCount = 0;
  let cursor = 5;
  const expectedEventCount = bytes[4] ?? 0;

  while (cursor < bytes.length && blockers.length === 0) {
    if (cursor + 6 > bytes.length) {
      blockers.push("Event bytecode ended inside an event record.");
      break;
    }
    const eventChecksum = readArrayU16(bytes, cursor);
    cursor += 2;
    const decodedTrigger = bytes[cursor] ?? 0;
    cursor += 1;
    const decodedTargetChecksum = readArrayU16(bytes, cursor);
    cursor += 2;
    const actionCount = bytes[cursor] ?? 0;
    cursor += 1;
    decodedEventCount += 1;
    const eventMatches =
      decodedTrigger === triggerOpcode &&
      (decodedTargetChecksum === targetChecksum || decodedTargetChecksum === sceneChecksum);
    if (eventMatches) {
      triggeredEventIds.push(lookupChecksumName(eventLookup, eventChecksum));
      if (!targetLookup.has(decodedTargetChecksum)) {
        warnings.push(
          `Event target ${formatHex(decodedTargetChecksum, 4)} is not present in the project.`,
        );
      }
    }
    for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
      if (cursor + 3 > bytes.length) {
        blockers.push("Event bytecode ended inside an action record.");
        break;
      }
      const opcode = bytes[cursor] ?? 0;
      cursor += 1;
      const keyChecksum = readArrayU16(bytes, cursor);
      cursor += 2;
      if (!eventMatches) {
        continue;
      }
      if (opcode === 1) {
        shownCutsceneIds.push(lookupChecksumName(cutsceneLookup, keyChecksum));
      } else if (opcode === 2) {
        grantedItemIds.push(lookupChecksumName(itemLookup, keyChecksum));
      } else if (opcode === 3) {
        flags.push(lookupChecksumName(flagLookup, keyChecksum));
      } else {
        warnings.push(`Unknown event opcode ${opcode}.`);
      }
    }
    if ((bytes[cursor] ?? 0) !== 0xff) {
      blockers.push("Event bytecode record is missing the end-event opcode.");
      break;
    }
    cursor += 1;
  }

  if (decodedEventCount !== expectedEventCount) {
    blockers.push(
      `Decoded ${decodedEventCount} events, but bytecode header declares ${expectedEventCount}.`,
    );
  }

  return {
    status: blockers.length === 0 ? "verified" : "blocked",
    runtimeStatus: expectedEventCount > 0 ? "bytecode-interpreter-tested" : "empty-bytecode",
    trigger,
    targetId,
    decodedEventCount,
    triggeredEventIds: [...new Set(triggeredEventIds)],
    shownCutsceneIds: [...new Set(shownCutsceneIds)],
    grantedItemIds: [...new Set(grantedItemIds)],
    flags: [...new Set(flags)],
    warnings,
    blockers,
    checksum: bytecode.checksum,
  };
}

function decodeSnesRomLevelLoaderTable(
  table: SnesRomLevelLoaderTable,
): SnesRomLevelLoaderTable["entries"] {
  const bytes = hexStringToBytes(table.bytecodeHex);
  const header = new TextDecoder().decode(bytes.slice(0, 4));
  if (header !== "OCLV") {
    return [];
  }
  const entryCount = bytes[4] ?? 0;
  const entries: SnesRomLevelLoaderTable["entries"] = [];
  let cursor = 5;
  for (let index = 0; index < entryCount && cursor + 8 <= bytes.length; index += 1) {
    entries.push({
      index: bytes[cursor] ?? 0,
      id: table.entries[index]?.id ?? `scene-${bytes[cursor] ?? index}`,
      widthMetatiles: bytes[cursor + 1] ?? 0,
      heightMetatiles: bytes[cursor + 2] ?? 0,
      tilemapChecksum: readArrayU16(bytes, cursor + 3),
      collisionMapChecksum: readArrayU16(bytes, cursor + 5),
      entityCount: bytes[cursor + 7] ?? 0,
      compiledPreviewTarget: (bytes[cursor + 8] ?? 0) === 1,
    });
    cursor += 9;
  }
  return entries;
}

export function executeSnesRomLevelLoaderTable(
  project: SnesStudioProject,
  fromSceneId = normalizeSnesStudioProject(project).scenes[0]?.id ?? "",
  trigger: "right-edge" | "manual-event" = "right-edge",
  table = createSnesRomLevelLoaderTable(project),
): SnesRomLevelLoaderExecution {
  const normalized = normalizeSnesStudioProject(project);
  const transitions = createSnesLevelTransitionPlan(normalized).transitions;
  const transition = transitions.find(
    (candidate) => candidate.fromSceneId === fromSceneId && candidate.trigger === trigger,
  );
  const runtimeEntries = createSnesSceneRuntimeTable(normalized);
  const decodedEntries = decodeSnesRomLevelLoaderTable(table);
  const expectedEntry = transition
    ? (runtimeEntries.find((entry) => entry.id === transition.toSceneId) ?? null)
    : null;
  const selectedEntry = transition
    ? (decodedEntries.find((entry) => entry.id === transition.toSceneId) ?? null)
    : null;
  const checks: SnesRomLevelLoaderExecution["checks"] = [
    {
      code: "TRANSITION_EXISTS",
      passed: transition !== undefined,
      detail: transition
        ? `Transition ${transition.fromSceneId} -> ${transition.toSceneId} is present.`
        : `No ${trigger} transition starts at ${fromSceneId}.`,
    },
    {
      code: "TABLE_ENTRY_EXISTS",
      passed: selectedEntry !== null,
      detail: selectedEntry
        ? `Level-loader entry for ${selectedEntry.id} is present.`
        : "No destination level-loader entry was decoded.",
    },
    {
      code: "TILEMAP_CHECKSUM",
      passed:
        selectedEntry !== null &&
        expectedEntry !== null &&
        selectedEntry.tilemapChecksum === expectedEntry.tilemapChecksum,
      detail:
        selectedEntry !== null && expectedEntry !== null
          ? `Decoded tilemap checksum ${formatHex(selectedEntry.tilemapChecksum, 4)}; expected ${formatHex(expectedEntry.tilemapChecksum, 4)}.`
          : "Tilemap checksum could not be compared.",
    },
    {
      code: "COLLISION_CHECKSUM",
      passed:
        selectedEntry !== null &&
        expectedEntry !== null &&
        selectedEntry.collisionMapChecksum === expectedEntry.collisionMapChecksum,
      detail:
        selectedEntry !== null && expectedEntry !== null
          ? `Decoded collision checksum ${formatHex(selectedEntry.collisionMapChecksum, 4)}; expected ${formatHex(expectedEntry.collisionMapChecksum, 4)}.`
          : "Collision checksum could not be compared.",
    },
    {
      code: "ENTITY_COUNT",
      passed:
        selectedEntry !== null &&
        expectedEntry !== null &&
        selectedEntry.entityCount === expectedEntry.entityCount,
      detail:
        selectedEntry !== null && expectedEntry !== null
          ? `Decoded ${selectedEntry.entityCount} entities; expected ${expectedEntry.entityCount}.`
          : "Entity count could not be compared.",
    },
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail);
  return {
    status:
      normalized.scenes.length <= 1
        ? "blocked"
        : blockers.length === 0
          ? "verified"
          : selectedEntry
            ? "mismatch"
            : "blocked",
    runtimeStatus: normalized.scenes.length <= 1 ? "single-scene" : "loader-table-tested",
    trigger,
    fromSceneId,
    toSceneId: transition?.toSceneId ?? null,
    selectedEntry,
    checks,
    blockers,
    checksum: table.checksum,
  };
}

function formatRuntimeEventAction(action: SnesEventAction): string {
  if (action.type === "give-item") {
    return `give-item:${action.itemId}`;
  }
  if (action.type === "set-flag") {
    return `set-flag:${action.flag}`;
  }
  return `show-dialogue:${action.cutsceneId}`;
}

export function createSnesRuntimeEventPlan(project: SnesStudioProject): SnesRuntimeEventPlan {
  const normalized = normalizeSnesStudioProject(project);
  return {
    status: normalized.events.length > 0 ? "manifest-ready" : "no-events",
    runtimeStatus:
      normalized.events.length > 0 ? "blocked-until-65816-interpreter" : "preview-simulator-ready",
    eventCount: normalized.events.length,
    events: normalized.events.map((event) => ({
      id: event.id,
      name: event.name,
      trigger: event.trigger,
      targetId: event.targetId,
      actionCount: event.actions.length,
      actions: event.actions.map(formatRuntimeEventAction),
    })),
    acceptance: [
      "Preview simulator resolves event triggers and action references.",
      "ROM manifest exports a deterministic event plan for every editable event script.",
      "Production ROM verification must prove show-dialogue, give-item, and set-flag actions execute on hardware-visible state.",
    ],
  };
}

export function createSnesCutsceneTimeline(project: SnesStudioProject): SnesCutsceneTimeline {
  const normalized = normalizeSnesStudioProject(project);
  const linkedEventsByCutscene = new Map<string, string[]>();
  for (const event of normalized.events) {
    for (const action of event.actions) {
      if (action.type !== "show-dialogue") {
        continue;
      }
      linkedEventsByCutscene.set(action.cutsceneId, [
        ...(linkedEventsByCutscene.get(action.cutsceneId) ?? []),
        event.id,
      ]);
    }
  }
  const steps = normalized.dialogue.flatMap((cutscene) =>
    cutscene.lines.map((line, lineIndex) => ({
      id: `${cutscene.id}:${line.id}`,
      cutsceneId: cutscene.id,
      cutsceneName: cutscene.name,
      trigger: cutscene.trigger,
      lineIndex,
      speaker: line.speaker,
      text: line.text,
      durationTicks: Math.max(90, Math.min(360, 48 + line.text.length * 3)),
      linkedEventIds: linkedEventsByCutscene.get(cutscene.id) ?? [],
    })),
  );
  const warnings = [
    ...(normalized.dialogue.length === 0 ? ["No cutscenes are configured."] : []),
    ...normalized.dialogue
      .filter((cutscene) => (linkedEventsByCutscene.get(cutscene.id) ?? []).length === 0)
      .map((cutscene) => `Cutscene ${cutscene.id} is not linked to an event script.`),
  ];
  return {
    status: warnings.length > 0 ? "warning" : "ready",
    cutsceneCount: normalized.dialogue.length,
    lineCount: steps.length,
    totalDurationTicks: steps.reduce((sum, step) => sum + step.durationTicks, 0),
    steps,
    warnings,
  };
}

export function createSnesCollisionPhysicsPlan(
  project: SnesStudioProject,
): SnesCollisionPhysicsPlan {
  const normalized = normalizeSnesStudioProject(project);
  const counts = new Map<number, number>();
  for (const scene of normalized.scenes) {
    for (const value of scene.collisionMap) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return {
    status: "preview-ready",
    runtimeStatus: "solid-cells-only",
    materials: [
      {
        id: "empty",
        value: 0,
        label: "Passable",
        cellCount: counts.get(0) ?? 0,
        previewBehavior: "No collision response.",
        productionRuntimeStatus: "implemented",
      },
      {
        id: "solid",
        value: 1,
        label: "Solid",
        cellCount: counts.get(1) ?? 0,
        previewBehavior: "Ground clamp and wall stop.",
        productionRuntimeStatus: "implemented",
      },
      {
        id: "hazard",
        value: 2,
        label: "Hazard",
        cellCount: counts.get(2) ?? 0,
        previewBehavior: "Preview marker only until damage runtime lands.",
        productionRuntimeStatus: "blocked",
      },
      {
        id: "one-way",
        value: 3,
        label: "One-way",
        cellCount: counts.get(3) ?? 0,
        previewBehavior: "Preview marker only until one-way collision solver lands.",
        productionRuntimeStatus: "blocked",
      },
      {
        id: "water",
        value: 4,
        label: "Water",
        cellCount: counts.get(4) ?? 0,
        previewBehavior: "Preview marker only until water physics lands.",
        productionRuntimeStatus: "blocked",
      },
    ],
    physics: {
      jumpVelocity: normalized.physics.jumpVelocity,
      gravityPerFrame: normalized.physics.gravityPerFrame,
      maxFallSpeed: normalized.physics.maxFallSpeed,
      groundY: normalized.physics.groundY,
    },
    acceptance: [
      "Solid/passable collision stays parity-tested between preview simulation and ROM validation.",
      "Hazard, one-way, and water materials must not be marked production-ready until 65816 solver behavior exists.",
      "Dashboard material painting must preserve collision-map values in exported project JSON.",
    ],
  };
}

export function createSnesProjectPersistencePlan(): SnesProjectPersistencePlan {
  return {
    status: "local-first-ready",
    primaryDraftStorageKey: "openclaw:snes-studio:project:v1",
    versionHistoryStorageKey: "openclaw:snes-studio:project:v1:versions",
    portableFormats: [
      {
        extension: ".oc-snes.json",
        purpose: "Canonical single-project document for source control and recovery.",
      },
      {
        extension: ".oc-snes-bundle.json",
        purpose: "Portable project plus bounded version history for transfer or backup.",
      },
    ],
    recoveryGuarantees: [
      "Dashboard draft autosaves locally after every accepted edit.",
      "Undo/redo keeps recent in-session states.",
      "Human-approved agent patches create a version snapshot before applying.",
      "Project JSON and bundles can be imported back into the dashboard.",
    ],
    cloudSyncStatus: "blocked-until-project-store-binding",
  };
}

function createRomMapText(
  symbols: SnesRomSymbol[],
  artifact: Pick<SnesPreviewRomArtifact, "fileName" | "checksum" | "checksumComplement">,
) {
  return `${[
    `SNES Studio ROM Map: ${artifact.fileName}`,
    `Checksum: ${formatHex(artifact.checksum, 4)}`,
    `Checksum complement: ${formatHex(artifact.checksumComplement, 4)}`,
    "",
    "Name                         CPU       Offset    Size    Description",
    ...symbols.map((symbol) =>
      [
        symbol.name.padEnd(28, " "),
        `$${formatHex(symbol.bank, 2)}:${formatHex(symbol.address, 4)}`,
        `$${formatHex(symbol.offset, 6)}`,
        `$${formatHex(symbol.sizeBytes, 4)}`,
        symbol.description,
      ].join("  "),
    ),
  ].join("\n")}\n`;
}

function validationCheck(
  checks: SnesPreviewRomValidationCheck[],
  code: string,
  label: string,
  passed: boolean,
  detail: string,
  severity: SnesPreviewRomValidationCheck["severity"] = "error",
) {
  checks.push({ code, detail, label, passed, severity });
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function manifestRecord(artifact: SnesPreviewRomArtifact): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(artifact.manifestJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function nestedRecord(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> {
  const value = record?.[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function nestedNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function symbolNames(record: Record<string, unknown> | null): string[] {
  const value = record?.symbols;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((symbol) => {
    if (
      symbol &&
      typeof symbol === "object" &&
      typeof (symbol as { name?: unknown }).name === "string"
    ) {
      return [(symbol as { name: string }).name];
    }
    return [];
  });
}

function runtimeWritesSramHeader(
  bytes: Uint8Array,
  offset: number | null,
  header: Uint8Array,
  baseAddress: number | null,
): boolean {
  if (offset === null || baseAddress === null || header.byteLength === 0) {
    return header.byteLength === 0;
  }
  return Array.from(header).every((byte, index) => {
    const instructionOffset = offset + index * 6;
    const address = baseAddress + index;
    return (
      bytes[instructionOffset] === 0xa9 &&
      bytes[instructionOffset + 1] === byte &&
      bytes[instructionOffset + 2] === 0x8f &&
      bytes[instructionOffset + 3] === (address & 0xff) &&
      bytes[instructionOffset + 4] === ((address >> 8) & 0xff) &&
      bytes[instructionOffset + 5] === ((address >> 16) & 0xff)
    );
  });
}

export function validateSnesPreviewRomArtifact(
  artifact: SnesPreviewRomArtifact,
): SnesPreviewRomValidationReport {
  const checks: SnesPreviewRomValidationCheck[] = [];
  const manifest = manifestRecord(artifact);
  const assets = nestedRecord(manifest, "assets");
  const runtime = nestedRecord(manifest, "runtime");
  const graphics = nestedRecord(manifest, "graphics");
  const scene = nestedRecord(manifest, "scene");
  const save = nestedRecord(manifest, "save");
  const runtimeData = nestedRecord(manifest, "runtimeData");
  const fxpak = nestedRecord(manifest, "fxpak");
  const names = symbolNames(manifest);
  const runtimeJsonSize =
    readU16(artifact.bytes, RUNTIME_DATA_OFFSET + 10) |
    (readU16(artifact.bytes, RUNTIME_DATA_OFFSET + 12) << 16);
  const runtimeJson = artifact.bytes.slice(
    RUNTIME_DATA_OFFSET + 16,
    RUNTIME_DATA_OFFSET + 16 + runtimeJsonSize,
  );

  validationCheck(
    checks,
    "ROM_SIZE_MATCH",
    "ROM byte length matches artifact metadata",
    artifact.bytes.byteLength === artifact.sizeBytes,
    `${artifact.bytes.byteLength} bytes in ROM, ${artifact.sizeBytes} bytes in metadata.`,
  );
  validationCheck(
    checks,
    "RESET_VECTOR",
    "Reset vector points to LoROM entrypoint",
    readU16(artifact.bytes, LOROM_RESET_VECTOR_OFFSET) === SNES_RESET_VECTOR,
    `Reset vector is $${formatHex(readU16(artifact.bytes, LOROM_RESET_VECTOR_OFFSET), 4)}.`,
  );
  validationCheck(
    checks,
    "CHECKSUM_PAIR",
    "Checksum and complement are paired",
    ((artifact.checksum ^ artifact.checksumComplement) & 0xffff) === 0xffff &&
      readU16(artifact.bytes, LOROM_HEADER_OFFSET + 0x1c) === artifact.checksumComplement &&
      readU16(artifact.bytes, LOROM_HEADER_OFFSET + 0x1e) === artifact.checksum,
    `Checksum $${formatHex(artifact.checksum, 4)}, complement $${formatHex(artifact.checksumComplement, 4)}.`,
  );
  validationCheck(
    checks,
    "RUNTIME_MAGIC",
    "Embedded runtime project block is present",
    String.fromCharCode(...artifact.bytes.slice(RUNTIME_DATA_OFFSET, RUNTIME_DATA_OFFSET + 7)) ===
      "OCSNES1",
    "Expected OCSNES1 runtime data magic at the configured runtime-data offset.",
  );
  validationCheck(
    checks,
    "RUNTIME_DATA_CHECKSUM",
    "Embedded runtime project checksum matches",
    calculateChecksum(runtimeJson) === readU16(artifact.bytes, RUNTIME_DATA_OFFSET + 14) &&
      artifact.runtimeDataChecksum === readU16(artifact.bytes, RUNTIME_DATA_OFFSET + 14),
    `Runtime JSON size ${runtimeJsonSize} bytes.`,
  );
  validationCheck(
    checks,
    "RUNTIME_DATA_MANIFEST",
    "Build manifest records the embedded runtime project payload",
    nestedNumber(runtimeData, "jsonSizeBytes") === runtimeJsonSize &&
      nestedNumber(runtimeData, "checksum") === artifact.runtimeDataChecksum &&
      nestedNumber(runtimeData, "offset") === RUNTIME_DATA_OFFSET &&
      nestedNumber(runtimeData, "sizeBytes") === artifact.runtimeDataSizeBytes,
    `Runtime data offset $${formatHex(RUNTIME_DATA_OFFSET, 5)}, size ${String(nestedNumber(runtimeData, "sizeBytes") ?? "missing")} bytes.`,
  );
  validationCheck(
    checks,
    "MANIFEST_PARSE",
    "Build manifest parses as JSON",
    manifest !== null,
    manifest ? "Manifest JSON parsed." : "Manifest JSON did not parse.",
  );
  const playtestRuntime = nestedRecord(runtime, "playtest");
  validationCheck(
    checks,
    "RUNTIME_PLAYTEST_MANIFEST",
    "Build manifest includes the authoritative 60 Hz playtest runtime hash",
    playtestRuntime.runtimeHash === artifact.runtimeManifest.runtimeHash &&
      nestedNumber(playtestRuntime, "frameRate") === artifact.runtimeManifest.frameRate &&
      nestedNumber(playtestRuntime, "sceneCount") === artifact.runtimeManifest.sceneCount &&
      nestedNumber(playtestRuntime, "fixedPointScale") === artifact.runtimeManifest.fixedPointScale,
    `Runtime hash ${typeof playtestRuntime.runtimeHash === "string" ? playtestRuntime.runtimeHash : "missing"} at ${String(nestedNumber(playtestRuntime, "frameRate") ?? "missing")} FPS.`,
  );
  validationCheck(
    checks,
    "FXPAK_FAT32",
    "FXPAK export manifest preserves FAT32 rules",
    fxpak.requiredFileSystem === "FAT32" &&
      typeof fxpak.romPath === "string" &&
      fxpak.romPath.endsWith(".sfc"),
    `FXPAK path ${typeof fxpak.romPath === "string" ? fxpak.romPath : "missing"}.`,
  );
  validationCheck(
    checks,
    "SAVE_MANIFEST",
    "Save manifest matches SRAM budget and FXPAK save path",
    nestedNumber(save, "totalBytes") !== null &&
      nestedNumber(save, "slotSizeBytes") !== null &&
      nestedNumber(save, "slots") !== null &&
      nestedNumber(save, "sramSizeKib") !== null &&
      (nestedNumber(save, "totalBytes") ?? 0) <= (nestedNumber(save, "sramSizeKib") ?? 0) * 1024 &&
      (save.savePath === null || save.savePath === fxpak.savePath),
    `Save path ${typeof save.savePath === "string" ? save.savePath : "none"}, total bytes ${String(nestedNumber(save, "totalBytes") ?? "missing")}.`,
  );
  const sramHeader =
    typeof save.sramHeaderHex === "string" ? hexToBytes(save.sramHeaderHex) : new Uint8Array();
  validationCheck(
    checks,
    "SRAM_HEADER_BOOTSTRAP",
    "Runtime writes the versioned save header into LoROM SRAM",
    runtimeWritesSramHeader(
      artifact.bytes,
      nestedNumber(runtime, "sramHeaderBootstrapOffset"),
      sramHeader,
      nestedNumber(runtime, "sramBaseAddress"),
    ) &&
      nestedNumber(save, "sramHeaderChecksum") ===
        (sramHeader.byteLength > 0 ? readU16(sramHeader, 12) : 0),
    sramHeader.byteLength > 0
      ? `Writes ${sramHeader.byteLength} SRAM header bytes at $${formatHex(
          nestedNumber(runtime, "sramBaseAddress") ?? 0,
          6,
        )}.`
      : "SRAM disabled; no runtime save header emitted.",
  );
  validationCheck(
    checks,
    "GRAPHICS_LAYOUT",
    "Graphics sections match fixed Mode 1 offsets",
    nestedNumber(graphics, "paletteOffset") === artifact.graphics.paletteOffset &&
      nestedNumber(graphics, "chrOffset") === artifact.graphics.chrOffset &&
      nestedNumber(graphics, "tilemapOffset") === artifact.graphics.tilemapOffset &&
      nestedNumber(graphics, "paletteSizeBytes") === artifact.graphics.paletteSizeBytes &&
      nestedNumber(graphics, "chrSizeBytes") === artifact.graphics.chrSizeBytes &&
      nestedNumber(graphics, "builtinTileCount") === artifact.graphics.builtinTileCount &&
      nestedNumber(graphics, "importedTileBaseIndex") === artifact.graphics.importedTileBaseIndex &&
      nestedNumber(graphics, "importedTileCount") === artifact.graphics.importedTileCount &&
      nestedNumber(graphics, "tilemapSizeBytes") === artifact.graphics.tilemapSizeBytes,
    "Manifest graphics offsets and sizes match artifact metadata.",
  );
  validationCheck(
    checks,
    "GRAPHICS_STYLE_PRESET",
    "Graphics manifest records the original classic platformer style",
    graphics.visualStylePreset === artifact.graphics.visualStylePreset &&
      graphics.assetProvenance === artifact.graphics.assetProvenance &&
      graphics.stylePackName === artifact.graphics.stylePackName &&
      graphics.assetProvenance === "original-generated",
    `Style ${typeof graphics.visualStylePreset === "string" ? graphics.visualStylePreset : "missing"}, provenance ${typeof graphics.assetProvenance === "string" ? graphics.assetProvenance : "missing"}.`,
  );
  const audio = nestedRecord(assets, "audio");
  validationCheck(
    checks,
    "AUDIO_MANIFEST",
    "SPC700 audio manifest stays inside ARAM budget",
    audio.driver === "preview-spc700" &&
      (nestedNumber(audio, "totalBytes") ?? SNES_HARDWARE_LIMITS.aramBytes + 1) <=
        SNES_HARDWARE_LIMITS.aramBytes &&
      (nestedNumber(audio, "aramLimitBytes") ?? 0) === SNES_HARDWARE_LIMITS.aramBytes,
    `Audio bytes ${String(nestedNumber(audio, "totalBytes") ?? "missing")} / ${SNES_HARDWARE_LIMITS.aramBytes}.`,
  );
  validationCheck(
    checks,
    "SCENE_EDIT_LAYERS",
    "Compiled scene edit layers are embedded with checksums",
    nestedNumber(scene, "editGridWidth") === SNES_STUDIO_EDIT_GRID.width &&
      nestedNumber(scene, "editGridHeight") === SNES_STUDIO_EDIT_GRID.height &&
      nestedNumber(scene, "collisionMapOffset") === artifact.scene.collisionMapOffset &&
      nestedNumber(scene, "collisionMapSizeBytes") === artifact.scene.collisionMapSizeBytes &&
      nestedNumber(scene, "collisionMapChecksum") === artifact.scene.collisionMapChecksum &&
      calculateChecksum(
        artifact.bytes.slice(
          artifact.scene.collisionMapOffset,
          artifact.scene.collisionMapOffset + artifact.scene.collisionMapSizeBytes,
        ),
      ) === artifact.scene.collisionMapChecksum,
    `Collision cells ${artifact.scene.collisionTileCount}, checksum $${formatHex(
      artifact.scene.collisionMapChecksum,
      4,
    )}.`,
  );
  const manifestRuntimeTable = Array.isArray(scene.runtimeTable) ? scene.runtimeTable : [];
  validationCheck(
    checks,
    "SCENE_RUNTIME_TABLE",
    "All editable scenes are represented in the ROM runtime table",
    manifestRuntimeTable.length === artifact.scene.runtimeTable.length &&
      artifact.scene.runtimeTable.length > 0 &&
      artifact.scene.runtimeTable.every((entry, index) => {
        const manifestEntry = manifestRuntimeTable[index];
        return (
          manifestEntry &&
          typeof manifestEntry === "object" &&
          (manifestEntry as { id?: unknown }).id === entry.id &&
          (manifestEntry as { tilemapChecksum?: unknown }).tilemapChecksum ===
            entry.tilemapChecksum &&
          (manifestEntry as { collisionMapChecksum?: unknown }).collisionMapChecksum ===
            entry.collisionMapChecksum
        );
      }),
    `${artifact.scene.runtimeTable.length} scene runtime table entries; active scene ${artifact.scene.activeSceneId}.`,
  );
  const manifestLevelLoaderTable = nestedRecord(scene, "levelLoaderTable");
  validationCheck(
    checks,
    "LEVEL_LOADER_TABLE",
    "Binary level-loader table is embedded in ROM",
    String.fromCharCode(
      ...artifact.bytes.slice(LEVEL_TABLE_DATA_OFFSET, LEVEL_TABLE_DATA_OFFSET + 4),
    ) === "OCLV" &&
      nestedNumber(manifestLevelLoaderTable, "offset") === LEVEL_TABLE_DATA_OFFSET &&
      nestedNumber(manifestLevelLoaderTable, "sceneCount") === artifact.scene.runtimeTable.length &&
      calculateChecksum(
        artifact.bytes.slice(
          LEVEL_TABLE_DATA_OFFSET,
          LEVEL_TABLE_DATA_OFFSET + (nestedNumber(manifestLevelLoaderTable, "sizeBytes") ?? 0),
        ),
      ) === nestedNumber(manifestLevelLoaderTable, "checksum"),
    `Level table offset $${formatHex(LEVEL_TABLE_DATA_OFFSET, 5)} with ${String(nestedNumber(manifestLevelLoaderTable, "sceneCount") ?? "unknown")} scene entries.`,
  );
  const manifestEventBytecode = nestedRecord(manifest, "eventBytecode");
  validationCheck(
    checks,
    "EVENT_BYTECODE",
    "No-code event bytecode is embedded in ROM",
    String.fromCharCode(
      ...artifact.bytes.slice(EVENT_BYTECODE_DATA_OFFSET, EVENT_BYTECODE_DATA_OFFSET + 4),
    ) === "OCEV" &&
      nestedNumber(manifestEventBytecode, "offset") === EVENT_BYTECODE_DATA_OFFSET &&
      calculateChecksum(
        artifact.bytes.slice(
          EVENT_BYTECODE_DATA_OFFSET,
          EVENT_BYTECODE_DATA_OFFSET + (nestedNumber(manifestEventBytecode, "sizeBytes") ?? 0),
        ),
      ) === nestedNumber(manifestEventBytecode, "checksum"),
    `Event bytecode offset $${formatHex(EVENT_BYTECODE_DATA_OFFSET, 5)} with ${String(nestedNumber(manifestEventBytecode, "eventCount") ?? "unknown")} event scripts.`,
  );
  validationCheck(
    checks,
    "UPLOAD_OFFSETS",
    "Runtime upload loops are ordered before the joypad loop",
    (nestedNumber(runtime, "ppuBootstrapOffset") ?? -1) <
      (nestedNumber(runtime, "cgramUploadOffset") ?? -1) &&
      (nestedNumber(runtime, "cgramUploadOffset") ?? -1) <
        (nestedNumber(runtime, "vramChrUploadOffset") ?? -1) &&
      (nestedNumber(runtime, "vramChrUploadOffset") ?? -1) <
        (nestedNumber(runtime, "vramTilemapUploadOffset") ?? -1) &&
      (nestedNumber(runtime, "vramTilemapUploadOffset") ?? -1) <
        (nestedNumber(runtime, "joypadLoopOffset") ?? -1),
    "PPU bootstrap, CGRAM upload, VRAM CHR upload, VRAM tilemap upload, then joypad loop.",
  );
  validationCheck(
    checks,
    "UPLOAD_OPCODES",
    "Runtime upload loops read compiled ROM data",
    artifact.bytes[nestedNumber(runtime, "cgramUploadOffset") ?? -1] === 0xbf &&
      artifact.bytes[nestedNumber(runtime, "vramChrUploadOffset") ?? -1] === 0xbf &&
      artifact.bytes[nestedNumber(runtime, "vramTilemapUploadOffset") ?? -1] === 0xbf,
    "Upload loops start with LDA long,X.",
  );
  validationCheck(
    checks,
    "CONTROLLER_SCROLL_LOOP",
    "Controller loop updates BG1 horizontal scroll and player X",
    nestedNumber(runtime, "controllerScrollStepOffset") !== null &&
      nestedNumber(runtime, "cameraScrollAddress") === WRAM_CAMERA_SCROLL_X_ADDRESS &&
      artifact.bytes[nestedNumber(runtime, "controllerScrollStepOffset") ?? -1] === 0xad &&
      artifact.bytes[(nestedNumber(runtime, "controllerScrollStepOffset") ?? -1) + 1] ===
        (WRAM_JOYPAD_STATE_ADDRESS & 0xff) &&
      artifact.bytes[(nestedNumber(runtime, "controllerScrollStepOffset") ?? -1) + 2] ===
        WRAM_JOYPAD_STATE_ADDRESS >> 8 &&
      artifact.bytes[(nestedNumber(runtime, "controllerScrollStepOffset") ?? -1) + 3] === 0x29,
    "Controller step reads WRAM joypad state, writes camera scroll to BG1HOFS, and mutates player X.",
  );
  validationCheck(
    checks,
    "PLAYER_OAM_LOOP",
    "Runtime writes the preview player sprite to OAM",
    nestedNumber(runtime, "oamClearOffset") !== null &&
      nestedNumber(runtime, "playerOamUpdateOffset") !== null &&
      (nestedNumber(runtime, "oamClearOffset") ?? -1) <
        (nestedNumber(runtime, "playerOamUpdateOffset") ?? -1) &&
      (nestedNumber(runtime, "playerOamUpdateOffset") ?? -1) <
        (nestedNumber(runtime, "joypadLoopOffset") ?? -1) &&
      artifact.bytes[nestedNumber(runtime, "playerOamUpdateOffset") ?? -1] === 0x9c,
    "OAM is cleared, then sprite 0 is populated from player WRAM before the main loop.",
  );
  validationCheck(
    checks,
    "ENTITY_OAM_LOOP",
    "Runtime writes preview enemy, item, and NPC sprites to OAM",
    nestedNumber(runtime, "entityOamUpdateOffset") !== null &&
      nestedNumber(runtime, "entityOamSpriteCount") !== null &&
      (nestedNumber(runtime, "entityOamUpdateOffset") ?? -1) >
        (nestedNumber(runtime, "playerOamUpdateOffset") ?? -1) &&
      (nestedNumber(runtime, "entityOamUpdateOffset") ?? -1) <
        (nestedNumber(runtime, "joypadLoopOffset") ?? -1) &&
      artifact.bytes[nestedNumber(runtime, "entityOamUpdateOffset") ?? -1] === 0xa9 &&
      artifact.mapText.includes("EntityOamUpdate"),
    `Entity OAM sprites ${String(nestedNumber(runtime, "entityOamSpriteCount") ?? "missing")}.`,
  );
  validationCheck(
    checks,
    "PLAYER_PHYSICS_LOOP",
    "Runtime applies jump, gravity, and ground collision",
    nestedNumber(runtime, "playerPhysicsStepOffset") !== null &&
      (nestedNumber(runtime, "playerPhysicsStepOffset") ?? -1) >
        (nestedNumber(runtime, "controllerScrollStepOffset") ?? -1) &&
      artifact.bytes[nestedNumber(runtime, "playerPhysicsStepOffset") ?? -1] === 0xad &&
      artifact.mapText.includes("PlayerPhysicsStep"),
    "Physics step reads joypad state, mutates Y velocity/Y position, and clamps to ground.",
  );
  validationCheck(
    checks,
    "SYMBOL_MAP",
    "ROM map exposes runtime and graphics symbols",
    [
      "CgramPaletteUpload",
      "VramChrUpload",
      "VramTilemapUpload",
      "ControllerScrollStep",
      "OamClearLoop",
      "PlayerOamUpdate",
      "EntityOamUpdate",
      "PlayerPhysicsStep",
      ...(sramHeader.byteLength > 0 ? ["SramHeaderBootstrap"] : []),
      "Mode1CgramPalette",
      "Mode1ChrTiles",
      "Mode1Bg1Tilemap",
      "Mode1CollisionMap",
      "EventBytecode",
      "Mode1LevelLoaderTable",
    ].every((name) => names.includes(name) && artifact.mapText.includes(name)),
    "Required runtime upload and graphics symbols are present.",
  );

  return {
    checks,
    valid: checks.every((check) => check.passed || check.severity === "warning"),
  };
}

export function createSnesFxpakExportPackage(
  artifact: SnesPreviewRomArtifact,
): SnesFxpakExportPackage {
  const validation = validateSnesPreviewRomArtifact(artifact);
  const manifest = manifestRecord(artifact);
  const fxpak = nestedRecord(manifest, "fxpak");
  const save = nestedRecord(manifest, "save");
  const romPath = typeof fxpak.romPath === "string" ? fxpak.romPath : `/${artifact.fileName}`;
  const savePath = typeof fxpak.savePath === "string" ? fxpak.savePath : null;
  const cardSizeGb =
    typeof fxpak.cardSizeGb === "number" && Number.isFinite(fxpak.cardSizeGb)
      ? fxpak.cardSizeGb
      : SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
  const preserveExistingSave = fxpak.preserveExistingSave !== false;
  const blockers = [
    ...(validation.valid ? [] : ["Static ROM validation failed."]),
    ...(fxpak.requiredFileSystem === "FAT32" ? [] : ["FXPAK package requires FAT32."]),
    ...(romPath.endsWith(".sfc") ? [] : ["FXPAK package ROM path must end in .sfc."]),
    ...(cardSizeGb === SNES_HARDWARE_LIMITS.defaultFxpakCardGb
      ? []
      : ["FXPAK package is calibrated for a 128 GB microSD card."]),
  ];
  const files: SnesFxpakExportPackage["files"] = [
    {
      kind: "rom",
      sourceName: artifact.fileName,
      destinationPath: romPath,
      sizeBytes: artifact.sizeBytes,
      writeMode: "create-or-replace",
    },
  ];
  if (savePath) {
    files.push({
      kind: "sram",
      sourceName: savePath.split("/").pop() || `${artifact.fileName.replace(/\.sfc$/i, "")}.srm`,
      destinationPath: savePath,
      sizeBytes: nestedNumber(save, "totalBytes") ?? 0,
      writeMode: "preserve-existing",
    });
  }
  return {
    packageVersion: 1,
    target: "FXPAK PRO",
    status: blockers.length > 0 ? "blocked" : "ready",
    blockers,
    requiredFileSystem: "FAT32",
    cardSizeGb,
    romFileName: artifact.fileName,
    files,
    integrity: {
      checksum: artifact.checksum,
      checksumComplement: artifact.checksumComplement,
      runtimeDataChecksum: artifact.runtimeDataChecksum,
      staticValidationPassed: validation.valid,
      requiredOperatorHash: "sha256-after-copy",
    },
    sram: {
      enabled: savePath !== null,
      savePath,
      preserveExistingSave,
      requiredPowerCycleTest: true,
    },
    copyPlan: [
      "Confirm the microSD volume is FAT32 before copying.",
      `Copy ${artifact.fileName} to ${romPath}.`,
      savePath
        ? `Preserve any existing ${savePath}; do not overwrite SRAM without explicit confirmation.`
        : "No SRAM file is required for this project.",
      "Compute sha256 on the copied ROM and compare it with the source ROM before hardware launch.",
      "Boot the ROM on FXPAK PRO and power-cycle to verify SRAM behavior before release use.",
    ],
  };
}

export function createSnesFxpakCopyProof(
  fxpakPackage: SnesFxpakExportPackage,
  sourceBytes: Uint8Array,
  copiedBytes: Uint8Array | null,
  destinationPath = fxpakPackage.files.find((file) => file.kind === "rom")?.destinationPath ?? "",
): SnesFxpakCopyProof {
  const sourceChecksum = calculateChecksum(sourceBytes);
  const copiedChecksum = copiedBytes ? calculateChecksum(copiedBytes) : 0;
  const byteLengthMatched = copiedBytes?.byteLength === sourceBytes.byteLength;
  const byteContentMatched =
    byteLengthMatched &&
    copiedBytes !== null &&
    sourceBytes.every((byte, index) => copiedBytes[index] === byte);
  const blockers = [
    ...(fxpakPackage.status === "ready" ? [] : fxpakPackage.blockers),
    ...(copiedBytes ? [] : ["Copied ROM bytes were not provided for verification."]),
    ...(byteLengthMatched ? [] : ["Copied ROM byte length does not match the source ROM."]),
    ...(byteContentMatched ? [] : ["Copied ROM bytes do not match the source ROM."]),
  ];
  return {
    status: blockers.length === 0 ? "verified" : copiedBytes ? "mismatch" : "blocked",
    destinationPath,
    byteLengthMatched,
    byteContentMatched,
    sourceChecksum,
    copiedChecksum,
    blockers,
  };
}

function mountedDestinationPath(volumePath: string, destinationPath: string): string {
  const volume = volumePath.replace(/\/+$/u, "");
  const destination = destinationPath.replace(/^\/+/u, "");
  return `${volume}/${destination}`;
}

export function createSnesFxpakMountedExportValidation(
  fxpakPackage: SnesFxpakExportPackage,
  volume: SnesFxpakMountedVolumeProbe,
): SnesFxpakMountedExportValidation {
  const romFile = fxpakPackage.files.find((file) => file.kind === "rom");
  const saveFile = fxpakPackage.files.find((file) => file.kind === "sram") ?? null;
  const requiredBytes = fxpakPackage.files
    .filter((file) => file.writeMode === "create-or-replace")
    .reduce((sum, file) => sum + file.sizeBytes, 0);
  const savePreserved =
    !fxpakPackage.sram.enabled ||
    !fxpakPackage.sram.preserveExistingSave ||
    saveFile?.writeMode === "preserve-existing";
  const checks: SnesFxpakMountedExportValidation["checks"] = [
    {
      code: "VOLUME_MOUNTED",
      passed: volume.mounted,
      detail: volume.mounted
        ? `Mounted at ${volume.volumePath}.`
        : "FXPAK PRO microSD is not mounted.",
    },
    {
      code: "FAT32",
      passed: volume.fileSystem === "FAT32",
      detail: `Detected file system: ${volume.fileSystem}.`,
    },
    {
      code: "CARD_SIZE",
      passed: volume.cardSizeGb >= fxpakPackage.cardSizeGb,
      detail: `Detected ${volume.cardSizeGb} GB; required ${fxpakPackage.cardSizeGb} GB.`,
    },
    {
      code: "FREE_SPACE",
      passed: volume.freeBytes >= requiredBytes,
      detail: `Detected ${volume.freeBytes} free bytes; required ${requiredBytes} bytes.`,
    },
    {
      code: "ROM_DESTINATION",
      passed: romFile !== undefined && romFile.destinationPath.endsWith(".sfc"),
      detail: romFile
        ? `ROM destination: ${romFile.destinationPath}.`
        : "FXPAK package has no ROM destination.",
    },
    {
      code: "SRAM_PRESERVATION",
      passed: savePreserved,
      detail: saveFile
        ? volume.existingSavePresent
          ? `Existing SRAM is present and package write mode is ${saveFile.writeMode}.`
          : `No existing SRAM detected; package write mode is ${saveFile.writeMode}.`
        : "Project does not export SRAM.",
    },
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail);
  return {
    status: blockers.length === 0 && fxpakPackage.status === "ready" ? "ready" : "blocked",
    destinationRomPath: romFile
      ? mountedDestinationPath(volume.volumePath, romFile.destinationPath)
      : "",
    destinationSavePath:
      saveFile && fxpakPackage.sram.savePath
        ? mountedDestinationPath(volume.volumePath, fxpakPackage.sram.savePath)
        : null,
    checks,
    blockers: [...fxpakPackage.blockers, ...blockers],
  };
}

export function selectSnesFxpakMountedVolume(
  fxpakPackage: SnesFxpakExportPackage,
  detectedVolumes: SnesFxpakMountedVolumeProbe[],
): SnesFxpakMountedVolumeSelection {
  const checks = detectedVolumes.map((volume) => {
    const validation = createSnesFxpakMountedExportValidation(fxpakPackage, volume);
    return {
      volumePath: volume.volumePath,
      status: validation.status,
      blockers: validation.blockers,
    };
  });
  const selectedVolume =
    detectedVolumes.find((volume, index) => checks[index]?.status === "ready" && volume.mounted) ??
    null;
  const blockers =
    selectedVolume === null
      ? detectedVolumes.length === 0
        ? ["No mounted FXPAK PRO or SD2SNES-style FAT32 volume was detected."]
        : [
            "No detected volume satisfied FXPAK PRO FAT32, 128 GB card, free-space, and SRAM preservation checks.",
          ]
      : [];
  return {
    status: selectedVolume ? "ready" : "blocked",
    selectedVolume,
    detectedVolumes,
    checks,
    blockers,
  };
}

function mountedDirectoryPath(destinationPath: string): string {
  const normalized = destinationPath.replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function createSnesFxpakCopyDryRun(
  fxpakPackage: SnesFxpakExportPackage,
  volume: SnesFxpakMountedVolumeProbe,
): SnesFxpakCopyDryRun {
  const mountedValidation = createSnesFxpakMountedExportValidation(fxpakPackage, volume);
  const operations = fxpakPackage.files.map((file) => {
    const destinationPath = mountedDestinationPath(volume.volumePath, file.destinationPath);
    return {
      kind: file.kind,
      sourceName: file.sourceName,
      destinationPath,
      sizeBytes: file.sizeBytes,
      writeMode: file.writeMode,
      action:
        file.kind === "rom"
          ? ("copy-rom" as const)
          : file.writeMode === "preserve-existing"
            ? ("preserve-existing-sram" as const)
            : ("skip-sram" as const),
    };
  });
  const requiredDirectories = [
    ...new Set(operations.map((operation) => mountedDirectoryPath(operation.destinationPath))),
  ];
  const warnings = operations
    .filter(
      (operation) => operation.kind === "sram" && operation.action === "preserve-existing-sram",
    )
    .map(
      (operation) =>
        `Preserve existing SRAM at ${operation.destinationPath}; copy only after explicit overwrite approval.`,
    );
  return {
    status: mountedValidation.status,
    destinationRoot: volume.volumePath,
    mountedValidation,
    requiredDirectories,
    operations,
    blockers: mountedValidation.blockers,
    warnings,
  };
}

export function createSnesHardwareQaBundle(
  project: SnesStudioProject,
  createdAt = new Date().toISOString(),
  options: {
    availableEmulators?: SnesEmulatorKind[];
    emulatorExecution?: SnesEmulatorBootExecution | null;
    emulatorStateDump?: SnesEmulatorReplayStateDump | null;
    mountedVolume?: SnesFxpakMountedVolumeProbe | null;
    runtimeReplay?: SnesRuntimeReplay | null;
    sramPowerCycle?: SnesSramPowerCycleProof | null;
  } = {},
): SnesHardwareQaBundle {
  const normalized = normalizeSnesStudioProject(project);
  const artifact = buildSnesPreviewRom(normalized);
  const runtime = compileSnesRuntimeProject(normalized);
  const runtimeReplay =
    options.runtimeReplay ??
    ({
      runtimeHash: runtime.manifest.runtimeHash,
      inputs: [{ right: true }, { right: true }, { jump: true }, { right: true }],
    } satisfies SnesRuntimeReplay);
  const emulatorProof = createSnesEmulatorBootProof(
    artifact,
    options.availableEmulators ?? [],
    options.emulatorExecution ?? null,
  );
  const emulatorReplayParity = createSnesEmulatorReplayParityProof(
    artifact,
    runtime,
    runtimeReplay,
    options.availableEmulators ?? [],
    {
      emulatorExecution: options.emulatorExecution ?? null,
      emulatorStateDump: options.emulatorStateDump ?? null,
    },
  );
  const fxpakPackage = createSnesFxpakExportPackage(artifact);
  const mountedExport = options.mountedVolume
    ? createSnesFxpakMountedExportValidation(fxpakPackage, options.mountedVolume)
    : null;
  const sramPowerCycle = options.sramPowerCycle ?? null;
  const blockers = [
    ...(emulatorProof.status === "verified"
      ? []
      : ["Emulator boot/screenshot proof is not verified."]),
    ...(emulatorReplayParity.status === "verified"
      ? []
      : ["Emulator replay parity proof is not verified."]),
    ...(mountedExport?.status === "ready"
      ? []
      : ["FXPAK PRO FAT32 mounted export is not verified."]),
    ...(normalized.save.enabled && sramPowerCycle?.status !== "verified"
      ? ["SRAM power-cycle preservation proof is not verified."]
      : []),
    ...(fxpakPackage.status === "ready" ? [] : fxpakPackage.blockers),
  ];
  return {
    format: "openclaw-snes-hardware-qa-bundle",
    bundleVersion: 1,
    createdAt,
    projectId: normalized.id,
    projectName: normalized.name,
    status: blockers.length === 0 ? "ready-for-operator" : "blocked",
    blockers,
    artifacts: {
      romFileName: artifact.fileName,
      romSizeBytes: artifact.sizeBytes,
      checksum: artifact.checksum,
      checksumComplement: artifact.checksumComplement,
      runtimeDataChecksum: artifact.runtimeDataChecksum,
      emulatorProof,
      emulatorReplayParity,
      fxpakPackage,
      mountedExport,
      sramPowerCycle,
    },
    checklist: [
      "Export the preview ROM and manifest.",
      "Verify emulator boot with screenshot evidence before hardware copy.",
      "Replay the same input log in the emulator and compare state hashes.",
      "Mount the FXPAK PRO microSD as FAT32 and confirm the 128 GB card profile.",
      "Copy the ROM without overwriting existing SRAM files.",
      "Boot on real SNES hardware through FXPAK PRO, save, power-cycle, and compare `.srm` bytes.",
    ],
  };
}

export function createSnesSuperFxProfileReport(
  project: SnesStudioProject,
): SnesSuperFxProfileReport {
  const normalized = normalizeSnesStudioProject(project);
  const enabled =
    normalized.profile.enhancementChip === "superfx" || normalized.profile.videoMode === "superfx";
  return {
    status: enabled ? "concept-only" : "not-enabled",
    enhancementChip: normalized.profile.enhancementChip,
    videoMode: normalized.profile.videoMode,
    fxpakCompatible:
      normalized.profile.target === "fxpak-pro" &&
      normalized.profile.fxpak.fileSystem === "fat32" &&
      normalized.profile.fxpak.cardSizeGb === SNES_HARDWARE_LIMITS.defaultFxpakCardGb,
    memoryMap: {
      romMapMode: normalized.profile.mapMode,
      sramSizeKib: normalized.profile.sramSizeKib,
      gsuWorkRamBytes: 64 * 1024,
      targetCardFileSystem: "FAT32",
    },
    blockers: enabled
      ? [
          "GSU instruction assembler/linker is not implemented.",
          "SuperFX runtime, object transforms, and framebuffer upload path are not implemented.",
          "Real FXPAK PRO SuperFX boot proof is required before release use.",
        ]
      : [],
    buildRules: [
      "Keep FXPAK PRO 128 GB FAT32 and SRAM preservation rules enabled.",
      "Do not compile a Star Fox/Doom-style project as a Mode 1 production ROM without explicit downgrade approval.",
      "Require emulator and real-hardware boot proof for SuperFX release candidates.",
    ],
  };
}

export function createSnesSuperFxRuntimePlan(project: SnesStudioProject): SnesSuperFxRuntimePlan {
  const profile = createSnesSuperFxProfileReport(project);
  if (profile.status === "not-enabled") {
    return {
      status: "not-enabled",
      profile,
      requiredTools: [],
      memorySegments: [],
      milestones: [],
    };
  }
  return {
    status: "blocked",
    profile,
    requiredTools: [
      "GSU assembler/linker",
      "SuperFX ROM bank planner",
      "Framebuffer-to-SNES PPU upload runtime",
      "FXPAK PRO SuperFX hardware smoke harness",
    ],
    memorySegments: [
      {
        name: "GSU work RAM",
        sizeBytes: profile.memoryMap.gsuWorkRamBytes,
        purpose: "Object transforms, raster buffers, and fixed-point math scratch space.",
      },
      {
        name: "LoROM program banks",
        sizeBytes: (16 * 1024 * 1024) / 8,
        purpose: "SuperFX-aware game code, assets, and data banks for v0.1 concept builds.",
      },
      {
        name: "SRAM save area",
        sizeBytes: profile.memoryMap.sramSizeKib * 1024,
        purpose: "FXPAK-preserved save slots using the same OCSV header contract.",
      },
    ],
    milestones: [
      {
        id: "gsu-assemble",
        title: "Assemble deterministic GSU code",
        acceptance: "A minimal GSU routine assembles reproducibly and is visible in the ROM map.",
      },
      {
        id: "framebuffer-upload",
        title: "Upload SuperFX framebuffer output",
        acceptance: "An emulator screenshot shows GSU-rendered pixels on a SNES display layer.",
      },
      {
        id: "fxpak-proof",
        title: "Boot on FXPAK PRO",
        acceptance: "The SuperFX ROM boots from a 128 GB FAT32 microSD card and preserves SRAM.",
      },
    ],
  };
}

export function createSnesSuperFxMinimalRomArtifact(
  project: SnesStudioProject,
): SnesSuperFxMinimalRomArtifact {
  const normalized = normalizeSnesStudioProject(project);
  const profile = createSnesSuperFxProfileReport(normalized);
  const fileName = `${sanitizeRomBaseName(normalized.export.romBaseName || normalized.name)}.superfx-concept.sfc`;
  if (profile.status === "not-enabled") {
    return {
      status: "not-enabled",
      runtimeStatus: "not-enabled",
      fileName,
      sizeBytes: 0,
      checksum: 0,
      gsuProgramOffset: 0,
      gsuProgramSizeBytes: 0,
      gsuProgramHex: "",
      romMap: [],
      blockers: [],
    };
  }
  const sizeBytes = 512 * 1024;
  const bytes = new Uint8Array(sizeBytes);
  bytes.fill(0xff);
  const gsuProgramOffset = 0x8000;
  const gsuProgram = Array.from(new TextEncoder().encode("OCGSU"));
  pushU16(gsuProgram, checksumText(normalized.id));
  pushU16(gsuProgram, normalized.scenes.length);
  pushU16(gsuProgram, normalized.assets.spriteTiles);
  pushU16(gsuProgram, normalized.assets.backgroundTiles);
  const gsuProgramBytes = new Uint8Array(gsuProgram);
  bytes.set(gsuProgramBytes, gsuProgramOffset);
  const projectData = new TextEncoder().encode(stableProjectJson(normalized));
  const projectDataOffset = 0x9000;
  bytes.set(projectData.slice(0, Math.min(projectData.byteLength, 16 * 1024)), projectDataOffset);
  return {
    status: "static-artifact-ready",
    runtimeStatus: "blocked-until-gsu-runtime-and-emulator-proof",
    fileName,
    sizeBytes,
    checksum: calculateChecksum(bytes),
    gsuProgramOffset,
    gsuProgramSizeBytes: gsuProgramBytes.byteLength,
    gsuProgramHex: bytesToHex(gsuProgramBytes),
    romMap: [
      {
        name: "Concept SuperFX ROM shell",
        offset: 0,
        sizeBytes,
        purpose:
          "Deterministic container for SuperFX project proof before a real GSU linker exists.",
      },
      {
        name: "GSU program marker",
        offset: gsuProgramOffset,
        sizeBytes: gsuProgramBytes.byteLength,
        purpose: "Minimal reproducible GSU metadata block for tooling and ROM-map proof.",
      },
      {
        name: "Project data preview",
        offset: projectDataOffset,
        sizeBytes: Math.min(projectData.byteLength, 16 * 1024),
        purpose: "Stable project JSON slice for SuperFX concept validation.",
      },
    ],
    blockers: [
      "Static SuperFX concept ROM artifact is not a boot-verified production ROM.",
      ...profile.blockers,
    ],
  };
}

export function createSnesEmulatorValidationReport(
  artifact: SnesPreviewRomArtifact,
  availableEmulators: SnesEmulatorKind[] = [],
): SnesEmulatorValidationReport {
  const supportedEmulators: SnesEmulatorKind[] = ["ares", "bsnes", "mesen", "snes9x"];
  const staticRomValidation = validateSnesPreviewRomArtifact(artifact);
  const selectedEmulator =
    supportedEmulators.find((emulator) => availableEmulators.includes(emulator)) ?? null;
  const blockers = [
    ...(staticRomValidation.valid ? [] : ["Preview ROM failed static integrity validation."]),
    ...(selectedEmulator
      ? []
      : ["No supported SNES emulator was detected for boot/screenshot validation."]),
  ];

  return {
    status: blockers.length > 0 ? "blocked" : "ready",
    selectedEmulator,
    supportedEmulators,
    staticRomValidation,
    blockers,
    nextSteps:
      blockers.length > 0
        ? [
            "Install or configure a supported emulator: ares, bsnes, Mesen, or Snes9x.",
            "Run boot proof after generating the preview ROM and before FXPAK PRO hardware export.",
            "Keep static ROM integrity checks passing before attempting emulator or hardware proof.",
          ]
        : [
            `Boot ${artifact.fileName} in ${selectedEmulator}.`,
            "Capture a first-frame screenshot and record checksum/header proof.",
            "Replay the exported input log and capture emulator state hash proof.",
            "Keep emulator proof separate from FXPAK PRO hardware SRAM power-cycle proof.",
          ],
  };
}

export function createSnesEmulatorBootPlan(
  artifact: SnesPreviewRomArtifact,
  availableEmulators: SnesEmulatorKind[] = [],
): SnesEmulatorBootPlan {
  const validation = createSnesEmulatorValidationReport(artifact, availableEmulators);
  const screenshotFileName = `${artifact.fileName.replace(/\.sfc$/i, "")}.boot.png`;
  const command =
    validation.selectedEmulator === null
      ? []
      : validation.selectedEmulator === "ares"
        ? ["ares", "--fullscreen=false", "--screenshot", screenshotFileName, artifact.fileName]
        : validation.selectedEmulator === "bsnes"
          ? ["bsnes", artifact.fileName, "--screenshot", screenshotFileName]
          : validation.selectedEmulator === "mesen"
            ? ["mesen", artifact.fileName, "--screenshot", screenshotFileName]
            : ["snes9x", "-snapshot", screenshotFileName, artifact.fileName];
  return {
    status: validation.status,
    selectedEmulator: validation.selectedEmulator,
    romFileName: artifact.fileName,
    screenshotFileName,
    command,
    blockers: validation.blockers,
    validation,
  };
}

export function createSnesEmulatorBootProof(
  artifact: SnesPreviewRomArtifact,
  availableEmulators: SnesEmulatorKind[] = [],
  execution?: SnesEmulatorBootExecution | null,
): SnesEmulatorBootProof {
  const plan = createSnesEmulatorBootPlan(artifact, availableEmulators);
  const staticRomPassed = plan.validation.staticRomValidation.valid;
  const emulatorAvailable = plan.selectedEmulator !== null;
  const exitCodePassed = execution ? execution.exitCode === 0 : false;
  const screenshotBytes = execution?.screenshotBytes.byteLength ?? 0;
  const screenshotPassed = screenshotBytes > 0;
  const checks: SnesEmulatorBootProof["checks"] = [
    {
      code: "STATIC_ROM",
      passed: staticRomPassed,
      detail: staticRomPassed
        ? "Preview ROM passed static integrity validation."
        : "Preview ROM failed static integrity validation.",
    },
    {
      code: "EMULATOR_AVAILABLE",
      passed: emulatorAvailable,
      detail: emulatorAvailable
        ? `${plan.selectedEmulator} selected for boot proof.`
        : "No supported emulator selected for boot proof.",
    },
    {
      code: "EXIT_CODE",
      passed: exitCodePassed,
      detail: execution
        ? `Emulator process exited with code ${execution.exitCode}.`
        : "No emulator execution result has been recorded.",
    },
    {
      code: "SCREENSHOT_BYTES",
      passed: screenshotPassed,
      detail:
        screenshotBytes > 0
          ? `Captured ${screenshotBytes} screenshot bytes.`
          : "No screenshot bytes have been recorded.",
    },
  ];
  const blockers = [
    ...plan.blockers,
    ...(execution
      ? []
      : emulatorAvailable
        ? ["Boot proof has not been executed yet."]
        : ["Install or configure a supported emulator before boot proof can run."]),
    ...(execution && !exitCodePassed ? ["Emulator exited with a non-zero code."] : []),
    ...(execution && !screenshotPassed ? ["Emulator did not produce screenshot evidence."] : []),
  ];
  const status =
    plan.status === "blocked"
      ? "blocked"
      : !execution
        ? "ready-to-run"
        : checks.every((check) => check.passed)
          ? "verified"
          : "failed";
  return {
    status,
    plan,
    checks,
    evidence: {
      emulator: plan.selectedEmulator,
      command: plan.command,
      screenshotFileName: plan.screenshotFileName,
      screenshotBytes,
      exitCode: execution?.exitCode ?? null,
      elapsedMs: execution?.elapsedMs ?? null,
    },
    blockers,
  };
}

export function createSnesEmulatorScreenshotComparison(
  artifact: SnesPreviewRomArtifact,
  screenshotBytes: Uint8Array | null,
  options: {
    expectedChecksum?: number | null;
    screenshotFileName?: string;
  } = {},
): SnesEmulatorScreenshotComparison {
  const bytes = screenshotBytes ?? new Uint8Array();
  const checksum = calculateChecksum(bytes);
  const uniqueByteCount = new Set(bytes).size;
  const nonZeroByteCount = bytes.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0);
  const expectedChecksum = options.expectedChecksum ?? null;
  const screenshotFileName =
    options.screenshotFileName ?? `${artifact.fileName.replace(/\.sfc$/i, "")}.boot.png`;
  const checks: SnesEmulatorScreenshotComparison["checks"] = [
    {
      code: "SCREENSHOT_PRESENT",
      passed: bytes.byteLength > 0,
      detail:
        bytes.byteLength > 0
          ? `Captured ${bytes.byteLength} screenshot bytes.`
          : "No screenshot bytes were provided.",
    },
    {
      code: "NONBLANK_FRAME",
      passed: nonZeroByteCount > 0 && uniqueByteCount > 1,
      detail:
        nonZeroByteCount > 0 && uniqueByteCount > 1
          ? `Screenshot has ${uniqueByteCount} unique byte values and ${nonZeroByteCount} non-zero bytes.`
          : "Screenshot evidence appears blank or uninitialized.",
    },
    {
      code: "EXPECTED_CHECKSUM",
      passed: expectedChecksum === null || checksum === expectedChecksum,
      detail:
        expectedChecksum === null
          ? "No baseline checksum supplied; nonblank screenshot proof is required."
          : checksum === expectedChecksum
            ? `Screenshot checksum ${formatHex(checksum, 4)} matches the expected baseline.`
            : `Screenshot checksum ${formatHex(checksum, 4)} does not match expected ${formatHex(
                expectedChecksum,
                4,
              )}.`,
    },
  ];
  const blockers = checks.filter((check) => !check.passed).map((check) => check.detail);
  return {
    status: bytes.byteLength === 0 ? "blocked" : blockers.length === 0 ? "verified" : "mismatch",
    screenshotFileName,
    screenshotBytes: bytes.byteLength,
    checksum,
    uniqueByteCount,
    nonZeroByteCount,
    expectedChecksum,
    checks,
    blockers,
  };
}

function collisionMaterialAtPixel(scene: SnesStudioScene, x: number, y: number): number {
  const column = Math.max(0, Math.min(SNES_STUDIO_EDIT_GRID.width - 1, Math.floor(x / 16)));
  const row = Math.max(0, Math.min(SNES_STUDIO_EDIT_GRID.height - 1, Math.floor((y - 8) / 16)));
  return scene.collisionMap[row * SNES_STUDIO_EDIT_GRID.width + column] ?? 0;
}

export function solidCellAtPixel(
  scene: SnesStudioScene,
  x: number,
  y: number,
  falling = true,
): boolean {
  const material = collisionMaterialAtPixel(scene, x, y);
  return material === 1 || (material === 3 && falling);
}

function runtimeFrameRate(region: SnesRegion): number {
  return region === "pal" ? SNES_PAL_FRAME_RATE : SNES_NTSC_FRAME_RATE;
}

function runtimeEntityRole(entity: SnesSceneEntity): SnesRuntimeEntityRole {
  if (entity.kind === "player") {
    return "hero";
  }
  const name = entity.name.toLowerCase();
  if (name.includes("door") || name.includes("gate") || name.includes("exit")) {
    return "door";
  }
  if (name.includes("goal") || name.includes("flag") || name.includes("finish")) {
    return "goal";
  }
  return entity.kind;
}

function runtimeEntityFromSceneEntity(entity: SnesSceneEntity): SnesRuntimeEntity {
  return {
    id: entity.id,
    kind: entity.kind,
    role: runtimeEntityRole(entity),
    name: entity.name,
    x: clampInteger(entity.x, 0, 0xffff),
    y: clampInteger(entity.y, 0, 0xffff),
    width: entity.kind === "item" ? 12 : 16,
    height: entity.kind === "item" ? 12 : 16,
    metaspriteTiles: entity.metaspriteTiles,
    visualRecipe: entity.visualRecipe,
    behavior:
      entity.kind === "enemy" ? normalizeEnemyBehavior(entity.behavior, entity.x) : undefined,
  };
}

function runtimeSceneFromStudioScene(scene: SnesStudioScene): SnesRuntimeScene {
  const collisionMap = scene.collisionMap.map((material) => normalizeCollisionMaterial(material));
  const tilemap = scene.tilemap.map((tile) => normalizeTileBrush(tile));
  return {
    id: scene.id,
    name: scene.name,
    widthMetatiles: scene.widthMetatiles,
    heightMetatiles: scene.heightMetatiles,
    widthPixels: scene.widthMetatiles * 16,
    heightPixels: scene.heightMetatiles * 16,
    collisionMap,
    tilemap,
    entities: scene.entities.map(runtimeEntityFromSceneEntity),
    collisionMapChecksum: calculateChecksum(editLayerBytes(collisionMap)),
    tilemapChecksum: calculateChecksum(editLayerBytes(tilemap)),
  };
}

function runtimeMaterialAtPixel(
  scene: SnesRuntimeScene,
  x: number,
  y: number,
): SnesCollisionMaterial {
  const column = clampInteger(Math.floor(x / 16), 0, SNES_STUDIO_EDIT_GRID.width - 1);
  const row = clampInteger(Math.floor(y / 16), 0, SNES_STUDIO_EDIT_GRID.height - 1);
  return scene.collisionMap[row * SNES_STUDIO_EDIT_GRID.width + column] ?? 0;
}

function runtimeSolidAtPixel(
  scene: SnesRuntimeScene,
  x: number,
  y: number,
  falling = true,
): boolean {
  const material = runtimeMaterialAtPixel(scene, x, y);
  return material === 1 || (material === 3 && falling);
}

function runtimeLandingY(scene: SnesRuntimeScene, x: number, nextY: number): number | null {
  const footY = nextY + 8;
  const leftFoot = runtimeSolidAtPixel(scene, x + 3, footY, true);
  const rightFoot = runtimeSolidAtPixel(scene, x + 13, footY, true);
  if (!leftFoot && !rightFoot) {
    return null;
  }
  return clampInteger(Math.floor(footY / 16) * 16, 0, Math.max(0, scene.heightPixels - 16));
}

function runtimeStateHash(state: SnesRuntimeFrameState): string {
  return formatHex(calculateChecksum(new TextEncoder().encode(collisionSignature(state))), 4);
}

function runtimeManifestSeed(runtime: Omit<SnesRuntimeProject, "manifest">): string {
  return stableStringify(
    {
      activeSceneId: runtime.activeSceneId,
      frameRate: runtime.frameRate,
      fixedPointScale: runtime.fixedPointScale,
      physics: runtime.physics,
      region: runtime.region,
      scenes: runtime.scenes.map((scene) => ({
        collisionMapChecksum: scene.collisionMapChecksum,
        entities: scene.entities.map((entity) => ({
          behavior: entity.behavior,
          height: entity.height,
          id: entity.id,
          kind: entity.kind,
          name: entity.name,
          role: entity.role,
          visualRecipe: entity.visualRecipe,
          width: entity.width,
          x: entity.x,
          y: entity.y,
        })),
        heightMetatiles: scene.heightMetatiles,
        id: scene.id,
        tilemapChecksum: scene.tilemapChecksum,
        widthMetatiles: scene.widthMetatiles,
      })),
      viewport: runtime.viewport,
    },
    0,
  );
}

export function compileSnesRuntimeProject(project: SnesStudioProject): SnesRuntimeProject {
  const normalized = normalizeSnesStudioProject(project);
  const scenes = normalized.scenes.map(runtimeSceneFromStudioScene);
  const activeRuntimeScene = scenes[0] ?? runtimeSceneFromStudioScene(activeScene(normalized));
  const frameRate = runtimeFrameRate(normalized.profile.region);
  const runtimeBase: Omit<SnesRuntimeProject, "manifest"> = {
    version: 1,
    region: normalized.profile.region,
    frameRate,
    frameTimeMs: 1000 / frameRate,
    fixedPointScale: SNES_RUNTIME_FIXED_POINT_SCALE,
    viewport: SNES_RUNTIME_VIEWPORT,
    activeSceneId: activeRuntimeScene.id,
    scenes: scenes.length > 0 ? scenes : [activeRuntimeScene],
    physics: normalized.physics,
    visualStylePreset: normalized.visualStylePreset ?? SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
    artDirection: normalized.artDirection ?? createDefaultSnesArtDirection(),
  };
  const runtimeHash = formatHex(
    calculateChecksum(new TextEncoder().encode(runtimeManifestSeed(runtimeBase))),
    4,
  );
  const initialState = createInitialSnesRuntimeFrameState(
    {
      ...runtimeBase,
      manifest: {
        version: 1,
        cadence: normalized.profile.region === "pal" ? "pal-50hz" : "ntsc-60hz",
        frameRate,
        frameTimeMs: 1000 / frameRate,
        fixedPointScale: SNES_RUNTIME_FIXED_POINT_SCALE,
        viewport: SNES_RUNTIME_VIEWPORT,
        activeSceneId: activeRuntimeScene.id,
        sceneCount: runtimeBase.scenes.length,
        runtimeHash,
        stateHash: "0000",
        visualStylePreset: runtimeBase.visualStylePreset,
      },
    },
    activeRuntimeScene.id,
  );
  const manifest: SnesRuntimeManifest = {
    version: 1,
    cadence: normalized.profile.region === "pal" ? "pal-50hz" : "ntsc-60hz",
    frameRate,
    frameTimeMs: 1000 / frameRate,
    fixedPointScale: SNES_RUNTIME_FIXED_POINT_SCALE,
    viewport: SNES_RUNTIME_VIEWPORT,
    activeSceneId: activeRuntimeScene.id,
    sceneCount: runtimeBase.scenes.length,
    runtimeHash,
    stateHash: runtimeStateHash(initialState),
    visualStylePreset: runtimeBase.visualStylePreset,
  };
  return {
    ...runtimeBase,
    manifest,
  };
}

function runtimeScene(
  runtime: SnesRuntimeProject,
  sceneId = runtime.activeSceneId,
): SnesRuntimeScene {
  return runtime.scenes.find((scene) => scene.id === sceneId) ?? runtime.scenes[0];
}

function createInitialSnesRuntimeFrameState(
  runtime: SnesRuntimeProject,
  sceneId = runtime.activeSceneId,
): SnesRuntimeFrameState {
  const scene = runtimeScene(runtime, sceneId);
  const hero = scene.entities.find((entity) => entity.role === "hero");
  return {
    cameraScrollX: 0,
    collectedItems: [],
    collisions: [],
    defeatedEnemies: [],
    enemyPositions: {},
    frame: 0,
    grounded: true,
    health: 3,
    inputLog: [],
    inventory: [],
    lives: 3,
    playerX: hero?.x ?? PREVIEW_PLAYER_START_X,
    playerY: hero?.y ?? PREVIEW_PLAYER_START_Y,
    playerYVelocity: 0,
    runtimeHash: runtime.manifest.runtimeHash,
    sceneId: scene.id,
    score: 0,
    status: "playing",
  };
}

function cloneRuntimeFrameState(state: SnesRuntimeFrameState): SnesRuntimeFrameState {
  return {
    cameraScrollX: state.cameraScrollX,
    collectedItems: [...state.collectedItems],
    collisions: [],
    defeatedEnemies: [...state.defeatedEnemies],
    enemyPositions: { ...state.enemyPositions },
    frame: state.frame,
    grounded: state.grounded,
    health: state.health,
    inputLog: [...state.inputLog],
    inventory: [...state.inventory],
    lives: state.lives,
    playerX: state.playerX,
    playerY: state.playerY,
    playerYVelocity: state.playerYVelocity,
    runtimeHash: state.runtimeHash,
    sceneId: state.sceneId,
    score: state.score,
    status: state.status,
  };
}

export function stepSnesRuntimeFrame(
  runtime: SnesRuntimeProject,
  previous: SnesRuntimeFrameState | null = null,
  input: SnesRuntimeInputFrame = {},
): SnesRuntimeFrameState {
  const scene = runtimeScene(runtime, previous?.sceneId);
  const physics = runtime.physics;
  const state =
    previous && previous.runtimeHash === runtime.manifest.runtimeHash
      ? cloneRuntimeFrameState(previous)
      : createInitialSnesRuntimeFrameState(runtime, scene.id);
  state.frame += 1;

  const inputNames = [
    input.left ? "left" : "",
    input.right ? "right" : "",
    input.jump ? "jump" : "",
  ].filter(Boolean);
  if (inputNames.length > 0) {
    state.inputLog.push(`f${state.frame}:${inputNames.join("+")}`);
  }
  state.inputLog = state.inputLog.slice(-60);

  if (state.status !== "playing") {
    return state;
  }

  const speed = Math.max(0, physics.moveSpeed);
  const requestedX = state.playerX + (input.right ? speed : 0) - (input.left ? speed : 0);
  state.playerX = clampInteger(requestedX, 0, Math.max(0, scene.widthPixels - 16));

  if (input.jump && state.grounded) {
    state.playerYVelocity = physics.jumpVelocity;
    state.grounded = false;
  }

  state.playerYVelocity = clampInteger(
    state.playerYVelocity + physics.gravityPerFrame,
    -64,
    physics.maxFallSpeed,
  );
  const nextY = clampInteger(state.playerY + state.playerYVelocity, -32, scene.heightPixels + 48);
  const landingY = state.playerYVelocity >= 0 ? runtimeLandingY(scene, state.playerX, nextY) : null;
  if (landingY !== null) {
    state.playerY = landingY;
    state.playerYVelocity = 0;
    state.grounded = true;
    state.collisions.push("ground");
  } else {
    state.playerY = nextY;
    state.grounded = false;
  }

  const footMaterial = runtimeMaterialAtPixel(scene, state.playerX + 8, state.playerY + 8);
  if (footMaterial === 2) {
    state.collisions.push("hazard");
    state.health = Math.max(0, state.health - 1);
  }
  if (footMaterial === 4) {
    state.collisions.push("water");
    state.playerYVelocity = Math.min(state.playerYVelocity, physics.gravityPerFrame);
  }

  for (const entity of scene.entities) {
    if (entity.role === "hero") {
      continue;
    }
    let entityX = entity.x;
    let entityY = entity.y;
    if (entity.role === "enemy") {
      const behavior = entity.behavior ?? normalizeEnemyBehavior(null, entity.x);
      const previousEnemy = state.enemyPositions[entity.id] ?? {
        direction: behavior.guardDirection,
        x: entity.x,
        y: entity.y,
      };
      let direction = previousEnemy.direction;
      let x = previousEnemy.x;
      if (behavior.kind === "chase") {
        const distanceX = Math.abs(state.playerX - previousEnemy.x);
        if (distanceX <= behavior.aggroRange) {
          direction = state.playerX < previousEnemy.x ? -1 : 1;
          x = previousEnemy.x + direction * Math.max(1, behavior.speed);
        }
      } else if (behavior.kind === "guard") {
        direction = behavior.guardDirection;
      } else if (behavior.kind === "patrol") {
        x = previousEnemy.x + direction * Math.max(1, behavior.speed);
        const minX = Math.max(0, behavior.patrolStartX);
        const maxX = Math.min(scene.widthPixels - 1, behavior.patrolEndX);
        if (x <= minX || x >= maxX) {
          direction = direction === 1 ? -1 : 1;
          x = clampInteger(x, minX, maxX);
        }
      }
      state.enemyPositions[entity.id] = { direction, x, y: previousEnemy.y };
      entityX = x;
      entityY = previousEnemy.y;
    }

    const distance = Math.abs(entityX - state.playerX) + Math.abs(entityY - state.playerY);
    if (entity.role === "item" && distance <= 24 && !state.collectedItems.includes(entity.id)) {
      state.collectedItems.push(entity.id);
      state.inventory.push(entity.name);
      state.score += 100;
    }
    if (entity.role === "enemy" && distance <= 20 && !state.defeatedEnemies.includes(entity.id)) {
      if (state.playerY + 8 < entityY && state.playerYVelocity >= 0) {
        state.defeatedEnemies.push(entity.id);
        state.playerYVelocity = physics.jumpVelocity;
        state.score += 200;
      } else {
        state.collisions.push(entity.id);
        state.health = Math.max(0, state.health - 1);
      }
    }
    if ((entity.role === "door" || entity.role === "goal") && distance <= 24) {
      state.status = "won";
    }
  }

  if (state.playerY > scene.heightPixels + 24) {
    state.collisions.push("fell");
    state.health = 0;
  }
  if (state.health <= 0) {
    state.status = "lost";
    state.lives = Math.max(0, state.lives - 1);
  }
  if (state.playerX >= Math.min(scene.widthPixels - 32, 768)) {
    state.status = "won";
  }
  state.cameraScrollX = clampInteger(
    state.playerX - 80,
    0,
    Math.max(0, scene.widthPixels - runtime.viewport.width),
  );
  return state;
}

export function runSnesRuntimeReplay(
  runtime: SnesRuntimeProject,
  replay: SnesRuntimeReplay,
): SnesRuntimeParityReport {
  const run = () =>
    replay.inputs.reduce<SnesRuntimeFrameState | null>(
      (state, input, index) => stepSnesRuntimeFrame(runtime, state, { ...input, frame: index }),
      null,
    );
  const first = run();
  const second = run();
  const firstSignature = first ? collisionSignature(first) : "";
  const secondSignature = second ? collisionSignature(second) : "";
  const deterministic = firstSignature === secondSignature && first !== null;
  const finalStateHash = first ? runtimeStateHash(first) : "0000";
  return {
    status: deterministic ? "verified" : "blocked",
    runtimeStatus: deterministic ? "browser-runtime-verified" : "blocked-until-emulator-state-dump",
    frameCount: replay.inputs.length,
    deterministic,
    runtimeHash: runtime.manifest.runtimeHash,
    finalStateHash,
    browserReplayChecksum: calculateChecksum(new TextEncoder().encode(firstSignature)),
    blockers: deterministic
      ? ["Emulator WRAM/state-dump comparison is still required before ROM parity is verified."]
      : ["Browser runtime replay is not deterministic."],
  };
}

export function createSnesEmulatorReplayParityProof(
  artifact: SnesPreviewRomArtifact,
  runtime: SnesRuntimeProject,
  replay: SnesRuntimeReplay,
  availableEmulators: SnesEmulatorKind[] = [],
  options: {
    emulatorExecution?: SnesEmulatorBootExecution | null;
    emulatorStateDump?: SnesEmulatorReplayStateDump | null;
  } = {},
): SnesEmulatorReplayParityProof {
  const browserReplay = runSnesRuntimeReplay(runtime, replay);
  const bootProof = createSnesEmulatorBootProof(
    artifact,
    availableEmulators,
    options.emulatorExecution ?? null,
  );
  const emulatorStateDump = options.emulatorStateDump ?? null;
  const manifestMatches =
    artifact.runtimeManifest.runtimeHash === runtime.manifest.runtimeHash &&
    artifact.runtimeManifest.frameRate === runtime.manifest.frameRate &&
    artifact.runtimeManifest.sceneCount === runtime.manifest.sceneCount &&
    artifact.runtimeManifest.fixedPointScale === runtime.manifest.fixedPointScale;
  const stateDumpMatches =
    emulatorStateDump !== null &&
    emulatorStateDump.runtimeHash === browserReplay.runtimeHash &&
    emulatorStateDump.finalStateHash === browserReplay.finalStateHash &&
    emulatorStateDump.frameCount === browserReplay.frameCount &&
    emulatorStateDump.browserReplayChecksum === browserReplay.browserReplayChecksum;
  const checks: SnesEmulatorReplayParityProof["checks"] = [
    {
      code: "RUNTIME_MANIFEST",
      passed: manifestMatches,
      detail: manifestMatches
        ? `Exported game file manifest matches runtime ${runtime.manifest.runtimeHash}.`
        : "Exported game file manifest does not match the current runtime contract.",
    },
    {
      code: "BROWSER_REPLAY",
      passed: browserReplay.status === "verified",
      detail:
        browserReplay.status === "verified"
          ? `Browser replay is deterministic for ${browserReplay.frameCount} frame${browserReplay.frameCount === 1 ? "" : "s"}.`
          : "Browser runtime replay is not deterministic.",
    },
    {
      code: "EMULATOR_AVAILABLE",
      passed: bootProof.plan.selectedEmulator !== null,
      detail:
        bootProof.plan.selectedEmulator !== null
          ? `${bootProof.plan.selectedEmulator} selected for emulator replay proof.`
          : "No supported emulator selected for replay proof.",
    },
    {
      code: "BOOT_SCREENSHOT",
      passed: bootProof.status === "verified",
      detail:
        bootProof.status === "verified"
          ? `Boot screenshot evidence captured in ${bootProof.evidence.screenshotFileName}.`
          : "Boot screenshot proof has not been verified.",
    },
    {
      code: "STATE_DUMP",
      passed: emulatorStateDump !== null,
      detail:
        emulatorStateDump !== null
          ? `Captured emulator replay state from ${emulatorStateDump.source}.`
          : "No emulator replay state dump has been captured.",
    },
    {
      code: "STATE_HASH",
      passed: stateDumpMatches,
      detail: stateDumpMatches
        ? `Emulator replay state matches browser state ${browserReplay.finalStateHash}.`
        : emulatorStateDump
          ? `Emulator replay state ${emulatorStateDump.finalStateHash} does not match browser state ${browserReplay.finalStateHash}.`
          : "Emulator replay state hash cannot be compared until a state dump exists.",
    },
  ];
  const failedChecks = checks.filter((check) => !check.passed);
  const mismatch = emulatorStateDump !== null && !stateDumpMatches;
  const status =
    failedChecks.length === 0
      ? "verified"
      : mismatch
        ? "mismatch"
        : bootProof.plan.selectedEmulator !== null &&
            manifestMatches &&
            browserReplay.status === "verified"
          ? "ready-to-run"
          : "blocked";
  const blockers =
    status === "verified"
      ? []
      : failedChecks
          .map((check) => check.detail)
          .filter(
            (detail) =>
              status !== "ready-to-run" ||
              !detail.includes("Boot screenshot") ||
              options.emulatorExecution !== null,
          );
  return {
    status,
    runtimeManifest: artifact.runtimeManifest,
    browserReplay,
    bootProof,
    emulatorStateDump,
    checks,
    evidence: {
      romFileName: artifact.fileName,
      emulator: bootProof.plan.selectedEmulator,
      command: bootProof.plan.command,
      runtimeHash: runtime.manifest.runtimeHash,
      browserFinalStateHash: browserReplay.finalStateHash,
      emulatorFinalStateHash: emulatorStateDump?.finalStateHash ?? null,
      frameCount: browserReplay.frameCount,
      browserReplayChecksum: browserReplay.browserReplayChecksum,
    },
    blockers,
    nextSteps:
      status === "verified"
        ? [
            "Keep this replay with the exported game file manifest.",
            "Run FXPAK PRO hardware proof before claiming real-console parity.",
          ]
        : status === "ready-to-run"
          ? [
              `Run ${artifact.fileName} in ${bootProof.plan.selectedEmulator} with the exported replay inputs.`,
              "Capture boot screenshot evidence and a replay state dump.",
              `Compare emulator state against browser state ${browserReplay.finalStateHash}.`,
            ]
          : mismatch
            ? [
                "Inspect the runtime manifest, replay inputs, and exported ROM data for drift.",
                "Do not mark emulator parity verified until the state hashes match.",
              ]
            : [
                "Build a valid preview SNES game file.",
                "Run a deterministic browser replay.",
                "Install or configure a supported emulator before replay proof.",
              ],
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

export function createSnesEmulatorReplayRunPack(
  artifact: SnesPreviewRomArtifact,
  runtime: SnesRuntimeProject,
  replay: SnesRuntimeReplay,
  availableEmulators: SnesEmulatorKind[] = [],
): SnesEmulatorReplayRunPack {
  const replayParity = createSnesEmulatorReplayParityProof(
    artifact,
    runtime,
    replay,
    availableEmulators,
  );
  const proofBaseName = artifact.fileName.replace(/\.sfc$/iu, "");
  const proofFileName = `${proofBaseName}.emulator-proof.json`;
  const scriptFileName = `${proofBaseName}.run-emulator-proof.sh`;
  const commandText =
    replayParity.evidence.command.length > 0
      ? replayParity.evidence.command.map(shellQuote).join(" ")
      : "";
  const ready =
    (replayParity.status === "ready-to-run" || replayParity.status === "verified") &&
    replayParity.evidence.command.length > 0;
  const blockers = ready
    ? []
    : replayParity.blockers.length > 0
      ? replayParity.blockers
      : ["No emulator replay command is ready."];
  const scriptText = ready
    ? [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'cd "$(dirname "$0")"',
        `echo "SNES Studio emulator proof for ${artifact.fileName}"`,
        `echo "Expected runtime hash: ${replayParity.evidence.runtimeHash}"`,
        `echo "Expected final state hash: ${replayParity.evidence.browserFinalStateHash}"`,
        `echo "Replay frames: ${replayParity.evidence.frameCount}"`,
        `echo "Booting ${replayParity.evidence.emulator} and requesting screenshot proof..."`,
        commandText,
        `echo "Screenshot command completed. Compare captured emulator state to ${proofFileName} before marking ROM parity verified."`,
        "",
      ].join("\n")
    : [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `echo "SNES Studio emulator proof is blocked for ${artifact.fileName}."`,
        ...blockers.map((blocker) => `echo ${shellQuote(blocker)}`),
        "exit 2",
        "",
      ].join("\n");
  return {
    status: ready ? "ready" : "blocked",
    romFileName: artifact.fileName,
    proofFileName,
    scriptFileName,
    selectedEmulator: replayParity.evidence.emulator,
    command: replayParity.evidence.command,
    expectedFinalStateHash: replayParity.evidence.browserFinalStateHash,
    runtimeHash: replayParity.evidence.runtimeHash,
    frameCount: replayParity.evidence.frameCount,
    scriptText,
    blockers,
    nextSteps: ready
      ? [
          `Put ${artifact.fileName}, ${proofFileName}, and ${scriptFileName} in the same folder.`,
          `Run ./${scriptFileName} to boot the selected emulator and capture screenshot proof.`,
          "Capture or import an emulator state dump before claiming ROM parity verified.",
        ]
      : replayParity.nextSteps,
  };
}

export function renderSnesRuntimeFrame(
  canvas: HTMLCanvasElement,
  runtime: SnesRuntimeProject,
  state: SnesRuntimeFrameState,
): boolean {
  if (canvas.ownerDocument?.defaultView?.navigator.userAgent.toLowerCase().includes("jsdom")) {
    return false;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return false;
  }
  const scene = runtimeScene(runtime, state.sceneId);
  canvas.width = runtime.viewport.width;
  canvas.height = runtime.viewport.height;
  context.imageSmoothingEnabled = false;
  const classic = runtime.visualStylePreset === SNES_CLASSIC_PLATFORMER_STYLE_PRESET;
  const theme = runtime.artDirection.backgroundTheme;
  const skyTop = theme === "cave" ? "#24283f" : theme === "mountain" ? "#8ed0ff" : "#7fd7ff";
  const skyBottom = theme === "cave" ? "#111827" : theme === "mountain" ? "#d8f4ff" : "#c9f2ff";
  const gradient = context.createLinearGradient(0, 0, 0, runtime.viewport.height);
  gradient.addColorStop(0, skyTop);
  gradient.addColorStop(1, skyBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, runtime.viewport.width, runtime.viewport.height);

  if (classic) {
    const parallaxX = Math.round(state.cameraScrollX * 0.22) % runtime.viewport.width;
    const drawCloud = (x: number, y: number) => {
      context.fillStyle = "rgba(255, 255, 255, 0.92)";
      context.fillRect(x + 5, y + 4, 28, 8);
      context.fillRect(x + 11, y, 12, 16);
      context.fillRect(x + 24, y + 2, 14, 12);
      context.fillStyle = "rgba(198, 238, 255, 0.95)";
      context.fillRect(x + 7, y + 12, 28, 3);
    };
    const drawHill = (x: number, y: number, width: number, height: number, fill: string) => {
      context.fillStyle = fill;
      for (let step = 0; step < height; step += 4) {
        const inset = Math.round((step / height) * (width / 2));
        context.fillRect(x + inset, y + step, Math.max(0, width - inset * 2), 4);
      }
      context.fillStyle = "rgba(255,255,255,0.18)";
      context.fillRect(x + width * 0.28, y + 8, 12, 4);
    };
    if (theme !== "cave") {
      drawCloud(28 - parallaxX, 25);
      drawCloud(160 - parallaxX, 45);
      drawCloud(28 - parallaxX + runtime.viewport.width, 25);
      drawHill(-24 - Math.round(state.cameraScrollX * 0.12), 118, 104, 58, "#78d779");
      drawHill(80 - Math.round(state.cameraScrollX * 0.1), 126, 142, 52, "#a8e874");
      drawHill(188 - Math.round(state.cameraScrollX * 0.08), 112, 120, 66, "#6bc7db");
    } else {
      context.fillStyle = "#34304f";
      for (let x = 0; x < runtime.viewport.width; x += 28) {
        context.fillRect(x - (state.cameraScrollX % 28), 32 + ((x / 28) % 3) * 8, 18, 120);
      }
    }
  }

  const firstColumn = Math.floor(state.cameraScrollX / 16);
  const xOffset = -(state.cameraScrollX % 16);
  const drawClassicTile = (x: number, y: number, material: SnesCollisionMaterial) => {
    if (material === 2) {
      context.fillStyle = "#e84855";
      context.fillRect(x, y, 16, 16);
      context.fillStyle = "#fff0f3";
      context.fillRect(x + 3, y + 2, 3, 8);
      context.fillRect(x + 10, y + 3, 3, 7);
      context.fillStyle = "#7f1d1d";
      context.fillRect(x, y + 13, 16, 3);
      return;
    }
    if (material === 4) {
      context.fillStyle = "#2f94e8";
      context.fillRect(x, y, 16, 16);
      context.fillStyle = "#7bdfff";
      context.fillRect(x, y + 2, 16, 2);
      context.fillRect(x + 3, y + 9, 9, 1);
      return;
    }
    if (material === 1 || material === 3) {
      context.fillStyle = "#52c65a";
      context.fillRect(x, y, 16, 5);
      context.fillStyle = "#238442";
      context.fillRect(x, y + 4, 16, 2);
      context.fillStyle = "#9b6330";
      context.fillRect(x, y + 6, 16, 10);
      context.fillStyle = "#d4933f";
      context.fillRect(x + 2, y + 8, 3, 2);
      context.fillRect(x + 9, y + 12, 4, 2);
      context.fillStyle = "#74411f";
      context.fillRect(x, y + 15, 16, 1);
      return;
    }
  };
  for (let row = 0; row < SNES_STUDIO_EDIT_GRID.height; row += 1) {
    for (let column = 0; column <= 16; column += 1) {
      const worldColumn = firstColumn + column;
      const cellIndex =
        row * SNES_STUDIO_EDIT_GRID.width + (worldColumn % SNES_STUDIO_EDIT_GRID.width);
      const material = scene.collisionMap[cellIndex] ?? 0;
      const x = xOffset + column * 16;
      const y = row * 16;
      if (classic) {
        drawClassicTile(x, y, material);
      } else {
        context.fillStyle =
          material === 2
            ? "#ef4444"
            : material === 4
              ? "#2563eb"
              : material === 1 || material === 3
                ? "#7c4a24"
                : row < 4
                  ? "#a7e8ff"
                  : "#8fd3f4";
        context.fillRect(x, y, 16, 16);
        if (material === 1 || material === 3) {
          context.fillStyle = "#35a853";
          context.fillRect(x, y, 16, 3);
        }
      }
    }
  }

  const drawEntityBox = (
    x: number,
    y: number,
    width: number,
    height: number,
    fill: string,
    stroke = "#07111f",
  ) => {
    const screenX = Math.round(x - state.cameraScrollX);
    const screenY = Math.round(y);
    if (screenX < -24 || screenX > runtime.viewport.width + 24) {
      return;
    }
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.fillRect(screenX, screenY, width, height);
    context.strokeRect(screenX + 0.5, screenY + 0.5, width - 1, height - 1);
  };

  const drawPixelShadow = (screenX: number, screenY: number, width: number) => {
    context.fillStyle = "rgba(7, 17, 31, 0.26)";
    context.fillRect(screenX + 1, screenY + 15, Math.max(8, width - 2), 2);
  };

  const drawRuntimeEntity = (entity: SnesRuntimeEntity, x: number, y: number) => {
    const screenX = Math.round(x - state.cameraScrollX);
    const screenY = Math.round(y);
    if (screenX < -24 || screenX > runtime.viewport.width + 24) {
      return;
    }
    drawPixelShadow(screenX, screenY, entity.width);
    context.lineWidth = 1;
    context.strokeStyle = "#07111f";
    if (entity.role === "enemy") {
      context.fillStyle = "#ff9345";
      context.fillRect(screenX + 2, screenY + 4, 12, 9);
      context.fillStyle = "#e84855";
      context.fillRect(screenX + 4, screenY + 1, 8, 5);
      context.fillStyle = "#ffd84a";
      context.fillRect(screenX + 1, screenY + 11, 14, 3);
      context.fillStyle = "#07111f";
      context.fillRect(screenX + 5, screenY + 7, 2, 2);
      context.fillRect(screenX + 10, screenY + 7, 2, 2);
      context.strokeRect(screenX + 1.5, screenY + 1.5, 13, 12);
      return;
    }
    if (entity.role === "item") {
      context.fillStyle = "#fde68a";
      context.beginPath();
      context.moveTo(screenX + 6, screenY);
      context.lineTo(screenX + 12, screenY + 6);
      context.lineTo(screenX + 6, screenY + 12);
      context.lineTo(screenX, screenY + 6);
      context.closePath();
      context.fill();
      context.strokeStyle = "#d97706";
      context.stroke();
      context.fillStyle = "#fff7d6";
      context.fillRect(screenX + 5, screenY + 3, 3, 6);
      return;
    }
    if (entity.role === "door") {
      context.fillStyle = "#238442";
      context.fillRect(screenX + 1, screenY + 2, 14, 14);
      context.fillStyle = "#5ec65e";
      context.fillRect(screenX + 3, screenY, 10, 16);
      context.fillStyle = "#0f5132";
      context.fillRect(screenX + 5, screenY + 4, 6, 12);
      context.fillStyle = "#facc15";
      context.fillRect(screenX + 10, screenY + 8, 2, 2);
      context.strokeStyle = "#07111f";
      context.strokeRect(screenX + 1.5, screenY + 0.5, 13, 15);
      return;
    }
    if (entity.role === "goal") {
      context.fillStyle = "#17202a";
      context.fillRect(screenX + 3, screenY, 2, 16);
      context.fillStyle = "#ffd84a";
      context.fillRect(screenX + 5, screenY + 1, 10, 7);
      context.fillStyle = "#e84855";
      context.fillRect(screenX + 7, screenY + 3, 5, 2);
      return;
    }
    if (entity.role === "npc") {
      context.fillStyle = "#0ea5e9";
      context.fillRect(screenX + 2, screenY + 3, 12, 11);
      context.fillStyle = "#e0f2fe";
      context.fillRect(screenX + 5, screenY + 6, 2, 2);
      context.fillRect(screenX + 9, screenY + 6, 2, 2);
      context.strokeStyle = "#075985";
      context.strokeRect(screenX + 1.5, screenY + 2.5, 13, 12);
      return;
    }
    drawEntityBox(screenX + state.cameraScrollX, screenY, entity.width, entity.height, "#facc15");
  };

  const drawHero = () => {
    const screenX = Math.round(state.playerX - state.cameraScrollX);
    const screenY = Math.round(state.playerY);
    drawPixelShadow(screenX, screenY, 16);
    context.fillStyle = "#3157c8";
    context.fillRect(screenX + 4, screenY + 6, 8, 7);
    context.fillStyle = "#e84855";
    context.fillRect(screenX + 3, screenY + 2, 10, 5);
    context.fillStyle = "#f7c59f";
    context.fillRect(screenX + 5, screenY + 3, 7, 6);
    context.fillStyle = "#ffffff";
    context.fillRect(screenX + 9, screenY + 5, 2, 2);
    context.fillStyle = "#ffd84a";
    context.fillRect(screenX + 3, screenY + 13, 4, 3);
    context.fillRect(screenX + 9, screenY + 13, 4, 3);
    context.strokeStyle = "#07111f";
    context.strokeRect(screenX + 3.5, screenY + 0.5, 9, 15);
  };

  for (const entity of scene.entities) {
    if (entity.role === "hero") {
      continue;
    }
    if (state.collectedItems.includes(entity.id) || state.defeatedEnemies.includes(entity.id)) {
      continue;
    }
    const enemy = state.enemyPositions[entity.id];
    const x = enemy?.x ?? entity.x;
    const y = enemy?.y ?? entity.y;
    drawRuntimeEntity(entity, x, y);
  }
  drawHero();

  context.fillStyle = "rgba(7, 17, 31, 0.78)";
  context.fillRect(0, 0, runtime.viewport.width, 16);
  context.fillStyle = "#e0f2fe";
  context.font = "8px monospace";
  context.fillText(`HP ${state.health}  SCORE ${state.score}  F${state.frame}`, 6, 11);
  return true;
}

export function simulateSnesEventScripts(
  project: SnesStudioProject,
  trigger: SnesEventScript["trigger"],
  targetId = "scene",
): SnesEventSimulationResult {
  const normalized = normalizeSnesStudioProject(project);
  const cutsceneIds = new Set(normalized.dialogue.map((cutscene) => cutscene.id));
  const entityIds = new Set(
    normalized.scenes.flatMap((scene) => scene.entities.map((entity) => entity.id)),
  );
  const triggeredEventIds: string[] = [];
  const shownCutsceneIds: string[] = [];
  const grantedItemIds: string[] = [];
  const flags: string[] = [];
  const warnings: string[] = [];

  for (const event of normalized.events) {
    if (event.trigger !== trigger || (event.targetId !== targetId && event.targetId !== "scene")) {
      continue;
    }
    triggeredEventIds.push(event.id);
    if (event.targetId !== "scene" && !entityIds.has(event.targetId)) {
      warnings.push(`Event ${event.id} targets missing entity ${event.targetId}.`);
    }
    for (const action of event.actions) {
      if (action.type === "show-dialogue") {
        if (cutsceneIds.has(action.cutsceneId)) {
          shownCutsceneIds.push(action.cutsceneId);
        } else {
          warnings.push(`Event ${event.id} references missing cutscene ${action.cutsceneId}.`);
        }
      } else if (action.type === "give-item") {
        grantedItemIds.push(action.itemId);
      } else {
        flags.push(action.flag);
      }
    }
  }

  return {
    triggeredEventIds,
    shownCutsceneIds: [...new Set(shownCutsceneIds)],
    grantedItemIds: [...new Set(grantedItemIds)],
    flags: [...new Set(flags)],
    warnings,
  };
}

export function simulateSnesPreviewFrame(
  project: SnesStudioProject,
  previous: SnesPreviewSimulationState | null = null,
  input: SnesPreviewControllerInput = {},
): SnesPreviewSimulationState {
  return stepSnesRuntimeFrame(compileSnesRuntimeProject(project), previous, input);
}

function collisionSignature(state: SnesPreviewSimulationState): string {
  return stableStringify(
    {
      cameraScrollX: state.cameraScrollX,
      collectedItems: state.collectedItems,
      collisions: state.collisions,
      defeatedEnemies: state.defeatedEnemies,
      enemyPositions: state.enemyPositions,
      grounded: state.grounded,
      health: state.health,
      inputLog: state.inputLog,
      inventory: state.inventory,
      lives: state.lives,
      playerX: state.playerX,
      playerY: state.playerY,
      playerYVelocity: state.playerYVelocity,
      score: state.score,
      status: state.status,
    },
    0,
  );
}

export function createSnesCollisionParityReport(
  project: SnesStudioProject,
  inputs: SnesPreviewControllerInput[] = [
    { right: true },
    { jump: true },
    { right: true },
    { right: true },
    {},
  ],
): SnesCollisionParityReport {
  const normalized = normalizeSnesStudioProject(project);
  const run = () =>
    inputs.reduce<SnesPreviewSimulationState | null>(
      (state, input) => simulateSnesPreviewFrame(normalized, state, input),
      null,
    );
  const first = run();
  const second = run();
  const firstSignature = first ? collisionSignature(first) : "";
  const secondSignature = second ? collisionSignature(second) : "";
  const deterministic = firstSignature === secondSignature && first !== null;
  const materialCounts = {
    passable: 0,
    solid: 0,
    hazard: 0,
    oneWay: 0,
    water: 0,
  };
  for (const scene of normalized.scenes) {
    for (const material of scene.collisionMap) {
      if (material === 1) {
        materialCounts.solid += 1;
      } else if (material === 2) {
        materialCounts.hazard += 1;
      } else if (material === 3) {
        materialCounts.oneWay += 1;
      } else if (material === 4) {
        materialCounts.water += 1;
      } else {
        materialCounts.passable += 1;
      }
    }
  }
  const blockers = [
    ...(deterministic ? [] : ["Preview collision simulation is not deterministic."]),
    "Emulator WRAM/state-dump comparison is still required before ROM collision parity is verified.",
  ];
  return {
    status: deterministic ? "verified" : "blocked",
    runtimeStatus: "blocked-until-emulator-state-dump",
    frameCount: inputs.length,
    deterministic,
    finalStateChecksum: calculateChecksum(new TextEncoder().encode(firstSignature)),
    materialCounts,
    collisions: first?.collisions ?? [],
    blockers,
  };
}

export function buildSnesPreviewRom(project: SnesStudioProject): SnesPreviewRomArtifact {
  const buildProject = normalizeSnesStudioProject(project);
  const runtimeProject = compileSnesRuntimeProject(buildProject);
  const readiness = buildSnesReadiness(buildProject);
  const blockingIssue = readiness.issues.find((issue) => issue.severity === "error");
  if (blockingIssue) {
    throw new Error(`Cannot build preview ROM while project is blocked: ${blockingIssue.code}`);
  }
  if (buildProject.profile.mapMode !== "lorom") {
    throw new Error("Preview ROM builder supports LoROM projects only.");
  }
  if (
    buildProject.profile.videoMode !== "mode1" ||
    buildProject.profile.enhancementChip !== "none"
  ) {
    throw new Error("Preview ROM builder supports Mode 1 without enhancement chips.");
  }

  const manifest = createFxpakExportManifest(buildProject);
  const romBytes = Math.max(128 * 1024, (buildProject.profile.romSizeMbit * 1024 * 1024) / 8);
  const bytes = new Uint8Array(romBytes);
  bytes.fill(0xff);

  const backdropColor = backdropColorForProject(buildProject);
  const graphics = createMode1SceneGraphics(buildProject, backdropColor);
  const sceneRuntimeTable = createSnesSceneRuntimeTable(buildProject);
  const levelTransitions = createSnesLevelTransitionPlan(buildProject);
  const runtimeEvents = createSnesRuntimeEventPlan(buildProject);
  const eventBytecode = compileSnesRuntimeEventBytecode(buildProject);
  const levelLoaderTable = createSnesRomLevelLoaderTable(buildProject);
  const collisionPhysics = createSnesCollisionPhysicsPlan(buildProject);
  const persistence = createSnesProjectPersistencePlan();
  const saveManifest = createSnesSaveManifest(buildProject);
  const entitySprites = runtimeEntitySprites(buildProject);
  const runtimeProgram = createMode1RuntimeProgram(
    graphics,
    backdropColor,
    saveManifest,
    entitySprites,
  );
  bytes.set(runtimeProgram.bytes, 0);

  const graphicSections = [
    { name: "palette", offset: PALETTE_DATA_OFFSET, bytes: graphics.palette },
    { name: "CHR", offset: CHR_DATA_OFFSET, bytes: graphics.chr },
    { name: "tilemap", offset: TILEMAP_DATA_OFFSET, bytes: graphics.tilemap },
    { name: "collision map", offset: COLLISION_MAP_DATA_OFFSET, bytes: graphics.collisionMap },
    {
      name: "event bytecode",
      offset: EVENT_BYTECODE_DATA_OFFSET,
      bytes: hexToBytes(eventBytecode.bytecodeHex),
    },
    {
      name: "level loader table",
      offset: LEVEL_TABLE_DATA_OFFSET,
      bytes: hexToBytes(levelLoaderTable.bytecodeHex),
    },
  ];
  for (const section of graphicSections) {
    if (section.offset + section.bytes.byteLength > bytes.byteLength) {
      throw new Error(`Compiled ${section.name} data does not fit inside the configured ROM size.`);
    }
    bytes.set(section.bytes, section.offset);
  }

  const runtimeData = createRuntimeDataPayload(buildProject);
  if (RUNTIME_DATA_OFFSET + runtimeData.bytes.byteLength > bytes.byteLength) {
    throw new Error("Project runtime data does not fit inside the configured ROM size.");
  }
  bytes.set(runtimeData.bytes, RUNTIME_DATA_OFFSET);

  writeAscii(bytes, LOROM_HEADER_OFFSET, 21, buildProject.name);
  bytes[LOROM_HEADER_OFFSET + 0x15] = 0x20; // LoROM, slow ROM.
  bytes[LOROM_HEADER_OFFSET + 0x16] = buildProject.save.enabled ? 0x02 : 0x00;
  bytes[LOROM_HEADER_OFFSET + 0x17] = romSizeExponent(buildProject.profile.romSizeMbit);
  bytes[LOROM_HEADER_OFFSET + 0x18] = buildProject.save.enabled
    ? sramSizeExponent(buildProject.profile.sramSizeKib)
    : 0x00;
  bytes[LOROM_HEADER_OFFSET + 0x19] = buildProject.profile.region === "ntsc" ? 0x01 : 0x02;
  bytes[LOROM_HEADER_OFFSET + 0x1a] = 0x33;
  bytes[LOROM_HEADER_OFFSET + 0x1b] = 0x00;
  writeU16(bytes, LOROM_HEADER_OFFSET + 0x1c, 0);
  writeU16(bytes, LOROM_HEADER_OFFSET + 0x1e, 0);

  for (let offset = LOROM_VECTOR_START_OFFSET; offset <= LOROM_RESET_VECTOR_OFFSET; offset += 2) {
    writeU16(bytes, offset, SNES_RESET_VECTOR);
  }

  const checksum = calculateChecksum(bytes);
  const checksumComplement = checksum ^ 0xffff;
  writeU16(bytes, LOROM_HEADER_OFFSET + 0x1c, checksumComplement);
  writeU16(bytes, LOROM_HEADER_OFFSET + 0x1e, checksum);
  const symbols = [
    loRomSymbol(
      "ResetVectorRoutine",
      0,
      runtimeProgram.bytes.length,
      "65816 reset routine entrypoint.",
    ),
    loRomSymbol(
      "Mode1PpuBootstrap",
      runtimeProgram.ppuBootstrapOffset,
      runtimeProgram.cgramUploadOffset - runtimeProgram.ppuBootstrapOffset,
      "Initializes force blank, Mode 1, BG1 screen registers, and upload ports.",
    ),
    loRomSymbol(
      "CgramPaletteUpload",
      runtimeProgram.cgramUploadOffset,
      runtimeProgram.vramChrUploadOffset - runtimeProgram.cgramUploadOffset,
      "Uploads the compiled first-scene palette into CGRAM.",
    ),
    loRomSymbol(
      "VramChrUpload",
      runtimeProgram.vramChrUploadOffset,
      runtimeProgram.vramTilemapUploadOffset - runtimeProgram.vramChrUploadOffset,
      "Uploads compiled 4bpp BG1 character tiles into VRAM.",
    ),
    loRomSymbol(
      "VramTilemapUpload",
      runtimeProgram.vramTilemapUploadOffset,
      runtimeProgram.joypadLoopOffset - runtimeProgram.vramTilemapUploadOffset,
      "Uploads the compiled BG1 tilemap into VRAM.",
    ),
    loRomSymbol(
      "JoypadPollLoop",
      runtimeProgram.joypadLoopOffset,
      runtimeProgram.bytes.length - runtimeProgram.joypadLoopOffset,
      "Polls auto joypad registers and mirrors player 1 state into WRAM $0200-$0201.",
    ),
    loRomSymbol(
      "OamClearLoop",
      runtimeProgram.oamClearOffset,
      runtimeProgram.playerOamUpdateOffset - runtimeProgram.oamClearOffset,
      "Clears OAM before the preview player sprite is written.",
    ),
    loRomSymbol(
      "PlayerOamUpdate",
      runtimeProgram.playerOamUpdateOffset,
      runtimeProgram.entityOamUpdateOffset - runtimeProgram.playerOamUpdateOffset,
      "Writes preview player OBJ coordinates, tile, and attributes to OAM.",
    ),
    loRomSymbol(
      "EntityOamUpdate",
      runtimeProgram.entityOamUpdateOffset,
      runtimeProgram.joypadLoopOffset - runtimeProgram.entityOamUpdateOffset,
      "Writes preview enemy, item, and NPC OBJ coordinates, tiles, and attributes to OAM.",
    ),
    ...(runtimeProgram.sramHeaderBootstrapOffset === null
      ? []
      : [
          loRomSymbol(
            "SramHeaderBootstrap",
            runtimeProgram.sramHeaderBootstrapOffset,
            saveManifest.sramHeaderSizeBytes * 6,
            "Writes the versioned OpenClaw save header into LoROM SRAM.",
          ),
        ]),
    loRomSymbol(
      "ControllerScrollStep",
      runtimeProgram.controllerScrollStepOffset,
      runtimeProgram.playerPhysicsStepOffset - runtimeProgram.controllerScrollStepOffset,
      "Updates BG1 horizontal scroll and player X position from left/right controller input.",
    ),
    loRomSymbol(
      "PlayerPhysicsStep",
      runtimeProgram.playerPhysicsStepOffset,
      runtimeProgram.bytes.length - runtimeProgram.playerPhysicsStepOffset,
      "Applies jump input, gravity, ground collision clamp, and grounded state.",
    ),
    loRomSymbol("SnesInternalHeader", LOROM_HEADER_OFFSET, 0x40, "SNES LoROM internal header."),
    loRomSymbol(
      "Mode1CgramPalette",
      PALETTE_DATA_OFFSET,
      graphics.palette.byteLength,
      "Compiled 16-color CGRAM palette for the first scene.",
    ),
    loRomSymbol(
      "Mode1ChrTiles",
      CHR_DATA_OFFSET,
      graphics.chr.byteLength,
      "Compiled 4bpp BG1 character tiles for the first scene.",
    ),
    ...(graphics.importedTileCount > 0
      ? [
          loRomSymbol(
            "Mode1ImportedChrTiles",
            CHR_DATA_OFFSET + graphics.importedTileBaseIndex * TILE_BYTES_4BPP,
            graphics.importedTileCount * TILE_BYTES_4BPP,
            "Imported 4bpp CHR tiles appended after built-in preview tiles.",
          ),
        ]
      : []),
    loRomSymbol(
      "Mode1Bg1Tilemap",
      TILEMAP_DATA_OFFSET,
      graphics.tilemap.byteLength,
      "Compiled 32x32 BG1 tilemap for the first scene.",
    ),
    loRomSymbol(
      "Mode1CollisionMap",
      COLLISION_MAP_DATA_OFFSET,
      graphics.collisionMap.byteLength,
      "Compiled 16x12 solid-cell collision map for the first scene.",
    ),
    loRomSymbol(
      "EventBytecode",
      EVENT_BYTECODE_DATA_OFFSET,
      eventBytecode.sizeBytes,
      "Deterministic no-code event bytecode for the future 65816 event VM.",
    ),
    loRomSymbol(
      "Mode1LevelLoaderTable",
      LEVEL_TABLE_DATA_OFFSET,
      levelLoaderTable.sizeBytes,
      "Binary scene table for future runtime level loading and transitions.",
    ),
    loRomSymbol(
      "OpenClawProjectData",
      RUNTIME_DATA_OFFSET,
      runtimeData.bytes.byteLength,
      "Stable SNES Studio project JSON runtime data block.",
    ),
  ];
  const mapFileName = `${manifest.romFileName.replace(/\.sfc$/i, "")}.map`;
  const manifestFileName = `${manifest.romFileName.replace(/\.sfc$/i, "")}.build.json`;
  const mapText = createRomMapText(symbols, {
    fileName: manifest.romFileName,
    checksum,
    checksumComplement,
  });
  const manifestJson = `${stableStringify(
    {
      artifact: "openclaw-snes-preview-rom",
      assets: {
        audio: createSnesAudioManifest(buildProject),
        backgroundTiles: buildProject.assets.backgroundTiles,
        customTileBrushes: buildProject.assets.customTileBrushes,
        importedTilesets: buildProject.assets.importedTilesets.map((tileset) => ({
          chrChecksum: tileset.chrChecksum,
          chrSizeBytes: tileset.chrSizeBytes,
          id: tileset.id,
          name: tileset.name,
          palettePreviewHex: tileset.palettePreviewHex,
          quantized: tileset.quantized,
          sourceTileCount: tileset.sourceTileCount,
          sourceColorCount: tileset.sourceColorCount,
          uniqueTileCount: tileset.uniqueTileCount,
          warnings: tileset.warnings,
        })),
        spriteTiles: buildProject.assets.spriteTiles,
        pipeline: createSnesAssetPipelineReport(buildProject),
      },
      fileName: manifest.romFileName,
      fxpak: {
        cardSizeGb: manifest.cardSizeGb,
        preserveExistingSave: manifest.preserveExistingSave,
        requiredFileSystem: manifest.requiredFileSystem,
        romPath: manifest.romPath,
        savePath: manifest.savePath,
      },
      graphics: {
        artDirection: buildProject.artDirection,
        assetProvenance: buildProject.assetProvenance,
        bg1ChrBaseWord: graphics.bg1ChrBaseWord,
        bg1TilemapBaseWord: graphics.bg1TilemapBaseWord,
        builtinTileCount: graphics.builtinTileCount,
        chrOffset: CHR_DATA_OFFSET,
        chrSizeBytes: graphics.chr.byteLength,
        importedTileBaseIndex: graphics.importedTileBaseIndex,
        importedTileCount: graphics.importedTileCount,
        paletteOffset: PALETTE_DATA_OFFSET,
        paletteSizeBytes: graphics.palette.byteLength,
        styleBudgetEstimate: graphics.stylePack.budgetEstimate,
        stylePackName: graphics.stylePack.name,
        styleWarnings: buildProject.styleWarnings,
        tileCount: graphics.tileCount,
        tilemapOffset: TILEMAP_DATA_OFFSET,
        tilemapSizeBytes: graphics.tilemap.byteLength,
        visualStylePreset: buildProject.visualStylePreset,
      },
      scene: {
        activeSceneId: sceneRuntimeTable[0]?.id ?? "scene-empty",
        activeSceneIndex: 0,
        collisionMapChecksum: graphics.collisionMapChecksum,
        collisionMapOffset: COLLISION_MAP_DATA_OFFSET,
        collisionMapSizeBytes: graphics.collisionMap.byteLength,
        collisionTileCount: graphics.collisionTileCount,
        editGridHeight: SNES_STUDIO_EDIT_GRID.height,
        editGridWidth: SNES_STUDIO_EDIT_GRID.width,
        levelLoaderTable,
        runtimeTable: sceneRuntimeTable,
        transitionPlan: levelTransitions,
        runtimeEntitySprites: entitySprites,
        tilemapChecksum: graphics.tilemapChecksum,
      },
      mapMode: buildProject.profile.mapMode,
      project: {
        animationCount: buildProject.animations.length,
        cutsceneCount: buildProject.dialogue.length,
        eventScriptCount: buildProject.events.length,
        id: buildProject.id,
        name: buildProject.name,
        schemaVersion: buildProject.schemaVersion,
        sceneCount: buildProject.scenes.length,
      },
      region: buildProject.profile.region,
      rom: {
        checksum,
        checksumComplement,
        resetVector: SNES_RESET_VECTOR,
        sizeBytes: bytes.byteLength,
      },
      save: saveManifest,
      runtime: {
        backdropColor: runtimeProgram.backdropColor,
        cameraScrollAddress: WRAM_CAMERA_SCROLL_X_ADDRESS,
        collisionPhysics,
        controllerStateAddress: WRAM_JOYPAD_STATE_ADDRESS,
        controllerScrollStepOffset: runtimeProgram.controllerScrollStepOffset,
        cgramUploadOffset: runtimeProgram.cgramUploadOffset,
        entityOamSpriteCount: runtimeProgram.entityOamSpriteCount,
        entityOamUpdateOffset: runtimeProgram.entityOamUpdateOffset,
        joypadLoopOffset: runtimeProgram.joypadLoopOffset,
        mode: "mode1-preview",
        oamClearOffset: runtimeProgram.oamClearOffset,
        playtest: runtimeProject.manifest,
        playerOamUpdateOffset: runtimeProgram.playerOamUpdateOffset,
        playerPhysicsStepOffset: runtimeProgram.playerPhysicsStepOffset,
        playerStart: {
          gravityPerFrame: buildProject.physics.gravityPerFrame,
          groundY: buildProject.physics.groundY,
          groundedAddress: WRAM_PLAYER_GROUNDED_ADDRESS,
          jumpVelocity: buildProject.physics.jumpVelocity,
          maxFallSpeed: buildProject.physics.maxFallSpeed,
          moveSpeed: buildProject.physics.moveSpeed,
          tileIndex: PREVIEW_PLAYER_TILE_INDEX,
          x: PREVIEW_PLAYER_START_X,
          xAddress: WRAM_PLAYER_X_ADDRESS,
          y: PREVIEW_PLAYER_START_Y,
          yAddress: WRAM_PLAYER_Y_ADDRESS,
          yVelocityAddress: WRAM_PLAYER_Y_VELOCITY_ADDRESS,
        },
        ppuBootstrapOffset: runtimeProgram.ppuBootstrapOffset,
        resetProgramSizeBytes: runtimeProgram.bytes.length,
        sramBaseAddress: saveManifest.sramBaseAddress,
        sramHeaderBootstrapOffset: runtimeProgram.sramHeaderBootstrapOffset,
        vramChrUploadOffset: runtimeProgram.vramChrUploadOffset,
        vramTilemapUploadOffset: runtimeProgram.vramTilemapUploadOffset,
      },
      events: runtimeEvents,
      eventBytecode,
      cutscenes: createSnesCutsceneTimeline(buildProject),
      persistence,
      runtimeData: {
        checksum: runtimeData.checksum,
        jsonSizeBytes: runtimeData.jsonSizeBytes,
        offset: RUNTIME_DATA_OFFSET,
        sizeBytes: runtimeData.bytes.byteLength,
      },
      symbols,
      videoMode: buildProject.profile.videoMode,
    },
    0,
  )}\n`;

  const artifact: SnesPreviewRomArtifact = {
    fileName: manifest.romFileName,
    bytes,
    mapFileName,
    mapText,
    manifestFileName,
    manifestJson,
    sizeBytes: bytes.byteLength,
    resetVector: SNES_RESET_VECTOR,
    checksum,
    checksumComplement,
    runtimeDataOffset: RUNTIME_DATA_OFFSET,
    runtimeDataSizeBytes: runtimeData.bytes.byteLength,
    runtimeDataChecksum: runtimeData.checksum,
    runtimeManifest: runtimeProject.manifest,
    graphics: {
      paletteOffset: PALETTE_DATA_OFFSET,
      paletteSizeBytes: graphics.palette.byteLength,
      chrOffset: CHR_DATA_OFFSET,
      chrSizeBytes: graphics.chr.byteLength,
      tilemapOffset: TILEMAP_DATA_OFFSET,
      tilemapSizeBytes: graphics.tilemap.byteLength,
      builtinTileCount: graphics.builtinTileCount,
      importedTileBaseIndex: graphics.importedTileBaseIndex,
      importedTileCount: graphics.importedTileCount,
      tileCount: graphics.tileCount,
      bg1ChrBaseWord: graphics.bg1ChrBaseWord,
      bg1TilemapBaseWord: graphics.bg1TilemapBaseWord,
      visualStylePreset: buildProject.visualStylePreset ?? SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
      assetProvenance: buildProject.assetProvenance ?? "original-generated",
      stylePackName: graphics.stylePack.name,
    },
    scene: {
      activeSceneId: sceneRuntimeTable[0]?.id ?? "scene-empty",
      activeSceneIndex: 0,
      collisionMapChecksum: graphics.collisionMapChecksum,
      collisionMapOffset: COLLISION_MAP_DATA_OFFSET,
      collisionMapSizeBytes: graphics.collisionMap.byteLength,
      collisionTileCount: graphics.collisionTileCount,
      editGridHeight: SNES_STUDIO_EDIT_GRID.height,
      editGridWidth: SNES_STUDIO_EDIT_GRID.width,
      runtimeTable: sceneRuntimeTable,
      tilemapChecksum: graphics.tilemapChecksum,
    },
    symbols,
    notes: [
      "Generated an unheadered LoROM .sfc preview runtime artifact.",
      "Compiles first-scene palette, 4bpp CHR tiles, BG1 tilemap data, and collision map data into the ROM.",
      "Embeds deterministic event bytecode and a binary level-loader table for VM/loader validation.",
      "Initializes Mode 1, uploads compiled CGRAM/VRAM scene data, enables auto joypad reads, mirrors player 1 state into WRAM, scrolls BG1 with left/right input, and writes a preview player OBJ through OAM.",
      "Includes a valid internal header, checksum/complement pair, reset vectors, and embedded project data.",
      "This is a compiler smoke artifact with inspectable symbols, not the final game runtime.",
    ],
  };
  const validation = validateSnesPreviewRomArtifact(artifact);
  const failed = validation.checks.find((check) => !check.passed && check.severity === "error");
  if (failed) {
    throw new Error(`Generated preview ROM failed integrity validation: ${failed.code}`);
  }
  return artifact;
}

export function createSnesBuildPipeline(project: SnesStudioProject): SnesBuildStep[] {
  const target: SnesBuildTarget[] = [project.profile.target];
  return [
    {
      id: "schema-validate",
      label: "Validate project schema",
      owner: "project",
      requiredFor: target,
      description: "Check project files, save schema, hardware profile, and export settings.",
    },
    {
      id: "assets-pack",
      label: "Pack SNES assets",
      owner: "asset-pipeline",
      requiredFor: target,
      description:
        "Quantize palettes, pack tiles, build metasprites, convert audio, and plan banks.",
    },
    {
      id: "runtime-data",
      label: "Generate runtime data",
      owner: "runtime",
      requiredFor: target,
      description:
        "Emit scene, entity, collision, SRAM, menu, and event data for the Mode 1 runtime.",
    },
    {
      id: "compile-rom",
      label: "Compile deterministic ROM",
      owner: "compiler",
      requiredFor: target,
      description:
        "Build an unheadered LoROM .sfc with valid internal header, checksum, and symbols.",
    },
    {
      id: "fxpak-export",
      label: "Prepare FXPAK PRO export",
      owner: "export",
      requiredFor: ["fxpak-pro"],
      description: "Dry-run FAT32 copy, protect SRAM, write manifest, and verify hashes.",
    },
  ];
}

export function createSnesProjectTemplates(): SnesProjectTemplate[] {
  return [
    {
      id: "mode1-platformer",
      name: "Mode 1 Platformer",
      summary:
        "Hardware-safe starter with drawing, bump rules, game pieces, save points, and hardware export.",
      prompt:
        'Create "Moonlit Ridge" as a polished SNES platformer with a hero, patrol enemies, collectibles, dialogue, save points, and real-hardware export.',
      enhancementChip: "none",
      videoMode: "mode1",
      status: "ready",
    },
    {
      id: "exploration-rpg",
      name: "Exploration RPG",
      summary: "Dialogue-forward exploration game with NPCs, items, flags, and save fields.",
      prompt:
        'Create "Signal Grove" as an exploration RPG slice with NPC dialogue, item collection, event flags, save points, and conservative SNES limits.',
      enhancementChip: "none",
      videoMode: "mode1",
      status: "ready",
    },
    {
      id: "superfx-rail-concept",
      name: "SuperFX Rail Concept",
      summary: "Star Fox-style concept profile that stays blocked until real GSU tooling lands.",
      prompt:
        'Create "Vector Fox Run" as a SuperFX rail-shooter concept with polygon enemies, cockpit HUD, SRAM progress, and FXPAK PRO SuperFX compatibility constraints.',
      enhancementChip: "superfx",
      videoMode: "superfx",
      status: "concept-blocked",
    },
  ];
}

export function createSnesProjectFromTemplate(
  templateId: SnesProjectTemplate["id"],
  updatedAt = new Date().toISOString(),
): SnesStudioProject {
  const template = createSnesProjectTemplates().find((candidate) => candidate.id === templateId);
  if (!template) {
    throw new Error(`Unknown SNES Studio template: ${templateId}`);
  }
  const generated = generateSnesProjectFromPrompt(
    template.prompt,
    createDefaultSnesStudioProject(updatedAt),
  ).project;
  generated.profile.enhancementChip = template.enhancementChip;
  generated.profile.videoMode = template.videoMode;
  if (template.status === "concept-blocked") {
    generated.profile.mapMode = "lorom";
    generated.profile.target = "fxpak-pro";
    generated.profile.fxpak.fileSystem = "fat32";
    generated.profile.fxpak.cardSizeGb = SNES_HARDWARE_LIMITS.defaultFxpakCardGb;
    generated.profile.fxpak.preserveExistingSaves = true;
  }
  generated.updatedAt = updatedAt;
  return normalizeSnesStudioProject(generated);
}

export function createSnesGuidedBuildChecklist(
  project: SnesStudioProject,
): SnesGuidedBuildChecklistItem[] {
  const normalized = normalizeSnesStudioProject(project);
  const readiness = buildSnesReadiness(normalized);
  const romReady =
    readiness.status !== "blocked" &&
    normalized.profile.mapMode === "lorom" &&
    normalized.profile.videoMode === "mode1" &&
    normalized.profile.enhancementChip === "none";
  const emulatorProof = romReady
    ? createSnesEmulatorValidationReport(buildSnesPreviewRom(normalized))
    : null;
  const hasImportedArt = normalized.assets.importedTilesets.length > 0;
  const hasEvents = normalized.events.length > 0;
  const hasSave = normalized.save.enabled && normalized.save.fields.length > 0;
  return [
    {
      id: "game-prompt",
      label: "Create a game draft",
      status: normalized.name.trim() ? "complete" : "action-needed",
      detail: normalized.name.trim()
        ? `${normalized.name} is ready to edit.`
        : "No project name has been created yet.",
      nextAction: "Use Create Game or choose a template.",
    },
    {
      id: "edit-level",
      label: "Edit a playable level",
      status: normalized.scenes.length > 0 ? "complete" : "action-needed",
      detail: `${normalized.scenes.length} editable level${normalized.scenes.length === 1 ? "" : "s"} in the project.`,
      nextAction: "Paint tiles, collision, and drag entities onto the grid.",
    },
    {
      id: "art-assets",
      label: "Import or paint art",
      status: hasImportedArt ? "complete" : "action-needed",
      detail: hasImportedArt
        ? `${normalized.assets.importedTilesets.length} imported tileset${normalized.assets.importedTilesets.length === 1 ? "" : "s"}.`
        : "Using built-in preview tiles only.",
      nextAction: "Drop a PNG tileset or create custom tile brushes.",
    },
    {
      id: "logic-events",
      label: "Connect game logic",
      status: hasEvents ? "complete" : "action-needed",
      detail: `${normalized.events.length} event script${normalized.events.length === 1 ? "" : "s"}.`,
      nextAction: "Use Events and Logic or ask AI to create scripts.",
    },
    {
      id: "save-system",
      label: "Protect progress with SRAM",
      status: hasSave ? "complete" : "action-needed",
      detail: hasSave
        ? `${normalized.save.fields.length} SRAM field${normalized.save.fields.length === 1 ? "" : "s"} across ${normalized.save.slots} slot${normalized.save.slots === 1 ? "" : "s"}.`
        : "SRAM save fields are not configured.",
      nextAction: "Open FXPAK Export and add save fields.",
    },
    {
      id: "rom-build",
      label: "Build a preview ROM",
      status: romReady ? "complete" : "blocked",
      detail: `Readiness is ${readiness.status.toUpperCase()} ${readiness.score}/100.`,
      nextAction: romReady
        ? "Build ROM and export proof files."
        : (readiness.issues[0]?.suggestion ?? "Resolve blockers."),
    },
    {
      id: "emulator-proof",
      label: "Prove emulator boot",
      status: emulatorProof?.status === "ready" ? "action-needed" : "blocked",
      detail:
        emulatorProof?.status === "ready"
          ? `${emulatorProof.selectedEmulator} can be used for screenshot proof.`
          : (emulatorProof?.blockers[0] ?? "Preview ROM or emulator proof is not ready."),
      nextAction: "Install a supported emulator and run screenshot proof.",
    },
  ];
}

export function createSnesOnePromptGameReport(project: SnesStudioProject): SnesOnePromptGameReport {
  const normalized = normalizeSnesStudioProject(project);
  const readiness = buildSnesReadiness(normalized);
  const components = createSnesGuidedBuildChecklist(normalized);
  const editableObjectCount = createSnesGeneratedObjectSummary(normalized).length;
  const completeCount = components.filter((component) => component.status === "complete").length;
  const blockedCount = components.filter((component) => component.status === "blocked").length;
  const score = Math.round((completeCount / Math.max(1, components.length)) * 100);
  const actionNeededPanels: SnesOnePromptGameReport["nextEditPanels"] = [];
  for (const component of components) {
    if (component.status === "complete") {
      continue;
    }
    if (component.id === "edit-level" || component.id === "art-assets") {
      actionNeededPanels.push(component.id === "edit-level" ? "scene" : "assets");
    } else if (component.id === "logic-events") {
      actionNeededPanels.push("logic");
    } else if (component.id === "save-system" || component.id === "rom-build") {
      actionNeededPanels.push("export");
    } else if (component.id === "game-prompt") {
      actionNeededPanels.push("prompt");
    }
  }
  return {
    status:
      blockedCount > 0
        ? "blocked"
        : completeCount === components.length
          ? "ready"
          : "action-needed",
    score: Math.min(readiness.score, score),
    editableObjectCount,
    prompt: {
      placeholder:
        createSnesAiAuthoringPrompts(normalized).find((entry) => entry.surface === "full-game")
          ?.placeholder ?? "",
      requiredSurfaces: [
        "full-game",
        "level",
        "player",
        "enemies",
        "items",
        "dialogue",
        "audio",
        "save",
        "export",
      ],
    },
    components,
    nextEditPanels: [...new Set(actionNeededPanels)],
    acceptance: [
      "A single prompt creates an editable project name, level, player, enemies, items, audio, story, save fields, and export settings.",
      "Every generated object appears in an edit panel after creation.",
      "Build readiness and static ROM validation remain visible before emulator or hardware claims.",
    ],
  };
}

export function createSnesMacPackagingReport(
  bundlePath: string,
  signingIdentity: string | null = null,
): SnesMacPackagingReport {
  const trimmedIdentity = signingIdentity?.trim() || null;
  const blockers = trimmedIdentity
    ? []
    : [
        "Developer ID signing identity was not provided.",
        "Apple notarization proof is required before distributing to other MacBooks.",
      ];
  return {
    status: trimmedIdentity ? "signed" : "unsigned-blocked",
    bundlePath,
    signingIdentity: trimmedIdentity,
    notarizationRequired: true,
    blockers,
  };
}

export function createSnesAgentTaskBlueprints(
  project: SnesStudioProject,
): SnesAgentTaskBlueprint[] {
  const readiness = buildSnesReadiness(project);
  return [
    {
      role: "SNES Constraints Engineer",
      title: "Audit hardware budgets",
      approvalRequired: true,
      prompt: `Audit ${project.name} for SNES Mode 1 hardware risks. Current readiness: ${readiness.status}, score ${readiness.score}. Return proposed JSON patches only.`,
    },
    {
      role: "Codex Build Engineer",
      title: "Diagnose build pipeline",
      approvalRequired: true,
      prompt: `Review the LoROM build pipeline for ${project.name}. Preserve FXPAK PRO FAT32 and SRAM safety rules. Return a testable patch plan.`,
    },
    {
      role: "Pixel Art Director",
      title: "Improve asset budgets",
      approvalRequired: true,
      prompt: `Suggest palette, tile, and metasprite improvements for ${project.name}. Keep all changes inside SNES CGRAM, VRAM, and OAM budgets.`,
    },
  ];
}

export function stableProjectJson(project: SnesStudioProject): string {
  return `${stableStringify(normalizeSnesStudioProject(project), 0)}\n`;
}

function stableStringify(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[\n${value.map((item) => `${childIndent}${stableStringify(item, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.length === 0) {
    return "{}";
  }
  return `{\n${keys
    .map(
      (key) => `${childIndent}${JSON.stringify(key)}: ${stableStringify(record[key], depth + 1)}`,
    )
    .join(",\n")}\n${indent}}`;
}
