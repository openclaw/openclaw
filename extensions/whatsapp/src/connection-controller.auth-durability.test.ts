import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createSocketWithTransportEmitter,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
} from "./connection-controller.test-helpers.js";
import { enqueueCredsSave } from "./creds-persistence.js";
import { createCompletedPhoneCodeCreds } from "./phone-code.test-helpers.js";

let modules!: ControllerTestModules;

describe("WhatsApp connection auth durability", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
  });

  it("waits for queued creds persistence so linked auth survives an auth-dir reuse", async () => {
    const actualAuthStore =
      await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-auth-durability-"));
    try {
      modules.readWebAuthExistsForDecisionMock.mockImplementation(
        actualAuthStore.readWebAuthExistsForDecision,
      );
      let credsSaved = false;
      enqueueCredsSave(
        authDir,
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          await modules.session.writeCredsJsonAtomically(
            authDir,
            createCompletedPhoneCodeCreds({ registered: true }),
          );
          credsSaved = true;
        },
        () => {},
      );

      const result = await modules.login.waitForWhatsAppLoginResult({
        sock: createSocketWithTransportEmitter() as never,
        authDir,
        isLegacyAuthDir: false,
        verbose: false,
        runtime: { log: vi.fn() } as never,
        waitForConnection: vi.fn().mockResolvedValueOnce(undefined) as never,
      });

      expect(credsSaved).toBe(true);
      expect(result).toEqual({ outcome: "connected", restarted: false, sock: expect.anything() });
      // A fresh read of the same auth dir is what a restarted/rebuilt container does.
      await expect(actualAuthStore.webAuthExists(authDir)).resolves.toBe(true);
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });
});
