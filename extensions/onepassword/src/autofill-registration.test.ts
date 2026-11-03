import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import { registerAutofill } from "./autofill-registration.js";
import { AutofillService } from "./autofill-service.js";
import { MemoryKeyedStore } from "./memory-store.test-support.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type Options = Parameters<Handler>[0];

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const methods = new Map<string, Handler>();
  const policies = new Map<string, unknown>();
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const config = { agenticAutofill: { enabled: true } };
  const base = createTestPluginApi();
  const unexpectedStore = () => {
    throw new Error("This RPC fixture must not access stored credentials.");
  };
  const eventTarget = Object.freeze({});
  const system = {
    ...base.runtime.system,
    captureSessionEventTarget: vi.fn(async () => eventTarget),
    enqueueSessionEvent: vi.fn(() => ({
      id: "event",
      cancel: () => false,
      accepted: Promise.resolve({ ok: true as const }),
      settled: new Promise<never>(() => {}),
    })),
  } as unknown as typeof base.runtime.system;
  const api = createTestPluginApi({
    pluginConfig: config,
    runtime: {
      ...base.runtime,
      system,
      state: {
        ...base.runtime.state,
        openKeyedStoreV2: <T>(): PluginStateKeyedStore<T, 2> =>
          Object.assign(new MemoryKeyedStore<T>(), {
            observe: unexpectedStore,
            compareAndApply: unexpectedStore,
            deleteIfEqual: unexpectedStore,
            entriesInKeyRange: unexpectedStore,
            moveEntriesFrom: unexpectedStore,
            count: unexpectedStore,
          }),
      },
    },
    session: {
      ...base.session,
      controls: { ...base.session.controls, registerControlUiDescriptor: vi.fn() },
    },
    registerTool: vi.fn(),
    inlineView: vi.fn(),
    registerService: (service: (typeof services)[number]) => services.push(service),
    registerGatewayMethod(name: string, handler: Handler, policy: unknown) {
      methods.set(name, handler);
      policies.set(name, policy);
    },
  });
  registerAutofill(api, () => config);
  const handler = methods.get("onepassword.autofill.approval")!;
  const assertCurrent = vi.fn();
  const release = vi.fn();
  const retained = { signal: new AbortController().signal, assertCurrent, release };
  const options: Pick<
    Options,
    "params" | "client" | "hasCurrentClientAuthority" | "sessionAccessAuthority"
  > = {
    params: { requestId: "request", sessionKey: "agent:main:chat" },
    client: {
      internal: { authenticatedControlUi: true },
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        scopes: ["operator.admin"],
      },
    },
    hasCurrentClientAuthority: () => true,
    sessionAccessAuthority: {
      sandboxRequired: false,
      release() {},
      retainSession: () => retained,
      target: { agentId: "main", sessionKey: "agent:main:chat", sessionId: "incarnation" },
      assertCurrent,
      retain: () => retained,
    },
  };
  return {
    api,
    handler,
    options: options as Options,
    policies,
    services,
    retained,
    system,
    eventTarget,
  };
}

it("exposes the autofill tool by default once the feature is enabled", () => {
  expect(vi.mocked(fixture().api.registerTool).mock.calls[0]![1]).not.toHaveProperty("optional");
});

it("requires current real Control UI admin and admitted session access before hydrating", async () => {
  const f = fixture();
  const hydrate = vi.spyOn(AutofillService.prototype, "approval").mockResolvedValue({
    goal: "Sign in",
    entries: [],
    state: "pending",
    appLink: "onepassword://synthetic-private",
    expiresAt: 600_000,
  });
  expect(f.policies.get("onepassword.autofill.approval")).toEqual({
    scope: "operator.write",
    sessionAccess: { mode: "write", requiredTool: "onepassword_autofill" },
  });
  await f.handler(f.options);
  expect(hydrate).toHaveBeenCalledWith(
    "request",
    JSON.stringify(["agent:main:chat", "incarnation"]),
    expect.anything(),
  );
  for (const change of [
    () => {
      f.options.client!.connect.scopes = ["operator.read"];
    },
    () => {
      f.options.client!.internal!.syntheticClient = true;
    },
    () => {
      f.options.client!.internal!.authenticatedControlUi = undefined;
    },
    () => {
      f.options.hasCurrentClientAuthority = () => false;
    },
    () => {
      f.options.sessionAccessAuthority = undefined;
    },
  ]) {
    const next = fixture();
    Object.assign(f.options, next.options);
    change();
    expect(await f.handler(f.options)).toEqual({ state: "error", code: "gatewayOwnerRequired" });
  }
  expect(hydrate).toHaveBeenCalledTimes(1);
});

it("starts a single service-owned checker from the click with retained authority, not the completed RPC", async () => {
  const f = fixture();
  const hydrate = vi.spyOn(AutofillService.prototype, "approval").mockResolvedValue({
    goal: "Sign in",
    entries: [],
    state: "pending",
    appLink: "onepassword://synthetic-private",
    expiresAt: 600_000,
  });
  const opened = vi.spyOn(AutofillService.prototype, "noteApprovalOpened").mockResolvedValue();
  const checker = vi.spyOn(AutofillService.prototype, "checkStatus").mockResolvedValue({
    state: "resolved",
    requestId: "request",
    entries: [
      { entryId: "entry", website: "https://example.com/login", label: "Login", granted: true },
    ],
    guidance: "Request finished.",
  });
  const browser = await import("./autofill-browser.js");
  vi.spyOn(browser.BrowserAutofillExtension.prototype, "start").mockResolvedValue();
  vi.spyOn(browser.BrowserAutofillExtension.prototype, "close").mockResolvedValue();
  const jobs: Array<() => void | Promise<unknown>> = [];
  const abort = new AbortController();
  const scheduler = {
    version: 1 as const,
    signal: abort.signal,
    now: Date.now,
    schedule: vi.fn((job: { run: () => void | Promise<unknown> }) => {
      jobs.push(job.run);
      return { cancel() {}, stop: async () => {} };
    }),
    scope: vi.fn(),
    beginClose() {},
    stop: async () => {},
  };
  const service = f.services[0]!;
  const serviceContext = {
    scheduler,
    config: {},
    stateDir: "/tmp/onepassword-approval-test",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await service.start(serviceContext);
  f.options.params.action = "opened";
  expect(await f.handler(f.options)).toMatchObject({ state: "pending" });
  expect(opened).toHaveBeenCalledTimes(1);
  expect(checker).not.toHaveBeenCalled();
  expect(scheduler.schedule.mock.calls[1]?.[0]).toMatchObject({ delayMs: 0 });
  // The RPC lifetime may close immediately after its response; the explicit borrow remains current.
  f.options.hasCurrentClientAuthority = () => false;
  await jobs[1]!();
  expect(checker).toHaveBeenCalledWith(
    "request",
    JSON.stringify(["agent:main:chat", "incarnation"]),
    true,
    expect.objectContaining({
      assertCurrent: f.retained.assertCurrent,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(f.retained.release).toHaveBeenCalledTimes(1);
  // The finished checker resumes the session captured at click time.
  expect(f.system.captureSessionEventTarget).toHaveBeenCalledWith("main", "agent:main:chat");
  expect(f.system.enqueueSessionEvent).toHaveBeenCalledTimes(1);
  const [text, eventOptions] = vi.mocked(f.system.enqueueSessionEvent).mock.calls[0]!;
  expect(text).toContain("requestId=request");
  expect(text).toContain("Granted entryIds: entry.");
  expect(text).not.toContain("onepassword://");
  expect(eventOptions).toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:chat",
    expectedTarget: f.eventTarget,
  });
  f.options.hasCurrentClientAuthority = () => true;
  const forget = vi.spyOn(AutofillService.prototype, "forgetApprovalLink");
  checker.mockRejectedValueOnce(new Error("onepassword://synthetic-private-error"));
  await f.handler(f.options);
  await jobs[2]!();
  expect(forget).toHaveBeenCalledWith("request");
  expect(f.system.enqueueSessionEvent).toHaveBeenCalledTimes(1);
  expect(f.retained.release).toHaveBeenCalledTimes(2);
  scheduler.schedule.mockImplementationOnce(() => {
    throw new Error("scheduler closed");
  });
  expect(await f.handler(f.options)).toEqual({ state: "error", code: "operationFailed" });
  expect(forget).toHaveBeenCalledTimes(2);
  expect(f.retained.release).toHaveBeenCalledTimes(3);
  const scheduled = scheduler.schedule.mock.calls.length;
  const acknowledged = opened.mock.calls.length;
  hydrate.mockResolvedValueOnce({
    state: "pending",
    appLink: "onepassword://synthetic-private",
    openedAt: 1000,
    deadline: 121_000,
  });
  expect(await f.handler(f.options)).toMatchObject({ openedAt: 1000 });
  expect(scheduler.schedule).toHaveBeenCalledTimes(scheduled);
  expect(opened).toHaveBeenCalledTimes(acknowledged);
  await service.stop?.(serviceContext);
});

it("rechecks the viewer after awaited hydration before returning the private URL", async () => {
  const f = fixture();
  vi.spyOn(AutofillService.prototype, "approval").mockImplementationOnce(async () => {
    f.options.hasCurrentClientAuthority = () => false;
    return {
      goal: "Sign in",
      entries: [],
      state: "pending",
      appLink: "onepassword://synthetic-private",
      expiresAt: 600_000,
    };
  });
  const result = await f.handler(f.options);
  expect(result).toEqual({ state: "error", code: "gatewayOwnerRequired" });
  expect(JSON.stringify(result)).not.toContain("onepassword://");
});
