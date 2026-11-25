import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, onTestFinished } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamRequestHandler } from "./http.js";

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
    let current = true;
    const assertCurrent = (requiredGrant?: string) => {
      expect(requiredGrant).toBe("visitor-access");
      if (!current) {
        throw new Error("publisher authority ended");
      }
    };
    const revalidate = async (requiredGrant?: string) => {
      entered.resolve();
      await resume.promise;
      assertCurrent(requiredGrant);
    };
    const handler = createBeamRequestHandler({
      store,
      resolveControlUiBasePath: () => undefined,
      resolveAuthority: () => ({
        scopes: ["operator.sessions.write"],
        personProfileId: "visitor",
        requiredGrantPluginId: "visitor-access",
        assertCurrent,
        revalidate,
      }),
    });
    const outcome = handler(req, res).catch((error: unknown) => error);
    onTestFinished(() => {
      req.destroy();
      res.destroy();
    });
    try {
      if (phase === "body") {
        current = false;
      }
      req.push(Buffer.from(JSON.stringify(sampleUpload())));
      req.complete = true;
      req.push(null);
      await entered.promise;
      current = false;
      resume.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      // The Gateway owns the HTTP response for an expired or temporarily unavailable grant.
      expect(res.writableEnded).toBe(false);
      expect(await store.get(sampleUpload().beamId)).toBeUndefined();
    } finally {
      resume.resolve();
      await outcome;
    }
  },
);
