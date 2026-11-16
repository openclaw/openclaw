import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { CallManager } from "../manager.js";
import type { ToolHandlerContext } from "../types.js";
import {
  createRealtimeConfig,
  makeBridge,
  makeCall,
  makeRealtimeProvider,
  managedHandler,
  updateCallMetadata,
} from "./realtime-call-control.test-helpers.js";
import { DtmfElevationGate } from "./realtime-dtmf-elevation.js";
import {
  connectCarrierStream,
  sendCarrierStart,
} from "./realtime-handler.lifecycle.test-helpers.js";

const PIN = "24681357";
type BridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

function sendDigits(ws: WebSocket, digits: string) {
  for (const digit of digits) {
    ws.send(
      JSON.stringify({ event: "dtmf", streamSid: "MZ-1", dtmf: { track: "inbound", digit } }),
    );
  }
}

function sendMedia(ws: WebSocket, byte: number) {
  ws.send(
    JSON.stringify({
      event: "media",
      media: { payload: Buffer.alloc(160, byte).toString("base64") },
    }),
  );
}

function elevationFixture(gate = createGate()) {
  const call = makeCall("CA-elevate", { callId: "call-elevate" });
  const requests: BridgeRequest[] = [];
  const bridges: Array<{ sendAudio: Mock; sendUserMessage: Mock }> = [];
  const provider = makeRealtimeProvider((request) => {
    requests.push(request);
    const mocks = { sendAudio: vi.fn(), sendUserMessage: vi.fn() };
    bridges.push(mocks);
    return makeBridge(mocks);
  });
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const endCall = vi.fn<CallManager["endCall"]>(async () => ({ success: true }));
  const handler = managedHandler(
    createRealtimeConfig(),
    {
      processEvent,
      endCall,
      updateCallMetadata,
      getCallByProviderCallId: vi.fn(() => call),
    } as unknown as CallManager,
    () => ({
      agentId: "main",
      instructions: "Be helpful.",
      provider,
      providerConfig: { apiKey: "test-key" },
    }),
    undefined,
    gate,
  );
  const consult = vi.fn(async (_args: unknown, _callId: string, _context: ToolHandlerContext) => ({
    text: "ok",
  }));
  handler.registerToolHandler("openclaw_agent_consult", consult);
  const connect = async () => {
    const count = requests.length;
    const { ws } = await connectCarrierStream(handler);
    sendCarrierStart(ws, "MZ-1", call.providerCallId);
    await vi.waitFor(() => expect(requests).toHaveLength(count + 1), { interval: 1 });
    return {
      ws,
      request: expectDefined(requests[count], "bridge request"),
      bridge: expectDefined(bridges[count], "bridge"),
    };
  };
  const consultPolicy = async (request: BridgeRequest, id: string) => {
    const before = consult.mock.calls.length;
    request.onToolCall?.({
      itemId: id,
      callId: id,
      name: "openclaw_agent_consult",
      args: { question: "What is on my calendar?" },
    });
    await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(before + 1), { interval: 1 });
    return expectDefined(consult.mock.calls.at(-1), "consult call")[2].toolPolicy;
  };
  const lastConsultContext = () => consult.mock.calls.at(-1)?.[2];
  return { call, handler, processEvent, endCall, connect, consultPolicy, lastConsultContext };
}

function createGate(maxAttempts = 3) {
  return new DtmfElevationGate({
    pin: PIN,
    config: { prefix: "*", elevatedToolPolicy: "owner", maxAttempts, lockoutMs: 60_000 },
    allowFrom: ["+15550001234"],
  });
}

describe("realtime keypad PIN elevation", () => {
  it("elevates only the current call's consult policy and never leaks the digits", async () => {
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const fixture = elevationFixture();
    const { ws, request, bridge } = await fixture.connect();

    await expect(fixture.consultPolicy(request, "tool-1")).resolves.toBe("safe-read-only");

    sendDigits(ws, "*");
    sendMedia(ws, 0x11);
    sendDigits(ws, `${PIN}#`);
    await vi.waitFor(() => expect(bridge.sendUserMessage).toHaveBeenCalledOnce(), {
      interval: 1,
    });
    expect(String(bridge.sendUserMessage.mock.calls[0]?.[0])).toContain("now elevated");
    // Caller audio while entering the PIN is withheld from the model.
    expect(bridge.sendAudio).not.toHaveBeenCalled();
    sendMedia(ws, 0x22);
    await vi.waitFor(() => expect(bridge.sendAudio).toHaveBeenCalledOnce(), { interval: 1 });

    await expect(fixture.consultPolicy(request, "tool-2")).resolves.toBe("owner");

    const leaked = [
      ...fixture.processEvent.mock.calls,
      ...bridge.sendUserMessage.mock.calls,
      ...logs.flatMap((spy) => spy.mock.calls),
    ]
      .map((args) => JSON.stringify(args))
      .filter((text) => text.includes(PIN));
    expect(leaked).toEqual([]);
    expect(logs[0]?.mock.calls.flat().join("\n")).toContain(
      "Realtime keypad elevation granted callId=call-elevate toolPolicy=owner",
    );
  });

  it("drops elevation when the call's stream closes", async () => {
    const fixture = elevationFixture();
    const first = await fixture.connect();
    sendDigits(first.ws, `*${PIN}#`);
    await vi.waitFor(() => expect(first.bridge.sendUserMessage).toHaveBeenCalledOnce(), {
      interval: 1,
    });
    await expect(fixture.consultPolicy(first.request, "tool-1")).resolves.toBe("owner");

    first.ws.close();
    const second = await fixture.connect();
    await expect(fixture.consultPolicy(second.request, "tool-2")).resolves.toBe("safe-read-only");
    // The reconnected call's transcript still holds elevated answers, so its consults stay in the
    // call's isolated session even though the tool policy reset.
    expect(fixture.lastConsultContext()?.elevated).toBe(true);
  });

  it("hangs up after max wrong PINs and locks the caller out of later calls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate = createGate(2);
    const fixture = elevationFixture(gate);
    const { ws, bridge } = await fixture.connect();

    sendDigits(ws, "*1111#");
    await vi.waitFor(() => expect(bridge.sendUserMessage).toHaveBeenCalledOnce(), {
      interval: 1,
    });
    expect(String(bridge.sendUserMessage.mock.calls[0]?.[0])).toContain("not accepted");
    expect(fixture.endCall).not.toHaveBeenCalled();
    sendDigits(ws, "*2222#");
    await vi.waitFor(() => expect(fixture.endCall).toHaveBeenCalledWith("call-elevate"), {
      interval: 1,
    });
    expect(warn.mock.calls.flat().join("\n")).toMatch(
      /attempt=2\/2[\s\S]*locked out caller=sha256:[0-9a-f]+; hanging up callId=call-elevate/,
    );

    // The lockout outlives the call: the correct PIN is refused on the next call, which hangs up.
    const next = elevationFixture(gate);
    const retry = await next.connect();
    sendDigits(retry.ws, `*${PIN}#`);
    await vi.waitFor(() => expect(next.endCall).toHaveBeenCalledWith("call-elevate"), {
      interval: 1,
    });
    expect(retry.bridge.sendUserMessage).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/elevation granted/);
  });
});
