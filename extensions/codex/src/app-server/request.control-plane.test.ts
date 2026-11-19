import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCodexAppServerJsonClient } from "./request.js";
import {
  getOrCreateSharedClientEntry,
  getSharedCodexAppServerClientState,
  releaseSharedClientEntry,
} from "./shared-client-lifecycle.js";
import * as sharedClient from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

const clients: ReturnType<typeof createClientHarness>["client"][] = [];
function createHarness() {
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line) as { id: number };
      send({ id: request.id, result: { data: [] } });
    },
  });
  clients.push(harness.client);
  vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockResolvedValue(harness.client);
  vi.spyOn(sharedClient, "releaseLeasedSharedCodexAppServerClient").mockReturnValue(false);
  return harness;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    await client.closeAndWait();
  }
  vi.restoreAllMocks();
});

describe("Codex control-plane request scope", () => {
  it.each([null, false, "unrecognized"])(
    "rejects invalid scope %s before acquisition",
    async (value) => {
      createHarness();
      await expect(
        withCodexAppServerJsonClient(
          { requestScope: value as unknown as "control-plane" },
          async () => undefined,
        ),
      ).rejects.toThrow("Unknown Codex request scope");
      expect(sharedClient.getLeasedSharedCodexAppServerClient).not.toHaveBeenCalled();
    },
  );

  it.each(["command/exec", "thread/start", "config/mcpServer/reload", "unknown/method"])(
    "rejects %s without a physical write or raw-client capability",
    async (method) => {
      const harness = createHarness();
      await expect(
        withCodexAppServerJsonClient({ requestScope: "control-plane" }, async (request, client) => {
          expect(Object.keys(client).toSorted()).toEqual([
            "captureCatalogLifetime",
            "retireIfCurrent",
          ]);
          expect(client).not.toBe(harness.client);
          return request({ method });
        }),
      ).rejects.toMatchObject({ name: "CodexAppServerScopedRequestRejectedError" });
      expect(harness.writes).toEqual([]);
      expect(sharedClient.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledExactlyOnceWith(
        harness.client,
      );
    },
  );

  it("captures scope and method once across acquisition and async authority", async () => {
    const harness = createHarness();
    const entered = createDeferred<void>();
    const acquire = createDeferred<typeof harness.client>();
    vi.mocked(sharedClient.getLeasedSharedCodexAppServerClient).mockImplementationOnce(() => {
      entered.resolve();
      return acquire.promise;
    });
    let selectedScope = "control-plane";
    let scopeReads = 0;
    let methodReads = 0;
    let selectedMethod = "model/list";
    const request = {
      get method() {
        methodReads += 1;
        return selectedMethod;
      },
      assertCurrentAsync: async () => {
        selectedMethod = "command/exec";
      },
    };
    const result = withCodexAppServerJsonClient(
      {
        get requestScope(): "control-plane" {
          scopeReads += 1;
          return selectedScope as "control-plane";
        },
      },
      async (send, client) => {
        expect(client).not.toHaveProperty("request");
        const response = await send(request);
        await expect(send({ method: "command/exec" })).rejects.toThrow("control-plane");
        return response;
      },
    );
    try {
      await entered.promise;
      selectedScope = "guarded";
      acquire.resolve(harness.client);
      await expect(result).resolves.toEqual({ data: [] });
      expect(scopeReads).toBe(1);
      expect(methodReads).toBe(1);
      expect(JSON.parse(harness.writes[0]!).method).toBe("model/list");
    } finally {
      acquire.resolve(harness.client);
      await result.catch(() => {});
    }
  });

  it.each(["scope", "request", "dispatch", "scope-sync", "request-sync"] as const)(
    "retains %s authority immediately before physical dispatch",
    async (rejectedBy) => {
      const harness = createHarness();
      const failure = new Error("synthetic authority revoked");
      const checks: string[] = [];
      const check = (owner: string) => {
        checks.push(owner);
        if (rejectedBy === owner) {
          throw failure;
        }
      };
      await expect(
        withCodexAppServerJsonClient(
          {
            requestScope: "control-plane",
            assertCurrent: () => check("scope-sync"),
            assertCurrentAsync: async () => check("scope"),
            assertDispatchCurrentAsync: async () => check("dispatch"),
          },
          async (send) =>
            send({
              method: "account/read",
              assertCurrent: () => check("request-sync"),
              assertCurrentAsync: async () => check("request"),
            }),
        ),
      ).rejects.toMatchObject({ cause: failure });
      const ordered = ["scope", "request", "dispatch", "scope-sync", "request-sync"];
      expect(checks).toEqual(ordered.slice(0, ordered.indexOf(rejectedBy) + 1));
      expect(harness.writes).toEqual([]);
    },
  );

  it.each(["abort", "deadline"] as const)(
    "cannot send after %s while acquiring and releases a late client",
    async (end) => {
      vi.useFakeTimers();
      const harness = createHarness();
      const entered = createDeferred<void>();
      const acquire = createDeferred<typeof harness.client>();
      const controller = new AbortController();
      vi.mocked(sharedClient.getLeasedSharedCodexAppServerClient).mockImplementationOnce(() => {
        entered.resolve();
        return acquire.promise;
      });
      const result = withCodexAppServerJsonClient(
        {
          requestScope: "control-plane",
          signal: controller.signal,
          timeoutMs: 50,
          pluginConfig: { appServer: { requestTimeoutMs: 10 } },
        },
        async (send) => send({ method: "model/list" }),
      );
      const rejected = expect(result).rejects.toThrow();
      try {
        await entered.promise;
        if (end === "abort") {
          controller.abort(new Error("synthetic cancellation"));
        } else {
          await vi.advanceTimersByTimeAsync(151);
        }
        await rejected;
        acquire.resolve(harness.client);
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.writes).toEqual([]);
        expect(sharedClient.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledOnce();
      } finally {
        acquire.resolve(harness.client);
        await result.catch(() => {});
      }
    },
  );

  it("keeps exact-client retirement after cancellation without retiring a replacement or sibling", async () => {
    const harness = createHarness();
    const state = getSharedCodexAppServerClientState();
    const key = "control-plane-lifetime-fixture";
    const entry = getOrCreateSharedClientEntry(state, key);
    entry.client = harness.client;
    entry.activeLeases = 2;
    state.entriesByClient.set(harness.client, entry);
    vi.mocked(sharedClient.releaseLeasedSharedCodexAppServerClient).mockImplementation(() => {
      releaseSharedClientEntry(entry, "activeLeases");
      return true;
    });
    const controller = new AbortController();
    const blocked = createDeferred<void>();
    const ready = createDeferred<{
      isCurrent: () => boolean;
      retire: () => unknown;
    }>();
    const result = withCodexAppServerJsonClient(
      { requestScope: "control-plane", signal: controller.signal },
      async (_send, client) => {
        ready.resolve({
          isCurrent: client.captureCatalogLifetime(),
          retire: client.retireIfCurrent,
        });
        await blocked.promise;
      },
    );
    const rejected = expect(result).rejects.toThrow("synthetic cancellation");
    try {
      const retained = await ready.promise;
      expect(retained.isCurrent()).toBe(true);
      controller.abort(new Error("synthetic cancellation"));
      await rejected;
      expect(retained.retire()).toEqual({ activeLeases: 1, closed: false });
      expect(retained.isCurrent()).toBe(false);
      expect(harness.client.getCloseError()).toBeUndefined();
      const replacement = getOrCreateSharedClientEntry(state, key);
      retained.retire();
      expect(state.clients.get(key)).toBe(replacement);
      releaseSharedClientEntry(entry, "activeLeases");
      expect(harness.client.getCloseError()).toBeDefined();
    } finally {
      blocked.resolve();
      await result.catch(() => {});
      state.clients.delete(key);
      state.entriesByClient.delete(harness.client);
    }
  });
});

it("loads the real cold request owner without loading execution policy for control-plane requests", async ({
  signal,
}) => {
  const { stdout } = await promisify(execFile)(
    resolveTestNodeExecPath(),
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        import { pathToFileURL } from "node:url";
        const owner = pathToFileURL(process.cwd() + "/extensions/codex/src/app-server/request.ts").href;
        const policy = new Error("execution policy imported");
        let policyImports = 0;
        const fixture = "data:text/javascript," + encodeURIComponent(\`
          export const writes = [];
          export let releases = 0;
          export async function getLeasedSharedCodexAppServerClient() {
            return { async request(method, params, options) {
              options.assertCurrent();
              await options.withCurrent(() => writes.push(method));
              return { data: [] };
            } };
          }
          export const createIsolatedCodexAppServerClient = getLeasedSharedCodexAppServerClient;
          export function releaseLeasedSharedCodexAppServerClient() { releases++; }
        \`);
        const hooks = registerHooks({
          resolve(specifier, context, next) {
            if (context.parentURL === owner && specifier === "./shared-client.js") {
              return { url: fixture, shortCircuit: true };
            }
            if (specifier.endsWith("/sandbox-guard.js") || specifier.endsWith("/native-execution-policy.js")) {
              policyImports++;
              throw policy;
            }
            return next(specifier, context);
          },
        });
        try {
          const { withCodexAppServerJsonClient: run } = await import(owner);
          await run({ requestScope: "control-plane" }, async (request) => {
            await request({ method: "account/read" });
            await request({ method: "model/list" });
            await assert.rejects(request({ method: "config/mcpServer/reload" }));
          });
          const { writes, releases } = await import(fixture);
          assert.deepEqual(writes, ["account/read", "model/list"]);
          assert.equal(releases, 1);
          assert.equal(policyImports, 0);
          await assert.rejects(run({}, async () => {}), (error) => error === policy);
          assert.equal(policyImports, 1);
          console.log("cold control-plane boundary passed");
        } finally {
          hooks.deregister();
        }
      `,
    ],
    { cwd: process.cwd(), signal, timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  expect(stdout).toContain("cold control-plane boundary passed");
});
