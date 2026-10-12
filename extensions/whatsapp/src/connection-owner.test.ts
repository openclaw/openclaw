// Whatsapp tests cover exclusive auth-backed connection ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  acquireWhatsAppGatewayConnectionOwner,
  acquireWhatsAppStandaloneConnectionOwner,
} from "./connection-owner.js";

async function createTempParent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-owner-"));
  onTestFinished(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("WhatsApp connection owner", () => {
  it("rejects a second process-local owner until the first lease is released", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);

    const gatewayOwner = await acquireWhatsAppGatewayConnectionOwner(authDir);
    await expect(acquireWhatsAppStandaloneConnectionOwner(authDir)).rejects.toMatchObject({
      code: "whatsapp_connection_owner_busy",
      authDir,
    });

    await gatewayOwner.release();
    const standaloneOwner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    await standaloneOwner.release();
  });

  it("lets the gateway wait for a process-local standalone owner", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);

    const standaloneOwner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    const gatewayOwnerPromise = acquireWhatsAppGatewayConnectionOwner(authDir);
    await standaloneOwner.release();

    const gatewayOwner = await gatewayOwnerPromise;
    await gatewayOwner.release();
  });

  it.runIf(process.platform !== "win32")(
    "treats symlink aliases as the same process-local owner",
    async () => {
      const parent = await createTempParent();
      const authDir = path.join(parent, "auth");
      const authAlias = path.join(parent, "auth-alias");
      await fs.mkdir(authDir);
      await fs.symlink(authDir, authAlias, "dir");

      const gatewayOwner = await acquireWhatsAppGatewayConnectionOwner(authDir);
      await expect(acquireWhatsAppStandaloneConnectionOwner(authAlias)).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
        authDir: authAlias,
      });
      await gatewayOwner.release();
    },
  );

  it("recovers an unchanged lock owned by a definitely dead process", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() })}\n`,
    );

    const owner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    await owner.release();
  });

  describe("incumbent cleanup retry", () => {
    async function createAuthDir(): Promise<string> {
      const parent = await createTempParent();
      const authDir = path.join(parent, "auth");
      await fs.mkdir(authDir);
      return authDir;
    }

    it("finishes a failed incumbent cleanup before the replacement owner acquires", async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const firstAttempt = createDeferred<void>();
      const retry = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          firstAttempt.resolve();
          throw new Error("still draining");
        })
        .mockImplementationOnce(async () => {
          await incumbent.release();
        });
      incumbent.setCleanupRetry(retry);

      const replacementPromise = acquireWhatsAppGatewayConnectionOwner(authDir);
      // The acquire reaches its wait loop after real filesystem I/O; only then can
      // the fake clock drive the backoff.
      await firstAttempt.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      const replacement = await replacementPromise;

      expect(retry).toHaveBeenCalledTimes(2);
      await replacement.release();
    });

    it("keeps the incumbent fail-closed when its cleanup never completes", async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const cleanupError = new Error("credential persistence did not drain");
      const firstAttempt = createDeferred<void>();
      const retry = vi.fn<() => Promise<void>>().mockImplementation(async () => {
        firstAttempt.resolve();
        throw cleanupError;
      });
      incumbent.setCleanupRetry(retry);

      const replacement = acquireWhatsAppGatewayConnectionOwner(authDir);
      const outcome = expect(replacement).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
        cause: cleanupError,
      });
      await firstAttempt.promise;
      await vi.advanceTimersByTimeAsync(150_000);
      await outcome;

      expect(retry.mock.calls.length).toBeGreaterThan(1);
      await expect(acquireWhatsAppStandaloneConnectionOwner(authDir)).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
      });
      await incumbent.release();
    });

    it("reports a retry that throws synchronously as owner busy with the cause", async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const cleanupError = new Error("retry exploded");
      const firstAttempt = createDeferred<void>();
      incumbent.setCleanupRetry(() => {
        firstAttempt.resolve();
        throw cleanupError;
      });

      const replacement = acquireWhatsAppGatewayConnectionOwner(authDir);
      const outcome = expect(replacement).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
        cause: cleanupError,
      });
      await firstAttempt.promise;
      await vi.advanceTimersByTimeAsync(150_000);
      await outcome;
      await incumbent.release();
    });

    it("shares one retry between concurrent replacement owners", async () => {
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const retry = vi.fn(async () => {
        await incumbent.release();
      });
      incumbent.setCleanupRetry(retry);

      // Whichever replacement wins releases at once so the other can follow.
      await Promise.all([
        acquireWhatsAppGatewayConnectionOwner(authDir).then((lease) => lease.release()),
        acquireWhatsAppGatewayConnectionOwner(authDir).then((lease) => lease.release()),
      ]);

      expect(retry).toHaveBeenCalledOnce();
    });

    it("cancels a replacement that is waiting on incumbent cleanup", async () => {
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const cleanupStarted = createDeferred<void>();
      const retry = vi.fn(async () => {
        cleanupStarted.resolve();
        throw new Error("still draining");
      });
      incumbent.setCleanupRetry(retry);
      const abortController = new AbortController();

      const replacement = acquireWhatsAppGatewayConnectionOwner(authDir, abortController.signal);
      const outcome = expect(replacement).rejects.toThrow("shutdown");
      // Abort only once the replacement is inside the incumbent cleanup wait.
      await cleanupStarted.promise;
      abortController.abort(new Error("shutdown"));

      await outcome;
      expect(retry).toHaveBeenCalledOnce();
      await incumbent.release();
    });

    it("does not run the incumbent cleanup for standalone lookups", async () => {
      const authDir = await createAuthDir();
      const incumbent = await acquireWhatsAppGatewayConnectionOwner(authDir);
      const retry = vi.fn(async () => {});
      incumbent.setCleanupRetry(retry);

      await expect(acquireWhatsAppStandaloneConnectionOwner(authDir)).rejects.toMatchObject({
        code: "whatsapp_connection_owner_busy",
      });

      expect(retry).not.toHaveBeenCalled();
      await incumbent.release();
    });
  });

  it("cancels cross-process owner retries during shutdown", async () => {
    const parent = await createTempParent();
    const authDir = path.join(parent, "auth");
    await fs.mkdir(authDir);
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    const abortController = new AbortController();

    const ownerPromise = acquireWhatsAppGatewayConnectionOwner(authDir, abortController.signal);
    abortController.abort(new Error("shutdown"));

    await expect(ownerPromise).rejects.toThrow("shutdown");
  });
});
