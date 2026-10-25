import { randomUUID } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { SandboxBackendCommandResult } from "openclaw/plugin-sdk/sandbox";
import type { CloudRunConfig } from "./config.js";
import type { Mount } from "./filesystem.js";
import { buildNativeCommandSpec, invoke, type Invoke } from "./native.js";

export type GuestRecord = { runtimeId: string; guestId: string; phase: "creating" | "ready" };
export type GuestJournal = Pick<
  PluginStateKeyedStore<GuestRecord>,
  "register" | "delete" | "entries"
>;
function requireSuccess(result: SandboxBackendCommandResult, action: string) {
  if (result.code !== 0) {
    throw new Error(
      "Cloud Run sandbox " + action + " failed: " + result.stderr.toString("utf8").slice(-2000),
    );
  }
}
export function assertRecord(record: GuestRecord) {
  if (
    !/^oc-cr-[0-9a-f-]{36}$/.test(record.runtimeId) ||
    !/^oc-exec-[0-9a-f-]{36}$/.test(record.guestId) ||
    !["creating", "ready"].includes(record.phase)
  ) {
    throw new Error("Invalid Cloud Run guest cleanup record; refusing to guess ownership");
  }
}

/** Core owns runtime generations; this journal owns their exact external children. */
export class GuestOwner {
  readonly active = new Map<string, Guest>();
  private recovered?: Promise<void>;
  private stopped = false;
  constructor(
    readonly journal: GuestJournal,
    readonly run: Invoke = invoke,
  ) {}

  assertActive() {
    if (this.stopped) {
      throw new Error("Cloud Run sandbox plugin is stopping");
    }
  }
  async recover() {
    this.assertActive();
    this.recovered ??= this.recoverRecords();
    await this.recovered;
    this.assertActive();
  }
  private async recoverRecords(runtimeId?: string, attempted = new Set<string>()) {
    const errors: unknown[] = [];
    for (const { key, value } of await this.journal.entries()) {
      if (attempted.has(key)) {
        continue;
      }
      try {
        assertRecord(value);
        if (key !== value.guestId) {
          throw new Error("Cloud Run guest journal key mismatch");
        }
        if (runtimeId && value.runtimeId !== runtimeId) {
          continue;
        }
        const live = this.active.get(key);
        if (live) {
          await live.close();
          continue;
        }
        await this.deleteGuest(value);
        // Absence after one delete cannot rule out an unacknowledged late create.
        if (value.phase === "creating") {
          throw new Error(
            "Unsettled Cloud Run guest creation: " +
              key +
              "; restart the enclosing Cloud Run container before reconciling its receipt",
          );
        }
        await this.journal.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, errors.map(String).join("; "));
    }
  }
  async deleteGuest(record: GuestRecord) {
    assertRecord(record);
    requireSuccess(
      await this.run(["delete", "--force", record.guestId], {
        signal: AbortSignal.timeout(30_000),
      }),
      "delete",
    );
  }
  guest(runtimeId: string, assertCurrent: () => void) {
    this.assertActive();
    const guest = new Guest(
      this,
      { runtimeId, guestId: "oc-exec-" + randomUUID(), phase: "creating" },
      assertCurrent,
    );
    this.active.set(guest.record.guestId, guest);
    return guest;
  }
  async removeRuntime(runtimeId: string) {
    const attempted = new Set<string>();
    const errors: unknown[] = [];
    for (const guest of this.active.values()) {
      if (guest.record.runtimeId !== runtimeId) {
        continue;
      }
      attempted.add(guest.record.guestId);
      try {
        await guest.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.recoverRecords(runtimeId, attempted);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "Cloud Run runtime cleanup incomplete");
    }
  }
  async stop() {
    this.stopped = true;
    const outcomes = await Promise.allSettled(
      [...this.active.values()].map((guest) => guest.close()),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "Cloud Run guest cleanup failed");
    }
  }
}

export class Guest {
  private creating?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private journaled = false;
  private launchAttempted = false;
  constructor(
    readonly owner: GuestOwner,
    readonly record: GuestRecord,
    private readonly authority: () => void,
  ) {}
  assertCurrent = () => {
    this.owner.assertActive();
    this.authority();
    if (this.stopped) {
      throw new Error("Cloud Run guest execution has ended");
    }
  };
  async create(config: CloudRunConfig, rootfs: string, mounts: Mount[]) {
    this.assertCurrent();
    this.creating ??= this.createInner(config, rootfs, mounts);
    try {
      await this.creating;
      this.assertCurrent();
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Cloud Run creation and cleanup failed", {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }
  private async createInner(config: CloudRunConfig, rootfs: string, mounts: Mount[]) {
    await this.owner.recover();
    this.assertCurrent();
    await this.owner.journal.register(this.record.guestId, this.record, {
      assertCurrent: this.assertCurrent,
    });
    this.journaled = true;
    this.assertCurrent();
    this.launchAttempted = true;
    requireSuccess(
      await this.owner.run(
        [
          "run",
          this.record.guestId,
          "--detach",
          "--rootfs=" + rootfs,
          "--write",
          ...(config.allowEgress ? ["--allow-egress"] : []),
          ...mounts.flatMap((mount) => [
            "--mount",
            "type=bind,source=" +
              mount.hostPath +
              ",destination=" +
              mount.containerPath +
              (mount.readOnly ? ",readonly" : ""),
          ]),
          "--",
          "/bin/sleep",
          String(config.guestLifetimeSeconds),
        ],
        { signal: AbortSignal.timeout(30_000) },
      ),
      "create",
    );
    this.record.phase = "ready";
    // Termination custody owns this receipt even when user execution was revoked.
    await this.owner.journal.register(this.record.guestId, this.record);
  }
  execSpec(command: string[]) {
    this.assertCurrent();
    return {
      ...buildNativeCommandSpec(["exec", this.record.guestId, "--", ...command]),
      assertCurrent: this.assertCurrent,
    };
  }
  async exec(command: string[], options: { stdin?: Buffer | string; signal?: AbortSignal } = {}) {
    this.assertCurrent();
    options.signal?.throwIfAborted();
    return await this.owner.run(["exec", this.record.guestId, "--", ...command], options);
  }
  close(): Promise<void> {
    this.stopped = true;
    this.closing ??= this.closeInner().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
  private async closeInner() {
    // Never race delete against a still-pending successful creation.
    await this.creating?.catch(() => undefined);
    if (this.launchAttempted) {
      await this.owner.deleteGuest(this.record);
      if (this.record.phase !== "ready") {
        throw new Error(
          "Cloud Run create did not settle; cleanup receipt retained for " + this.record.guestId,
        );
      }
    }
    if (this.journaled) {
      await this.owner.journal.delete(this.record.guestId);
    }
    this.owner.active.delete(this.record.guestId);
  }
}
