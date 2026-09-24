import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { z } from "zod";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  isDeadProcessState,
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

// Startup tolerates transient host load; signal containment retains its shorter budget.
const PROCESS_REGISTRATION_INSPECTION_MS = 10_000;

const processIdentity = z.object({
  pid: z.number().int().positive().safe(),
  pgid: z.number().int().positive().safe(),
  startedAt: z.string().min(1).max(64),
});
const childIdentity = processIdentity.extend({
  // Durable rows hold only a digest: appServer.args is operator-configurable and
  // may carry secrets, matching the spawn-identity argsFingerprint precedent.
  // Unreleased dev/nightly rows stay reapable with identity-only authority instead
  // of blocking spawns. Require the fingerprint at the next natural schema touch.
  commandFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const registrationSchema = z.object({ parent: processIdentity, child: childIdentity }).strict();
type ProcessRegistration = z.infer<typeof registrationSchema>;
const registrationCleanup = new WeakMap<object, Promise<void>>();
// Source and dist copies must not stop or resume the same orphan concurrently.
const processReaper = resolveGlobalSingleton(
  Symbol.for("openclaw.codexAppServerProcessReaper"),
  () => new KeyedAsyncQueue(),
);

/** Join bookkeeping after the transport owner has observed physical exit. */
export async function waitForCodexAppServerProcessRegistrationCleanup(
  child: object,
): Promise<void> {
  await registrationCleanup.get(child);
}

function fingerprintProcessCommand(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

async function openProcessRegistrationStore() {
  const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir() };
  const { createPluginStateKeyedStore } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  return createPluginStateKeyedStore<ProcessRegistration>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    // Expiration or eviction could forget a child that still owns a native turn.
    overflowPolicy: "reject-new",
    env,
  });
}

async function reapRegisteredCodexAppServerOrphans() {
  const store = await openProcessRegistrationStore();
  // Reread each caller's store after prior cleanup settles; never cache success
  // across registration changes or let a failed boot sweep poison a new turn.
  await processReaper.enqueue("orphans", () => sweepRegisteredCodexAppServerOrphans(store));
  return store;
}

async function sweepRegisteredCodexAppServerOrphans(
  store: Awaited<ReturnType<typeof openProcessRegistrationStore>>,
): Promise<void> {
  // Loading durable registrations can include cold database-worker startup.
  const entries = await store.entries();
  const deadline = Date.now() + PROCESS_REGISTRATION_INSPECTION_MS;
  for (const entry of entries) {
    if (Date.now() >= deadline) {
      throw new Error("Codex orphan cleanup exceeded its startup budget. Retry to finish cleanup.");
    }
    const registration = registrationSchema.parse(entry.value);
    const snapshot = await readCodexAppServerProcessSnapshot(deadline, [
      registration.parent.pid,
      registration.child.pid,
    ]);
    const parent = snapshot.find((row) => row.pid === registration.parent.pid);
    if (parent?.startedAt === registration.parent.startedAt && !isDeadProcessState(parent.state)) {
      continue;
    }
    const child = snapshot.find((row) => row.pid === registration.child.pid);
    if (
      registration.child.commandFingerprint !== undefined &&
      child?.startedAt === registration.child.startedAt &&
      !isDeadProcessState(child.state)
    ) {
      let command: string | undefined;
      try {
        command = await readCodexAppServerProcessCommand(child, deadline);
      } catch (error) {
        // A matching live process still needs its command verified before containment.
        const current = (
          await readCodexAppServerProcessSnapshot(deadline, [registration.child.pid])
        ).find((row) => row.pid === registration.child.pid);
        if (
          current?.startedAt === registration.child.startedAt &&
          !isDeadProcessState(current.state)
        ) {
          throw error;
        }
      }
      if (
        command !== undefined &&
        fingerprintProcessCommand(command) !== registration.child.commandFingerprint
      ) {
        // macOS lstart has second granularity: a replacement can inherit pid +
        // startedAt. A different command revokes kill authority; Linux already
        // uses tick-granular start identities.
        await store.delete(entry.key);
        continue;
      }
    }
    if (!(await terminateCodexAppServerOrphan(registration.child))) {
      throw new Error(
        `Cannot reap registered Codex process ${registration.child.pid}. Stop it before retrying.`,
      );
    }
    await store.delete(entry.key);
  }
}

export function createCodexAppServerProcessReaperService(): OpenClawPluginService {
  let pendingSweep: Promise<void> | undefined;
  return {
    id: "codex-app-server-process-reaper",
    start(ctx) {
      if (process.platform === "win32") {
        return;
      }
      // Boot cleanup is best-effort promptness. The before-spawn check remains
      // authoritative and fails closed without delaying Gateway startup.
      pendingSweep = (async () => {
        try {
          await reapRegisteredCodexAppServerOrphans();
        } catch (error) {
          ctx.logger.warn(`Codex app-server orphan cleanup failed: ${String(error)}`);
        }
      })();
    },
    async stop() {
      await pendingSweep;
    },
  };
}

/** Reap previous owners before spawn; commit this child's identity before initialization. */
export async function prepareCodexAppServerProcessRegistration(): Promise<
  (child: ChildProcessWithoutNullStreams) => Promise<void>
> {
  if (process.platform === "win32") {
    return async (child) => {
      await once(child, "spawn");
    };
  }
  const store = await reapRegisteredCodexAppServerOrphans();
  return async (child) => {
    await once(child, "spawn");
    if (!child.pid) {
      throw new ProcessInspectionError("unavailable");
    }
    const deadline = Date.now() + PROCESS_REGISTRATION_INSPECTION_MS;
    const snapshot = await readCodexAppServerProcessSnapshot(deadline, [child.pid]);
    const parent = snapshot.find((row) => row.pid === process.pid);
    const spawned = snapshot.find((row) => row.pid === child.pid);
    if (!parent || !spawned || spawned.ppid !== process.pid) {
      throw new Error(
        "Cannot register the Codex child process: its direct-parent identity is unavailable. Retry.",
      );
    }
    const command = await readCodexAppServerProcessCommand(spawned, deadline);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "Cannot register the Codex child process command: the child exited during inspection. Retry.",
      );
    }
    const key = randomUUID();
    const value = {
      parent: processIdentity.parse(parent),
      child: childIdentity.parse({
        ...spawned,
        commandFingerprint: fingerprintProcessCommand(command),
      }),
    };
    // Observe exit before yielding to the database worker. Deletion must follow
    // insertion settlement even when the child exits while admission is queued.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const registered = store.register(key, value);
    const cleanup = (async () => {
      await exited;
      await registered.catch(() => undefined);
      try {
        await store.delete(key);
      } catch {
        // Leave the durable fact for the next connection to verify and remove.
      }
    })();
    registrationCleanup.set(child, cleanup);
    // Codex rejects non-initialize requests; no native turn can start before
    // this commit. A failed commit closes the uninitialized child.
    await registered;
    if (child.exitCode !== null || child.signalCode !== null) {
      await cleanup;
      throw new Error(
        "Cannot register the Codex child process: the child exited during registration. Retry.",
      );
    }
  };
}
