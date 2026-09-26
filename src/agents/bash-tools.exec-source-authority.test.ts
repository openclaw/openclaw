import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RunExit, SpawnInput } from "../process/supervisor/types.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createRunExit, runtimeManagedRun } from "./bash-tools.exec-runtime.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorMock.spawn }),
}));

let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

beforeAll(async () => {
  ({ markBackgrounded } = await import("./bash-process-registry.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

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

describe("registered exec source authority", () => {
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
    supervisorMock.spawn
      .mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, "saved guest output\n"),
        cancel: cancelGuest,
        wait: () => guestExit.promise,
        waitForExtinction: () => {
          cleanupStarted.resolve();
          return cleanup.promise;
        },
      }))
      .mockImplementationOnce(async (input: SpawnInput) => ({
        ...runtimeManagedRun(input, "independent output\n"),
        cancel: cancelStaff,
        wait: () => staffExit.promise,
      }));
    const options = {
      command: "retained-source-command",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      timeoutSec: null,
    };
    const guest = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:retained-exec",
        operatorAuthority: source.authority,
        receiptAuthority: () => !turn.signal.aborted,
      },
      () => runExecProcess({ ...options, startupSignal: turn.signal }),
    );
    const staff = await runExecProcess(options);
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
      expect(guest.session.finalizing).toBe(true);
      expect(guest.session.exited).toBe(false);
      expect(source.release).not.toHaveBeenCalled();

      const replacement = createExecOperatorSource();
      expect(() => replacement.authority.assertCurrent()).not.toThrow();
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
      supervisorMock.spawn.mockImplementationOnce(async (input: SpawnInput) => {
        if (fails) {
          throw new Error("process startup failed");
        }
        return { ...runtimeManagedRun(input), cancel };
      });
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:source-release",
          operatorAuthority: source.authority,
        },
        () =>
          runExecProcess({
            command: "source-release-command",
            workdir: "/tmp",
            env: {},
            usePty: false,
            warnings: [],
            maxOutput: 1000,
            pendingMaxOutput: 1000,
            notifyOnExit: false,
            timeoutSec: null,
          }),
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
});
