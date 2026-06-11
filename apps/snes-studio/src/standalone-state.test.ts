import { describe, expect, it } from "vitest";
import { createDefaultSnesStudioProject } from "@openclaw/snes-studio-core";
import {
  STANDALONE_STORAGE_KEY,
  applyStandaloneAgentPatch,
  createStandaloneAgentPatchProposal,
  createStandaloneViewModel,
  generateStandaloneProjectFromPrompt,
  isSnesStudioProject,
  loadStandaloneProject,
  meterPercent,
  parseSnesStudioProject,
  saveStandaloneProject,
  type StandaloneStorage,
} from "./standalone-state.ts";

function makeStorage(initial: Record<string, string> = {}): StandaloneStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("SNES Studio standalone state", () => {
  it("loads a default hardware-safe project without stored state", () => {
    const project = loadStandaloneProject(makeStorage());

    expect(project.profile.mapMode).toBe("lorom");
    expect(project.profile.fxpak.fileSystem).toBe("fat32");
    expect(project.profile.fxpak.preserveExistingSaves).toBe(true);
    expect(project.assets.importedTilesets).toEqual([]);
    expect(project.scenes[0]?.tilemap.length).toBe(16 * 12);
    expect(project.scenes[0]?.collisionMap.length).toBe(16 * 12);
  });

  it("round-trips saved standalone projects", () => {
    const storage = makeStorage();
    const project = createDefaultSnesStudioProject();
    project.name = "Expert Demo Cart";

    saveStandaloneProject(storage, project);

    expect(loadStandaloneProject(storage).name).toBe("Expert Demo Cart");
  });

  it("drops corrupt local state back to a clean project", () => {
    const storage = makeStorage({ [STANDALONE_STORAGE_KEY]: "{broken json" });

    expect(loadStandaloneProject(storage).name).toBe("Moonlit Ridge");
  });

  it("rejects non-project import payloads", () => {
    expect(() => parseSnesStudioProject(JSON.stringify({ schemaVersion: 2 }))).toThrow(
      /not an SNES Studio project/,
    );
    expect(isSnesStudioProject({ schemaVersion: 1 })).toBe(false);
  });

  it("creates a standalone view model with FXPAK export details", () => {
    const viewModel = createStandaloneViewModel(createDefaultSnesStudioProject());

    expect(viewModel.readiness.score).toBe(100);
    expect(viewModel.manifest.romPath).toBe("/SNES/OpenClaw/moonlit-ridge.sfc");
    expect(viewModel.pipeline.map((step) => step.id)).toContain("fxpak-export");
    expect(viewModel.spc700Plan.status).toBe("manifest-ready");
    expect(viewModel.saveManifest).toEqual(
      expect.objectContaining({
        enabled: true,
        savePath: "/sd2snes/saves/moonlit-ridge.srm",
        slotSizeBytes: 5,
        slots: 3,
        totalBytes: 15,
      }),
    );
  });

  it("clamps budget meter percentages for display", () => {
    expect(
      meterPercent({
        label: "VRAM",
        used: 120,
        limit: 100,
        ratio: 1.2,
        unit: "bytes",
        severity: "info",
      }),
    ).toBe(100);
  });

  it("generates editable project drafts from text prompts", () => {
    const result = generateStandaloneProjectFromPrompt(
      "Create a forest game with gems, an NPC, and robots.",
      createDefaultSnesStudioProject(),
    );

    expect(result.approvalRequired).toBe(true);
    expect(result.project.name).toContain("Forest");
    expect(result.project.profile.fxpak.fileSystem).toBe("fat32");
    expect(result.project.scenes[0]?.entities.some((entity) => entity.kind === "npc")).toBe(true);
    expect(result.appliedChanges.length).toBeGreaterThan(1);
  });

  it("previews and applies approved agent patches", () => {
    const project = createDefaultSnesStudioProject("2026-05-19T00:00:00.000Z");
    const proposal = createStandaloneAgentPatchProposal(
      'Create "Harbor Robot Quest" with keys and robots.',
      project,
    );

    expect(project.name).toBe("Moonlit Ridge");
    expect(proposal.operations.map((operation) => operation.path)).toContain("/name");

    const approved = applyStandaloneAgentPatch(project, proposal.operations);

    expect(approved.name).toBe("Harbor Robot Quest");
    expect(approved.profile.target).toBe("fxpak-pro");
    expect(approved.profile.fxpak.fileSystem).toBe("fat32");
  });
});
