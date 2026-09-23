import assert from "node:assert/strict";
import test from "node:test";
import { withTelegramRun } from "./telegram-run-scope.mjs";
import { prepareTelegramTestGroup } from "./telegram-test-group.mjs";

function fixture({ cleanupFails = false } = {}) {
  const events = [];
  const credential = {
    groupId: "-1001",
    driverEnv: {},
    whenLeaseUnhealthy: new Promise(() => {}),
    assertLeaseHealthy() {},
    async release() {
      events.push("credential-released");
    },
  };
  return {
    events,
    credential,
    async runCommandImpl(_command, args) {
      const cleanup = args.includes("cleanup-group");
      events.push(cleanup ? "group-cleanup" : "group-created");
      if (cleanup && cleanupFails) return { status: 1, stderr: "deletion denied", timedOut: false };
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          groupId: "-2042",
          status: cleanup ? "deleted" : "created",
        }),
        timedOut: false,
      };
    },
  };
}

test("owned group replaces the unusable shared group and is deleted before lease release", async () => {
  const f = fixture();
  await withTelegramRun(async (scope) => {
    const credential = await scope.acquire(Promise.resolve(f.credential));
    scope.observeLease(credential);
    await prepareTelegramTestGroup(credential, f);
    assert.equal(credential.groupId, "-2042");
    assert.equal(credential.driverEnv.TELEGRAM_USER_DRIVER_CHAT_ID, "-2042");
  });
  assert.deepEqual(f.events, ["group-created", "group-cleanup", "credential-released"]);
  assert.equal(f.credential.testGroup.cleanup.status, "deleted");
});

test("a later readiness failure still deletes the created group before release", async () => {
  const f = fixture();
  await assert.rejects(
    withTelegramRun(async (scope) => {
      scope.observeLease(await scope.acquire(Promise.resolve(f.credential)));
      await prepareTelegramTestGroup(f.credential, f);
      throw new Error("membership rejected");
    }),
    /membership rejected/,
  );
  assert.deepEqual(f.events, ["group-created", "group-cleanup", "credential-released"]);
});

test("failed group cleanup retains the credential instead of releasing usable authority", async () => {
  const f = fixture({ cleanupFails: true });
  await assert.rejects(
    withTelegramRun(async (scope) => {
      scope.observeLease(await scope.acquire(Promise.resolve(f.credential)));
      await prepareTelegramTestGroup(f.credential, f);
    }),
    /Telegram final cleanup failed/,
  );
  assert.deepEqual(f.events, ["group-created", "group-cleanup"]);
  assert.equal(f.credential.testGroup.cleanup.status, "failed");
});

test("revoked authority prevents cleanup requests and retains the owned group evidence", async () => {
  const f = fixture();
  await assert.rejects(
    withTelegramRun(async (scope) => {
      scope.observeLease(await scope.acquire(Promise.resolve(f.credential)));
      await prepareTelegramTestGroup(f.credential, f);
      f.credential.assertLeaseHealthy = () => {
        throw new Error("lease revoked");
      };
    }),
    /Telegram final cleanup failed/,
  );
  assert.deepEqual(f.events, ["group-created"]);
  assert.equal(f.credential.testGroup.setup.groupId, "-2042");
});
