/**
 * Workflow Manager: persists long-running workflow state across crashes/restarts.
 *
 * Perplexity Computer can run workflows for hours or months. This module
 * provides the persistence layer: workflows are written to disk (JSONL) so
 * they survive gateway restarts and can be resumed.
 *
 * Usage:
 *   const wm = getWorkflowManager();
 *   const id = wm.create({ goal: "...", tasks: [...] });
 *   wm.updateTask(id, taskId, { status: "done", output: "..." });
 *   const wf = wm.get(id);
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { TaskPlan, TaskResult } from "./task-planner.js";

const log = createSubsystemLogger("acp/workflow-manager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkflowStatus = "pending" | "running" | "done" | "failed" | "paused";

export type WorkflowRecord = {
  id: string;
  goal: string;
  status: WorkflowStatus;
  plan: TaskPlan;
  results: Record<string, TaskResult>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Optional cron expression for recurring workflows */
  schedule?: string;
  /** Next scheduled run timestamp (ms) */
  nextRunAt?: number;
  /** Number of times this workflow has been executed */
  runCount: number;
  /** Error message if workflow failed */
  error?: string;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const DEFAULT_STORE_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workflows",
);

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function workflowPath(storeDir: string, id: string): string {
  return path.join(storeDir, `${id}.json`);
}

function readWorkflow(storeDir: string, id: string): WorkflowRecord | null {
  const p = workflowPath(storeDir, id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as WorkflowRecord;
  } catch {
    log.warn(`Failed to read workflow ${id}`);
    return null;
  }
}

function writeWorkflow(storeDir: string, record: WorkflowRecord): void {
  ensureDir(storeDir);
  fs.writeFileSync(workflowPath(storeDir, record.id), JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private readonly storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir = storeDir ?? DEFAULT_STORE_DIR;
  }

  /** Create a new workflow record. */
  create(params: {
    goal: string;
    plan: TaskPlan;
    schedule?: string;
  }): WorkflowRecord {
    const now = Date.now();
    const record: WorkflowRecord = {
      id: crypto.randomUUID(),
      goal: params.goal,
      status: "pending",
      plan: params.plan,
      results: {},
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      schedule: params.schedule,
    };
    writeWorkflow(this.storeDir, record);
    log.debug(`Created workflow ${record.id}: ${params.goal}`);
    return record;
  }

  /** Get a workflow by ID. */
  get(id: string): WorkflowRecord | null {
    return readWorkflow(this.storeDir, id);
  }

  /** List all workflows (optionally filtered by status). */
  list(filter?: { status?: WorkflowStatus }): WorkflowRecord[] {
    if (!fs.existsSync(this.storeDir)) return [];
    const files = fs.readdirSync(this.storeDir).filter((f) => f.endsWith(".json"));
    const records: WorkflowRecord[] = [];
    for (const file of files) {
      const id = path.basename(file, ".json");
      const record = readWorkflow(this.storeDir, id);
      if (!record) continue;
      if (filter?.status && record.status !== filter.status) continue;
      records.push(record);
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Update workflow status. */
  updateStatus(id: string, status: WorkflowStatus, error?: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.status = status;
    record.updatedAt = Date.now();
    if (status === "done" || status === "failed") {
      record.completedAt = record.updatedAt;
    }
    if (error) record.error = error;
    writeWorkflow(this.storeDir, record);
    return true;
  }

  /** Update a single task result within a workflow. */
  updateTask(id: string, taskId: string, result: TaskResult): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.results[taskId] = result;
    record.updatedAt = Date.now();
    writeWorkflow(this.storeDir, record);
    return true;
  }

  /** Mark workflow as started (running). */
  start(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.status = "running";
    record.runCount += 1;
    record.updatedAt = Date.now();
    writeWorkflow(this.storeDir, record);
    return true;
  }

  /** Pause a running workflow. */
  pause(id: string): boolean {
    return this.updateStatus(id, "paused");
  }

  /** Resume a paused workflow. */
  resume(id: string): boolean {
    return this.updateStatus(id, "running");
  }

  /** Delete a workflow record. */
  delete(id: string): boolean {
    const p = workflowPath(this.storeDir, id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  /** Get workflows due for scheduled execution. */
  getDueWorkflows(): WorkflowRecord[] {
    const now = Date.now();
    return this.list().filter(
      (w) => w.schedule && w.nextRunAt && w.nextRunAt <= now && w.status !== "running",
    );
  }

  /** Update next run time for a recurring workflow. */
  scheduleNextRun(id: string, nextRunAt: number): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.nextRunAt = nextRunAt;
    record.status = "pending";
    record.updatedAt = Date.now();
    writeWorkflow(this.storeDir, record);
    return true;
  }
}

// Singleton
let _manager: WorkflowManager | null = null;

export function getWorkflowManager(storeDir?: string): WorkflowManager {
  if (!_manager) {
    _manager = new WorkflowManager(storeDir);
  }
  return _manager;
}
