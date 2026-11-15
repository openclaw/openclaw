// Whatsapp tests cover exclusive auth-backed connection ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  acquireWhatsAppGatewayConnectionOwner,
  acquireWhatsAppStandaloneConnectionOwner,
} from "./connection-owner.js";
import { whatsappDoctor } from "./doctor.js";

async function createAuthDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-owner-"));
  onTestFinished(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const authDir = path.join(dir, "auth");
  await fs.mkdir(authDir);
  return authDir;
}

describe("WhatsApp connection owner", () => {
  it("serializes process-local owners and waits for handoff", async () => {
    const authDir = await createAuthDir();

    const gatewayOwner = await acquireWhatsAppGatewayConnectionOwner(authDir);
    await expect(acquireWhatsAppStandaloneConnectionOwner(authDir)).rejects.toMatchObject({
      code: "whatsapp_connection_owner_busy",
      authDir,
      message: expect.stringContaining("openclaw doctor"),
    });

    await gatewayOwner.release();
    const standaloneOwner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    const gatewayOwnerPromise = acquireWhatsAppGatewayConnectionOwner(authDir);
    await standaloneOwner.release();

    const resumedOwner = await gatewayOwnerPromise;
    await resumedOwner.release();
  });

  it.runIf(process.platform !== "win32")(
    "treats symlink aliases as the same process-local owner",
    async () => {
      const authDir = await createAuthDir();
      const authAlias = path.join(path.dirname(authDir), "auth-alias");
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
    const authDir = await createAuthDir();
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() })}\n`,
    );

    const owner = await acquireWhatsAppStandaloneConnectionOwner(authDir);
    await owner.release();
  });

  it("cancels cross-process owner retries during shutdown", async () => {
    const authDir = await createAuthDir();
    await fs.writeFile(
      `${authDir}.lock`,
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    const abortController = new AbortController();

    const ownerPromise = acquireWhatsAppGatewayConnectionOwner(authDir, abortController.signal);
    abortController.abort(new Error("shutdown"));

    await expect(ownerPromise).rejects.toThrow("shutdown");
  });

  it.each([
    [null, false],
    ["", true],
    ["{", true],
    ["{}", true],
    ['{"pid":0}', true],
    [`{"pid":${process.pid}}`, false],
  ] as const)("diagnoses ambiguous locks without removing them: %j", async (raw, warns) => {
    const authDir = await createAuthDir();
    const lockPath = `${authDir}.lock`;
    if (raw !== null) {
      await fs.writeFile(lockPath, raw);
    }
    const cfg = { channels: { whatsapp: { accounts: { default: { authDir } } } } };
    const warnings = await whatsappDoctor.collectPreviewWarnings?.({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings).toEqual(warns ? [expect.stringContaining("Stop every process")] : []);
    if (warnings?.length) {
      expect(warnings[0]).toContain(lockPath);
    }
    if (raw !== null) {
      expect(await fs.readFile(lockPath, "utf8")).toBe(raw);
    }
  });
});
