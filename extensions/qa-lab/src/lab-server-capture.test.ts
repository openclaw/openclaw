// Qa Lab tests cover lab server capture plugin behavior.
import net from "node:net";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapCaptureEventForQa, readQaCaptureStartupStatus } from "./lab-server-capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("qa-lab server capture helpers", () => {
  it("reports timed-out probes as unavailable and closes their sockets", async () => {
    const sockets: net.Socket[] = [];
    vi.spyOn(net, "createConnection").mockImplementation(() => {
      const socket = new net.Socket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("timeout"));
      return socket;
    });

    const status = await readQaCaptureStartupStatus({
      publicBaseUrl: "http://127.0.0.1:8080",
    });

    expect(status.proxy).toMatchObject({ ok: false, error: "timeout" });
    expect(status.gateway).toMatchObject({ ok: false, error: "timeout" });
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("maps capture rows into QA-friendly fields", () => {
    const record = mapCaptureEventForQa({
      flowId: "flow-1",
      dataText: '{"hello":"world"}',
      metaJson: JSON.stringify({
        provider: "openai",
        api: "responses",
        model: "gpt-5.6-luna",
        captureOrigin: "shared-fetch",
      }),
    }) as ReturnType<typeof mapCaptureEventForQa> & { flowId?: string };
    expect(record.flowId).toBe("flow-1");
    expect(record.payloadPreview).toBe('{"hello":"world"}');
    expect(record.provider).toBe("openai");
    expect(record.api).toBe("responses");
    expect(record.model).toBe("gpt-5.6-luna");
    expect(record.captureOrigin).toBe("shared-fetch");
  });

  it("reports reachable and unreachable targets in startup status", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (baseUrl) => {
        const status = await readQaCaptureStartupStatus({
          proxyUrl: baseUrl,
          gatewayUrl: "http://127.0.0.1:9",
          publicBaseUrl: "http://127.0.0.1:8080",
        });
        expect(status.proxy).toMatchObject({ label: "Proxy", ok: true });
        expect(status.gateway).toMatchObject({ label: "Gateway", ok: false });
        expect(status.qaLab).toEqual({ label: "QA Lab", url: "http://127.0.0.1:8080", ok: true });
      },
    );
  });
});
