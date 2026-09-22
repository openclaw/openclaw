import { randomUUID } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import {
  getProviderRequestAuthority,
  withProviderRequestAuthority,
} from "./provider-request-authority.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await closeProviderTransportDispatcherPool();
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});
async function admitted(runId = randomUUID()) {
  const owner = prepareSystemAgentRunAdmission({}, runId, "main", "provider-io-test");
  cleanup.push(owner.close);
  const context = await owner.admit("embedded");
  const assertCurrent = resolveAdmittedRunActiveAssertion(context);
  if (!assertCurrent) {
    throw new Error("Expected genuine admission");
  }
  return { owner, context, assertCurrent, runId };
}
async function server(handle: http.RequestListener) {
  const instance = http.createServer(handle);
  await new Promise<void>((resolve) => {
    instance.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.closeAllConnections();
        instance.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const model: Model = {
    api: "openai-responses",
    id: "test",
    provider: "test",
    name: "test",
    baseUrl,
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    baseUrl,
    fetch: buildGuardedModelFetch(
      attachModelProviderRequestTransport(model, { allowPrivateNetwork: true }),
    ),
  };
}

describe("captured provider HTTP authority", () => {
  it("carries the exact assertion through awaits without leaking to unrelated requests", async () => {
    const a = await admitted();
    const b = await admitted();
    await Promise.all(
      [a, b].map(async (current) => {
        await withProviderRequestAuthority(current.assertCurrent, async () => {
          await Promise.resolve();
          expect(getProviderRequestAuthority()).toBe(current.assertCurrent);
        });
      }),
    );
    expect(getProviderRequestAuthority()).toBeUndefined();
  });

  it.each(["close", "replace"] as const)(
    "rejects %s after the check, not just aborted signals",
    async (action) => {
      let requests = 0;
      const endpoint = await server((_req, res) => {
        requests++;
        res.end("ok");
      });
      const a = await admitted();
      const signal = new AbortController().signal;
      await withProviderRequestAuthority(a.assertCurrent, async () => {
        a.assertCurrent();
        if (action === "close") {
          closeAdmittedRunDelegatedAuthority(a.context);
        } else {
          await admitted(a.runId);
        }
        expect(getAdmittedRunDelegatedAuthority(a.context)).toBeUndefined();
        expect(signal.aborted).toBe(false);
        await expect(endpoint.fetch(endpoint.baseUrl, { signal })).rejects.toThrow(
          "authority is no longer active",
        );
      });
      expect(requests).toBe(0);
    },
  );

  it("checks the same owner after redirect preparation before sending the next hop", async () => {
    const paths: string[] = [];
    const a = await admitted();
    const endpoint = await server((req, res) => {
      paths.push(req.url ?? "");
      closeAdmittedRunDelegatedAuthority(a.context);
      res.writeHead(307, { location: "/next" });
      res.end();
    });
    await withProviderRequestAuthority(a.assertCurrent, async () => {
      await expect(endpoint.fetch(endpoint.baseUrl + "/first")).rejects.toThrow(
        "authority is no longer active",
      );
    });
    expect(paths).toEqual(["/first"]);
  });

  it("does not reuse a retired caller or reacquire authority by run id on later dispatch", async () => {
    let requests = 0;
    const endpoint = await server((_req, res) => {
      requests++;
      res.end("ok");
    });
    const a = await admitted();
    await withProviderRequestAuthority(a.assertCurrent, async () => {
      expect(await (await endpoint.fetch(endpoint.baseUrl)).text()).toBe("ok");
    });
    const b = await admitted(a.runId);
    await withProviderRequestAuthority(a.assertCurrent, async () => {
      await expect(endpoint.fetch(endpoint.baseUrl)).rejects.toThrow(
        "authority is no longer active",
      );
    });
    await withProviderRequestAuthority(b.assertCurrent, async () => {
      expect(await (await endpoint.fetch(endpoint.baseUrl)).text()).toBe("ok");
    });
    expect(requests).toBe(2);
  });

  it("preserves ordinary unscoped fetch behavior", async () => {
    let requests = 0;
    const endpoint = await server((_req, res) => {
      requests++;
      res.end("ordinary");
    });
    const result = await endpoint.fetch(endpoint.baseUrl);
    expect(await result.text()).toBe("ordinary");
    expect(requests).toBe(1);
  });
});
