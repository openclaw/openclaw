import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamRequestHandler } from "./http.js";

const requestScope = vi.hoisted(() => ({
  client: { clientIp: "127.0.0.1", connect: { scopes: ["operator.write"] } },
  revalidate: vi.fn<() => Promise<void>>(),
  hasCurrentClientAuthority: vi.fn<() => boolean>(),
}));
// mock-isolation: The transport owner supplies live request authority, not Beam state decisions.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => requestScope,
}));

it.each(["body", "revalidation"] as const)(
  "rejects authority revoked during %s without uploading",
  async (phase) => {
    const store = memoryStore();
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.headers["content-type"] = "application/json";
    const res = new ServerResponse(req);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    requestScope.hasCurrentClientAuthority.mockReset().mockReturnValue(true);
    requestScope.revalidate.mockReset().mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
    });
    const handler = createBeamRequestHandler({ store, resolveControlUiBasePath: () => undefined });
    const outcome = handler(req, res).catch((error: unknown) => error);
    onTestFinished(() => {
      req.destroy();
      res.destroy();
    });
    try {
      if (phase === "body") {
        requestScope.hasCurrentClientAuthority.mockReturnValue(false);
      }
      req.push(Buffer.from(JSON.stringify(sampleUpload())));
      req.complete = true;
      req.push(null);
      await entered.promise;
      requestScope.hasCurrentClientAuthority.mockReturnValue(false);
      resume.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(res.statusCode).toBe(401);
      expect(await store.get(sampleUpload().beamId)).toBeUndefined();
    } finally {
      resume.resolve();
      await outcome;
    }
  },
);
