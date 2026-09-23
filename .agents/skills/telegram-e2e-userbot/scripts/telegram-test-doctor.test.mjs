import assert from "node:assert/strict";
import test from "node:test";
import { runTelegramTestDoctor } from "./telegram-test-doctor.mjs";

test("doctor revocation after getMe prevents later Bot API calls and releases", async () => {
  const leaseError = new Error("doctor lease revoked");
  let healthy = true;
  let revoke;
  let released = false;
  let proxyClosed = false;
  const methods = [];
  let statusArgs;
  const whenLeaseUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve(leaseError);
    };
  });
  const credential = {
    driverEnv: {},
    groupId: "-1001",
    sutBotId: "42",
    sutToken: "sut-token",
    sutUsername: "sut_bot",
    tdlibVersion: "1.8.56",
    testerUserId: "123",
    whenLeaseUnhealthy,
    assertLeaseHealthy: () => {
      if (!healthy) throw leaseError;
    },
    release: async () => {
      released = true;
    },
  };
  const fetchImpl = async (url) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    return {
      ok: true,
      status: 200,
      json: async () => {
        revoke();
        return {
          ok: true,
          result: {
            id: 42,
            username: "sut_bot",
            can_read_all_group_messages: true,
          },
        };
      },
    };
  };

  await assert.rejects(
    runTelegramTestDoctor({
      dm: false,
      acquireCredential: async () => credential,
      fetchImpl,
      runCommandImpl: async (_command, args) => {
        statusArgs = args;
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            authorized: true,
            testDc: true,
            tdlibVersion: "1.8.56",
            user: { id: 123 },
            chatId: -1001,
          }),
          stderr: "",
          timedOut: false,
        };
      },
      startProxy: async () => ({
        apiRoot: "http://127.0.0.1:19881",
        close: async () => {
          proxyClosed = true;
        },
      }),
    }),
    (error) => error === leaseError,
  );
  assert.deepEqual(methods, ["getMe"]);
  assert.deepEqual(statusArgs.slice(-2), ["--require-chat", "-1001"]);
  assert.equal(proxyClosed, true);
  assert.equal(released, true);
});

test("doctor rejects a credential whose configured group cannot be restored", async () => {
  let released = false;
  const credential = {
    driverEnv: {},
    groupId: "-1001",
    whenLeaseUnhealthy: new Promise(() => {}),
    assertLeaseHealthy: () => {},
    release: async () => {
      released = true;
    },
  };

  await assert.rejects(
    runTelegramTestDoctor({
      dm: false,
      acquireCredential: async () => credential,
      runCommandImpl: async () => ({
        status: 1,
        stdout: "",
        stderr:
          "[credential_state_missing_group] Chat -1001 could not be restored within the credential readiness boundary.",
        timedOut: false,
      }),
      startProxy: async () => {
        throw new Error("proxy must not start for an invalid credential");
      },
    }),
    /Disable and republish this credential/u,
  );
  assert.equal(released, true);
});

for (const [name, result] of [
  ["launcher failure", { status: null, stdout: "", stderr: "spawn uv ENOENT", timedOut: false }],
  ["timeout", { status: 1, stdout: "", stderr: "", timedOut: true }],
  [
    "unrelated TDLib failure",
    { status: 1, stdout: "", stderr: "Timed out waiting for getMe", timedOut: false },
  ],
]) {
  test(`doctor preserves ${name} as a runtime diagnostic`, async () => {
    const credential = {
      driverEnv: {},
      groupId: "-1001",
      whenLeaseUnhealthy: new Promise(() => {}),
      assertLeaseHealthy: () => {},
      release: async () => {},
    };

    await assert.rejects(
      runTelegramTestDoctor({
        dm: false,
        acquireCredential: async () => credential,
        runCommandImpl: async () => result,
        startProxy: async () => {
          throw new Error("proxy must not start after TDLib readiness failure");
        },
      }),
      (error) =>
        /Check the existing uv launcher and TDLib runtime/u.test(error.message) &&
        !/Disable and republish/u.test(error.message),
    );
  });
}
