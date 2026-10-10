import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { withTelegramRun } from "./telegram-run-scope.mjs";
import { telegramPythonArgs } from "./telegram-runtime.mjs";

const USER_DRIVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-driver.py");

// Runs one run-owned fixture's driver setup and chains its cleanup ahead of the
// credential release, so every exit path deletes it under the same lease.
async function ownTelegramFixture(
  credential,
  { kind, evidenceKey, prepare, cleanup, runCommandImpl },
) {
  const evidence = { setup: { status: "started" }, cleanup: { status: "pending" } };
  credential[evidenceKey] = evidence;
  const releaseCredential = credential.release;
  let releasing;
  const run = async (args) => {
    credential.assertLeaseHealthy();
    const result = await runCommandImpl(
      "uv",
      telegramPythonArgs(credential.driverEnv, USER_DRIVER_PATH, ...args, "--json"),
      {
        cwd: process.cwd(),
        env: { ...sanitizeChildEnvironment(), ...credential.driverEnv },
        timeoutMs: 60_000,
      },
    );
    if (result.status !== 0 || result.timedOut) {
      throw new Error(`Telegram test ${kind} ${args[0]} failed: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout);
  };
  credential.release = () => {
    releasing ??= (async () => {
      try {
        // Consumer cancellation has closed its scope. Cleanup keeps the same
        // still-held lease, with a separate bounded process owner.
        evidence.cleanup = await withTelegramRun(() => run([cleanup]), {
          leaseHealth: {
            assertHealthy: credential.assertLeaseHealthy,
            whenUnhealthy: credential.whenLeaseUnhealthy,
          },
        });
        if (evidence.cleanup.ok !== true)
          throw new Error(`Telegram ${kind} cleanup was not confirmed.`);
      } catch (error) {
        evidence.cleanup = { status: "failed", error: error.message };
        throw error;
      }
      await releaseCredential();
    })();
    return releasing;
  };
  try {
    evidence.setup = await run(prepare);
    if (evidence.setup.ok !== true || !/^-\d+$/u.test(evidence.setup.groupId)) {
      throw new Error(`Telegram ${kind} setup returned an invalid group identity.`);
    }
    credential.groupId = evidence.setup.groupId;
    credential.driverEnv.TELEGRAM_USER_DRIVER_CHAT_ID = credential.groupId;
  } catch (error) {
    evidence.setup = { status: "failed", error: error.message };
    throw error;
  }
  return evidence.setup;
}

export async function prepareTelegramTestGroup(
  credential,
  { runCommandImpl = runCommand, chatId } = {},
) {
  return await ownTelegramFixture(credential, {
    kind: "group",
    evidenceKey: "testGroup",
    prepare: chatId ? ["prepare-group", "--chat", chatId] : ["prepare-group"],
    cleanup: "cleanup-group",
    runCommandImpl,
  });
}

export async function prepareTelegramTestForum(credential, { runCommandImpl = runCommand } = {}) {
  const forum = await ownTelegramFixture(credential, {
    kind: "forum",
    evidenceKey: "testForum",
    prepare: ["prepare-forum"],
    cleanup: "cleanup-forum",
    runCommandImpl,
  });
  if (!Number.isSafeInteger(forum.forumTopicId) || forum.forumTopicId < 1) {
    throw new Error("Telegram forum setup returned an invalid topic identity.");
  }
  return forum;
}
