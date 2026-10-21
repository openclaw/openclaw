import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorMock.spawn }),
}));

beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});

afterEach(() => resetProcessRegistryForTests());

function queueRun(output: string, overrides: Partial<ManagedRun>) {
  supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => ({
    ...runtimeManagedRun(input, output),
    ...overrides,
  }));
}

function createExecOperatorSource() {
  const controller = new AbortController();
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "exec-guest",
    scopes: ["operator.write"],
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    retain,
  });
  return { controller, authority, retain, release };
}

const execOptions = (command: string) => ({
  command,
  workdir: "/tmp",
  env: {},
  usePty: false,
  warnings: [],
  maxOutput: 1000,
  pendingMaxOutput: 1000,
  notifyOnExit: false,
  timeoutSec: null,
});
const caller = (source: ReturnType<typeof createExecOperatorSource>, sessionKey: string) => ({
  agentId: "main",
  sessionKey,
  operatorAuthority: source.authority,
});

it("retains the original operator source through background cancellation and finalization", async () => {
  const source = createExecOperatorSource();
  const turn = new AbortController();
  const guestExit = createDeferred<RunExit>();
  const staffExit = createDeferred<RunExit>();
  const cleanupStarted = createDeferred();
  const cleanup = createDeferred();
  const cancelGuest = vi.fn(() => {
    guestExit.resolve(createRunExit({ reason: "manual-cancel", exitCode: null }));
  });
  const cancelStaff = vi.fn();
  queueRun("saved guest output\n", {
    cancel: cancelGuest,
    wait: () => guestExit.promise,
    waitForExtinction: () => {
      cleanupStarted.resolve();
      return cleanup.promise;
    },
  });
  queueRun("independent output\n", { cancel: cancelStaff, wait: () => staffExit.promise });
  const guest = await withGatewayToolCallerIdentity(
    {
      ...caller(source, "agent:main:retained-exec"),
      receiptAuthority: () => !turn.signal.aborted,
    },
    () => runExecProcess({ ...execOptions("retained-source-command"), startupSignal: turn.signal }),
  );
  const staff = await runExecProcess(execOptions("retained-source-command"));
  markBackgrounded(guest.session);
  markBackgrounded(staff.session);
  try {
    turn.abort();
    guest.disableUpdates();
    expect(cancelGuest).not.toHaveBeenCalled();
    expect(guest.session.exited).toBe(false);

    source.controller.abort(new Error("original invitation revoked"));
    expect(cancelGuest).toHaveBeenCalledWith("manual-cancel");
    expect(cancelStaff).not.toHaveBeenCalled();
    await cleanupStarted.promise;
    expect(guest.session).toMatchObject({ finalizing: true, exited: false });
    expect(source.release).not.toHaveBeenCalled();

    expect(() => source.authority.assertCurrent()).toThrow("original invitation revoked");
    expect(staff.session.exited).toBe(false);
    cleanup.resolve();
    await expect(guest.promise).resolves.toMatchObject({
      status: "failed",
      exitReason: "manual-cancel",
      aggregated: expect.stringContaining("saved guest output"),
    });
    expect(source.retain).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
    staffExit.resolve(createRunExit());
    await expect(staff.promise).resolves.toMatchObject({ status: "completed" });
    expect(cancelStaff).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    guestExit.resolve(createRunExit());
    staffExit.resolve(createRunExit());
    await Promise.all([guest.promise, staff.promise]);
  }
});

it.each([false, true])(
  "releases the original operator source after startup failure=%s",
  async (fails) => {
    const source = createExecOperatorSource();
    const cancel = vi.fn();
    if (fails) {
      supervisorMock.spawn.mockRejectedValueOnce(new Error("process startup failed"));
    } else {
      queueRun("", { cancel });
    }
    const pending = withGatewayToolCallerIdentity(caller(source, "agent:main:source-release"), () =>
      runExecProcess(execOptions("source-release-command")),
    );
    if (fails) {
      await expect(pending).rejects.toThrow("process startup failed");
    } else {
      const run = await pending;
      await expect(run.promise).resolves.toMatchObject({ status: "completed" });
    }
    expect(source.retain).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
    source.controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  },
);
