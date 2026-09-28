#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resumeQaLease } from "./qa-credential-lease.mjs";
import { runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { runTelegramCli, withTelegramRun } from "./telegram-run-scope.mjs";

const [directory, command, ...args] = process.argv.slice(2);
if (!directory || !["status", "cleanup-group", "release"].includes(command)) {
  throw new Error(
    "Usage: telegram-test-recover.mjs <retained-lease-directory> <status|cleanup-group|release> [driver arguments]",
  );
}
const leaseDir = path.resolve(directory);
const stateRoot = path.join(leaseDir, "state");
const receipt = path.join(leaseDir, "lease.json");

function requireOwnedPath(file, directory, privateMode = true) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (privateMode && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Retained Telegram state must be private, owned and free of symlinks.");
  }
}

function validateRetainedLayout() {
  if (
    path.dirname(leaseDir) !== path.resolve(os.tmpdir()) ||
    !path.basename(leaseDir).startsWith("openclaw-tg-test-credential-")
  ) {
    throw new Error(
      "Recovery requires an owned Telegram lease directory in the configured temporary root.",
    );
  }
  requireOwnedPath(leaseDir, true);
  requireOwnedPath(receipt, false);
  if (!fs.existsSync(stateRoot) && !fs.lstatSync(stateRoot, { throwIfNoEntry: false })) return;
  requireOwnedPath(stateRoot, true);
  requireOwnedPath(path.join(stateRoot, "user-driver"), true);
  const layout = [
    [stateRoot, new Set(["credentials.local.json", "user-driver"])],
    [
      path.join(stateRoot, "user-driver"),
      new Set(["config.local.json", "owned-test-group.json", "db", "files"]),
    ],
  ];
  for (const [directory, allowed] of layout) {
    for (const name of fs.readdirSync(directory)) {
      if (!allowed.has(name))
        throw new Error("Unknown retained state files must be preserved before recovery cleanup.");
    }
  }
  const pending = [stateRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      // Private enclosing roots protect ordinary archive directory modes.
      requireOwnedPath(file, stat.isDirectory(), !stat.isDirectory());
      if (stat.isDirectory()) pending.push(file);
    }
  }
}

function removeReleasedReceipt() {
  validateRetainedLayout();
  fs.unlinkSync(receipt);
  if (fs.readdirSync(leaseDir).length === 0) fs.rmdirSync(leaseDir);
}

runTelegramCli(async (signal) => {
  validateRetainedLayout();
  const recovery = JSON.parse(fs.readFileSync(receipt, "utf8"));
  if (recovery.identity.kind !== "telegram-test-userbot")
    throw new Error("Recovery receipt is not a Telegram lease.");
  const lease = await resumeQaLease({ recovery, signal });
  return await withTelegramRun(
    async (scope) => {
      if (command === "release") {
        if (fs.existsSync(stateRoot))
          throw new Error("Remove owned fixtures and credential state before broker-only release.");
        await lease.release();
        removeReleasedReceipt();
        return { ok: true, leaseReleased: true };
      }
      if (command === "status" && !fs.existsSync(stateRoot)) {
        return {
          ok: true,
          leaseHealthy: true,
          credentialStatePresent: false,
          leaseReleased: false,
        };
      }
      const credential = JSON.parse(
        fs.readFileSync(path.join(stateRoot, "credentials.local.json"), "utf8"),
      );
      const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "user-driver.py");
      const result = await runCommand("uv", ["run", driver, command, "--json", ...args], {
        cwd: process.cwd(),
        env: {
          ...sanitizeChildEnvironment(),
          TELEGRAM_E2E_STATE_DIR: stateRoot,
          TELEGRAM_USER_DRIVER_STATE_DIR: path.join(stateRoot, "user-driver"),
          TELEGRAM_USER_DRIVER_SUT_ID: credential.sutBotId,
          TELEGRAM_USER_DRIVER_SUT_USERNAME: credential.sutUsername,
        },
        timeoutMs: 60_000,
      });
      scope.assertActive();
      if (result.status !== 0 || result.timedOut)
        throw new Error(result.stderr || "Retained Telegram state recovery failed.");
      const evidence = JSON.parse(result.stdout);
      if (evidence.ok !== true)
        throw new Error("Retained Telegram state recovery was not confirmed.");
      if (command === "cleanup-group") {
        validateRetainedLayout();
        fs.rmSync(stateRoot, { recursive: true, force: true });
        await lease.release();
        removeReleasedReceipt();
      }
      return { ...evidence, leaseReleased: command === "cleanup-group" };
    },
    {
      signal,
      leaseHealth: { assertHealthy: lease.assertHealthy, whenUnhealthy: lease.whenUnhealthy },
    },
  );
})
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
