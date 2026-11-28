import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, SimlockClient } from "./client.js";

const config = { gatewayUrl: "https://simlock.example.invalid", token: "synthetic-agent-token" };
const invocation = { assertCurrent: () => {} };
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Simlock transport safety", () => {
  it("rejects unresolved secrets and credential/path-bearing origins", () => {
    for (const gatewayUrl of [
      "file:///private/path",
      "https://user:secret@example.invalid",
      "https://example.invalid/path",
      "https://example.invalid/?token=secret",
    ]) {
      expect(() => parseConfig({ ...config, gatewayUrl })).toThrow("origin");
    }
    expect(() =>
      parseConfig({ ...config, token: { source: "env", provider: "fixture", id: "TOKEN" } }),
    ).toThrow("resolved");
  });

  it("does not expose HTTP bodies, native errors, or parser diagnostics", async () => {
    for (const response of [
      new Response(config.token, { status: 403 }),
      new Response("invalid JSON " + config.token),
    ]) {
      const client = new SimlockClient(config, async () => response);
      await expect(client.health(invocation)).rejects.not.toThrow(config.token);
    }
    const client = new SimlockClient(config, async () => {
      throw new Error(config.gatewayUrl + config.token);
    });
    await expect(client.health(invocation)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("bounds response size and rejects arbitrary image artifacts", async () => {
    const huge = new SimlockClient(config, async () => new Response("x".repeat(1024 * 1024 + 1)));
    await expect(huge.health(invocation)).rejects.toMatchObject({ code: "TOO_LARGE" });
    const html = new SimlockClient(config, async () => new Response("<html>private</html>"));
    await expect(html.screenshot("artifact", "lease", invocation)).rejects.toMatchObject({
      code: "PROTOCOL",
    });
  });

  it("attaches a finite timeout and cancellation signal to the actual fetch", async () => {
    const timeout = new AbortController();
    const user = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const entered = Promise.withResolvers<void>();
    const client = new SimlockClient(config, async (_url, init) => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(config.token)), {
          once: true,
        });
      });
    });
    const pending = client.health({ ...invocation, signal: user.signal });
    await entered.promise;
    expect(spy).toHaveBeenCalledWith(15000);
    timeout.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("checks authority before dispatch and after data has arrived", async () => {
    let current = false;
    let count = 0;
    const client = new SimlockClient(config, async () => {
      count++;
      current = false;
      return Response.json({ ok: true, service: "agent-device-proxy", rpcProtocolVersion: 2 });
    });
    const authority = {
      assertCurrent: () => {
        if (!current) {
          throw new Error(config.token);
        }
      },
    };
    await expect(client.health(authority)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(count).toBe(0);
    current = true;
    await expect(client.health(authority)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(count).toBe(1);
  });
});
