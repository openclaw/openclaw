/**
 * soul-chip store
 *
 * Reads and writes the seven soul layers from workspace/soul/.
 * Each layer is a standalone markdown file. The pause state is
 * persisted as a small JSON file so it survives restarts.
 *
 * Directory layout:
 *   workspace/soul/
 *     worldview.md    - Five-element philosophy & cosmology
 *     identity.md     - Role, mission, orientation
 *     values.md       - Value hierarchy & decision rules
 *     boundaries.md   - Absolute constraints & permissions
 *     persona.md      - Communication style & energy
 *     anchors.md      - Relationship anchor memories
 *     direction.md    - Evolution vector (short/mid/long term)
 *     pause.json      - Meditation mode state
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PauseState, SoulLayer, SoulSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SOUL_DIR = "soul";
const PAUSE_FILE = "pause.json";

const LAYER_FILES: Record<SoulLayer, string> = {
  worldview: "worldview.md",
  identity: "identity.md",
  values: "values.md",
  boundaries: "boundaries.md",
  persona: "persona.md",
  anchors: "anchors.md",
  direction: "direction.md",
};

function soulDir(workspaceDir: string): string {
  return path.join(workspaceDir, SOUL_DIR);
}

function layerPath(workspaceDir: string, layer: SoulLayer): string {
  return path.join(soulDir(workspaceDir), LAYER_FILES[layer]);
}

function pausePath(workspaceDir: string): string {
  return path.join(soulDir(workspaceDir), PAUSE_FILE);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SoulStore = ReturnType<typeof createSoulStore>;

export function createSoulStore() {
  async function ensureDir(workspaceDir: string): Promise<void> {
    await fs.mkdir(soulDir(workspaceDir), { recursive: true });
  }

  // ----- Layer read/write -----

  async function readLayer(workspaceDir: string, layer: SoulLayer): Promise<string | null> {
    try {
      const content = await fs.readFile(layerPath(workspaceDir, layer), "utf-8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  async function writeLayer(workspaceDir: string, layer: SoulLayer, content: string): Promise<void> {
    await ensureDir(workspaceDir);
    await fs.writeFile(layerPath(workspaceDir, layer), content, "utf-8");
  }

  async function readAllLayers(workspaceDir: string): Promise<SoulSnapshot> {
    const layers = Object.keys(LAYER_FILES) as SoulLayer[];
    const entries = await Promise.all(
      layers.map(async (layer) => [layer, await readLayer(workspaceDir, layer)] as const),
    );
    return Object.fromEntries(entries) as SoulSnapshot;
  }

  /** Check if any soul file exists. */
  async function hasSoul(workspaceDir: string): Promise<boolean> {
    const snapshot = await readAllLayers(workspaceDir);
    return Object.values(snapshot).some((v) => v !== null);
  }

  // ----- Pause state -----

  const DEFAULT_PAUSE: PauseState = {
    paused: false,
    pausedAt: null,
    pausedBy: null,
    reason: null,
  };

  async function readPauseState(workspaceDir: string): Promise<PauseState> {
    try {
      const raw = await fs.readFile(pausePath(workspaceDir), "utf-8");
      return { ...DEFAULT_PAUSE, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_PAUSE };
    }
  }

  async function writePauseState(workspaceDir: string, state: PauseState): Promise<void> {
    await ensureDir(workspaceDir);
    await fs.writeFile(pausePath(workspaceDir), JSON.stringify(state, null, 2), "utf-8");
  }

  async function pause(workspaceDir: string, by: string, reason?: string): Promise<void> {
    await writePauseState(workspaceDir, {
      paused: true,
      pausedAt: new Date().toISOString(),
      pausedBy: by,
      reason: reason ?? null,
    });
  }

  async function resume(workspaceDir: string): Promise<void> {
    await writePauseState(workspaceDir, { ...DEFAULT_PAUSE });
  }

  // ----- Init: write default soul from chip spec -----

  async function initSoul(workspaceDir: string, layers: Partial<Record<SoulLayer, string>>): Promise<void> {
    await ensureDir(workspaceDir);
    for (const [layer, content] of Object.entries(layers)) {
      if (content) {
        await writeLayer(workspaceDir, layer as SoulLayer, content);
      }
    }
  }

  return {
    readLayer,
    writeLayer,
    readAllLayers,
    hasSoul,
    readPauseState,
    writePauseState,
    pause,
    resume,
    initSoul,
  };
}
