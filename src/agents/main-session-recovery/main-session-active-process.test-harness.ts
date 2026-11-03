import path from "node:path";
import { expect, it } from "vitest";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  readStore,
  runningSessionEntry,
  type createRestartRecoveryStoreFixture,
} from "./main-session-restart-recovery-fixture.test-support.js";
import type { recoverRestartAbortedMainSessions as recover } from "./main-session-restart-recovery.js";

type StoreFixture = ReturnType<typeof createRestartRecoveryStoreFixture>;
type RecoveryParams = Omit<Parameters<typeof recover>[0], "gatewayRuntime"> & {
  gatewayRuntime?: GatewayRecoveryRuntime;
};

export function registerActiveProcessRecoveryCases({
  getStateDir,
  makeSessionsDir,
  writeStore,
  writeTranscript,
  recoverRestartAbortedMainSessions,
}: {
  getStateDir: () => string;
  makeSessionsDir: StoreFixture["makeSessionsDir"];
  writeStore: StoreFixture["writeStore"];
  writeTranscript: StoreFixture["writeTranscript"];
  recoverRestartAbortedMainSessions: (params: RecoveryParams) => ReturnType<typeof recover>;
}): void {
  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        ...runningSessionEntry("active-key-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        ...runningSessionEntry("active-id-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        ...runningSessionEntry("recoverable-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "active-key-session", [
      { role: "user", content: "new run owns this key" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "active-id-session", [
      { role: "user", content: "new run owns this id" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "recoverable-session", [
      { role: "user", content: "recover this one" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: getStateDir(),
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 2 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        ...runningSessionEntry("stale-session", { status: "interrupted" }),
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "stale-session", [
      { role: "user", content: "recover the stale duplicate" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: getStateDir(),
      activeSessionKeys: ["agent:main:main"],
      activeSessionIds: ["new-current-session"],
    });

    expect(result).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });
}
