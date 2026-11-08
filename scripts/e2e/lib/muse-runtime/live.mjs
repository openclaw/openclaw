import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHarness } from "./gateway.mjs";

// Models refuse to "remember a token"; a neutral per-run fact proves recall without that refusal.
const token = `Pip${randomUUID().slice(0, 6)}`;
const apiKey = process.env.META_API_KEY;
let harness;
let stage = "Gateway startup";

async function logout() {
  await new Promise((resolve, reject) => {
    const child = spawn("muse", ["logout"], {
      env: { ...process.env },
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("muse logout timed out"));
    }, 30_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start muse logout"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("muse logout failed"));
      }
    });
  });
}

try {
  harness = await createHarness();
  await harness.start();

  stage = "initial model turn";
  const first = await harness.turn(
    `My cat is named ${token}. Reply with only my cat's name. Do not use tools.`,
  );
  assert.ok(first.text.includes(token), "The first real Muse reply must contain the recall token");
  console.log("Muse real model turn completed.");

  stage = "recall after Gateway restart";
  await harness.stop();
  await harness.start();
  const recallPrompt = "What is my cat's name? Reply with only the name. Do not use tools.";
  assert.ok(!recallPrompt.includes(token), "The recall prompt must not disclose the token");
  const recalled = await harness.turn(recallPrompt);
  assert.ok(
    recalled.text.includes(token),
    "Muse must recall the earlier token after a Gateway restart",
  );
  console.log("Muse conversation recall survived a Gateway restart.");

  stage = "recall after native session replacement";
  // A model change starts a new Muse session; OpenClaw must seed it with the retained conversation.
  await harness.stop();
  harness.config.agents.defaults.model = "meta/muse-spark-1.2";
  harness.config.agents.defaults.models = {
    "meta/muse-spark-1.2": { agentRuntime: { id: "muse" } },
  };
  harness.saveConfig();
  await harness.start();
  const replaced = await harness.turn(recallPrompt);
  assert.ok(
    replaced.text.includes(token),
    "A replacement Muse session must receive the retained OpenClaw conversation",
  );
  console.log("Muse recalled the conversation in a replacement native session.");

  stage = "native shell approval";
  const fixture = path.join(harness.workspace, `shell-approval-${randomUUID()}`);
  const removalTarget = path.join(fixture, "remove-me");
  const proofFile = path.join(fixture, "approved.txt");
  const shellMarker = "muse-native-shell-approved";
  await mkdir(removalTarget, { recursive: true });
  await writeFile(path.join(removalTarget, "fixture.txt"), "Disposable approval fixture.\n");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `rm -rf -- ${quote(removalTarget)} && printf '%s' ${quote(shellMarker)} > ${quote(proofFile)}`;
  const shell = await harness.turn(
    `Use your native shell tool to execute exactly this command once: ${command}\nThis removes only a disposable test fixture I created. Request approval when required and wait for it. Do not use file-editing tools or other commands instead. After execution, reply briefly that it completed.`,
    { decision: "allow-once" },
  );
  assert.ok(
    shell.approvals.length > 0,
    "Native Muse shell execution must request an OpenClaw approval",
  );
  // Muse 1.3 names its native shell tool `bash`.
  assert.ok(
    shell.approvals.some((approval) => approval.request?.title === "Muse: bash"),
    `An approval must belong to Muse's native shell tool: ${JSON.stringify(shell.approvals.map((approval) => approval.request?.title))}`,
  );
  assert.ok(
    shell.approvals.every((approval) => approval.request?.allowedDecisions?.includes("allow-once")),
    "Muse approvals must permit the allow-once decision",
  );
  assert.ok(
    (await readFile(proofFile, "utf8")) === shellMarker,
    "Approved native shell must write the proof file",
  );
  await assert.rejects(
    access(removalTarget),
    { code: "ENOENT" },
    "Approved native shell must remove the disposable fixture",
  );
  console.log(`Muse native shell completed with ${shell.approvals.length} allow-once approval(s).`);

  stage = "denied native shell";
  const deniedFile = path.join(fixture, "denied.txt");
  const denied = await harness.turn(
    `Use your native shell tool to execute exactly this command once: printf denied > ${quote(deniedFile)}\nRequest approval when required and wait for it. Do not use file-editing tools or any other command. Then reply briefly.`,
    { decision: "deny", expectError: true },
  );
  assert.ok(denied.approvals.length > 0, "The denied command must request an OpenClaw approval");
  await assert.rejects(
    access(deniedFile),
    { code: "ENOENT" },
    "A denied native shell command must not run",
  );
  console.log("Muse respected an OpenClaw deny: the command did not run.");

  stage = "cancellation after approval";
  const lateFile = path.join(fixture, "late.txt");
  const cancelled = await harness.turn(
    `Use your native shell tool to execute exactly this command once: sleep 20 && printf late > ${quote(lateFile)}\nRequest approval when required and wait for it. Do not use any other command.`,
    {
      decision: "allow-once",
      expectError: true,
      // Abort shortly after approval, while the approved command is sleeping.
      afterApproval: (runId) =>
        setTimeout(() => {
          void harness.client.request("chat.abort", { sessionKey: harness.sessionKey, runId });
        }, 3000),
    },
  );
  assert.ok(cancelled.approvals.length > 0, "The long command must request an OpenClaw approval");
  assert.notEqual(cancelled.wait.status, "ok", "The aborted run must not report success");
  // Wait past the command's sleep: an interrupted native command must leave no late effect.
  await delay(25_000);
  await assert.rejects(
    access(lateFile),
    { code: "ENOENT" },
    "An aborted native command must not complete after the attempt ends",
  );
  console.log("Muse cancellation stopped the approved command before its late effect.");

  stage = "credential logout";
  // Drop the environment key before stopping: start() builds a fresh child environment.
  delete process.env.META_API_KEY;
  await harness.stop();
  await logout();
  await harness.start();

  stage = "post-logout credential failure";
  const loggedOut = await harness.turn("Reply with a short hello. Do not use tools.", {
    expectError: true,
  });
  assert.equal(loggedOut.wait.status, "error", "A fresh Gateway turn must fail after Muse logout");
  // Chat surfaces show a generic failure; the harness logs the actionable cause for operators.
  const log = harness.gatewayLog();
  assert.ok(
    log.includes("Muse Code is not signed in on the Gateway host") && log.includes("muse login"),
    `The Gateway log must explain the missing Muse sign-in and how to fix it. Muse log lines:\n${log
      .split("\n")
      .filter((line) => /muse/i.test(line))
      .slice(-15)
      .join("\n")}\nTurn: ${JSON.stringify(loggedOut.wait).slice(0, 800)}`,
  );
  console.log("Muse logout produced an actionable sign-in error in the Gateway log.");
  console.log("Muse live Docker E2E passed.");
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(token, "[redacted recall token]");
  if (apiKey) {
    message = message.replaceAll(apiKey, "[redacted API key]");
  }
  console.error(`Muse live Docker E2E failed during ${stage}: ${message}`);
  process.exitCode = 1;
} finally {
  await harness?.stop();
}
