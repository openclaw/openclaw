import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { acquireMatrixCryptoStoreOwnership } from "./crypto-store-ownership.js";
import { observeCryptoStoreContention } from "./crypto-store-ownership.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await resetMatrixTestStores();
    cleanup();
  }),
);

function waitForChildLock(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout?.once("data", (chunk) => {
      if (String(chunk).trim() === "LOCKED") {
        resolve();
      } else {
        reject(new Error(`Unexpected lock-owner output: ${String(chunk)}`));
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`Lock-owner process exited early (${code}): ${stderr}`));
    });
  });
}

describe("Matrix crypto-store ownership across processes", () => {
  it("keeps custody in the OS owner until its explicit retirement", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-crypto-process-owner-"), "snapshot.json");
    installMatrixTestRuntime({ stateDir: path.dirname(snapshotPath) });
    const moduleUrl = pathToFileURL(
      path.resolve("extensions/matrix/src/matrix/sdk/crypto-store-ownership.ts"),
    ).href;
    const childScript = `
      const { acquireMatrixCryptoStoreOwnership } = await import(${JSON.stringify(moduleUrl)});
      // This child only acquires an empty store's file lock; it never enters Rust.
      const stateRuntime = { openKeyedStoreV2: () => ({ lookup: async () => undefined }) };
      const ownership = await acquireMatrixCryptoStoreOwnership(${JSON.stringify(snapshotPath)}, { stateRuntime });
      process.stdout.write("LOCKED\\n");
      process.stdin.resume();
      await new Promise((resolve) => process.stdin.once("end", resolve));
      await ownership.release();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", childScript],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      await waitForChildLock(child);
      const contention = observeCryptoStoreContention(snapshotPath);
      const caller = new AbortController();
      const pending = acquireMatrixCryptoStoreOwnership(snapshotPath, { signal: caller.signal });
      try {
        await contention.waitFor(pending);
        expect(child.exitCode).toBeNull();
        child.stdin?.end();
        const next = await pending;
        await next.release();
      } finally {
        contention.close();
        caller.abort();
        const acquired = await pending.catch(() => undefined);
        await acquired?.release();
      }
    } finally {
      child.stdin?.end();
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
      }
    }
  }, 30_000);
});
