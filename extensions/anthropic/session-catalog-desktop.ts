import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import {
  asPositiveSafeInteger as pullRequestNumber,
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readClaudeDesktopCustomGroups } from "./claude-desktop-groups.js";
import {
  childDirectories,
  desktopSessionsDir,
  readJsonFile,
  reserveCatalogJsonBytes,
  reserveCatalogJsonFile,
  setBoundedCache,
  type CatalogJsonFileRejectionReason,
  type CatalogJsonReadBudget,
} from "./session-catalog-scan.js";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";

export const MAX_STRING_LENGTH = 4096;
const MAX_SESSION_PULL_REQUESTS = 20;
const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;

export type DesktopSessionMetadata = {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  originCwd?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  model?: unknown;
  isArchived?: unknown;
  title?: unknown;
  customGroup?: unknown;
  prNumber?: unknown;
  prState?: unknown;
  prs?: unknown;
};

type DesktopPullRequestMetadata = {
  prNumber?: unknown;
  state?: unknown;
  dismissed?: unknown;
};

function pullRequestState(value: unknown): SessionCatalogPullRequestSummary["state"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const state = value.trim().toLowerCase();
  return state === "open" || state === "draft" || state === "merged" || state === "closed"
    ? state
    : undefined;
}

const DESKTOP_ARCHIVE_SCAN_CHUNK_BYTES = 16 * 1024;

type DesktopArchiveProbeState = {
  phase:
    | "start"
    | "key-or-end"
    | "key"
    | "colon"
    | "value-start"
    | "string"
    | "primitive"
    | "composite"
    | "after-value"
    | "done"
    | "invalid";
  key?: string;
  stringKind?: "key" | "cli" | "other";
  stringRaw: string;
  stringEscaped: boolean;
  stringTooLong: boolean;
  compositeDepth: number;
  compositeInString: boolean;
  compositeEscaped: boolean;
  primitive: string;
  cliSessionId?: string;
  isArchived: boolean;
};

function createDesktopArchiveProbeState(): DesktopArchiveProbeState {
  return {
    phase: "start",
    stringRaw: "",
    stringEscaped: false,
    stringTooLong: false,
    compositeDepth: 0,
    compositeInString: false,
    compositeEscaped: false,
    primitive: "",
    isArchived: false,
  };
}

function appendDesktopArchiveProbeString(state: DesktopArchiveProbeState, value: string): void {
  if (state.stringTooLong) {
    return;
  }
  if (state.stringRaw.length + value.length > 1024) {
    state.stringTooLong = true;
    state.stringRaw = "";
    return;
  }
  state.stringRaw += value;
}

function finishDesktopArchiveProbeString(state: DesktopArchiveProbeState): void {
  let value: unknown;
  if (!state.stringTooLong) {
    try {
      value = JSON.parse(`"${state.stringRaw}"`) as unknown; // SAFETY: the scanner collected one JSON string token's contents.
    } catch {
      state.phase = "invalid";
      return;
    }
  }
  if (state.stringKind === "key") {
    state.key = typeof value === "string" ? value : undefined;
    state.phase = "colon";
  } else {
    if (state.stringKind === "cli" && typeof value === "string") {
      state.cliSessionId = readBoundedString(value, 256);
    }
    state.phase = "after-value";
  }
  state.stringKind = undefined;
  state.stringRaw = "";
  state.stringEscaped = false;
  state.stringTooLong = false;
}

function finishDesktopArchiveProbePrimitive(state: DesktopArchiveProbeState): void {
  if (state.key === "isArchived" && state.primitive === "true") {
    state.isArchived = true;
  }
  state.primitive = "";
  state.phase = "after-value";
}

function consumeDesktopArchiveProbeText(state: DesktopArchiveProbeState, text: string): void {
  let index = 0;
  while (index < text.length && state.phase !== "done" && state.phase !== "invalid") {
    const character = text[index];
    if (character === undefined) {
      break;
    }
    if (
      state.phase === "primitive" &&
      (character === "," || character === "}" || /\s/.test(character))
    ) {
      finishDesktopArchiveProbePrimitive(state);
      continue;
    }
    if (state.phase === "start") {
      state.phase = /\s/.test(character) ? "start" : character === "{" ? "key-or-end" : "invalid";
    } else if (state.phase === "key-or-end") {
      if (/\s/.test(character)) {
        // Keep waiting for the next object key or the closing brace.
      } else if (character === "}") {
        state.phase = "done";
      } else if (character === '"') {
        state.phase = "key";
        state.stringKind = "key";
        state.stringRaw = "";
        state.stringEscaped = false;
        state.stringTooLong = false;
      } else {
        state.phase = "invalid";
      }
    } else if (state.phase === "key") {
      if (state.stringEscaped) {
        appendDesktopArchiveProbeString(state, character);
        state.stringEscaped = false;
      } else if (character === "\\") {
        state.stringEscaped = true;
        appendDesktopArchiveProbeString(state, character);
      } else if (character === '"') {
        finishDesktopArchiveProbeString(state);
      } else {
        appendDesktopArchiveProbeString(state, character);
      }
    } else if (state.phase === "colon") {
      state.phase = /\s/.test(character) ? "colon" : character === ":" ? "value-start" : "invalid";
    } else if (state.phase === "value-start") {
      if (/\s/.test(character)) {
        // Keep waiting for the value token.
      } else if (character === '"') {
        state.phase = "string";
        state.stringKind = state.key === "cliSessionId" ? "cli" : "other";
        state.stringRaw = "";
        state.stringEscaped = false;
        state.stringTooLong = false;
      } else if (character === "{" || character === "[") {
        state.phase = "composite";
        state.compositeDepth = 1;
        state.compositeInString = false;
        state.compositeEscaped = false;
      } else {
        state.phase = "primitive";
        state.primitive = character;
      }
    } else if (state.phase === "string") {
      if (state.stringEscaped) {
        appendDesktopArchiveProbeString(state, character);
        state.stringEscaped = false;
      } else if (character === "\\") {
        state.stringEscaped = true;
        appendDesktopArchiveProbeString(state, character);
      } else if (character === '"') {
        finishDesktopArchiveProbeString(state);
      } else {
        appendDesktopArchiveProbeString(state, character);
      }
    } else if (state.phase === "primitive") {
      if (state.primitive.length >= 64) {
        state.phase = "invalid";
      } else {
        state.primitive += character;
      }
    } else if (state.phase === "composite") {
      if (state.compositeInString) {
        if (state.compositeEscaped) {
          state.compositeEscaped = false;
        } else if (character === "\\") {
          state.compositeEscaped = true;
        } else if (character === '"') {
          state.compositeInString = false;
        }
      } else if (character === '"') {
        state.compositeInString = true;
      } else if (character === "{" || character === "[") {
        state.compositeDepth += 1;
      } else if (character === "}" || character === "]") {
        state.compositeDepth -= 1;
        if (state.compositeDepth === 0) {
          state.phase = "after-value";
        }
      }
    } else if (state.phase === "after-value") {
      if (/\s/.test(character)) {
        // Keep waiting for the next property or the closing brace.
      } else if (character === ",") {
        state.phase = "key-or-end";
      } else if (character === "}") {
        state.phase = "done";
      } else {
        state.phase = "invalid";
      }
    }
    index += 1;
  }
}

async function probeDesktopArchiveStatus(
  filePath: string,
  onIoFailure: () => void,
): Promise<{ cliSessionId: string; isArchived: true } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(DESKTOP_ARCHIVE_SCAN_CHUNK_BYTES);
    const decoder = new TextDecoder();
    const probe = createDesktopArchiveProbeState();
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        onIoFailure();
        return undefined;
      }
      offset += bytesRead;
      consumeDesktopArchiveProbeText(
        probe,
        decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < stat.size }),
      );
      if (probe.isArchived && probe.cliSessionId) {
        return { cliSessionId: probe.cliSessionId, isArchived: true };
      }
    }
    consumeDesktopArchiveProbeText(probe, decoder.decode());
    if (probe.isArchived && probe.cliSessionId) {
      return { cliSessionId: probe.cliSessionId, isArchived: true };
    }
    return undefined;
  } catch {
    onIoFailure();
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Desktop retains historical PRs in order and marks hidden ones as dismissed;
// the top-level pair identifies the current PR whose state labels the row.
export function desktopPullRequestSummary(
  metadata: DesktopSessionMetadata,
): SessionCatalogPullRequestSummary | undefined {
  const visibleByNumber = new Map<number, SessionCatalogPullRequestSummary["state"] | undefined>();
  const dismissed = new Set<number>();
  if (Array.isArray(metadata.prs)) {
    for (const value of metadata.prs) {
      if (!isRecord(value)) {
        continue;
      }
      const entry: DesktopPullRequestMetadata = value;
      const number = pullRequestNumber(entry.prNumber);
      if (!number) {
        continue;
      }
      if (entry.dismissed === true) {
        dismissed.add(number);
        visibleByNumber.delete(number);
        continue;
      }
      if (!dismissed.has(number) && !visibleByNumber.has(number)) {
        visibleByNumber.set(number, pullRequestState(entry.state));
      }
    }
  }
  const currentNumber = pullRequestNumber(metadata.prNumber);
  let currentState = currentNumber ? visibleByNumber.get(currentNumber) : undefined;
  if (currentNumber && !dismissed.has(currentNumber)) {
    currentState = pullRequestState(metadata.prState) ?? currentState;
    // Reinsert the current PR at the tail so truncation always retains it.
    visibleByNumber.delete(currentNumber);
    visibleByNumber.set(currentNumber, currentState);
  }
  const visible = [...visibleByNumber].map(([number, state]) => ({ number, state }));
  if (visible.length === 0) {
    return undefined;
  }
  const state = currentState ?? visible.at(-1)?.state;
  if (!state) {
    return undefined;
  }
  return {
    numbers: visible.slice(-MAX_SESSION_PULL_REQUESTS).map((entry) => entry.number),
    state,
  };
}

export function parsePullRequestSummary(
  value: unknown,
): SessionCatalogPullRequestSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.numbers)) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  const numbers = value.numbers.flatMap((candidate) => {
    const number = pullRequestNumber(candidate);
    return number === undefined ? [] : [number];
  });
  const state = pullRequestState(value.state);
  if (
    numbers.length === 0 ||
    numbers.length !== value.numbers.length ||
    numbers.length > MAX_SESSION_PULL_REQUESTS ||
    new Set(numbers).size !== numbers.length ||
    !state
  ) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  return { numbers, state };
}

async function readDesktopMetadata(
  homeDir: string,
  forceRefresh?: boolean,
  budget?: CatalogJsonReadBudget,
  onIoFailure?: () => void,
): Promise<{
  available: boolean;
  customGroups: Map<string, string>;
  active: Map<string, DesktopSessionMetadata>;
  activeFileIndexes: Map<string, number>;
  archived: Set<string>;
  archivedFileIndexes: Map<string, number>;
  admittedFileSizes: number[];
  skippedFiles: number;
  racedFiles: number;
  scannedBytes: number;
  readFailed: boolean;
}> {
  const active = new Map<string, DesktopSessionMetadata>();
  const activeFileIndexes = new Map<string, number>();
  const archived = new Set<string>();
  const archivedFileIndexes = new Map<string, number>();
  const admittedFileSizes: number[] = [];
  const skippedFilesBefore = budget?.skippedFiles ?? 0;
  const racedFilesBefore = budget?.racedFiles ?? 0;
  const remainingBytesBefore = budget?.remainingBytes;
  let readFailed = false;
  const markIoFailure = () => {
    readFailed = true;
    onIoFailure?.();
  };
  const customGroups = await readClaudeDesktopCustomGroups(homeDir, forceRefresh);
  for (const accountDir of (await childDirectories(desktopSessionsDir(homeDir))).toSorted()) {
    for (const workspaceDir of (await childDirectories(accountDir)).toSorted()) {
      let entries: string[];
      try {
        entries = await fs.readdir(workspaceDir);
      } catch {
        continue;
      }
      for (const name of entries.toSorted()) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) {
          continue;
        }
        const filePath = path.join(workspaceDir, name);
        let rejectionReason: CatalogJsonFileRejectionReason | undefined;
        const reservedBytes = budget
          ? await reserveCatalogJsonFile(filePath, budget, markIoFailure, (reason) => {
              rejectionReason = reason;
            })
          : undefined;
        if (budget && reservedBytes === undefined) {
          if (rejectionReason === "oversized" || rejectionReason === "budget") {
            const archive = await probeDesktopArchiveStatus(filePath, markIoFailure);
            if (archive) {
              archived.add(archive.cliSessionId);
              active.delete(archive.cliSessionId);
              activeFileIndexes.delete(archive.cliSessionId);
            }
          }
          continue;
        }
        const admittedFileIndex =
          reservedBytes === undefined ? undefined : admittedFileSizes.push(reservedBytes) - 1;
        const raw = await readJsonFile(filePath, {
          budget,
          onIoFailure: markIoFailure,
          ...(reservedBytes !== undefined ? { reservedBytes } : {}),
        });
        if (!isRecord(raw)) {
          continue;
        }
        const metadata: DesktopSessionMetadata = raw;
        const cliSessionId = readBoundedString(metadata.cliSessionId, 256);
        if (!cliSessionId) {
          continue;
        }
        if (metadata.isArchived === true) {
          archived.add(cliSessionId);
          if (admittedFileIndex !== undefined) {
            archivedFileIndexes.set(cliSessionId, admittedFileIndex);
          }
          active.delete(cliSessionId);
          activeFileIndexes.delete(cliSessionId);
          continue;
        }
        if (!archived.has(cliSessionId)) {
          const localSessionId = readBoundedString(metadata.sessionId, 256);
          const customGroup = localSessionId ? customGroups.get(localSessionId) : undefined;
          active.set(cliSessionId, customGroup ? { ...metadata, customGroup } : metadata);
          if (admittedFileIndex !== undefined) {
            activeFileIndexes.set(cliSessionId, admittedFileIndex);
          } else {
            activeFileIndexes.delete(cliSessionId);
          }
        }
      }
    }
  }
  return {
    available: true,
    active,
    activeFileIndexes,
    archived,
    archivedFileIndexes,
    admittedFileSizes,
    customGroups,
    skippedFiles: (budget?.skippedFiles ?? 0) - skippedFilesBefore,
    racedFiles: (budget?.racedFiles ?? 0) - racedFilesBefore,
    scannedBytes:
      budget && remainingBytesBefore !== undefined
        ? remainingBytesBefore - budget.remainingBytes
        : 0,
    readFailed,
  };
}

export type DesktopOverlay = Awaited<ReturnType<typeof readDesktopMetadata>>;
type DesktopOverlayCacheEntry = {
  watch?: DirtyDirectoryWatch;
  startingBudgetBytes: number | undefined;
  refreshedAt: number;
  refreshing: boolean;
  overlay: Promise<DesktopOverlay>;
};
const desktopOverlays = new Map<string, DesktopOverlayCacheEntry>();
export const emptyDesktopOverlay: DesktopOverlay = {
  available: false,
  active: new Map(),
  activeFileIndexes: new Map(),
  archived: new Set(),
  archivedFileIndexes: new Map(),
  admittedFileSizes: [],
  customGroups: new Map(),
  skippedFiles: 0,
  racedFiles: 0,
  scannedBytes: 0,
  readFailed: false,
};

function replayDesktopReadStatus(
  overlay: DesktopOverlay,
  budget?: CatalogJsonReadBudget,
  onIoFailure?: () => void,
): DesktopOverlay {
  if (!budget) {
    return overlay;
  }
  budget.skippedFiles += overlay.skippedFiles;
  budget.racedFiles += overlay.racedFiles;
  if (overlay.readFailed) {
    onIoFailure?.();
  }
  const admittedFileIndexes = new Set<number>();
  for (const [index, fileSize] of overlay.admittedFileSizes.entries()) {
    if (reserveCatalogJsonBytes(budget, fileSize)) {
      admittedFileIndexes.add(index);
    } else {
      budget.skippedFiles += 1;
    }
  }
  const active = new Map<string, DesktopSessionMetadata>();
  const activeFileIndexes = new Map<string, number>();
  for (const [sessionId, metadata] of overlay.active) {
    const fileIndex = overlay.activeFileIndexes.get(sessionId);
    if (fileIndex !== undefined && !admittedFileIndexes.has(fileIndex)) {
      continue;
    }
    active.set(sessionId, metadata);
    if (fileIndex !== undefined) {
      activeFileIndexes.set(sessionId, fileIndex);
    }
  }
  const archived = new Set<string>();
  const archivedFileIndexes = new Map<string, number>();
  for (const sessionId of overlay.archived) {
    const fileIndex = overlay.archivedFileIndexes.get(sessionId);
    archived.add(sessionId);
    if (fileIndex !== undefined) {
      archivedFileIndexes.set(sessionId, fileIndex);
    }
  }
  if (active.size === overlay.active.size && archived.size === overlay.archived.size) {
    return overlay;
  }
  return { ...overlay, active, activeFileIndexes, archived, archivedFileIndexes };
}

function preserveArchivedSessions(
  overlay: DesktopOverlay,
  previous: DesktopOverlay,
): DesktopOverlay {
  const archived = new Set(overlay.archived);
  const archivedFileIndexes = new Map(overlay.archivedFileIndexes);
  const active = new Map(overlay.active);
  const activeFileIndexes = new Map(overlay.activeFileIndexes);
  const admittedFileSizes = [...overlay.admittedFileSizes];
  let changed = false;

  for (const sessionId of previous.archived) {
    if (!archived.has(sessionId)) {
      archived.add(sessionId);
      changed = true;
    }
    if (active.delete(sessionId)) {
      changed = true;
    }
    if (activeFileIndexes.delete(sessionId)) {
      changed = true;
    }
    if (!archivedFileIndexes.has(sessionId)) {
      const previousFileIndex = previous.archivedFileIndexes.get(sessionId);
      const previousFileSize =
        previousFileIndex === undefined ? undefined : previous.admittedFileSizes[previousFileIndex];
      if (previousFileSize !== undefined) {
        archivedFileIndexes.set(sessionId, admittedFileSizes.push(previousFileSize) - 1);
        changed = true;
      }
    }
  }

  return changed
    ? { ...overlay, active, activeFileIndexes, archived, archivedFileIndexes, admittedFileSizes }
    : overlay;
}

export async function readDesktopOverlay(
  homeDir: string,
  forceRefresh?: boolean,
  budget?: CatalogJsonReadBudget,
  onIoFailure?: () => void,
): Promise<DesktopOverlay> {
  const entry = desktopOverlays.get(homeDir);
  const startingBudgetBytes = budget?.remainingBytes;
  if (entry?.refreshing) {
    if (!forceRefresh) {
      if (entry.startingBudgetBytes !== startingBudgetBytes) {
        await entry.overlay;
        return readDesktopOverlay(homeDir, false, budget, onIoFailure);
      }
      const overlay = await entry.overlay;
      return replayDesktopReadStatus(overlay, budget, onIoFailure);
    }
    await entry.overlay;
    return readDesktopOverlay(homeDir, forceRefresh, budget, onIoFailure);
  }
  const dirty = entry?.watch?.takeDirty();
  const budgetChanged = entry !== undefined && entry.startingBudgetBytes !== startingBudgetBytes;
  // Groups live in Local Storage outside this watch. Keep the 60s Desktop refresh even
  // with clean session metadata; it must not invalidate the independent CLI scan.
  if (
    !forceRefresh &&
    entry &&
    entry.startingBudgetBytes === startingBudgetBytes &&
    entry.refreshedAt + CLAUDE_DESKTOP_SCAN_TTL_MS > Date.now() &&
    dirty !== "all" &&
    !(dirty instanceof Set && dirty.size > 0)
  ) {
    setBoundedCache(desktopOverlays, homeDir, entry, 8, (evicted) => evicted.watch?.close());
    const overlay = await entry.overlay;
    return replayDesktopReadStatus(overlay, budget, onIoFailure);
  }
  const watch = entry?.watch ?? createDirtyDirectoryWatch(desktopSessionsDir(homeDir));
  const current: DesktopOverlayCacheEntry = {
    watch,
    startingBudgetBytes,
    refreshedAt: Date.now(),
    refreshing: true,
    overlay: Promise.resolve(emptyDesktopOverlay),
  };
  current.overlay = (async () => {
    const previous =
      budgetChanged && !forceRefresh && dirty instanceof Set && dirty.size === 0 && entry
        ? await entry.overlay
        : undefined;
    const stat = await fs.stat(desktopSessionsDir(homeDir)).catch(() => undefined);
    if (!stat?.isDirectory()) {
      // An absent Desktop store is rechecked on the 60s overlay TTL, never on each CLI poll.
      watch.close();
      current.watch = undefined;
      return emptyDesktopOverlay;
    }
    const overlay = await readDesktopMetadata(homeDir, forceRefresh, budget, onIoFailure);
    return previous ? preserveArchivedSessions(overlay, previous) : overlay;
  })().finally(() => {
    current.refreshing = false;
  });
  setBoundedCache(desktopOverlays, homeDir, current, 8, (evicted) => evicted.watch?.close());
  return current.overlay;
}
