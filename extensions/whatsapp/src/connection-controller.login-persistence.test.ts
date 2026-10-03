import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerTestModules } from "./connection-controller.test-helpers.js";
import {
  createLoginResultHarness,
  createSocketWithTransportEmitter,
  loadConnectionControllerTestModules,
  resetConnectionControllerTestMocks,
  loginAuthDir,
} from "./connection-controller.test-helpers.js";

let modules!: ControllerTestModules;

describe("WhatsApp login credential persistence", () => {
  beforeAll(async () => {
    modules = await loadConnectionControllerTestModules();
  });

  beforeEach(() => {
    resetConnectionControllerTestMocks(modules);
  });

  it("preserves credential persistence guards on a replacement login socket", async () => {
    const harness = createLoginResultHarness(modules.login.waitForWhatsAppLoginResult);
    const restartError = { output: { statusCode: 515 } };
    const waitForConnection = vi
      .fn()
      .mockRejectedValueOnce(restartError)
      .mockResolvedValueOnce(undefined);
    const createSocket = vi.fn(async () => harness.replacementSock);
    const beforeCredentialPersistence = vi.fn(async () => {});
    const onCredentialPersistenceError = vi.fn();
    const onCredentialPersistenceTask = vi.fn();
    const waitForCredentialPersistence = vi.fn(async () => {});

    const result = await modules.login.waitForWhatsAppLoginResult({
      sock: harness.initialSock as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: harness.runtime,
      waitForConnection: waitForConnection as never,
      createSocket: createSocket as never,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
      waitForCredentialPersistence,
    });

    expect(result.outcome).toBe("connected");
    expect(createSocket).toHaveBeenCalledWith(false, false, {
      authDir: loginAuthDir,
      onQr: undefined,
      beforeCredentialPersistence,
      onCredentialPersistenceError,
      onCredentialPersistenceTask,
    });
    expect(waitForCredentialPersistence).toHaveBeenCalledOnce();
  });

  it("returns a retryable failure when the socket opens before auth persistence settles", async () => {
    modules.readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "unstable" });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await modules.login.waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("aborts an indefinite login wait when guarded credential persistence fails", async () => {
    const guardError = new Error("verified inference route changed");
    let persistenceFailure: { error: unknown } | null = null;
    let resolvePersistenceFailure = (_failure: { error: unknown }) => {};
    const persistenceFailurePromise = new Promise<{ error: unknown }>((resolve) => {
      resolvePersistenceFailure = resolve;
    });
    const pendingResult = modules.login.waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: vi.fn(() => new Promise<void>(() => {})) as never,
      credentialPersistenceFailure: persistenceFailurePromise,
      getCredentialPersistenceFailure: () => persistenceFailure,
    });

    persistenceFailure = { error: guardError };
    resolvePersistenceFailure(persistenceFailure);

    const result = await pendingResult;
    expect(result).toMatchObject({ outcome: "failed", error: guardError });
  });

  it("returns a retryable failure when auth is not linked on disk after the socket opens", async () => {
    modules.readWebAuthExistsForDecisionMock.mockResolvedValue({
      outcome: "stable",
      exists: false,
    });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);

    const result = await modules.login.waitForWhatsAppLoginResult({
      sock: createSocketWithTransportEmitter() as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.message).toMatch(/retry/i);
      expect((result.error as { code?: string })?.code).toBe("whatsapp-auth-unstable");
    }
  });

  it("returns connected only after auth is confirmed durable on disk", async () => {
    modules.readWebAuthExistsForDecisionMock.mockResolvedValue({ outcome: "stable", exists: true });
    const waitForConnection = vi.fn().mockResolvedValueOnce(undefined);
    const sock = createSocketWithTransportEmitter();

    const result = await modules.login.waitForWhatsAppLoginResult({
      sock: sock as never,
      authDir: loginAuthDir,
      isLegacyAuthDir: false,
      verbose: false,
      runtime: { log: vi.fn() } as never,
      waitForConnection: waitForConnection as never,
    });

    expect(result).toEqual({ outcome: "connected", restarted: false, sock });
    expect(modules.readWebAuthExistsForDecisionMock).toHaveBeenCalledWith(loginAuthDir);
  });
});
