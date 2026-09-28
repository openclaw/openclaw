import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { withTelegramRun } from "./telegram-run-scope.mjs";

const USER_DRIVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-driver.py");

export async function prepareTelegramTestGroup(
  credential,
  { runCommandImpl = runCommand, chatId } = {},
) {
  const evidence = { setup: { status: "started" }, cleanup: { status: "pending" } };
  credential.testGroup = evidence;
  const releaseCredential = credential.release;
  let releasing;
  const run = async (command) => {
    credential.assertLeaseHealthy();
    const args = ["run", USER_DRIVER_PATH, command, "--json"];
    if (command === "prepare-group" && chatId) args.push("--chat", chatId);
    const result = await runCommandImpl("uv", args, {
      cwd: process.cwd(),
      env: { ...sanitizeChildEnvironment(), ...credential.driverEnv },
      timeoutMs: 60_000,
    });
    if (result.status !== 0 || result.timedOut) {
      throw new Error(`Telegram test group ${command} failed: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout);
  };
  credential.release = () => {
    releasing ??= (async () => {
      try {
        // Consumer cancellation has closed its scope. Cleanup keeps the same
        // still-held lease, with a separate bounded process owner.
        evidence.cleanup = await withTelegramRun(() => run("cleanup-group"), {
          leaseHealth: {
            assertHealthy: credential.assertLeaseHealthy,
            whenUnhealthy: credential.whenLeaseUnhealthy,
          },
        });
        if (evidence.cleanup.ok !== true)
          throw new Error("Telegram group cleanup was not confirmed.");
      } catch (error) {
        evidence.cleanup = { status: "failed", error: error.message };
        throw error;
      }
      await releaseCredential();
    })();
    return releasing;
  };
  try {
    evidence.setup = await run("prepare-group");
    if (evidence.setup.ok !== true || !/^-\d+$/u.test(evidence.setup.groupId)) {
      throw new Error("Telegram group setup returned an invalid group identity.");
    }
    credential.groupId = evidence.setup.groupId;
    credential.driverEnv.TELEGRAM_USER_DRIVER_CHAT_ID = credential.groupId;
  } catch (error) {
    evidence.setup = { status: "failed", error: error.message };
    throw error;
  }
}
