/**
 * Recoder Session State Manager
 *
 * Tracks active project and project state across conversation turns.
 * Persists state to disk for session recovery.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { RecoderSessionState, RecoderSessionProject } from "../types/index.js";

const STATE_DIR = path.join(os.homedir(), ".openclaw", "state");
const STATE_FILE = path.join(STATE_DIR, "recoder-sessions.json");

/**
 * In-memory session state cache
 */
let cachedState: RecoderSessionState | null = null;

/**
 * Create default empty state
 */
function createDefaultState(): RecoderSessionState {
  return {
    activeProjectId: null,
    projects: {},
    lastUpdated: Date.now(),
  };
}

/**
 * Ensure state directory exists
 */
async function ensureStateDir(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

/**
 * Load session state from disk
 */
export async function loadSessionState(): Promise<RecoderSessionState> {
  if (cachedState) {
    return cachedState;
  }

  try {
    await ensureStateDir();
    const content = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(content) as RecoderSessionState;

    // Validate structure
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.projects === "object"
    ) {
      cachedState = parsed;
      return cachedState;
    }
  } catch {
    // File doesn't exist or is invalid
  }

  cachedState = createDefaultState();
  return cachedState;
}

/**
 * Save session state to disk
 */
export async function saveSessionState(state: RecoderSessionState): Promise<void> {
  state.lastUpdated = Date.now();
  cachedState = state;

  try {
    await ensureStateDir();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("[recoder-plugin] Failed to save session state:", err);
  }
}

/**
 * Get the active project ID
 */
export async function getActiveProjectId(): Promise<string | null> {
  const state = await loadSessionState();
  return state.activeProjectId;
}

/**
 * Set the active project ID
 */
export async function setActiveProjectId(projectId: string | null): Promise<void> {
  const state = await loadSessionState();
  state.activeProjectId = projectId;
  await saveSessionState(state);
}

/**
 * Get a project by ID
 */
export async function getProject(projectId: string): Promise<RecoderSessionProject | null> {
  const state = await loadSessionState();
  return state.projects[projectId] ?? null;
}

/**
 * Add or update a project
 */
export async function upsertProject(project: RecoderSessionProject): Promise<void> {
  const state = await loadSessionState();
  state.projects[project.id] = {
    ...project,
    lastActivityAt: Date.now(),
  };
  await saveSessionState(state);
}

/**
 * Remove a project
 */
export async function removeProject(projectId: string): Promise<void> {
  const state = await loadSessionState();
  delete state.projects[projectId];

  // Clear active project if it was this one
  if (state.activeProjectId === projectId) {
    state.activeProjectId = null;
  }

  await saveSessionState(state);
}

/**
 * List all projects
 */
export async function listProjects(): Promise<RecoderSessionProject[]> {
  const state = await loadSessionState();
  return Object.values(state.projects);
}

/**
 * Add a created file to a project
 */
export async function addCreatedFile(projectId: string, filePath: string): Promise<void> {
  const state = await loadSessionState();
  const project = state.projects[projectId];

  if (project) {
    if (!project.createdFiles.includes(filePath)) {
      project.createdFiles.push(filePath);
    }
    project.lastActivityAt = Date.now();
    await saveSessionState(state);
  }
}

/**
 * Update project sandbox info
 */
export async function updateProjectSandbox(
  projectId: string,
  sandboxId: string,
  previewUrl?: string,
): Promise<void> {
  const state = await loadSessionState();
  const project = state.projects[projectId];

  if (project) {
    project.sandboxId = sandboxId;
    if (previewUrl) {
      project.previewUrl = previewUrl;
    }
    project.lastActivityAt = Date.now();
    await saveSessionState(state);
  }
}

/**
 * Get or create active project
 * Returns the active project, or null if none is set
 */
export async function getActiveProject(): Promise<RecoderSessionProject | null> {
  const state = await loadSessionState();
  if (!state.activeProjectId) {
    return null;
  }
  return state.projects[state.activeProjectId] ?? null;
}

/**
 * Clear all session state
 */
export async function clearSessionState(): Promise<void> {
  cachedState = createDefaultState();
  await saveSessionState(cachedState);
}
