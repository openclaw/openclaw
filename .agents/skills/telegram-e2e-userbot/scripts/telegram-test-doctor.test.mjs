import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runTelegramTestDoctor } from "./telegram-test-doctor.mjs";

async function doctor({ lease = {}, ...options } = {}) {
  let released = 0;
  const credential = {
    driverEnv: {},
    groupId: "-1001",
    sutBotId: "42",
    sutToken: "synthetic-token",
    sutUsername: "sut_bot",
    tdlibVersion: "1.8.67",
    testerUserId: "123",
    whenLeaseUnhealthy: new Promise(() => {}),
    assertLeaseHealthy() {},
    ...lease,
    async release() {
      released++;
    },
  };
  try {
    return await runTelegramTestDoctor({ acquireCredential: async () => credential, ...options });
  } finally {
    assert.equal(released, 1);
  }
}

const ready = () => ({
  status: 0,
  stdout: JSON.stringify({
    ok: true,
    authorized: true,
    testDc: true,
    tdlibVersion: "1.8.67",
    user: { id: 123 },
    chatId: -1001,
  }),
});
const bot = { ok: true, result: { id: 42, username: "sut_bot" } };
function failure(status, stderr = "", timedOut = false) {
  return { status, stdout: "", stderr, timedOut };
}

test("doctor verifies the leased user and bot directly without a local listener", async (context) => {
  context.mock.method(http.Server.prototype, "listen", () => {
    throw new Error("readiness must not start a local Bot API adapter");
  });
  const result = await doctor({
    runCommandImpl: async () => ready(),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.telegram.org/botsynthetic-token/test/getMe");
      assert.ok(init.signal instanceof AbortSignal);
      init.signal.throwIfAborted();
      return Response.json(bot);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.botApiTransport, "direct-https");
  assert.equal(result.botApiProxy, false);
});

test("doctor revocation after getMe prevents later Bot API calls and releases", async () => {
  const leaseError = new Error("doctor lease revoked");
  let healthy = true;
  let revoke;
  const methods = [];
  let statusArgs;
  const whenLeaseUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve(leaseError);
    };
  });
  const fetchImpl = async (url) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    return {
      ok: true,
      json: async () => {
        revoke();
        return { ...bot, result: { ...bot.result, can_read_all_group_messages: true } };
      },
    };
  };

  await assert.rejects(
    doctor({
      dm: false,
      lease: {
        whenLeaseUnhealthy,
        assertLeaseHealthy: () => {
          if (!healthy) {
            throw leaseError;
          }
        },
      },
      fetchImpl,
      runCommandImpl: async (_command, args) => {
        statusArgs = args;
        return ready();
      },
    }),
    (error) => error === leaseError,
  );
  assert.deepEqual(methods, ["getMe"]);
  assert.deepEqual(statusArgs.slice(-2), ["--require-chat", "-1001"]);
});

for (const [name, result, missingGroup = false] of [
  ["unrestorable configured group", failure(1, "[credential_state_missing_group]"), true],
  ["launcher failure", failure(null, "spawn uv ENOENT")],
  ["timeout", failure(1, "", true)],
  ["unrelated TDLib failure", failure(1, "Timed out waiting for getMe")],
]) {
  test(`doctor diagnoses ${name} and releases the credential`, async () => {
    await assert.rejects(
      doctor({
        dm: false,
        runCommandImpl: async () => result,
        fetchImpl: async () => assert.fail("failed TDLib readiness must not reach the Bot API"),
      }),
      (error) => {
        assert.equal(/Disable and republish/u.test(error.message), missingGroup);
        if (missingGroup) {
          assert.match(error.message, /Disable and republish this credential/u);
        } else {
          assert.match(error.message, /Check the existing uv launcher and TDLib runtime/u);
        }
        return true;
      },
    );
  });
}
