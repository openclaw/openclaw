// Live-proof harness for PR #92037 (cron `on-exit` schedule kind).
//
// Drives the REAL gateway exit-watcher (`createCronExitWatchers`) against the
// REAL ProcessSupervisor (`getProcessSupervisor`) with a REAL short-lived child
// command, and captures the actual arm -> exit -> persist-before-fire -> fire
// lifecycle. The persistCompletion/fireOnExit sinks mirror the real wiring in
// server-cron.ts (disable-before-fire; force-run after exit) and only RECORD/LOG.
//
// Run: pnpm exec tsx scripts/proof-cron-on-exit.mts
//
// All identifiers are synthetic. No real Telegram chat ids / session keys.

import type { CronJob } from "../src/cron/types.js";
import {
  createCronExitWatchers,
  resolveExitWatchShell,
} from "../src/gateway/cron-exit-watchers.js";
import { getProcessSupervisor } from "../src/process/supervisor/index.js";

const isWin = process.platform === "win32";
// Commands phrased for the shell the watcher actually resolves on this host
// (cmd.exe /d /s /c on Windows, bash -lc on POSIX).
const delayThenExit = (code: number) =>
  isWin ? `ping -n 3 127.0.0.1 > nul & exit ${code}` : `sleep 2; exit ${code}`;
const longRunning = () => (isWin ? `ping -n 31 127.0.0.1 > nul` : `sleep 30`);

type FireEvent = { jobId: string; exitCode: number | null };

const events: { armed: string[]; persisted: string[]; fired: FireEvent[] } = {
  armed: [],
  persisted: [],
  fired: [],
};
// Monotonic call-order log so we can assert persist-before-fire directly
// (the watcher's fail-closed guarantee), not merely that both happened.
const order: string[] = [];

const logger = {
  info: (obj: unknown, msg?: string) => {
    const o = obj as { jobId?: string; exitCode?: number | null; reason?: string };
    if (msg?.includes("watcher armed") && o.jobId) {
      events.armed.push(o.jobId);
    }
    console.log(`[cron-exit] ${msg ?? ""}  ${JSON.stringify(obj)}`);
  },
  warn: (obj: unknown, msg?: string) =>
    console.log(`[cron-exit][warn] ${msg ?? ""}  ${JSON.stringify(obj)}`),
};

const watchers = createCronExitWatchers({
  getProcessSupervisor,
  // Real wiring disables the one-shot job in the store before firing.
  persistCompletion: async (jobId) => {
    events.persisted.push(jobId);
    order.push(`persist:${jobId}`);
    console.log(`[cron-exit] persistCompletion (job disabled, enabled=false) jobId=${jobId}`);
  },
  // Real wiring routes this into cron.run(job.id, "force").
  fireOnExit: (job, exit) => {
    events.fired.push({ jobId: job.id, exitCode: exit.exitCode });
    order.push(`fire:${job.id}`);
    console.log(`[gateway/cron] cron.run force jobId=${job.id}`);
  },
  logger,
});

function onExitJob(id: string, command: string, extra?: Partial<CronJob>): CronJob {
  return {
    id,
    enabled: true,
    schedule: { kind: "on-exit", command },
    sessionKey: `agent:main:telegram:direct:SYN:thread:SYN`,
    payload: { text: `on-exit[${id}]` },
    ...extra,
  } as unknown as CronJob;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });
async function waitFor(pred: () => boolean, timeoutMs: number, pollMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) {
      return true;
    }
    await sleep(pollMs);
  }
  return pred();
}

let failures = 0;
function assert(label: string, cond: boolean): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) {
    failures++;
  }
}

async function run(): Promise<void> {
  const shell = resolveExitWatchShell();
  console.log(`=== PR #92037 on-exit live proof (real watcher + real ProcessSupervisor) ===`);
  console.log(
    `platform=${process.platform} shell=${shell.command} argv=${JSON.stringify(shell.argsFor("<cmd>"))}`,
  );

  // Scenario A: arm a real watcher; the watched command runs ~2s then exits 7.
  // Expect: armed -> exited -> persistCompletion BEFORE fire -> fire with exitCode 7.
  console.log(`\n=== A. arm -> watched command exits (code 7) -> force-run fires ===`);
  const a = onExitJob("onexit-A", delayThenExit(7));
  watchers.reconcile([a]);
  assert(
    "watcher is active immediately after reconcile",
    watchers.activeJobIds().includes("onexit-A"),
  );
  const aFired = await waitFor(() => events.fired.some((e) => e.jobId === "onexit-A"), 15000);
  assert("watcher armed (logged) for onexit-A", events.armed.includes("onexit-A"));
  assert("job fired after the command exited", aFired);
  const aEvt = events.fired.find((e) => e.jobId === "onexit-A");
  assert("exit code 7 captured from the real child", aEvt?.exitCode === 7);
  assert(
    "persistCompletion ran BEFORE fire (fail-closed ordering)",
    order.includes("persist:onexit-A") &&
      order.indexOf("persist:onexit-A") < order.indexOf("fire:onexit-A"),
  );
  assert("fire routed to the cron force-run sink", aEvt?.jobId === a.id);

  // Scenario B: arm a long-running watcher, cancel before exit -> NO fire.
  console.log(`\n=== B. arm -> cancel before exit -> no fire (revocation) ===`);
  const b = onExitJob("onexit-B", longRunning());
  watchers.reconcile([b]);
  await waitFor(() => events.armed.includes("onexit-B"), 8000);
  assert("watcher armed for onexit-B", events.armed.includes("onexit-B"));
  watchers.cancel("onexit-B");
  assert(
    "watcher removed from active set after cancel",
    !watchers.activeJobIds().includes("onexit-B"),
  );
  await sleep(2500);
  assert("cancelled watcher never fired", !events.fired.some((e) => e.jobId === "onexit-B"));

  // Scenario C: reconcile without the job cancels its watcher.
  console.log(`\n=== C. reconcile-removal cancels the watcher ===`);
  const c = onExitJob("onexit-C", longRunning());
  watchers.reconcile([c]);
  await waitFor(() => watchers.activeJobIds().includes("onexit-C"), 8000);
  assert("watcher active for onexit-C", watchers.activeJobIds().includes("onexit-C"));
  watchers.reconcile([]); // job gone
  assert("reconcile([]) cancelled onexit-C", !watchers.activeJobIds().includes("onexit-C"));
}

async function main(): Promise<void> {
  try {
    await run();
  } finally {
    // Always tear down watchers so a thrown assertion can't leak the
    // long-running ping/sleep children (B, C) until their 24h timeout.
    watchers.cancelAll();
    await sleep(300);
  }
  console.log(`\n=== RESULT: ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("proof harness crashed:", err);
  watchers.cancelAll();
  process.exit(1);
});
