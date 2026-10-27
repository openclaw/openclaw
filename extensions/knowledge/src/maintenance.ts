import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { Check } from "typebox/value";
import { nextRun, parseCron, type Cron } from "./cron.js";
import {
  MaintenanceRun,
  type MaintenanceReview,
  type MaintenanceStatus,
  type MaintenanceVault,
} from "./maintenance-contract.js";
import type { RelinkOutput } from "./relink-contract.js";
import type { Stores } from "./stores.js";

type Logger = { info(message: string): void; warn(message: string): void };
type State = { nextRunAt?: number; lastRun?: MaintenanceRun };
/** The part of the host's service automation scheduler maintenance uses. */
type ReviewScheduler = {
  list?: (opts?: {
    includeDisabled?: boolean;
  }) => Promise<Array<{ id: string; declarationKey?: string; enabled?: boolean }>>;
  enqueueRun?: (
    id: string,
    mode?: "if-enabled",
  ) => Promise<
    { ok: true; enqueued: true; runId: string } | { ok: true; ran: boolean } | { ok: false }
  >;
};
/** Jobs in one pass, in order. Each is zero-LLM and bounded per call. */
const JOBS = ["relink"];
const RELINK_PAGE = 500;
/** Declaration key of the automation the review scribe creates for itself. */
export const REVIEW_SCRIBE_DECLARATION_KEY = "knowledge:scribe:unlinked-review";
/** A missed run is caught up shortly after start, once the Gateway settles. */
const CATCH_UP_DELAY_MS = 60_000;

/**
 * Plugin-owned scheduled maintenance (SPEC §11). Uses the host service
 * scheduler; there is no job store or queue. One pass visits every
 * operator-defined store and partition; one failing store never stops the
 * others. The last pass and the next slot persist in the store registry so a
 * pass missed while the Gateway was down runs after restart.
 */
export class Maintenance {
  private cron?: Cron;
  private configError?: string;
  private state: State = {};
  private scheduler?: PluginServiceSchedulerV1;
  private getCron?: () => ReviewScheduler | undefined;
  private running?: Promise<void>;
  constructor(
    private readonly stores: Stores,
    private readonly log: Logger,
  ) {
    const { schedule, timezone } = stores.policy.maintenance;
    try {
      this.cron = parseCron(schedule, timezone);
    } catch (e) {
      // SAFETY: parseCron throws only Error objects.
      this.configError = (e as Error).message;
    }
  }
  private get active() {
    return (
      this.stores.policy.maintenance.enabled &&
      this.stores.policy.writesEnabled &&
      Boolean(this.cron)
    );
  }

  /** Arm the schedule for this service lifetime. `getCron` reaches the review automation. */
  async start(scheduler: PluginServiceSchedulerV1, getCron?: () => ReviewScheduler | undefined) {
    this.scheduler = scheduler;
    this.getCron = getCron;
    this.state = await this.load();
    if (this.configError) {
      this.log.warn(`Knowledge maintenance is not scheduled: ${this.configError}`);
    }
    if (!this.active) {
      return;
    }
    const now = scheduler.now(),
      due = this.state.nextRunAt;
    // A slot that passed without a recorded run was missed while stopped.
    if (
      due !== undefined &&
      due <= now &&
      (this.state.lastRun ? Date.parse(this.state.lastRun.slot) < due : true)
    ) {
      scheduler.schedule({
        id: "knowledge-maintenance",
        delayMs: CATCH_UP_DELAY_MS,
        run: () => this.pass("catch-up", due),
      });
      this.log.info(
        `Knowledge maintenance missed ${new Date(due).toISOString()}; catching up in ${CATCH_UP_DELAY_MS / 1000}s.`,
      );
      return;
    }
    await this.arm(now);
  }

  /** End this service lifetime: arm nothing more and wait for a pass in flight. */
  async stop() {
    this.scheduler = undefined;
    await this.running;
  }

  private async arm(after: number) {
    if (!this.scheduler || !this.cron || !this.active) {
      return;
    }
    const slot = nextRun(this.cron, after);
    this.state.nextRunAt = slot;
    await this.save();
    this.scheduler.schedule({
      id: "knowledge-maintenance",
      atMs: slot,
      run: () => this.pass("scheduled", slot),
    });
  }

  /** One pass for one slot, then arm the next slot. Never overlaps itself. */
  pass(trigger: MaintenanceRun["trigger"], slot: number): Promise<void> {
    this.running ??= this.execute(trigger, slot)
      .catch((e: unknown) =>
        // SAFETY: execute() rejects only with Error objects from the store runtime and storage client.
        this.log.warn(`Knowledge maintenance pass failed: ${(e as Error).message}`),
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running.then(() => this.arm(Math.max(slot, this.scheduler?.now() ?? Date.now())));
  }

  private async execute(trigger: MaintenanceRun["trigger"], slot: number) {
    const startedAt = new Date().toISOString(),
      vaults: MaintenanceVault[] = [],
      epoch = this.stores.incarnation,
      reviewJobId = await this.reviewJobId();
    let pending = 0;
    for (const target of await this.stores.maintenanceTargets()) {
      const result: MaintenanceVault = {
        binding: target.binding,
        label: target.label.slice(0, 160),
        outcome: "ok",
        partitions: 0,
        scanned: 0,
        linked: 0,
        ambiguous: 0,
        noSubject: 0,
        failed: 0,
      };
      vaults.push(result);
      if (target.state !== "ready" || !target.vaultId) {
        result.outcome = "skipped";
        result.message =
          target.state === "unprovisioned" ? "Not created yet." : `Store is ${target.state}.`;
        continue;
      }
      try {
        const store = this.stores.openMaintenance(target.vaultId, { visibility: "private" }, epoch);
        const partitions = await store.runtime.enqueue(store.access.assertCurrent, () =>
          store.runtime.client.call("partitions", store.access),
        );
        for (const scope of partitions) {
          result.partitions++;
          const { runtime, access } = this.stores.openMaintenance(target.vaultId, scope, epoch);
          let cursor: string | undefined,
            linked = 0;
          do {
            const out: RelinkOutput = await runtime.enqueue(access.assertCurrent, () =>
              runtime.client.call("maintenanceRelink", access, {
                limit: RELINK_PAGE,
                ...(cursor ? { cursor } : {}),
              }),
            );
            result.scanned += out.scanned;
            result.linked += out.linked;
            linked += out.linked;
            result.ambiguous += out.ambiguous;
            result.noSubject += out.noSubject;
            result.failed += out.failed;
            cursor = out.nextCursor ?? undefined;
          } while (cursor);
          // The review handles every private claim no page reaches, not only remembered ones;
          // only the private partition is reachable from the owner's review session.
          if (scope.visibility === "private" && reviewJobId) {
            pending += await this.unlinked(runtime, access);
          }
          // A pass that linked nothing changed nothing; do not make open views refresh.
          if (linked && scope.visibility === "private") {
            runtime.live.invalidate();
          }
        }
      } catch (e) {
        // Reload or reassignment ends the whole pass; anything else is this store's failure.
        // SAFETY: the store runtime and storage client reject only with Error objects.
        if ((e as Error).message.includes("reloaded")) {
          throw e;
        }
        result.outcome = "failed";
        // SAFETY: the store runtime and storage client reject only with Error objects.
        result.message = (e as Error).message.slice(0, 1000);
      }
    }
    await this.stores.releaseIdle();
    const review = reviewJobId ? await this.review(reviewJobId, pending) : undefined;
    const run: MaintenanceRun = {
      trigger,
      slot: new Date(slot).toISOString(),
      startedAt,
      finishedAt: new Date().toISOString(),
      linked: vaults.reduce((n, v) => n + v.linked, 0),
      vaults: vaults.slice(0, 500),
      ...(review ? { review } : {}),
    };
    this.state.lastRun = run;
    await this.save();
    const failed = vaults.filter((v) => v.outcome === "failed");
    this.log[failed.length ? "warn" : "info"](
      `Knowledge maintenance (${trigger}): ${run.linked} claims linked across ${vaults.filter((v) => v.outcome === "ok").length} stores${failed.length ? `; ${failed.length} failed: ${failed.map((v) => `${v.label}: ${v.message}`).join("; ")}` : ""}${review ? `; review ${review.outcome} (${review.pending} unlinked)` : ""}.`,
    );
  }

  /** Count claims no page reaches in one partition, after relink. */
  private async unlinked(
    runtime: ReturnType<Stores["openMaintenance"]>["runtime"],
    access: ReturnType<Stores["openMaintenance"]>["access"],
  ) {
    let cursor: string | undefined,
      total = 0;
    do {
      const out: RelinkOutput = await runtime.enqueue(access.assertCurrent, () =>
        runtime.client.call("maintenanceRelink", access, {
          dryRun: true,
          include: "all",
          limit: RELINK_PAGE,
          ...(cursor ? { cursor } : {}),
        }),
      );
      total += out.scanned;
      cursor = out.nextCursor ?? undefined;
    } while (cursor);
    return total;
  }

  /**
   * The review automation for this pass: the configured `reviewJobId`, else the
   * job the review scribe declared. A disabled scribe job is still returned so
   * the pass reports it as skipped. No scheduler or no job means no review.
   */
  private async reviewJobId(): Promise<string | undefined> {
    const configured = this.stores.policy.maintenance.reviewJobId;
    if (configured) {
      return configured;
    }
    try {
      const jobs = (await this.getCron?.()?.list?.({ includeDisabled: true })) ?? [];
      const declared = jobs.filter((job) => job.declarationKey === REVIEW_SCRIBE_DECLARATION_KEY);
      return (declared.find((job) => job.enabled !== false) ?? declared[0])?.id;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.warn(`Knowledge maintenance could not look up the review scribe: ${reason}`);
      return undefined;
    }
  }

  /**
   * Hand the private claims relink left unlinked to the review automation, an
   * owner-delegated agent turn that follows the knowledge-unlinked-claims
   * skill. A disabled automation is not run.
   */
  private async review(jobId: string, pending: number): Promise<MaintenanceReview> {
    if (!pending) {
      return { jobId, pending, outcome: "not_needed" };
    }
    try {
      const cron = this.getCron?.();
      if (!cron?.enqueueRun) {
        return {
          jobId,
          pending,
          outcome: "unavailable",
          message: "The Gateway automation scheduler is not available to Knowledge.",
        };
      }
      const result = await cron.enqueueRun(jobId, "if-enabled");
      if (result.ok && "enqueued" in result) {
        return { jobId, pending, outcome: "enqueued", runId: result.runId };
      }
      return {
        jobId,
        pending,
        outcome: "skipped",
        message: result.ok
          ? `The automation did not run (${"reason" in result ? String(result.reason) : "not admitted"}).`
          : "The automation does not exist or cannot run.",
      };
    } catch (e) {
      // SAFETY: the host scheduler rejects only with Error objects.
      return { jobId, pending, outcome: "failed", message: (e as Error).message.slice(0, 1000) };
    }
  }

  status(): MaintenanceStatus {
    const { enabled, schedule, timezone } = this.stores.policy.maintenance;
    return {
      enabled,
      writesEnabled: this.stores.policy.writesEnabled,
      schedule,
      timezone,
      ...(this.configError ? { configError: this.configError } : {}),
      running: Boolean(this.running),
      nextRunAt:
        this.active && this.state.nextRunAt !== undefined
          ? new Date(this.state.nextRunAt).toISOString()
          : null,
      lastRun: this.state.lastRun ?? null,
      jobs: JOBS,
      reviewJobId: this.stores.policy.maintenance.reviewJobId ?? null,
    };
  }

  private async load(): Promise<State> {
    try {
      // SAFETY: each State field is validated below before use; null or a non-object throws into the catch.
      const raw = (await this.stores.registry.call("maintenance")) as State;
      return {
        ...(typeof raw.nextRunAt === "number" ? { nextRunAt: raw.nextRunAt } : {}),
        ...(raw.lastRun && Check(MaintenanceRun, raw.lastRun) ? { lastRun: raw.lastRun } : {}),
      };
    } catch {
      return {};
    }
  }
  /** Best effort: an unrecorded slot only costs a catch-up pass after restart. */
  private async save() {
    try {
      await this.stores.registry.call("maintenance", this.state);
    } catch (e) {
      // SAFETY: registry calls reject only with Error objects.
      this.log.warn(`Knowledge maintenance schedule was not recorded: ${(e as Error).message}`);
    }
  }
}
