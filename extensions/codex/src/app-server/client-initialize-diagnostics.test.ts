import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import * as diagnostics from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexRequestTimeoutDiagnostics } from "./request-diagnostics.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const harnesses: ReturnType<typeof createClientHarness>[] = [];
function harness(options: Parameters<typeof createClientHarness>[0] = {}) {
  const created = createClientHarness({ autoEmitExit: false, ...options });
  harnesses.push(created);
  return created;
}
function initialize(client: ReturnType<typeof createClientHarness>["client"]) {
  return client.initialize().catch((error: unknown) => error);
}
afterEach(() => {
  for (const fixture of harnesses.splice(0)) {
    fixture.client.close();
    fixture.emitExit();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["ok", "error"] as const)(
  "distinguishes pending write callback from callback %s and native response",
  async (outcome) => {
    let complete!: (error?: Error | null) => void;
    const fixture = harness({
      onWriteCallback: (callback) => {
        complete = callback;
      },
    });
    expect(fixture.client.getInitializeDiagnostic()).toBeUndefined();
    const result = initialize(fixture.client);
    await fixture.waitForWrite(0);
    const pending = fixture.client.getInitializeDiagnostic();
    expect(pending).toMatchObject({
      outcome: "pending",
      writeState: "possible-write",
      wireOutcome: "retained-pending",
    });
    complete(outcome === "error" ? new Error("synthetic write failure") : undefined);
    if (outcome === "error") {
      expect(await result).toBeInstanceOf(Error);
      expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
        outcome: "failed",
        writeState: "callback-error",
        wireOutcome: "correlation-closed",
      });
    } else {
      expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
        outcome: "pending",
        writeState: "callback-ok",
        wireOutcome: "retained-pending",
      });
      fixture.client.close();
      await result;
    }
    expect(pending).toMatchObject({
      outcome: "pending",
      writeState: "possible-write",
      wireOutcome: "retained-pending",
    });
  },
);

it.each(["prewrite", "stdin-error", "exit"] as const)(
  "does not classify %s as a native response",
  async (failure) => {
    const fixture = harness({ maxFrameBytes: failure === "prewrite" ? 1 : undefined });
    const result = initialize(fixture.client);
    if (failure === "stdin-error") {
      fixture.process.stdin.emit("error", new Error("synthetic pipe failure"));
    }
    if (failure === "exit") {
      fixture.process.emit("exit", 1, null);
    }
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
      outcome: "failed",
      wireOutcome: failure === "prewrite" ? "not-written" : "correlation-closed",
      waiterOutcome: failure === "prewrite" ? "local-failed" : "client-closed",
    });
  },
);

it.each(["success", "version-rejected", "native-error"] as const)(
  "preserves a matching native response through %s and later close",
  async (outcome) => {
    const fixture = harness({
      onWrite(line, send) {
        const message = JSON.parse(line);
        if (message.method !== "initialize") {
          return;
        }
        send(
          outcome === "native-error"
            ? { id: message.id, error: { code: -32600, message: "synthetic native failure" } }
            : {
                id: message.id,
                result: {
                  userAgent:
                    outcome === "success" ? `codex-cli/${CODEX_APP_SERVER_VERSION}` : "unsupported",
                },
              },
        );
      },
    });
    const result = await initialize(fixture.client);
    expect(result === undefined).toBe(outcome === "success");
    fixture.client.close();
    const beforeClose = fixture.client.getInitializeDiagnostic(true);
    fixture.client.close();
    expect(fixture.client.getInitializeDiagnostic(true)).toEqual(beforeClose);
    expect(beforeClose?.clientClosed).toBe(false);
    expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
      outcome: outcome === "success" ? "succeeded" : "failed",
      boundary:
        outcome === "success"
          ? "ready"
          : outcome === "version-rejected"
            ? "version-validation"
            : "request",
      wireOutcome: outcome === "native-error" ? "native-error" : "native-ok",
      clientClosed: true,
    });
    expect(JSON.stringify(fixture.client.getInitializeDiagnostic())).not.toContain(
      "synthetic native failure",
    );
  },
);

it("keeps ingress rejection during backoff and isolates an old write callback from its replacement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  const callbacks: Array<(error?: Error | null) => void> = [];
  const fixture = harness({ onWriteCallback: (callback) => callbacks.push(callback) });
  const result = initialize(fixture.client);
  const first = JSON.parse(await fixture.waitForWrite(0));
  fixture.send({ id: first.id, error: { code: -32001, message: "Server overloaded" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
    outcome: "pending",
    overloadAttemptOrdinal: 1,
    wireOutcome: "ingress-rejected",
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
    overloadAttemptOrdinal: 2,
    writeState: "possible-write",
    wireOutcome: "retained-pending",
  });
  callbacks[0]!();
  const second = JSON.parse(await fixture.waitForWrite(1));
  expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
    overloadAttemptOrdinal: 2,
    writeState: "possible-write",
    wireOutcome: "retained-pending",
  });
  fixture.send({ id: second.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
  expect(await result).toBeUndefined();
  callbacks[1]!();
  callbacks[2]?.();
  expect(fixture.client.getInitializeDiagnostic()).toMatchObject({
    outcome: "succeeded",
    overloadAttemptOrdinal: 2,
    writeState: "callback-ok",
    wireOutcome: "native-ok",
  });
});

it.each(["scope-retry", "startup-fallback"] as const)(
  "does not project a previous physical client's late response after %s",
  async (replacement) => {
    vi.spyOn(diagnostics, "areDiagnosticsEnabledForProcess").mockReturnValue(true);
    vi.spyOn(embeddedAgentLog, "isEnabled").mockReturnValue(true);
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const scope = createCodexRequestTimeoutDiagnostics(50)!;
    const first = harness();
    const second = harness();
    const firstObserver = scope.beginAttempt(1);
    firstObserver.onStartedClient(first.client);
    const firstResult = initialize(first.client);
    const secondObserver = replacement === "scope-retry" ? scope.beginAttempt(2) : firstObserver;
    secondObserver.onStartedClient(second.client);
    const secondResult = initialize(second.client);
    const request = JSON.parse(await first.waitForWrite(0));
    first.send({
      id: request.id,
      error: { code: -32600, message: "synthetic-private-native-error" },
    });
    await firstResult;
    if (replacement === "scope-retry") {
      firstObserver.onStartedClient(first.client);
    }
    scope.timeout();
    const attributes = warn.mock.calls.find(
      ([message]) => message === "codex app-server scope timed out",
    )?.[1];
    expect(attributes).toMatchObject({
      lastStartedClientInstanceId: second.client.getInstanceId(),
    });
    expect(JSON.parse(String(attributes?.initializeSnapshot))).toMatchObject({
      outcome: "pending",
      wireOutcome: "retained-pending",
      clientClosed: false,
    });
    expect(JSON.stringify(attributes)).not.toContain("synthetic-private-native-error");
    second.client.close();
    await secondResult;
  },
);
