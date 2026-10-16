import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { runAuthProfileUsage } from "./usage-lifecycle.js";

it.each([false, true])(
  "retains accepted maintenance bookkeeping while checking current authority (revoked=%s)",
  async (revoke) => {
    const release = createDeferred();
    let revoked = false;
    const resources = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent() {
        if (revoked) {
          throw new Error("Bookkeeping authority revoked");
        }
      },
    });
    const retire = vi.fn();
    resources.own({}, "shared-handles", retire);
    let bookkeeping: Promise<void> | undefined;
    resources.run(() => {
      bookkeeping = runAuthProfileUsage(async () => {
        await release.promise;
        resources.assertAdmission();
      });
    });
    const settled = Promise.allSettled([bookkeeping]);
    const closing = resources.close();
    try {
      expect(() => resources.run(() => {})).toThrow("admission is closed");
      expect(retire).not.toHaveBeenCalled();
      revoked = revoke;
    } finally {
      release.resolve();
      await closing;
    }
    expect(retire).toHaveBeenCalledOnce();
    expect(await settled).toEqual([
      revoke
        ? { status: "rejected", reason: new Error("Bookkeeping authority revoked") }
        : { status: "fulfilled", value: undefined },
    ]);
  },
);
