import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { createBootstrapDiagnostic } from "./bootstrap-diagnostics.test-support.js";

afterEach(() => vi.restoreAllMocks());
const eventFrame = (method: string, params: Record<string, unknown>) =>
  JSON.stringify({ method, params });

function observerFixture(sink = () => true) {
  const output = vi.spyOn(process.stderr, "write").mockImplementation(sink);
  const diagnostic = createBootstrapDiagnostic();
  let reply: ((raw: string) => void) | undefined;
  const receive = vi.fn();
  const bridge = {
    cdpClientCount: 0,
    attachCdpClientSocket(this: void, socket) {
      bridge.cdpClientCount++;
      reply = socket.send;
      return {
        onMessage: receive,
        onClose: async () => {
          bridge.cdpClientCount--;
          socket.close();
        },
      };
    },
  } satisfies Pick<ExtensionRelayBridge, "attachCdpClientSocket" | "cdpClientCount">;
  const original = bridge.attachCdpClientSocket;
  diagnostic.watchRelay(bridge);
  const send = vi.fn();
  const callbacks = bridge.attachCdpClientSocket({ send, close: vi.fn() });
  diagnostic.arm("private-selected", "private-unrelated");
  const respond = (raw: string) => reply?.(raw);
  return { output, diagnostic, bridge, original, receive, send, callbacks, respond };
}

it("projects only fixed names and ordinals while forwarding exact bytes", () => {
  const { output, diagnostic, bridge, original, receive, send, callbacks, respond } =
    observerFixture();
  const command =
    `{"id":42,"method":"Page.navigate","sessionId":"private-session",` +
    `"params":{"url":"https://private.invalid","headers":{"authorization":"private-credential"}}}`;
  callbacks.onMessage(command);
  const response = JSON.stringify({ id: 42, error: { message: "private-error" } });
  respond(response);
  const event = eventFrame("Runtime.consoleAPICalled", { args: ["private-content"] });
  respond(event);
  callbacks.onMessage("private-malformed");
  diagnostic.flush();
  expect(receive.mock.calls).toEqual([[command], ["private-malformed"]]);
  expect(send.mock.calls).toEqual([[response], [event]]);
  const printed = String(output.mock.calls[0]?.[0]);
  expect(printed).not.toMatch(/private-|Runtime\.consoleAPICalled/);
  expect(printed).toContain('"method":"Page.navigate"');
  expect(printed).toContain('"error":true');
  diagnostic.dispose();
  expect(bridge.attachCdpClientSocket).toBe(original);
});

it("caps flood output but retains the action outcome and teardown", async () => {
  const { output, diagnostic, callbacks, respond } = observerFixture();
  for (let index = 0; index < 1_000; index++) {
    respond(eventFrame("Network.requestWillBeSent", { requestId: `request-${index}` }));
  }
  diagnostic.mark("navigate.status", 500);
  diagnostic.flush();
  await callbacks.onClose();
  diagnostic.mark("relay.closed", true);
  diagnostic.flush();
  diagnostic.flush();
  const printed = output.mock.calls.map(([value]) => String(value)).join("");
  expect(output).toHaveBeenCalledTimes(2);
  expect(printed.length).toBeLessThan(100_000);
  expect(printed).toContain('"phase":"navigate.status","value":500');
  expect(printed).toContain('"phase":"relay.closed","value":true');
  expect(printed).not.toContain('"dropped":0');
});

it("preserves a transport exception and ignores a diagnostic sink exception", () => {
  const { diagnostic, receive, callbacks } = observerFixture(() => {
    throw new Error("sink");
  });
  const failure = new Error("transport");
  receive.mockImplementation(() => {
    throw failure;
  });
  expect(() => callbacks.onMessage("malformed")).toThrow(failure);
  expect(() => diagnostic.flush()).not.toThrow();
});
