import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMatrixCryptoStoreOwnership } from "./crypto-store-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

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
  it("hands exclusive ownership to a waiting OS process", async () => {
    const snapshotPath = path.join(tempDirs.make("matrix-crypto-process-owner-"), "snapshot.json");
    const moduleUrl = pathToFileURL(
      path.resolve("extensions/matrix/src/matrix/sdk/crypto-store-ownership.ts"),
    ).href;
    const childScript = `
      const { acquireMatrixCryptoStoreOwnership } = await import(${JSON.stringify(moduleUrl)});
      let ownership;
      ownership = await acquireMatrixCryptoStoreOwnership(${JSON.stringify(snapshotPath)}, {
        onYieldRequested: () => {
          process.stdout.write("YIELD\\n");
          void ownership.release();
        },
      });
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
      const yielded = new Promise<string>((resolve) => {
        child.stdout?.once("data", (chunk) => resolve(String(chunk).trim()));
      });
      const next = await acquireMatrixCryptoStoreOwnership(snapshotPath);
      expect(await yielded).toBe("YIELD");
      await next.release();
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
