import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { DEFAULT_DASHBOARD_WORKSPACE } from "./default-workspace.js";
import { migrateWorkspaceDoc, validateWorkspaceDoc, type WorkspaceDoc } from "./schema.js";

export type DashboardMutationOptions = { actor: string };
export type DashboardMutationResult = { doc: WorkspaceDoc; changed: boolean };

const MAX_WORKSPACE_BYTES = 256 * 1024;
const UNDO_RING_SIZE = 20;

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function serializeWorkspaceDoc(doc: WorkspaceDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function assertWorkspaceSize(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
    throw new Error("workspace document exceeds 256 KB");
  }
}

/**
 * Enforce the custom-widget approval invariant against the CURRENT document: a
 * caller-supplied doc can never ELEVATE a widget to `approved`. Any registry
 * entry that arrives `approved` but is not already `approved` in `current` is
 * downgraded to `pending` (dropping the approval provenance). Approve stays the
 * sole transition to `approved`, going through its own dedicated verb.
 */
export function reconcileReplaceApproval(
  incoming: WorkspaceDoc,
  current: WorkspaceDoc,
): WorkspaceDoc {
  const currentRegistry = current.widgetsRegistry ?? {};
  const incomingRegistry = incoming.widgetsRegistry ?? {};
  for (const [name, entry] of Object.entries(incomingRegistry)) {
    if (entry.status === "approved" && currentRegistry[name]?.status !== "approved") {
      entry.status = "pending";
      delete entry.approvedBy;
      delete entry.approvedAt;
    }
  }
  return incoming;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

export class DashboardStore {
  readonly stateDir: string;
  readonly dashboardDir: string;
  readonly workspacePath: string;
  readonly undoDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = options.stateDir ?? resolveStateDir();
    this.dashboardDir = path.join(this.stateDir, "dashboard");
    this.workspacePath = path.join(this.dashboardDir, "workspace.json");
    this.undoDir = path.join(this.dashboardDir, "undo");
  }

  async read(): Promise<WorkspaceDoc> {
    const raw = await readJsonFile(this.workspacePath);
    if (raw === undefined) {
      const seeded = validateWorkspaceDoc(structuredClone(DEFAULT_DASHBOARD_WORKSPACE));
      await this.writeWorkspaceDoc(seeded);
      return seeded;
    }
    const migrated = migrateWorkspaceDoc(raw);
    if (migrated.changed) {
      await this.writeWorkspaceDoc(migrated.doc);
    }
    return migrated.doc;
  }

  async mutate(
    fn: (draft: WorkspaceDoc) => WorkspaceDoc | void | Promise<WorkspaceDoc | void>,
    _options: DashboardMutationOptions,
  ): Promise<DashboardMutationResult> {
    return await this.runExclusive(async () => {
      const current = await this.read();
      const draft = structuredClone(current);
      const returned = await fn(draft);
      const candidate = returned === undefined ? draft : returned;
      candidate.workspaceVersion = current.workspaceVersion + 1;
      const next = validateWorkspaceDoc(candidate);
      const serialized = serializeWorkspaceDoc(next);
      assertWorkspaceSize(serialized);
      await this.writeUndoSnapshot(current, next.workspaceVersion);
      await this.writeWorkspaceSerialized(serialized);
      return { doc: next, changed: true };
    });
  }

  async replace(
    doc: WorkspaceDoc,
    options: DashboardMutationOptions,
  ): Promise<DashboardMutationResult> {
    return await this.mutate(() => structuredClone(doc), options);
  }

  /**
   * Like `replace`, but enforces the approval invariant against the CURRENT
   * document inside the write lock (no TOCTOU): a caller-supplied doc can never
   * elevate a custom widget to `approved`. Every UNTRUSTED whole-document write
   * (the `dashboard.workspace.replace` gateway method) MUST use this; `replace`
   * stays a trusted primitive for seeding, restore, and undo.
   */
  async replaceSanitized(
    doc: WorkspaceDoc,
    options: DashboardMutationOptions,
  ): Promise<DashboardMutationResult> {
    return await this.mutate(
      (current) => reconcileReplaceApproval(structuredClone(doc), current),
      options,
    );
  }

  async undo(): Promise<WorkspaceDoc> {
    return await this.runExclusive(async () => {
      const files = await this.listUndoFiles();
      const newest = files.at(-1);
      if (!newest) {
        throw new Error("no dashboard undo snapshot available");
      }
      const snapshotPath = path.join(this.undoDir, newest);
      const snapshot = validateWorkspaceDoc(await readJsonFile(snapshotPath));
      const serialized = serializeWorkspaceDoc(snapshot);
      assertWorkspaceSize(serialized);
      await this.writeWorkspaceSerialized(serialized);
      await fs.rm(snapshotPath, { force: true });
      return snapshot;
    });
  }

  private async runExclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    // One gateway process is the only writer; this promise chain serializes
    // all RPC/tool/CLI callers so read-modify-write cycles cannot interleave.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  private async writeWorkspaceDoc(doc: WorkspaceDoc): Promise<void> {
    const serialized = serializeWorkspaceDoc(doc);
    assertWorkspaceSize(serialized);
    await this.writeWorkspaceSerialized(serialized);
  }

  private async writeWorkspaceSerialized(serialized: string): Promise<void> {
    await fs.mkdir(this.dashboardDir, { recursive: true, mode: 0o700 });
    await replaceFileAtomic({
      filePath: this.workspacePath,
      content: serialized,
      mode: 0o600,
      tempPrefix: ".dashboard-workspace",
      throwOnCleanupError: true,
    });
  }

  private async writeUndoSnapshot(doc: WorkspaceDoc, nextWorkspaceVersion: number): Promise<void> {
    await fs.mkdir(this.undoDir, { recursive: true, mode: 0o700 });
    await replaceFileAtomic({
      filePath: path.join(this.undoDir, `${String(nextWorkspaceVersion).padStart(4, "0")}.json`),
      content: serializeWorkspaceDoc(doc),
      mode: 0o600,
      tempPrefix: ".dashboard-undo",
      throwOnCleanupError: true,
    });
    const files = await this.listUndoFiles();
    const evict = files.slice(0, Math.max(0, files.length - UNDO_RING_SIZE));
    await Promise.all(
      evict.map((fileName) => fs.rm(path.join(this.undoDir, fileName), { force: true })),
    );
  }

  private async listUndoFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(this.undoDir))
        .filter((fileName) => /^\d+\.json$/.test(fileName))
        .toSorted();
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }
}
