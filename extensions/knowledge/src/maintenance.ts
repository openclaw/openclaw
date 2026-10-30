import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { Check } from "typebox/value";
import { nextRun, parseCron, type Cron } from "./cron.js";
import {
  MaintenanceRun,
  type MaintenanceStatus,
  type MaintenanceVault,
} from "./maintenance-contract.js";
import type { RelinkOutput } from "./relink-contract.js";
import type { Stores } from "./stores.js";

type Logger = { info(message: string): void; warn(message: string): void };
type State = { nextRunAt?: number; lastRun?: MaintenanceRun };
/** Jobs in one pass, in order. Each is zero-LLM and bounded per call. */
const JOBS = ["relink"];
const RELINK_PAGE = 500;
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

  /** Arm the schedule for this service lifetime. */
  async start(scheduler: PluginServiceSchedulerV1) {
    this.scheduler = scheduler;
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
      epoch = this.stores.incarnation;
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
    const run: MaintenanceRun = {
      trigger,
      slot: new Date(slot).toISOString(),
      startedAt,
      finishedAt: new Date().toISOString(),
      linked: vaults.reduce((n, v) => n + v.linked, 0),
      vaults: vaults.slice(0, 500),
    };
    this.state.lastRun = run;
    await this.save();
    const failed = vaults.filter((v) => v.outcome === "failed");
    this.log[failed.length ? "warn" : "info"](
      `Knowledge maintenance (${trigger}): ${run.linked} claims linked across ${vaults.filter((v) => v.outcome === "ok").length} stores${failed.length ? `; ${failed.length} failed: ${failed.map((v) => `${v.label}: ${v.message}`).join("; ")}` : ""}.`,
    );
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
