import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import setupPlugin from "./setup-api.js";

const { createAcpxRuntimeServiceMock, tryDispatchAcpReplyHookMock } = vi.hoisted(() => ({
  createAcpxRuntimeServiceMock: vi.fn(),
  tryDispatchAcpReplyHookMock: vi.fn(),
}));

vi.mock("./register.runtime.js", () => ({
  createAcpxRuntimeService: createAcpxRuntimeServiceMock,
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  tryDispatchAcpReplyHook: tryDispatchAcpReplyHookMock,
}));

import plugin, { tryDispatchAcpReplyHookWithControlBypass } from "./index.js";

type AcpxAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerAcpxAutoEnableProbe(): AcpxAutoEnableProbe {
  const probes: AcpxAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected ACPX setup plugin to register an auto-enable probe");
  }
  return probe;
}

function buildEvent(body: string, extra?: Record<string, unknown>) {
  return {
    ctx: {
      Body: body,
      BodyForCommands: body,
      ...extra,
    },
    inboundAudio: false,
    shouldRouteToOriginating: false,
    shouldSendToolSummaries: false,
    sendPolicy: "allow" as const,
  };
}

const fakeHookCtx = {} as Parameters<typeof tryDispatchAcpReplyHookWithControlBypass>[1];

describe("acpx plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the runtime service and reply_dispatch hook", () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);

    const api = {
      pluginConfig: { stateDir: "/tmp/acpx" },
      registerService: vi.fn(),
      on: vi.fn(),
    };

    plugin.register(api as never);

    expect(createAcpxRuntimeServiceMock).toHaveBeenCalledWith({
      pluginConfig: api.pluginConfig,
    });
    expect(api.registerService).toHaveBeenCalledWith(service);
    expect(api.on).toHaveBeenCalledWith("reply_dispatch", tryDispatchAcpReplyHookWithControlBypass);
  });

  it("preserves the ACP reply_dispatch runtime path through the registered hook", async () => {
    const service = { id: "acpx-service", start: vi.fn() };
    createAcpxRuntimeServiceMock.mockReturnValue(service);
    tryDispatchAcpReplyHookMock.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });

    const on = vi.fn();
    const api = createTestPluginApi({
      pluginConfig: { stateDir: "/tmp/acpx" },
      registerService: vi.fn(),
      on,
    });

    plugin.register(api);

    const hook = on.mock.calls.find(([hookName]) => hookName === "reply_dispatch")?.[1];
    if (!hook) {
      throw new Error("expected reply_dispatch hook to be registered");
    }

    const event = {
      ctx: { raw: "reply ctx" },
      runId: "run-1",
      sessionKey: "agent:test:session",
      inboundAudio: false,
      shouldRouteToOriginating: false,
      shouldSendToolSummaries: true,
      sendPolicy: "allow",
    };
    const ctx = {
      cfg: {},
      dispatcher: { dispatch: vi.fn(), getQueuedCounts: vi.fn(), getFailedCounts: vi.fn() },
      recordProcessed: vi.fn(),
      markIdle: vi.fn(),
    };

    await expect(hook(event, ctx)).resolves.toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 0, final: 1 },
    });
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalledWith(event, ctx);
  });

  it("declares setup auto-enable reasons for ACPX-owned ACP config", () => {
    const probe = registerAcpxAutoEnableProbe();

    expect(probe({ config: { acp: { enabled: true } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { backend: "acpx" } }, env: {} })).toBe("ACP runtime configured");
    expect(probe({ config: { acp: { enabled: true, backend: "custom-runtime" } }, env: {} })).toBe(
      null,
    );
  });
});

describe("tryDispatchAcpReplyHookWithControlBypass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryDispatchAcpReplyHookMock.mockResolvedValue(undefined);
  });

  it.each([
    ["/acp"],
    ["/acp close"],
    ["/acp cancel"],
    ["/acp status"],
    ["/acp sessions"],
    ["/unfocus"],
    ["/focus some-session"],
    ["  /acp close  "],
    ["/ACP CLOSE"],
  ])("skips ACP dispatch for control command %s", async (body) => {
    const result = await tryDispatchAcpReplyHookWithControlBypass(buildEvent(body), fakeHookCtx);
    expect(result).toBeUndefined();
    expect(tryDispatchAcpReplyHookMock).not.toHaveBeenCalled();
  });

  it("prefers CommandBody over Body when classifying", async () => {
    const event = buildEvent("not a command", { CommandBody: "/acp close" });
    const result = await tryDispatchAcpReplyHookWithControlBypass(event, fakeHookCtx);
    expect(result).toBeUndefined();
    expect(tryDispatchAcpReplyHookMock).not.toHaveBeenCalled();
  });

  it("still runs ACP dispatch for normal prompts", async () => {
    tryDispatchAcpReplyHookMock.mockResolvedValue({ handled: true, queuedFinal: true });
    const event = buildEvent("write a test for me");
    const result = await tryDispatchAcpReplyHookWithControlBypass(event, fakeHookCtx);
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalledWith(event, fakeHookCtx);
    expect(result).toEqual({ handled: true, queuedFinal: true });
  });

  it("does not match words that merely start with acp- or focus-", async () => {
    for (const body of ["/acpfoo", "/focuser", "/unfocused"]) {
      tryDispatchAcpReplyHookMock.mockClear();
      await tryDispatchAcpReplyHookWithControlBypass(buildEvent(body), fakeHookCtx);
      expect(tryDispatchAcpReplyHookMock).toHaveBeenCalled();
    }
  });

  it("does not match plain text that mentions /acp", async () => {
    const event = buildEvent("please explain /acp spawn to me");
    await tryDispatchAcpReplyHookWithControlBypass(event, fakeHookCtx);
    // candidate starts with "please", not "/acp" — must delegate to ACP
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalled();
  });

  it("does not match empty bodies", async () => {
    const event = buildEvent("");
    await tryDispatchAcpReplyHookWithControlBypass(event, fakeHookCtx);
    expect(tryDispatchAcpReplyHookMock).toHaveBeenCalled();
  });
});
