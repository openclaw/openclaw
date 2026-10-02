import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import * as diagnostics from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import * as catalogEvents from "../session-catalog-events.js";
import * as authBridge from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import { withCodexAppServerJsonClient } from "./request.js";
import * as sharedClient from "./shared-client.js";
import {
  getSharedCodexAppServerClient,
  type CodexAppServerAcquireObservation,
} from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function deferNextAuthProfileApplication(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<authBridge.CodexAppServerAuthHandoff | undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.mocked(authBridge.applyCodexAppServerAuthProfile).mockReturnValueOnce(gate);
  return release;
}

/** Reuses the owning suite's auth fixtures and physical-client cleanup. */
export function registerSharedClientAcquisitionDiagnosticsTests({
  createInitializingClientHarness,
  sendInitializeResult,
}: {
  createInitializingClientHarness: () => ReturnType<typeof createClientHarness>;
  sendInitializeResult: (
    harness: ReturnType<typeof createClientHarness>,
    userAgent: string,
  ) => Promise<void>;
}) {
  const getLeasedSharedCodexAppServerClient = sharedClient.getLeasedSharedCodexAppServerClient;
  it.each([
    "context",
    "prestart-artifact-drain",
    "transport-registration",
    "initialize",
    "catalog-observation",
    "runtime-binding",
    "auth-handoff",
  ] as const)("reports the real shared acquisition boundary %s", async (boundary) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    vi.spyOn(embeddedAgentLog, "isEnabled").mockReturnValue(true);
    vi.mocked(embeddedAgentLog.warn).mockClear();
    const entered = createDeferred<void>();
    const finish = createDeferred<void>();
    const park = async () => {
      entered.resolve();
      await finish.promise;
    };
    const harness =
      boundary === "initialize" ? createClientHarness() : createInitializingClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
      if (boundary === "transport-registration") {
        await park();
      }
      return harness.client;
    });
    if (boundary === "context") {
      vi.mocked(authBridge.bridgeCodexAppServerStartOptions).mockImplementationOnce(
        async ({ startOptions }) => {
          await park();
          return startOptions;
        },
      );
    } else if (boundary === "prestart-artifact-drain") {
      vi.mocked(authBridge.reconcileCodexComputerUseStartArtifacts).mockImplementationOnce(park);
    } else if (boundary === "catalog-observation") {
      vi.spyOn(catalogEvents, "observeCodexCatalogClient").mockImplementationOnce(park);
    } else if (boundary === "auth-handoff") {
      vi.mocked(authBridge.applyCodexAppServerAuthProfile).mockImplementationOnce(async () => {
        await park();
        return undefined;
      });
    } else if (boundary === "runtime-binding") {
      const runtimeArtifact = await import("./runtime-artifact.js");
      vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockImplementation((options) =>
        getLeasedSharedCodexAppServerClient({ ...options, runtimeArtifactMode: "capture" }),
      );
      vi.spyOn(
        runtimeArtifact,
        "captureCodexAppServerRuntimeArtifactBeforeStart",
      ).mockResolvedValue({
        kind: "configured-connection",
        transport: "websocket",
        selectionFingerprint: "synthetic-selection",
      });
      vi.spyOn(runtimeArtifact, "finalizeCodexAppServerRuntimeArtifact").mockImplementationOnce(
        async () => {
          await park();
          return { id: "synthetic-artifact", fingerprint: "synthetic-fingerprint" };
        },
      );
    }
    const run = vi.fn(async () => undefined);
    const result = withCodexAppServerJsonClient({ timeoutMs: 50 }, run).catch(
      (error: unknown) => error,
    );
    if (boundary === "initialize") {
      await harness.waitForWrite(0);
    } else {
      await entered.promise;
    }
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ message: "codex app-server request timed out" });
    const warning = vi
      .mocked(embeddedAgentLog.warn)
      .mock.calls.find(([message]) => message === "codex app-server scope timed out");
    expect(warning?.[1]).toMatchObject({
      phase: "acquire-client",
      acquireLastObservedBoundary: boundary,
      scopeAttemptOrdinal: 1,
      requestStartedCount: 0,
      currentRequestCount: 0,
    });
    expect(warning?.[1]).not.toHaveProperty("clientInstanceId");
    if (boundary === "initialize") {
      expect(JSON.parse(String(warning?.[1]?.initializeSnapshot))).toMatchObject({
        boundary: "request",
        outcome: "pending",
        wireOutcome: "retained-pending",
        writeState: "callback-ok",
        clientClosed: false,
      });
      expect(warning?.[1]).not.toHaveProperty("initializeBeforeCleanup");
    }
    if (
      ["initialize", "catalog-observation", "runtime-binding", "auth-handoff"].includes(boundary)
    ) {
      expect(warning?.[1]).toHaveProperty(
        "lastStartedClientInstanceId",
        harness.client.getInstanceId(),
      );
    } else {
      expect(warning?.[1]).not.toHaveProperty("lastStartedClientInstanceId");
    }
    expect(run).not.toHaveBeenCalled();
    finish.resolve();
    harness.emitExit();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("retains the blocked boundary when an inner deadline joins cleanup before the scope times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    vi.spyOn(embeddedAgentLog, "isEnabled").mockReturnValue(true);
    vi.mocked(embeddedAgentLog.warn).mockClear();
    const harness = createClientHarness();
    vi.spyOn(harness.client, "getRegisteredTransportIdentity").mockReturnValue({
      pid: 500002,
      startedAt: "fixture-boot:12345",
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockImplementation((options) =>
      getLeasedSharedCodexAppServerClient({ ...options, timeoutMs: 5 }),
    );
    const finish = createDeferred<void>();
    const close = harness.client.closeAndWait.bind(harness.client);
    const closing = vi.spyOn(harness.client, "closeAndWait").mockImplementation(async () => {
      harness.client.close();
      await finish.promise;
      return await close();
    });
    const result = withCodexAppServerJsonClient({ timeoutMs: 50 }, async () => undefined).catch(
      (error: unknown) => error,
    );
    await harness.waitForWrite(0);
    await vi.advanceTimersByTimeAsync(5);
    expect(closing).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45);
    expect(await result).toMatchObject({ message: "codex app-server request timed out" });
    expect(
      vi
        .mocked(embeddedAgentLog.warn)
        .mock.calls.find(([message]) => message === "codex app-server scope timed out")?.[1],
    ).toMatchObject({
      phase: "acquire-client",
      acquireLastObservedBoundary: "cleanup",
      acquireBoundaryBeforeCleanup: "initialize",
      lastStartedClientInstanceId: harness.client.getInstanceId(),
    });
    const attributes = vi
      .mocked(embeddedAgentLog.warn)
      .mock.calls.find(([message]) => message === "codex app-server scope timed out")?.[1];
    expect(JSON.parse(String(attributes?.lastStartedTransportIdentity))).toEqual({
      pid: 500002,
      startedAt: "fixture-boot:12345",
    });
    expect(JSON.parse(String(attributes?.initializeBeforeCleanup))).toMatchObject({
      outcome: "pending",
      wireOutcome: "retained-pending",
      clientClosed: false,
    });
    expect(attributes?.initializeBeforeCleanupSource).toBe("before-client-close");
    expect(JSON.parse(String(attributes?.initializeSnapshot))).toMatchObject({
      outcome: "failed",
      wireOutcome: "correlation-closed",
      clientClosed: true,
    });
    finish.resolve();
    harness.emitExit();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("observes shared joins and ready hits without retaining cancelled observers", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    const releaseAuth = deferNextAuthProfileApplication();
    const firstObservations: CodexAppServerAcquireObservation[] = [];
    const joinedObservations: CodexAppServerAcquireObservation[] = [];
    const controller = new AbortController();
    const first = getSharedCodexAppServerClient({
      abandonSignal: controller.signal,
      onAcquireObservation: (observation) => firstObservations.push(observation),
    });
    const rejection = expect(first).rejects.toThrow("codex app-server initialize aborted");
    await harness.waitForWrite(0);
    const joinedAtInitialize = createDeferred<void>();
    const reachedAuth = createDeferred<void>();
    const second = getSharedCodexAppServerClient({
      onAcquireObservation: (observation) => {
        joinedObservations.push(observation);
        if (observation.startup === "joined-shared") {
          joinedAtInitialize.resolve();
        }
        if (observation.boundary === "auth-handoff") {
          reachedAuth.resolve();
        }
        throw new Error("synthetic diagnostic observer failure");
      },
    });
    await joinedAtInitialize.promise;
    expect(joinedObservations.at(-1)).toEqual({ boundary: "initialize", startup: "joined-shared" });
    controller.abort();
    await rejection;
    const cancelledCount = firstObservations.length;
    await sendInitializeResult(harness, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
    await reachedAuth.promise;
    expect(joinedObservations.at(-1)).toEqual({ boundary: "auth-handoff" });
    expect(firstObservations).toHaveLength(cancelledCount);
    expect(harness.process.stdin.destroyed).toBe(false);
    releaseAuth();
    await expect(second).resolves.toBe(harness.client);
    const hit: CodexAppServerAcquireObservation[] = [];
    await expect(
      getSharedCodexAppServerClient({ onAcquireObservation: (value) => hit.push(value) }),
    ).resolves.toBe(harness.client);
    expect(hit).toContainEqual({ boundary: "ready", startup: "ready-cache-hit" });
    expect(firstObservations).toContainEqual({
      boundary: "entry-selection",
      startup: "created-shared",
    });
    expect(joinedObservations.map((value) => value.boundary)).toEqual([
      "context",
      "entry-selection",
      "initialize",
      "catalog-observation",
      "runtime-binding",
      "auth-handoff",
      "ready",
    ]);
    expect(startSpy).toHaveBeenCalledOnce();
  });
}
