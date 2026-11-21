import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import {
  hasWebCredsSync,
  prepareWebAuthForLogin,
  readWebAuthState,
  webAuthExists,
} from "./auth-store.js";
import {
  enqueueCredsSave,
  waitForCredsSaveQueue,
  type CredsQueueWaitResult,
} from "./creds-persistence.js";
import {
  createCompletedPhoneCodeCreds,
  createPartialPhoneCodeCreds,
} from "./phone-code.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  waitForCredsSaveQueueWithTimeout: vi.fn<() => Promise<CredsQueueWaitResult>>(),
  oauthDir: "",
}));

vi.mock("./creds-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./creds-persistence.js")>()),
  waitForCredsSaveQueueWithTimeout: hoisted.waitForCredsSaveQueueWithTimeout,
}));
vi.mock("./auth-store.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-store.runtime.js")>()),
  resolveOAuthDir: () => hoisted.oauthDir,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createManagedAuthDir() {
  const authDir = path.join(hoisted.oauthDir, "whatsapp", "default");
  fsSync.mkdirSync(authDir, { recursive: true });
  return authDir;
}

describe("WhatsApp login auth preparation", () => {
  beforeEach(() => {
    hoisted.waitForCredsSaveQueueWithTimeout.mockReset().mockResolvedValue("drained");
    hoisted.oauthDir = tempDirs.make("openclaw-wa-login-auth-");
  });

  it.each([
    ["requestPairingCode", false],
    ["companion_finish", true],
  ] as const)("does not treat %s credentials as linked", async (stage, registered) => {
    const authDir = createManagedAuthDir();
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify(createPartialPhoneCodeCreds({ registered })),
      "utf-8",
    );
    const runtime = createRuntimeSpies();

    expect(hasWebCredsSync(authDir)).toBe(true);
    await expect(webAuthExists(authDir)).resolves.toBe(false);
    await expect(readWebAuthState(authDir)).resolves.toBe("not-linked");
    const guardError = new Error("setup authority changed");
    const beforeCredentialPersistence = vi.fn(async () => {
      throw guardError;
    });
    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "preserve-linked",
        runtime,
        beforeCredentialPersistence,
      }),
    ).rejects.toBe(guardError);
    expect(beforeCredentialPersistence).toHaveBeenCalledOnce();
    expect(fsSync.existsSync(authDir)).toBe(true);
    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "preserve-linked",
        runtime,
      }),
    ).resolves.toBe("cleared");
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  it("reports partial phone-code creds that cannot be cleared from a custom auth dir", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-phone-code-external-partial-");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(
      credsPath,
      JSON.stringify(createPartialPhoneCodeCreds({ registered: true })),
      "utf-8",
    );

    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "preserve-linked",
      }),
    ).resolves.toBe("not-cleared");
    expect(fsSync.existsSync(credsPath)).toBe(true);
  });

  it("clears linked credentials when login explicitly requests fresh auth", async () => {
    const authDir = createManagedAuthDir();
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify(createCompletedPhoneCodeCreds({ registered: true })),
      "utf-8",
    );

    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "clear-existing",
      }),
    ).resolves.toBe("cleared");
    expect(fsSync.existsSync(authDir)).toBe(false);
  });

  it("reports linked credentials that fresh login cannot clear from a custom auth dir", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-force-fresh-external-");
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(
      credsPath,
      JSON.stringify(createCompletedPhoneCodeCreds({ registered: true })),
      "utf-8",
    );

    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "clear-existing",
      }),
    ).resolves.toBe("not-cleared");
    expect(fsSync.existsSync(credsPath)).toBe(true);
  });

  it("reports fresh login ready when no credentials exist", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-force-fresh-absent-");
    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "clear-existing",
      }),
    ).resolves.toBe("not-needed");
  });

  it("treats completed phone-code pairing creds as linked", async () => {
    const authDir = tempDirs.make("openclaw-wa-auth-phone-code-linked-");
    fsSync.writeFileSync(
      path.join(authDir, "creds.json"),
      JSON.stringify(createCompletedPhoneCodeCreds({ registered: true })),
      "utf-8",
    );

    await expect(webAuthExists(authDir)).resolves.toBe(true);
    await expect(readWebAuthState(authDir)).resolves.toBe("linked");
  });

  it("preserves completed phone-code creds saved before stale cleanup reads", async () => {
    const authDir = createManagedAuthDir();
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, JSON.stringify(createPartialPhoneCodeCreds()), "utf-8");
    hoisted.waitForCredsSaveQueueWithTimeout.mockImplementationOnce(async () => {
      fsSync.writeFileSync(
        credsPath,
        JSON.stringify(createCompletedPhoneCodeCreds({ registered: true })),
        "utf-8",
      );
      return "drained";
    });

    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "preserve-linked",
      }),
    ).resolves.toBe("not-needed");
    expect(fsSync.existsSync(credsPath)).toBe(true);
    await expect(webAuthExists(authDir)).resolves.toBe(true);
  });

  it("preserves completed phone-code creds queued while stale cleanup deletes", async () => {
    const authDir = createManagedAuthDir();
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, JSON.stringify(createPartialPhoneCodeCreds()), "utf-8");
    const completedCreds = JSON.stringify(createCompletedPhoneCodeCreds({ registered: true }));
    const { rm: originalRm } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(authDir)) {
        enqueueCredsSave(
          authDir,
          () => {
            fsSync.mkdirSync(authDir, { recursive: true });
            fsSync.writeFileSync(credsPath, completedCreds, "utf-8");
          },
          () => undefined,
        );
        await Promise.resolve();
      }
      return await originalRm(target, options);
    });

    try {
      await expect(
        prepareWebAuthForLogin({
          authDir,
          isLegacyAuthDir: false,
          mode: "preserve-linked",
        }),
      ).resolves.toBe("cleared");
      await waitForCredsSaveQueue(authDir);

      await expect(webAuthExists(authDir)).resolves.toBe(true);
      expect(fsSync.readFileSync(credsPath, "utf-8")).toBe(completedCreds);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("reports unstable cleanup when the credential save queue does not settle", async () => {
    const authDir = createManagedAuthDir();
    const credsPath = path.join(authDir, "creds.json");
    fsSync.writeFileSync(credsPath, JSON.stringify(createPartialPhoneCodeCreds()), "utf-8");
    hoisted.waitForCredsSaveQueueWithTimeout.mockResolvedValueOnce("timed_out");

    await expect(
      prepareWebAuthForLogin({
        authDir,
        isLegacyAuthDir: false,
        mode: "preserve-linked",
      }),
    ).resolves.toBe("unstable");
    expect(fsSync.existsSync(credsPath)).toBe(true);
  });
});
