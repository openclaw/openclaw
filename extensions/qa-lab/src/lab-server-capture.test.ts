// Qa Lab tests cover lab server capture plugin behavior.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mapCaptureEventForQa, readQaCaptureStartupStatus } from "./lab-server-capture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server capture helpers", () => {
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
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp probe address");
    }

    const status = await readQaCaptureStartupStatus({
      proxyUrl: `http://127.0.0.1:${address.port}`,
      gatewayUrl: "http://127.0.0.1:9",
      publicBaseUrl: "http://127.0.0.1:8080",
    });
    expect(status.proxy).toMatchObject({ label: "Proxy", ok: true });
    expect(status.gateway).toMatchObject({ label: "Gateway", ok: false });
    expect(status.qaLab).toEqual({ label: "QA Lab", url: "http://127.0.0.1:8080", ok: true });
  });
});
