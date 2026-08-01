// OpenClaw SDK tests cover transport behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientTransport } from "./transport.js";

type MockGatewayClientInstance = {
  opts: {
    onConnectError?: (error: Error) => void;
    onHelloOk?: (hello: unknown) => void;
  };
  request: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stopAndWait: ReturnType<typeof vi.fn>;
};

const gatewayClientMocks = vi.hoisted(() => ({
  instances: [] as MockGatewayClientInstance[],
}));

vi.mock("@openclaw/gateway-client", () => ({
  GatewayClient: class {
    readonly opts: MockGatewayClientInstance["opts"];
    readonly request = vi.fn();
    readonly start = vi.fn();
    readonly stopAndWait = vi.fn(async () => {});

    constructor(opts: MockGatewayClientInstance["opts"]) {
      this.opts = opts;
      gatewayClientMocks.instances.push(this);
    }
  },
}));

describe("GatewayClientTransport", () => {
  beforeEach(() => {
    gatewayClientMocks.instances.length = 0;
  });

  it("rejects a pending connect when the transport closes before hello-ok", async () => {
    const transport = new GatewayClientTransport();

    const connect = transport.connect();
    const connectExpectation = expect(connect).rejects.toThrow(
      "gateway transport closed before connect completed",
    );
    const client = gatewayClientMocks.instances[0];
    expect(client?.start).toHaveBeenCalledTimes(1);

    await transport.close();

    await connectExpectation;
    expect(client?.stopAndWait).toHaveBeenCalledTimes(1);
  });

  it("rejects reconnect attempts after close", async () => {
    const transport = new GatewayClientTransport();

    await transport.close();

    await expect(transport.connect()).rejects.toThrow("gateway transport is closed");
    expect(gatewayClientMocks.instances).toHaveLength(0);
  });

  it("resolves connect when a hello observer throws", async () => {
    const onHelloOk = vi.fn(() => {
      throw new Error("hello observer failed");
    });
    const transport = new GatewayClientTransport({ onHelloOk });

    const connect = transport.connect();
    const client = gatewayClientMocks.instances[0];

    expect(() => client?.opts.onHelloOk?.({ sessionId: "session-1" })).toThrow(
      "hello observer failed",
    );

    await expect(connect).resolves.toBeUndefined();
    expect(onHelloOk).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("keeps an established client alive through a transient reconnect failure", async () => {
    const onConnectError = vi.fn();
    const transport = new GatewayClientTransport({ onConnectError });
    const connecting = transport.connect();
    const client = gatewayClientMocks.instances[0];
    client?.opts.onHelloOk?.({ sessionId: "session-1" });
    await connecting;

    client?.opts.onConnectError?.(new Error("temporary reconnect failure"));

    expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "temporary reconnect failure" }),
    );
    expect(client?.stopAndWait).not.toHaveBeenCalled();
    client?.request.mockResolvedValueOnce({ ok: true });
    await expect(transport.request("status")).resolves.toEqual({ ok: true });
    expect(gatewayClientMocks.instances).toHaveLength(1);

    await transport.close();
  });

  it("ignores stale connect failures after a replacement client starts", async () => {
    const transport = new GatewayClientTransport();
    const firstConnect = transport.connect();
    const firstClient = gatewayClientMocks.instances[0];
    firstClient?.opts.onConnectError?.(new Error("first connection failed"));
    await expect(firstConnect).rejects.toThrow("first connection failed");

    const replacementConnect = transport.connect();
    const replacement = gatewayClientMocks.instances[1];
    firstClient?.opts.onConnectError?.(new Error("retired connection failed again"));
    replacement?.opts.onHelloOk?.({ sessionId: "replacement" });

    await expect(replacementConnect).resolves.toBeUndefined();
    expect(replacement?.stopAndWait).not.toHaveBeenCalled();

    await transport.close();
  });

  it("rejects connect when a connect-error observer throws", async () => {
    const onConnectError = vi.fn(() => {
      throw new Error("connect observer failed");
    });
    const transport = new GatewayClientTransport({ onConnectError });

    const connect = transport.connect();
    const connectExpectation = expect(connect).rejects.toThrow("gateway rejected");
    const client = gatewayClientMocks.instances[0];

    expect(() => client?.opts.onConnectError?.(new Error("gateway rejected"))).toThrow(
      "connect observer failed",
    );

    await connectExpectation;
    expect(onConnectError).toHaveBeenCalledOnce();
    expect(client?.stopAndWait).toHaveBeenCalledTimes(1);
  });
});
