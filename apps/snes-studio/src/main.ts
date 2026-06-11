import {
  appendSnesAgentDispatchRecord,
  appendSnesProjectVersion,
  applySnesImportedTileset,
  buildSnesPreviewRom,
  createDefaultSnesStudioProject,
  createSnesEmulatorValidationReport,
  createSnesAgentDispatchRecord,
  createSnesAudioManifest,
  createSnesCodexTaskPacket,
  createSnesFxpakExportPackage,
  createSnesProjectBundle,
  createSnesProjectVersion,
  createSnesSuperFxProfileReport,
  importSnesIndexedTileAsset,
  normalizeSnesStudioProject,
  paintSnesSceneCell,
  paintSnesSceneRect,
  parseSnesAgentDispatchQueue,
  parseSnesProjectVersionHistory,
  parseSnesIndexedTilePixels,
  parseSnesAgentPatchProposalResponse,
  SNES_AGENT_DISPATCH_EVENT,
  SNES_AGENT_DISPATCH_QUEUE_KEY,
  SNES_IMPORTED_TILE_BRUSH_BASE,
  SNES_STUDIO_EDIT_GRID,
  stableProjectJson,
  validateSnesPreviewRomArtifact,
  type SnesAgentDispatchRecord,
  type SnesAgentPatchProposal,
  type SnesBudgetMeter,
  type SnesProjectVersion,
  type SnesSceneEntityKind,
  type SnesStudioProject,
  type SnesTileBrush,
} from "@openclaw/snes-studio-core";
import {
  applyStandaloneAgentPatch,
  createStandaloneAgentPatchProposal,
  createStandaloneViewModel,
  loadStandaloneProject,
  meterPercent,
  parseSnesStudioProject,
  saveStandaloneProject,
  saveStandaloneSnapshot,
} from "./standalone-state.ts";
import "./styles.css";

type Panel = "project" | "scene" | "assets" | "export" | "agents";

const STANDALONE_VERSION_HISTORY_KEY = "openclaw:snes-studio:standalone:versions:v1";

type AppState = {
  agentDispatchQueue: SnesAgentDispatchRecord[];
  agentPatchDraft: string;
  assetImportHeight: number;
  assetImportName: string;
  assetImportPixels: string;
  assetImportWidth: number;
  consoleLines: string[];
  lastSnapshotAt: string | null;
  panel: Panel;
  pendingAgentProposal: SnesAgentPatchProposal | null;
  projectVersions: SnesProjectVersion[];
  selectedPaintMode: "collision" | "tile";
  promptDraft: string;
  project: SnesStudioProject;
  redoStack: string[];
  selectedTileBrush: SnesTileBrush;
  undoStack: string[];
};

const app = document.querySelector<HTMLElement>("#app");
if (!app) {
  throw new Error("SNES Studio root element not found.");
}

const state: AppState = {
  agentDispatchQueue: loadAgentDispatchQueue(),
  agentPatchDraft: "",
  assetImportHeight: 8,
  assetImportName: "Checker Tiles",
  assetImportPixels: Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? "1" : "2")).join(" "),
  assetImportWidth: 16,
  consoleLines: [
    "Standalone SNES Studio initialized. No Gateway token required.",
    "Target: LoROM NTSC Mode 1, FXPAK PRO, FAT32, SRAM preservation.",
  ],
  lastSnapshotAt: null,
  panel: "project",
  pendingAgentProposal: null,
  projectVersions: loadProjectVersions(),
  selectedPaintMode: "tile",
  promptDraft:
    "A moonlit SNES platformer with a brave explorer, coins, a guide NPC, and a boss at the ridge gate.",
  project: loadStandaloneProject(window.localStorage),
  redoStack: [],
  selectedTileBrush: 1,
  undoStack: [],
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${value} B`;
}

function formatMeterValue(meter: SnesBudgetMeter): string {
  return meter.unit === "bytes"
    ? `${formatBytes(meter.used)} / ${formatBytes(meter.limit)}`
    : `${meter.used} / ${meter.limit} ${meter.unit}`;
}

function setAudioByteBudget(project: SnesStudioProject, totalBytes: number): void {
  const audio = project.assets.audio;
  const authoredBytes =
    audio.aramReservedBytes +
    audio.musicTracks.reduce((sum, track) => sum + track.estimatedBytes, 0) +
    audio.soundEffects.reduce((sum, effect) => sum + effect.estimatedBytes, 0);
  project.assets.audioBytes = totalBytes;
  audio.sampleBytes = Math.max(0, totalBytes - authoredBytes);
}

function pushConsole(line: string): void {
  state.consoleLines = [`${new Date().toLocaleTimeString()} ${line}`, ...state.consoleLines].slice(0, 10);
}

function loadAgentDispatchQueue(): SnesAgentDispatchRecord[] {
  try {
    return parseSnesAgentDispatchQueue(window.localStorage.getItem(SNES_AGENT_DISPATCH_QUEUE_KEY));
  } catch {
    window.localStorage.removeItem(SNES_AGENT_DISPATCH_QUEUE_KEY);
    return [];
  }
}

function saveAgentDispatchQueue(): void {
  window.localStorage.setItem(SNES_AGENT_DISPATCH_QUEUE_KEY, JSON.stringify(state.agentDispatchQueue));
}

function loadProjectVersions(): SnesProjectVersion[] {
  try {
    return parseSnesProjectVersionHistory(window.localStorage.getItem(STANDALONE_VERSION_HISTORY_KEY));
  } catch {
    window.localStorage.removeItem(STANDALONE_VERSION_HISTORY_KEY);
    return [];
  }
}

function saveProjectVersions(): void {
  window.localStorage.setItem(STANDALONE_VERSION_HISTORY_KEY, JSON.stringify(state.projectVersions));
}

function rememberUndo(): void {
  state.undoStack = [stableProjectJson(state.project), ...state.undoStack].slice(0, 30);
  state.redoStack = [];
}

function mutateProject(mutator: (project: SnesStudioProject) => void): void {
  rememberUndo();
  mutator(state.project);
  state.project = normalizeSnesStudioProject(state.project);
  saveStandaloneProject(window.localStorage, state.project);
  render();
}

function replaceProject(nextProject: SnesStudioProject): void {
  rememberUndo();
  state.project = normalizeSnesStudioProject(nextProject);
  saveStandaloneProject(window.localStorage, state.project);
  render();
}

function restoreProjectFromJson(json: string): void {
  state.project = parseSnesStudioProject(json);
  state.pendingAgentProposal = null;
  saveStandaloneProject(window.localStorage, state.project);
}

function saveProjectVersionSnapshot(reason = "Manual snapshot"): void {
  const version = createSnesProjectVersion(state.project, reason);
  state.projectVersions = appendSnesProjectVersion(state.projectVersions, version);
  saveProjectVersions();
  saveStandaloneSnapshot(window.localStorage, state.project);
  state.lastSnapshotAt = new Date().toLocaleString();
}

function restoreProjectVersion(version: SnesProjectVersion): void {
  rememberUndo();
  restoreProjectFromJson(version.projectJson);
  state.panel = "project";
  pushConsole(`Restored version ${version.reason} from ${version.createdAt}.`);
  render();
}

function undoProjectChange(): void {
  const previous = state.undoStack[0];
  if (!previous) {
    pushConsole("Nothing to undo.");
    render();
    return;
  }
  state.undoStack = state.undoStack.slice(1);
  state.redoStack = [stableProjectJson(state.project), ...state.redoStack].slice(0, 30);
  restoreProjectFromJson(previous);
  pushConsole(`Undid project change. Restored ${state.project.name}.`);
  render();
}

function redoProjectChange(): void {
  const next = state.redoStack[0];
  if (!next) {
    pushConsole("Nothing to redo.");
    render();
    return;
  }
  state.redoStack = state.redoStack.slice(1);
  state.undoStack = [stableProjectJson(state.project), ...state.undoStack].slice(0, 30);
  restoreProjectFromJson(next);
  pushConsole(`Redid project change. Restored ${state.project.name}.`);
  render();
}

function downloadFile(name: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadBytes(name: string, contents: Uint8Array, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function addEntity(kind: SnesSceneEntityKind): void {
  const scene = state.project.scenes[0];
  if (!scene) {
    return;
  }
  mutateProject(() => {
    const count = scene.entities.filter((entity) => entity.kind === kind).length + 1;
    scene.entities.push({
      id: `${kind}-${Date.now()}`,
      kind,
      name:
        kind === "enemy"
          ? `Patrol Enemy ${count}`
          : kind === "item"
            ? `Collectible ${count}`
            : `NPC ${count}`,
      x: 64 + count * 42,
      y: kind === "item" ? 112 : 176,
      metaspriteTiles: kind === "item" ? 2 : 8,
    });
  });
  pushConsole(`Added ${kind} entity to ${scene.name}.`);
  state.panel = "scene";
  render();
}

function paintSceneCell(cellIndex: number): void {
  try {
    const scene = state.project.scenes[0];
    const tile =
      state.selectedPaintMode === "collision"
        ? (scene?.tilemap[cellIndex] ?? 0)
        : state.selectedTileBrush;
    const solid =
      state.selectedPaintMode === "collision"
        ? !(scene?.collisionMap[cellIndex] ?? 0)
        : state.selectedTileBrush === 1 || state.selectedTileBrush === 2;
    replaceProject(paintSnesSceneCell(state.project, 0, cellIndex, tile, solid));
    pushConsole(
      state.selectedPaintMode === "collision"
        ? `Toggled collision cell ${cellIndex} ${solid ? "solid" : "passable"}.`
        : `Painted cell ${cellIndex} with tile ${state.selectedTileBrush}.`,
    );
    render();
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Tile paint failed.");
    render();
  }
}

function fillGroundBand(): void {
  try {
    replaceProject(
      paintSnesSceneRect(state.project, 0, 0, 8, SNES_STUDIO_EDIT_GRID.width, 4, 1, true),
    );
    pushConsole("Filled the lower collision band with solid ground tiles.");
    render();
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Rectangle fill failed.");
    render();
  }
}

function importIndexedTileset(): void {
  try {
    const importResult = importSnesIndexedTileAsset({
      name: state.assetImportName,
      width: state.assetImportWidth,
      height: state.assetImportHeight,
      pixels: parseSnesIndexedTilePixels(state.assetImportPixels),
    });
    replaceProject(applySnesImportedTileset(state.project, importResult));
    pushConsole(
      `Imported ${importResult.name}: ${importResult.uniqueTileCount}/${importResult.sourceTileCount} unique SNES 4bpp tiles, ${formatBytes(importResult.chrSizeBytes)} CHR.`,
    );
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Indexed tile import failed.");
    render();
  }
}

function addSaveField(): void {
  mutateProject((project) => {
    const nextIndex = project.save.fields.length + 1;
    project.save.enabled = true;
    project.save.fields.push({
      key: `field_${nextIndex}`,
      label: `Save Field ${nextIndex}`,
      type: "u8",
    });
  });
  pushConsole("Added SRAM save field.");
}

function removeSaveField(index: number): void {
  mutateProject((project) => {
    project.save.fields.splice(index, 1);
  });
  pushConsole(`Removed SRAM save field ${index + 1}.`);
}

function previewPromptPatch(): void {
  state.pendingAgentProposal = createStandaloneAgentPatchProposal(state.promptDraft, state.project);
  pushConsole(`Prepared agent patch preview: ${state.pendingAgentProposal.summary}`);
  render();
}

function exportCodexTaskPacket(): void {
  const packet = createSnesCodexTaskPacket(state.project, state.promptDraft);
  downloadFile(
    `${state.project.export.romBaseName || "openclaw-snes-game"}.codex-task.json`,
    `${JSON.stringify(packet, null, 2)}\n`,
    "application/json",
  );
  pushConsole("Exported OpenClaw/Codex task packet with approval-gated patch contract.");
  render();
}

function dispatchCodexTaskPacket(): void {
  const record = createSnesAgentDispatchRecord(state.project, state.promptDraft);
  state.agentDispatchQueue = appendSnesAgentDispatchRecord(state.agentDispatchQueue, record);
  saveAgentDispatchQueue();
  window.dispatchEvent(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  pushConsole(`Queued OpenClaw/Codex task ${record.id}; human approval remains required.`);
  render();
}

function importAgentPatchJson(): void {
  try {
    state.pendingAgentProposal = parseSnesAgentPatchProposalResponse(
      state.agentPatchDraft,
      state.project,
    );
    pushConsole(`Imported agent patch preview: ${state.pendingAgentProposal.summary}`);
  } catch (error) {
    state.pendingAgentProposal = null;
    pushConsole(error instanceof Error ? error.message : "Agent patch import failed.");
  }
  render();
}

function approvePromptPatch(): void {
  if (!state.pendingAgentProposal) {
    return;
  }
  const proposal = state.pendingAgentProposal;
  saveProjectVersionSnapshot("Before agent patch");
  rememberUndo();
  state.project = applyStandaloneAgentPatch(state.project, proposal.operations);
  state.pendingAgentProposal = null;
  state.panel = "project";
  saveStandaloneProject(window.localStorage, state.project);
  pushConsole(`Approved agent patch preview for ${state.project.name}.`);
  for (const change of proposal.rationale.slice(0, 3)) {
    pushConsole(change);
  }
  render();
}

function discardPromptPatch(): void {
  state.pendingAgentProposal = null;
  pushConsole("Discarded pending agent patch preview.");
  render();
}

function buildPreviewRom(): void {
  try {
    const artifact = buildSnesPreviewRom(state.project);
    const proof = validateSnesPreviewRomArtifact(artifact);
    if (!proof.valid) {
      throw new Error("Preview ROM failed integrity validation.");
    }
    const emulatorProof = createSnesEmulatorValidationReport(artifact);
    downloadBytes(artifact.fileName, artifact.bytes, "application/octet-stream");
    pushConsole(
      `Built preview ROM ${artifact.fileName} (${formatBytes(artifact.sizeBytes)}), ${proof.checks.length} proof checks passed.`,
    );
    if (emulatorProof.status === "blocked") {
      pushConsole(`Emulator proof blocked: ${emulatorProof.blockers[0]}`);
    }
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Preview ROM build failed.");
  }
  render();
}

function exportRomMap(): void {
  try {
    const artifact = buildSnesPreviewRom(state.project);
    downloadFile(artifact.mapFileName, artifact.mapText, "text/plain");
    pushConsole(`Downloaded ROM map ${artifact.mapFileName}.`);
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "ROM map export failed.");
  }
  render();
}

function exportBuildManifest(): void {
  try {
    const artifact = buildSnesPreviewRom(state.project);
    downloadFile(artifact.manifestFileName, artifact.manifestJson, "application/json");
    pushConsole(`Downloaded build manifest ${artifact.manifestFileName}.`);
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Build manifest export failed.");
  }
  render();
}

function exportProjectBundle(): void {
  const bundle = createSnesProjectBundle(state.project, state.projectVersions);
  downloadFile(
    `${state.project.export.romBaseName}.oc-snes-bundle.json`,
    `${JSON.stringify(bundle, null, 2)}\n`,
    "application/json",
  );
  pushConsole(`Exported project bundle with ${bundle.manifest.versionCount} versions.`);
  render();
}

function exportEmulatorProof(): void {
  try {
    const artifact = buildSnesPreviewRom(state.project);
    const proof = createSnesEmulatorValidationReport(artifact);
    const payload = {
      artifact: artifact.fileName,
      generatedAt: new Date().toISOString(),
      report: proof,
    };
    downloadFile(
      `${artifact.fileName.replace(/\.sfc$/i, "")}.emulator-proof.json`,
      `${JSON.stringify(payload, null, 2)}\n`,
      "application/json",
    );
    pushConsole(
      proof.status === "ready"
        ? `Downloaded emulator proof plan for ${artifact.fileName}.`
        : `Downloaded emulator proof report: ${proof.blockers[0]}`,
    );
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "Emulator proof export failed.");
  }
  render();
}

function exportFxpakPackagePlan(): void {
  try {
    const artifact = buildSnesPreviewRom(state.project);
    const fxpakPackage = createSnesFxpakExportPackage(artifact);
    downloadFile(
      `${artifact.fileName.replace(/\.sfc$/i, "")}.fxpak-package.json`,
      `${JSON.stringify(fxpakPackage, null, 2)}\n`,
      "application/json",
    );
    pushConsole(`Downloaded FXPAK package plan: ${fxpakPackage.status}.`);
  } catch (error) {
    pushConsole(error instanceof Error ? error.message : "FXPAK package export failed.");
  }
  render();
}

function formatPatchValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (!rendered) {
    return "null";
  }
  return rendered.length > 96 ? `${rendered.slice(0, 93)}...` : rendered;
}

function renderMeter(meter: SnesBudgetMeter): string {
  const percent = meterPercent(meter);
  return `
    <article class="meter meter--${escapeHtml(meter.severity)}">
      <div><span>${escapeHtml(meter.label)}</span><strong>${percent}%</strong></div>
      <b><i style="width:${percent}%"></i></b>
      <small>${escapeHtml(formatMeterValue(meter))}</small>
    </article>
  `;
}

function renderLevelGrid(): string {
  const scene = state.project.scenes[0];
  return Array.from({ length: 16 * 12 }, (_, index) => {
    const tile = scene?.tilemap[index] ?? 0;
    const solid = (scene?.collisionMap[index] ?? 0) > 0;
    const imported = tile >= SNES_IMPORTED_TILE_BRUSH_BASE;
    return `<button type="button" class="tile tile-${tile}${imported ? " imported" : ""}${solid ? " solid" : ""}" data-cell-index="${index}" aria-label="Paint cell ${index}"></button>`;
  }).join("");
}

function importedTileBrushes(): Array<[number, string]> {
  let tile = SNES_IMPORTED_TILE_BRUSH_BASE;
  return state.project.assets.importedTilesets.flatMap((tileset) =>
    Array.from({ length: tileset.uniqueTileCount }, (_, index): [number, string] => [
      tile++,
      `${tileset.name} ${index + 1}`,
    ]),
  );
}

function renderInspector(): string {
  const scene = state.project.scenes[0];
  const model = createStandaloneViewModel(state.project);
  const audioManifest = createSnesAudioManifest(state.project);
  const superFxReport = createSnesSuperFxProfileReport(state.project);
  const tabs: Panel[] = ["project", "scene", "assets", "export", "agents"];
  const tabButtons = tabs
    .map(
      (tab) =>
        `<button type="button" data-panel="${tab}" class="${state.panel === tab ? "active" : ""}">${tab}</button>`,
    )
    .join("");

  const panel =
    state.panel === "project"
      ? `
        <label>Project name<input data-field="project.name" value="${escapeHtml(state.project.name)}" /></label>
        <label>ROM base filename<input data-field="export.romBaseName" value="${escapeHtml(state.project.export.romBaseName)}" /></label>
        <div class="facts">
          <span>Mapper</span><strong>${escapeHtml(state.project.profile.mapMode.toUpperCase())}</strong>
          <span>Video</span><strong>${escapeHtml(state.project.profile.region.toUpperCase())} ${escapeHtml(state.project.profile.videoMode.toUpperCase())}</strong>
          <span>SuperFX</span><strong>${escapeHtml(superFxReport.status)}</strong>
          <span>SRAM</span><strong>${state.project.profile.sramSizeKib} KiB</strong>
          <span>ROM</span><strong>${state.project.profile.romSizeMbit} Mbit</strong>
        </div>
      `
      : state.panel === "scene" && scene
        ? `
          <label>Scene width<input type="number" min="16" max="512" data-field="scene.widthMetatiles" value="${scene.widthMetatiles}" /></label>
          <label>Scene height<input type="number" min="8" max="128" data-field="scene.heightMetatiles" value="${scene.heightMetatiles}" /></label>
          <div class="entity-list">
            ${scene.entities
              .map(
                (entity, index) => `
                  <article>
                    <span>${escapeHtml(entity.kind)}</span>
                    <label>Name<input data-entity-index="${index}" data-entity-field="name" value="${escapeHtml(entity.name)}" /></label>
                    <label>X<input type="number" min="0" max="4096" data-entity-index="${index}" data-entity-field="x" value="${entity.x}" /></label>
                    <label>Y<input type="number" min="0" max="2048" data-entity-index="${index}" data-entity-field="y" value="${entity.y}" /></label>
                    <label>Metasprite tiles<input type="number" min="1" max="64" data-entity-index="${index}" data-entity-field="metaspriteTiles" value="${entity.metaspriteTiles}" /></label>
                  </article>
                `,
              )
              .join("")}
          </div>
        `
        : state.panel === "assets"
          ? `
            <label>Background tiles<input type="number" min="0" max="2048" data-field="assets.backgroundTiles" value="${state.project.assets.backgroundTiles}" /></label>
            <label>Sprite tiles<input type="number" min="0" max="1024" data-field="assets.spriteTiles" value="${state.project.assets.spriteTiles}" /></label>
            <label>Audio bytes<input type="number" min="0" max="65536" data-field="assets.audioBytes" value="${state.project.assets.audioBytes}" /></label>
            <div class="info-grid">
              <span>SPC700 driver</span><strong>${escapeHtml(audioManifest.driver)}</strong>
              <span>Music</span><strong>${formatBytes(audioManifest.musicBytes)}</strong>
              <span>SFX</span><strong>${formatBytes(audioManifest.soundEffectBytes)}</strong>
              <span>Samples</span><strong>${formatBytes(audioManifest.sampleBytes)}</strong>
            </div>
            <label>Tileset name<input data-field="assetImport.name" value="${escapeHtml(state.assetImportName)}" /></label>
            <label>Import width<input type="number" min="8" max="128" step="8" data-field="assetImport.width" value="${state.assetImportWidth}" /></label>
            <label>Import height<input type="number" min="8" max="128" step="8" data-field="assetImport.height" value="${state.assetImportHeight}" /></label>
            <label>Indexed pixels<textarea data-field="assetImport.pixels" rows="5">${escapeHtml(state.assetImportPixels)}</textarea></label>
            <button type="button" data-action="import-indexed-tileset">Import Indexed Tileset</button>
            <div class="entity-list">
              ${state.project.assets.importedTilesets
                .map(
                  (tileset) => `
                    <article>
                      <span>${escapeHtml(tileset.id)}</span>
                      <strong>${escapeHtml(tileset.name)}</strong>
                      <small>${tileset.uniqueTileCount}/${tileset.sourceTileCount} unique tiles / ${formatBytes(tileset.chrSizeBytes)} CHR / checksum ${tileset.chrChecksum}</small>
                    </article>
                  `,
                )
                .join("")}
            </div>
          `
          : state.panel === "export"
            ? `
              <div class="facts">
                <span>Target</span><strong>${escapeHtml(model.manifest.target)}</strong>
                <span>Card</span><strong>${model.manifest.cardSizeGb} GB FAT32</strong>
                <span>ROM path</span><strong>${escapeHtml(model.manifest.romPath)}</strong>
                <span>Save path</span><strong>${escapeHtml(model.manifest.savePath ?? "No SRAM")}</strong>
                <span>Save bytes</span><strong>${model.saveManifest.totalBytes}/${model.saveManifest.sramSizeKib * 1024}</strong>
                <span>Slot size</span><strong>${model.saveManifest.slotSizeBytes} bytes</strong>
              </div>
              <label class="checkbox"><input type="checkbox" data-field="save.enabled" ${state.project.save.enabled ? "checked" : ""} /> Enable SRAM save file</label>
              <label>Save slots<input type="number" min="1" max="16" data-field="save.slots" value="${state.project.save.slots}" /></label>
              <div class="entity-list">
                ${state.project.save.fields
                  .map(
                    (field, index) => `
                      <article>
                        <label>Key<input data-save-index="${index}" data-save-field="key" value="${escapeHtml(field.key)}" /></label>
                        <label>Label<input data-save-index="${index}" data-save-field="label" value="${escapeHtml(field.label)}" /></label>
                        <label>Type<select data-save-index="${index}" data-save-field="type">
                          ${(["flag", "u8", "u16", "u32"] as const)
                            .map(
                              (type) =>
                                `<option value="${type}" ${field.type === type ? "selected" : ""}>${type}</option>`,
                            )
                            .join("")}
                        </select></label>
                        <button type="button" data-remove-save-field="${index}">Remove</button>
                      </article>
                    `,
                  )
                  .join("")}
              </div>
              <button type="button" data-action="add-save-field">Add Save Field</button>
              <label class="checkbox"><input type="checkbox" data-field="profile.fxpak.preserveExistingSaves" ${state.project.profile.fxpak.preserveExistingSaves ? "checked" : ""} /> Preserve existing FXPAK saves</label>
            `
            : `
              <div class="agent-list">
                ${model.agentTasks
                  .map(
                    (task) => `
                      <article>
                        <span>${escapeHtml(task.role)}</span>
                        <strong>${escapeHtml(task.title)}</strong>
                        <p>${escapeHtml(task.prompt)}</p>
                      </article>
                    `,
                  )
                  .join("")}
              </div>
            `;

  const issues =
    model.readiness.issues.length === 0
      ? `<p class="ok">No blockers. Ready for deterministic compiler work.</p>`
      : model.readiness.issues
          .map(
            (issue) => `
              <article class="issue issue--${escapeHtml(issue.severity)}">
                <strong>${escapeHtml(issue.code)}</strong>
                <span>${escapeHtml(issue.message)}</span>
                <small>${escapeHtml(issue.suggestion)}</small>
              </article>
            `,
          )
          .join("");

  return `
    <aside class="inspector">
      <nav class="tabs">${tabButtons}</nav>
      ${panel}
      <section class="readiness">
        <h3>Build Readiness: ${escapeHtml(model.readiness.status.toUpperCase())} ${model.readiness.score}/100</h3>
        ${issues}
      </section>
    </aside>
  `;
}

function render(): void {
  const model = createStandaloneViewModel(state.project);
  const scene = state.project.scenes[0];
  app.innerHTML = `
    <section class="app-shell">
      <header class="topbar">
        <div>
          <span>Standalone Mac/Web App</span>
          <h1>SNES Studio</h1>
          <p>Professional local-first Super Nintendo game builder cockpit for FXPAK PRO hardware workflows.</p>
        </div>
        <nav>
          <button type="button" data-action="snapshot">Snapshot</button>
          <button type="button" data-action="undo" ${state.undoStack.length === 0 ? "disabled" : ""}>Undo</button>
          <button type="button" data-action="redo" ${state.redoStack.length === 0 ? "disabled" : ""}>Redo</button>
          <button type="button" data-action="import">Import JSON</button>
          <button type="button" data-action="export">Export JSON</button>
          <button type="button" data-action="export-bundle">Export Bundle</button>
          <button type="button" data-action="build-rom">Build Preview ROM</button>
          <button type="button" data-action="export-map">Export ROM Map</button>
          <button type="button" data-action="export-build-manifest">Export Build Manifest</button>
          <button type="button" data-action="export-emulator-proof">Export Emulator Proof</button>
          <button type="button" data-action="export-fxpak-package">Export FXPAK Package</button>
          <button type="button" data-action="validate" class="primary">Validate</button>
        </nav>
      </header>

      <section class="drop-zone" data-drop-zone>
        Drop an <strong>.oc-snes.json</strong> project here to open it locally.
      </section>

      <section class="prompt-builder">
        <div>
          <span>OpenClaw / Codex Prompt</span>
          <h2>Describe the game you want to build</h2>
          <p>Preview a hardware-safe agent patch, approve it, then keep editing visually or with another prompt.</p>
        </div>
        <textarea data-prompt rows="4">${escapeHtml(state.promptDraft)}</textarea>
        <button type="button" class="primary" data-action="preview-prompt">Preview Agent Patch</button>
        <button type="button" data-action="export-codex-task">Export Codex Task</button>
        <button type="button" data-action="queue-codex-task">Queue OpenClaw Task</button>
        <textarea data-agent-patch-json rows="4" placeholder="Paste returned OpenClaw/Codex patch JSON">${escapeHtml(state.agentPatchDraft)}</textarea>
        <button type="button" data-action="import-agent-patch">Import Agent Patch JSON</button>
        ${
          state.pendingAgentProposal
            ? `
              <div class="proposal">
                <strong>${escapeHtml(state.pendingAgentProposal.summary)}</strong>
                <p>Readiness: ${escapeHtml(state.pendingAgentProposal.readiness.status.toUpperCase())} ${state.pendingAgentProposal.readiness.score}/100</p>
                <div class="patch-list">
                  ${state.pendingAgentProposal.operations
                    .slice(0, 8)
                    .map(
                      (operation) => `
                        <code>${escapeHtml(operation.path)}</code>
                        <span>${escapeHtml(formatPatchValue(operation.value))}</span>
                      `,
                    )
                    .join("")}
                </div>
                ${
                  state.pendingAgentProposal.operations.length > 8
                    ? `<small>${state.pendingAgentProposal.operations.length - 8} more approved patch paths</small>`
                    : ""
                }
                <nav>
                  <button type="button" class="primary" data-action="approve-prompt">Approve Patch</button>
                  <button type="button" data-action="discard-prompt">Discard</button>
                </nav>
              </div>
            `
            : ""
        }
        ${
          state.agentDispatchQueue.length > 0
            ? `
              <div class="proposal">
                <strong>Queued OpenClaw/Codex tasks</strong>
                <div class="patch-list">
                  ${state.agentDispatchQueue
                    .slice(0, 4)
                    .map(
                      (record) => `
                        <code>${escapeHtml(record.status)}</code>
                        <span>${escapeHtml(record.taskPacket.userPrompt || record.projectName)}</span>
                      `,
                    )
                    .join("")}
                </div>
              </div>
            `
            : ""
        }
      </section>

      <section class="budget-strip">${model.readiness.budgets.map(renderMeter).join("")}</section>

      <main class="workspace">
        <aside class="toolbox">
          <h2>Project Kit</h2>
          <button type="button" data-panel="project">Project Setup</button>
          <button type="button" data-panel="scene">Level Editor</button>
          <button type="button" data-panel="assets">Tiles, Sprites, Audio</button>
          <button type="button" data-panel="export">FXPAK Export</button>
          <button type="button" data-panel="agents">OpenClaw Agents</button>
          <button type="button" data-action="add-enemy">Add Enemy</button>
          <button type="button" data-action="add-item">Add Item</button>
          <button type="button" data-action="add-npc">Add NPC</button>
          <button type="button" data-action="fill-ground">Fill Ground</button>
          <button type="button" data-action="reset" class="danger">Reset Starter</button>
          ${state.lastSnapshotAt ? `<p>Last snapshot: ${escapeHtml(state.lastSnapshotAt)}</p>` : ""}
          ${
            state.projectVersions.length > 0
              ? `
                <div class="entity-list">
                  <article>
                    <span>Version History</span>
                    <strong>${state.projectVersions.length} saved</strong>
                    ${state.projectVersions
                      .slice(0, 3)
                      .map(
                        (version, index) =>
                          `<button type="button" data-version-index="${index}">${escapeHtml(version.reason)} · ${escapeHtml(version.projectName)}</button>`,
                      )
                      .join("")}
                  </article>
                </div>
              `
              : ""
          }
        </aside>

        <section class="stage">
          <div class="section-head">
            <div>
              <h2>${escapeHtml(scene?.name ?? "Scene")}</h2>
              <p>${scene?.widthMetatiles ?? 0}x${scene?.heightMetatiles ?? 0} metatiles, ${scene?.layers ?? 0} layers, ${scene?.collisionTiles ?? 0} collision cells</p>
            </div>
            <strong>${escapeHtml(model.manifest.romFileName)}</strong>
          </div>
          <nav class="tile-brushes" aria-label="Layer edit mode">
            <button type="button" data-paint-mode="tile" class="${state.selectedPaintMode === "tile" ? "active" : ""}">Tile Paint</button>
            <button type="button" data-paint-mode="collision" class="${state.selectedPaintMode === "collision" ? "active" : ""}">Collision Paint</button>
          </nav>
          <nav class="tile-brushes" aria-label="Tile brushes">
            ${[
              [0, "Air"],
              [1, "Ground"],
              [2, "Ledge"],
              [3, "Item"],
              ...importedTileBrushes(),
            ]
              .map(
                ([tile, label]) =>
                  `<button type="button" data-tile-brush="${tile}" class="${state.selectedTileBrush === tile ? "active" : ""}">${label}</button>`,
              )
              .join("")}
          </nav>
          <div class="level-grid" aria-label="Mode 1 level preview">${renderLevelGrid()}</div>
        </section>

        ${renderInspector()}
      </main>

      <section class="bottom">
        <div class="pipeline">
          <div class="section-head">
            <div>
              <h2>Build Pipeline</h2>
              <p>Project schema to deterministic ROM export.</p>
            </div>
          </div>
          ${model.pipeline
            .map(
              (step, index) => `
                <article>
                  <span>${index + 1}</span>
                  <div><strong>${escapeHtml(step.label)}</strong><p>${escapeHtml(step.description)}</p></div>
                </article>
              `,
            )
            .join("")}
        </div>
        <div class="console">
          <div class="section-head">
            <div>
              <h2>Build Console</h2>
              <p>${escapeHtml(model.manifest.romPath)}</p>
            </div>
          </div>
          ${state.consoleLines.map((line) => `<code>${escapeHtml(line)}</code>`).join("")}
        </div>
      </section>
      <input id="import-file" type="file" accept=".json,.oc-snes.json,application/json" hidden />
    </section>
  `;
}

async function importProject(file: File): Promise<void> {
  const imported = parseSnesStudioProject(await file.text());
  rememberUndo();
  state.project = imported;
  saveStandaloneProject(window.localStorage, state.project);
  state.panel = "project";
  pushConsole(`Imported ${imported.name}.`);
  render();
}

app.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>("button");
  if (!button) {
    return;
  }
  const brush = button.dataset.tileBrush;
  if (brush !== undefined) {
    state.selectedTileBrush = Number(brush) as SnesTileBrush;
    state.selectedPaintMode = "tile";
    pushConsole(`Selected tile brush ${brush}.`);
    render();
    return;
  }
  const paintMode = button.dataset.paintMode;
  if (paintMode === "tile" || paintMode === "collision") {
    state.selectedPaintMode = paintMode;
    pushConsole(`Selected ${paintMode} paint mode.`);
    render();
    return;
  }
  const saveRemove = button.dataset.removeSaveField;
  if (saveRemove !== undefined) {
    removeSaveField(Number(saveRemove));
    return;
  }
  const versionIndex = button.dataset.versionIndex;
  if (versionIndex !== undefined) {
    const version = state.projectVersions[Number(versionIndex)];
    if (version) {
      restoreProjectVersion(version);
    }
    return;
  }
  const cellButton = button.closest<HTMLButtonElement>("[data-cell-index]");
  if (cellButton?.dataset.cellIndex !== undefined) {
    paintSceneCell(Number(cellButton.dataset.cellIndex));
    return;
  }
  const panel = button.dataset.panel as Panel | undefined;
  if (panel) {
    state.panel = panel;
    render();
    return;
  }
  switch (button.dataset.action) {
    case "snapshot":
      saveProjectVersionSnapshot();
      pushConsole("Snapshot saved locally before generated or agent-assisted changes.");
      render();
      break;
    case "import":
      document.querySelector<HTMLInputElement>("#import-file")?.click();
      break;
    case "undo":
      undoProjectChange();
      break;
    case "redo":
      redoProjectChange();
      break;
    case "export":
      downloadFile(`${state.project.export.romBaseName}.oc-snes.json`, stableProjectJson(state.project), "application/json");
      pushConsole("Exported canonical SNES Studio project JSON.");
      render();
      break;
    case "export-bundle":
      exportProjectBundle();
      break;
    case "validate": {
      const model = createStandaloneViewModel(state.project);
      pushConsole(`Validated ${model.manifest.romFileName}: ${model.readiness.status}.`);
      render();
      break;
    }
    case "build-rom":
      buildPreviewRom();
      break;
    case "export-map":
      exportRomMap();
      break;
    case "export-build-manifest":
      exportBuildManifest();
      break;
    case "export-emulator-proof":
      exportEmulatorProof();
      break;
    case "export-fxpak-package":
      exportFxpakPackagePlan();
      break;
    case "preview-prompt":
      previewPromptPatch();
      break;
    case "export-codex-task":
      exportCodexTaskPacket();
      break;
    case "queue-codex-task":
      dispatchCodexTaskPacket();
      break;
    case "import-indexed-tileset":
      importIndexedTileset();
      break;
    case "add-save-field":
      addSaveField();
      break;
    case "import-agent-patch":
      importAgentPatchJson();
      break;
    case "approve-prompt":
      approvePromptPatch();
      break;
    case "discard-prompt":
      discardPromptPatch();
      break;
    case "add-enemy":
      addEntity("enemy");
      break;
    case "add-item":
      addEntity("item");
      break;
    case "add-npc":
      addEntity("npc");
      break;
    case "fill-ground":
      fillGroundBand();
      break;
    case "reset":
      rememberUndo();
      state.project = createDefaultSnesStudioProject();
      saveStandaloneProject(window.localStorage, state.project);
      pushConsole("Reset project to the professional Mode 1 starter.");
      render();
      break;
  }
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement | null;
  const promptInput = (event.target as HTMLElement | null)?.closest<HTMLTextAreaElement>(
    "textarea[data-prompt]",
  );
  if (promptInput) {
    state.promptDraft = promptInput.value;
    state.pendingAgentProposal = null;
    return;
  }
  const patchInput = (event.target as HTMLElement | null)?.closest<HTMLTextAreaElement>(
    "textarea[data-agent-patch-json]",
  );
  if (patchInput) {
    state.agentPatchDraft = patchInput.value;
    return;
  }
  const field = input?.dataset.field;
  const entityIndex = input?.dataset.entityIndex;
  const entityField = input?.dataset.entityField;
  const saveIndex = input?.dataset.saveIndex;
  const saveField = input?.dataset.saveField;
  if (input && entityIndex !== undefined && entityField) {
    mutateProject((project) => {
      const entity = project.scenes[0]?.entities[Number(entityIndex)];
      if (!entity) {
        return;
      }
      if (entityField === "name") {
        entity.name = input.value;
      } else if (entityField === "x" || entityField === "y" || entityField === "metaspriteTiles") {
        entity[entityField] = Number(input.value);
      }
    });
    return;
  }
  if (input && saveIndex !== undefined && saveField) {
    mutateProject((project) => {
      const fieldRecord = project.save.fields[Number(saveIndex)];
      if (!fieldRecord) {
        return;
      }
      if (saveField === "key") {
        fieldRecord.key = input.value;
      } else if (saveField === "label") {
        fieldRecord.label = input.value;
      }
    });
    return;
  }
  if (!input || !field) {
    return;
  }
  mutateProject((project) => {
    const scene = project.scenes[0];
    switch (field) {
      case "project.name":
        project.name = input.value;
        break;
      case "export.romBaseName":
        project.export.romBaseName = input.value;
        break;
      case "scene.widthMetatiles":
        if (scene) scene.widthMetatiles = Number(input.value);
        break;
      case "scene.heightMetatiles":
        if (scene) scene.heightMetatiles = Number(input.value);
        break;
      case "assets.backgroundTiles":
        project.assets.backgroundTiles = Number(input.value);
        break;
      case "assets.spriteTiles":
        project.assets.spriteTiles = Number(input.value);
        break;
      case "assets.audioBytes":
        setAudioByteBudget(project, Number(input.value));
        break;
      case "assetImport.name":
        state.assetImportName = input.value;
        break;
      case "assetImport.width":
        state.assetImportWidth = Number(input.value);
        break;
      case "assetImport.height":
        state.assetImportHeight = Number(input.value);
        break;
      case "assetImport.pixels":
        state.assetImportPixels = input.value;
        break;
      case "save.slots":
        project.save.slots = Number(input.value);
        break;
    }
  });
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | null;
  if (input?.id === "import-file" && input.files?.[0]) {
    void importProject(input.files[0]).catch((error: unknown) => {
      pushConsole(error instanceof Error ? error.message : "Import failed.");
      render();
    });
    return;
  }
  if (input?.dataset.field === "profile.fxpak.preserveExistingSaves") {
    mutateProject((project) => {
      project.profile.fxpak.preserveExistingSaves = input.checked;
    });
    return;
  }
  if (input?.dataset.field === "save.enabled") {
    mutateProject((project) => {
      project.save.enabled = input.checked;
    });
    return;
  }
  const select = event.target as HTMLSelectElement | null;
  if (select?.dataset.saveIndex !== undefined && select.dataset.saveField === "type") {
    mutateProject((project) => {
      const fieldRecord = project.save.fields[Number(select.dataset.saveIndex)];
      if (fieldRecord && ["flag", "u8", "u16", "u32"].includes(select.value)) {
        fieldRecord.type = select.value as typeof fieldRecord.type;
      }
    });
  }
});

app.addEventListener("dragover", (event) => {
  event.preventDefault();
  app.querySelector("[data-drop-zone]")?.classList.add("dragging");
});

app.addEventListener("dragleave", () => {
  app.querySelector("[data-drop-zone]")?.classList.remove("dragging");
});

app.addEventListener("drop", (event) => {
  event.preventDefault();
  app.querySelector("[data-drop-zone]")?.classList.remove("dragging");
  const file = event.dataTransfer?.files[0];
  if (!file) {
    return;
  }
  void importProject(file).catch((error: unknown) => {
    pushConsole(error instanceof Error ? error.message : "Import failed.");
    render();
  });
});

render();
