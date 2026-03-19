/**
 * MABOS Cron Bridge
 *
 * Syncs MABOS `cron-jobs.json` entries to the parent OpenClaw CronService
 * via gateway WebSocket RPC (`cron.add`, `cron.update`, `cron.remove`).
 *
 * Maps MABOS job structure to parent `CronJobCreate`:
 *   - sessionTarget: "isolated"
 *   - payload.kind: "agentTurn"
 *   - schedule: { kind: "cron", expr, tz }
 *
 * Stores parent job ID as `parentCronId` back in MABOS store.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import { resolveDefaultAgentWorkspaceDir } from "../../../src/agents/workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a MABOS cron job in `cron-jobs.json`. */
type MabosCronJob = {
  id: string;
  name: string;
  schedule: string; // cron expression
  agentId?: string;
  action?: string;
  enabled: boolean;
  status?: string;
  workflowId?: string;
  stepId?: string;
  parentCronId?: string;
  timezone?: string;
  createdAt?: string;
  [key: string]: unknown;
};

/** Parent CronJobCreate (simplified — matches src/cron/types.ts). */
type ParentCronJobCreate = {
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: { kind: "cron"; expr: string; tz?: string };
  sessionTarget: "isolated";
  wakeMode: "next-heartbeat";
  payload: {
    kind: "agentTurn";
    message: string;
    timeoutSeconds?: number;
  };
  delivery?: {
    mode: "announce" | "none" | "webhook";
    channel?: string;
    to?: string;
    bestEffort?: boolean;
  };
};

/** Parent CronJob (subset returned by cron.add). */
type ParentCronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  [key: string]: unknown;
};

/** Gateway response frame. */
type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// Minimal Gateway RPC Client
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 3;
const RPC_TIMEOUT_MS = 15_000;

/**
 * One-shot gateway RPC call: connect → handshake → request → response → close.
 * Designed for low-frequency bridge sync, not high-throughput.
 */
export async function callGatewayRpc<T = Record<string, unknown>>(
  gatewayUrl: string,
  method: string,
  params?: unknown,
  authToken?: string,
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const connectId = randomUUID();
    const requestId = randomUUID();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`gateway RPC timeout: ${method} (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    const ws = new WebSocket(gatewayUrl);
    let handshakeDone = false;

    ws.on("open", () => {
      // Send connect request frame (protocol v3 RequestFrame wrapper).
      const connectParams: Record<string, unknown> = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "node-host",
          displayName: "MABOS Cron Bridge",
          version: "1.0.0",
          platform: "node",
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read"],
      };
      if (authToken) {
        connectParams.auth = { token: authToken };
      }
      ws.send(
        JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: connectParams,
        }),
      );
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString());

        // Handle connect response (hello-ok wrapped in a response frame).
        if (frame.type === "res" && frame.id === connectId && frame.ok && !handshakeDone) {
          handshakeDone = true;
          // Send the actual RPC request.
          ws.send(
            JSON.stringify({
              type: "req",
              id: requestId,
              method,
              params,
            }),
          );
          return;
        }

        // Handle RPC response.
        if (frame.type === "res" && frame.id === requestId) {
          clearTimeout(timer);
          settled = true;
          ws.close();
          if (frame.ok) {
            resolve((frame.payload ?? {}) as T);
          } else {
            const errMsg = frame.error?.message ?? "unknown gateway error";
            reject(new Error(`gateway RPC ${method}: ${errMsg}`));
          }
          return;
        }

        // Ignore tick events and other frames during handshake.
      } catch {
        // Ignore parse errors on non-JSON frames.
      }
    });

    ws.on("error", (err: Error) => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error(`gateway WS error: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!settled) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("gateway WS closed before response"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Mapping: MABOS → Parent CronJobCreate
// ---------------------------------------------------------------------------

const BRIDGE_JOB_NAME_PREFIX = "[mabos:";
const BRIDGE_JOB_LEGACY_PREFIX = "[mabos] ";
const BRIDGE_DESC_BUSINESS_RE = /\[business:([^\]]+)\]/;

function buildBridgeJobName(businessId: string, jobName: string): string {
  return `${BRIDGE_JOB_NAME_PREFIX}${businessId}] ${jobName}`;
}

function buildBridgeDescription(businessId: string, jobId: string, workflowLabel: string): string {
  return `MABOS bridge [business:${businessId}] [job:${jobId}]${workflowLabel}`;
}

function resolveParentJobBusinessId(job: ParentCronJob): string | null {
  if (typeof job.description === "string") {
    const match = job.description.match(BRIDGE_DESC_BUSINESS_RE);
    if (match?.[1]) {
      return match[1];
    }
  }
  if (typeof job.name === "string" && job.name.startsWith(BRIDGE_JOB_NAME_PREFIX)) {
    const closingBracket = job.name.indexOf("]");
    if (closingBracket > BRIDGE_JOB_NAME_PREFIX.length) {
      return job.name.slice(BRIDGE_JOB_NAME_PREFIX.length, closingBracket);
    }
  }
  return null;
}

function isBridgeManagedJob(job: ParentCronJob): boolean {
  if (typeof job.name !== "string") {
    return false;
  }
  return (
    job.name.startsWith(BRIDGE_JOB_NAME_PREFIX) || job.name.startsWith(BRIDGE_JOB_LEGACY_PREFIX)
  );
}

function mapToParentCreate(businessId: string, job: MabosCronJob): ParentCronJobCreate {
  const actionLabel = job.action || "execute_workflow";
  const workflowLabel = job.workflowId ? ` for workflow ${job.workflowId}` : "";
  const stepLabel = job.stepId ? ` (step ${job.stepId})` : "";

  // Use custom message if provided, otherwise build default.
  const message =
    typeof job.message === "string" && job.message
      ? job.message
      : [
          `Execute MABOS tool action: ${actionLabel}${workflowLabel}${stepLabel}.`,
          `This is an automated cron task from the MABOS workflow scheduler.`,
          job.action
            ? `Call the "${job.action}" tool with business_id and appropriate parameters.`
            : `Run the scheduled workflow step.`,
        ].join("\n");

  const result: ParentCronJobCreate = {
    agentId: job.agentId || undefined,
    name: buildBridgeJobName(businessId, job.name),
    description: buildBridgeDescription(businessId, job.id, workflowLabel),
    enabled: job.enabled,
    schedule: {
      kind: "cron",
      expr: job.schedule,
      tz: job.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "agentTurn",
      message,
      timeoutSeconds: typeof job.timeoutSeconds === "number" ? job.timeoutSeconds : 120,
    },
  };

  // Pass through delivery config if present, otherwise default to "none".
  // Without an explicit delivery mode, the gateway's normalizeCronJobCreate
  // defaults isolated agentTurn jobs to delivery.mode="announce", which
  // triggers a WebSocket self-connection for result delivery. Bridge jobs
  // don't need announce delivery — they just execute and write results.
  const delivery = job.delivery;
  if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
    const d = delivery as Record<string, unknown>;
    if (typeof d.mode === "string") {
      result.delivery = {
        mode: d.mode as "announce" | "none" | "webhook",
        channel: typeof d.channel === "string" ? d.channel : undefined,
        to: typeof d.to === "string" ? d.to : undefined,
        bestEffort: typeof d.bestEffort === "boolean" ? d.bestEffort : undefined,
      };
    } else {
      result.delivery = { mode: "none" };
    }
  } else {
    result.delivery = { mode: "none" };
  }

  return result;
}

// ---------------------------------------------------------------------------
// File Helpers
// ---------------------------------------------------------------------------

async function readJsonSafe<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CronBridge
// ---------------------------------------------------------------------------

export class CronBridge {
  private readonly gatewayUrl: string;
  private readonly workspaceDir: string;
  private readonly authToken?: string;
  private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void };
  private readonly rpcCall: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
  ) => Promise<T>;

  constructor(opts: {
    gatewayUrl: string;
    workspaceDir: string;
    authToken?: string;
    logger?: { info: (msg: string) => void; warn: (msg: string) => void };
    rpcCall?: <T = Record<string, unknown>>(method: string, params?: unknown) => Promise<T>;
  }) {
    this.gatewayUrl = opts.gatewayUrl;
    this.workspaceDir = opts.workspaceDir;
    this.authToken = opts.authToken;
    this.logger = opts.logger ?? {
      info: (msg: string) => console.log(`[mabos-cron-bridge] ${msg}`),
      warn: (msg: string) => console.warn(`[mabos-cron-bridge] ${msg}`),
    };
    this.rpcCall =
      opts.rpcCall ??
      (async <T = Record<string, unknown>>(method: string, params?: unknown) =>
        await callGatewayRpc<T>(this.gatewayUrl, method, params, this.authToken));
  }

  /** Resolve path to a business's cron-jobs.json. */
  private cronPath(businessId: string): string {
    return join(this.workspaceDir, "businesses", businessId, "cron-jobs.json");
  }

  /** Resolve the root businesses directory in the workspace. */
  private businessesRootPath(): string {
    return join(this.workspaceDir, "businesses");
  }

  /** Enumerate business IDs from workspace directories. */
  async listBusinessIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.businessesRootPath(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name.length > 0)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /** Read all MABOS cron jobs for a business. */
  async readJobs(businessId: string): Promise<MabosCronJob[]> {
    const jobs = await readJsonSafe<MabosCronJob[]>(this.cronPath(businessId));
    return Array.isArray(jobs) ? jobs : [];
  }

  /** Write MABOS cron jobs back (with updated parentCronId). */
  private async writeJobs(businessId: string, jobs: MabosCronJob[]): Promise<void> {
    await writeJsonAtomic(this.cronPath(businessId), jobs);
  }

  /**
   * Sync all MABOS cron jobs for a business to the parent CronService.
   * - Jobs with `workflowId` or a custom `message` and no `parentCronId` → `cron.add`
   * - Jobs with `parentCronId` → `cron.update` (enabled/schedule/payload/delivery sync)
   * - Parent jobs whose MABOS source was removed → `cron.remove`
   */
  async syncAll(businessId: string): Promise<{ added: number; updated: number; removed: number }> {
    const jobs = await this.readJobs(businessId);
    const workflowJobs = jobs.filter((j) => j.workflowId || typeof j.message === "string");
    let added = 0;
    let updated = 0;
    let removed = 0;

    // Collect current parent IDs for orphan detection.
    const activeParentIds = new Set<string>();

    for (const job of workflowJobs) {
      try {
        if (!job.parentCronId) {
          // New job — add to parent.
          const parentJob = await this.addToParent(businessId, job);
          job.parentCronId = parentJob.id;
          added++;
          activeParentIds.add(parentJob.id);
        } else {
          // Existing job — update parent.
          await this.updateInParent(businessId, job);
          updated++;
          activeParentIds.add(job.parentCronId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`sync failed for ${job.id}: ${msg}`);
      }
    }

    // Remove orphaned parent jobs (MABOS job was deleted but parent still exists).
    try {
      const parentList = await this.rpcCall<{ jobs: ParentCronJob[] }>("cron.list", {
        includeDisabled: true,
      });
      for (const pj of parentList.jobs ?? []) {
        if (!isBridgeManagedJob(pj)) {
          continue;
        }
        const ownerBusinessId = resolveParentJobBusinessId(pj);
        if (ownerBusinessId !== businessId || activeParentIds.has(pj.id)) {
          continue;
        }
        try {
          await this.rpcCall("cron.remove", { id: pj.id });
          removed++;
        } catch {
          // Ignore removal errors — job may already be gone.
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`orphan cleanup failed: ${msg}`);
    }

    // Persist parentCronId updates.
    await this.writeJobs(businessId, jobs);

    this.logger.info(`sync complete for ${businessId}: +${added} ~${updated} -${removed}`);
    return { added, updated, removed };
  }

  /** Sync every business found in the workspace independently. */
  async syncAllBusinesses(): Promise<{
    businesses: number;
    added: number;
    updated: number;
    removed: number;
  }> {
    const businessIds = await this.listBusinessIds();
    let added = 0;
    let updated = 0;
    let removed = 0;
    let processed = 0;

    for (const businessId of businessIds) {
      try {
        const result = await this.syncAll(businessId);
        processed++;
        added += result.added;
        updated += result.updated;
        removed += result.removed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`sync failed for business ${businessId}: ${msg}`);
      }
    }

    this.logger.info(
      `sync all businesses complete (${processed}/${businessIds.length}): +${added} ~${updated} -${removed}`,
    );
    return { businesses: processed, added, updated, removed };
  }

  /** Add a single MABOS job to the parent CronService. */
  private async addToParent(businessId: string, job: MabosCronJob): Promise<ParentCronJob> {
    const create = mapToParentCreate(businessId, job);
    const result = await this.rpcCall<ParentCronJob>("cron.add", create);
    this.logger.info(`added parent job ${result.id} for MABOS ${job.id}`);
    return result;
  }

  /** Update an existing parent job to match current MABOS state. */
  private async updateInParent(businessId: string, job: MabosCronJob): Promise<void> {
    if (!job.parentCronId) return;

    const create = mapToParentCreate(businessId, job);
    const patch: Record<string, unknown> = {
      enabled: job.enabled,
      schedule: create.schedule,
      payload: create.payload,
    };
    if (create.delivery) {
      patch.delivery = create.delivery;
    }

    await this.rpcCall("cron.update", {
      id: job.parentCronId,
      patch,
    });
  }

  /** Remove a parent job when its MABOS source is deleted. */
  async removeFromParent(parentCronId: string): Promise<void> {
    await this.rpcCall("cron.remove", { id: parentCronId });
    this.logger.info(`removed parent job ${parentCronId}`);
  }
}

// ---------------------------------------------------------------------------
// Service Factory
// ---------------------------------------------------------------------------

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create the MABOS cron bridge as an OpenClaw plugin service.
 * Periodically syncs MABOS workflow cron jobs to the parent CronService.
 */
export function createCronBridgeService(api: OpenClawPluginApi) {
  const gatewayPort = (api.config as any)?.gateway?.port ?? 18789;
  const tlsEnabled = (api.config as any)?.gateway?.tls?.enabled === true;
  const scheme = tlsEnabled ? "wss" : "ws";
  const gatewayUrl = `${scheme}://127.0.0.1:${gatewayPort}`;

  // Resolve workspace directory using same logic as tools.
  const pluginCfg = (api as any).pluginConfig ?? {};
  const defaultMabosWorkspace = resolveDefaultAgentWorkspaceDir({
    ...process.env,
    MABOS_PRODUCT: "1",
  } as NodeJS.ProcessEnv);
  const workspaceDir =
    pluginCfg.workspaceDir ??
    pluginCfg.agents?.defaults?.workspace ??
    (api.config as any)?.agents?.defaults?.workspace ??
    defaultMabosWorkspace;

  const authToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  const bridge = new CronBridge({
    gatewayUrl,
    workspaceDir,
    authToken,
    logger: {
      info: (msg) => api.logger.info(`[mabos-cron-bridge] ${msg}`),
      warn: (msg) => (api.logger.warn ?? api.logger.info)(`[mabos-cron-bridge] ${msg}`),
    },
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function syncOnce() {
    if (running) return;
    running = true;
    try {
      await bridge.syncAllBusinesses();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (api.logger.warn ?? api.logger.info)(`[mabos-cron-bridge] sync error: ${msg}`);
    } finally {
      running = false;
    }
  }

  return {
    id: "mabos-cron-bridge",
    start: async () => {
      api.logger.info("[mabos-cron-bridge] Service started");
      // Initial sync after a short delay to let the gateway finish starting.
      setTimeout(() => void syncOnce(), 10_000);
      // Periodic sync.
      timer = setInterval(() => void syncOnce(), SYNC_INTERVAL_MS);
    },
    stop: async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      api.logger.info("[mabos-cron-bridge] Service stopped");
    },
  };
}
