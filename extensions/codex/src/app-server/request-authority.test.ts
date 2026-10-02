import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
  withCodexAppServerJsonClient,
} from "./request.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
import * as sharedClient from "./shared-client.js";
import { createClientHarness } from "./test-support.js";

type Harness = ReturnType<typeof createClientHarness>;
type WireOptions = NonNullable<Parameters<Harness["client"]["request"]>[2]>;
type ScopeOptions = Parameters<typeof withCodexAppServerJsonClient>[0];
const clients: Harness["client"][] = [];
function createHarness(reply = false) {
  const harness = createClientHarness(
    reply
      ? {
          onWrite(line, send) {
            const request = JSON.parse(line) as { id: number };
            send({ id: request.id, result: { data: [] } });
          },
        }
      : {},
  );
  clients.push(harness.client);
  return Object.assign(harness, {
    list: (options: WireOptions = {}) => harness.client.request("thread/list", {}, options),
    scoped: (options: ScopeOptions, assertCurrent?: () => void) =>
      withCodexAppServerJsonClient(options, (send) =>
        send({ method: "thread/list", requestParams: {}, assertCurrent }),
      ),
  });
}
function authority(message: string) {
  const state = {
    current: true,
    check: vi.fn(() => {
      if (!state.current) {
        throw new Error(message);
      }
    }),
  };
  return state;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    await client.closeAndWait();
  }
  vi.restoreAllMocks();
});

describe("Codex physical request authority", () => {
  it.each([false, true])(
    "runs one fresh check after acquisition and guards the final write (revoked: %s)",
    async (revoke) => {
      const owner = authority("credential revoked");
      const entered = createDeferred<void>(),
        resume = createDeferred<void>();
      const freshCheck = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
      });
      const harness = createHarness(true);
      vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockImplementation(
        async (options) => {
          await options?.assertCurrentAsync?.();
          expect(freshCheck).not.toHaveBeenCalled();
          return harness.client;
        },
      );
      const result = harness.scoped({
        assertCurrent: owner.check,
        assertDispatchCurrentAsync: freshCheck,
      });
      const settled = revoke
        ? expect(result).rejects.toThrow("credential revoked")
        : expect(result).resolves.toEqual({ data: [] });
      try {
        await entered.promise;
        owner.current = !revoke;
        resume.resolve();
        await settled;
        expect(freshCheck).toHaveBeenCalledOnce();
        expect(harness.writes).toHaveLength(revoke ? 0 : 1);
      } finally {
        resume.resolve();
        await result.catch(() => {});
      }
    },
  );

  it.each(["current", "scope-revoked", "request-revoked"] as const)(
    "checks each caller authority once at the physical write: %s",
    async (outcome) => {
      const scope = authority("scope authority revoked");
      const request = authority("request authority revoked");
      const harness = createHarness(true);
      vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockResolvedValue(
        harness.client,
      );
      const result = harness.scoped(
        {
          assertCurrent: scope.check,
          assertCurrentAsync: async () => {
            await Promise.resolve();
            scope.current = outcome !== "scope-revoked";
            request.current = outcome !== "request-revoked";
          },
        },
        request.check,
      );
      if (outcome === "current") {
        await expect(result).resolves.toEqual({ data: [] });
      } else {
        await expect(result).rejects.toThrow(
          outcome === "scope-revoked" ? "scope authority revoked" : "request authority revoked",
        );
      }
      expect(harness.writes).toHaveLength(outcome === "current" ? 1 : 0);
      expect(scope.check).toHaveBeenCalledOnce();
      expect(request.check).toHaveBeenCalledTimes(outcome === "scope-revoked" ? 0 : 1);
    },
  );

  it("ignores duplicate admission of one wire request", async () => {
    const harness = createHarness();
    const result = harness
      .list({
        withCurrent: async (write) => {
          write();
          write();
        },
      })
      .catch((error: unknown) => error);
    expect(harness.writes).toHaveLength(1);
    const sent = JSON.parse(await harness.waitForWrite(0));
    harness.send({ id: sent.id, result: { data: [] } });
    await expect(result).resolves.toEqual({ data: [] });
  });

  it("settles a request when authority returns without admission", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const result = harness.list({ withCurrent: async () => {} }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const failure = await result;
    expect(failure).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
    expect(failure).toMatchObject({
      cause: {
        message: "Codex request authority did not admit the wire write",
      },
    });
    expect(harness.writes).toHaveLength(0);
  });

  it.each(
    (["client", "scoped helper"] as const).flatMap((entry) =>
      [false, true].map((written) => ({ entry, written })),
    ),
  )("classifies $entry authority rejection (written: $written)", async ({ entry, written }) => {
    const harness = createHarness();
    const failure = new Error("lineage guard unavailable");
    const withCurrent = vi.fn(async (write: () => void) => {
      if (written) {
        write();
      }
      throw failure;
    });
    const result =
      entry === "client"
        ? harness.list({ withCurrent })
        : requestCodexAppServerClientJson({
            client: harness.client,
            method: "thread/list",
            requestParams: {},
            withCurrent,
          });
    await expect(result).rejects.toMatchObject(
      written
        ? {
            name: "CodexAppServerIndeterminateTransportError",
            code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE",
            mayHaveWritten: true,
            cause: failure,
          }
        : { name: "CodexAppServerScopedRequestRejectedError", cause: failure },
    );
    expect(harness.writes).toHaveLength(written ? 1 : 0);
    expect(withCurrent).toHaveBeenCalledOnce();
  });

  it.each(["authority", "prewrite assertion"] as const)(
    "preserves non-Error rejection causes from %s",
    async (stage) => {
      const harness = createHarness();
      const cause = { reason: "lineage replaced" };
      const fail = () => {
        // oxlint-disable-next-line typescript/only-throw-error -- Deliberate non-Error fixture verifies exact cause preservation.
        throw cause;
      };
      await expect(
        harness.list({
          withCurrent: async (write) => {
            if (stage === "authority") {
              fail();
            }
            write();
          },
          assertCurrent: fail,
        }),
      ).rejects.toMatchObject({ name: "CodexAppServerScopedRequestRejectedError", cause });
      expect(harness.writes).toHaveLength(0);
    },
  );

  it.each([
    new CodexAppServerScopedRequestRejectedError("late authority failure"),
    new CodexAppServerRpcError(
      { code: -32_001, message: "local authority overloaded" },
      "thread/list",
    ),
  ])(
    "does not turn a local rejection after the callback into a never-written outcome: %s",
    async (cause) => {
      const harness = createHarness();
      await expect(
        harness.list({
          withCurrent: async (write) => {
            write();
            throw cause;
          },
        }),
      ).rejects.toMatchObject({
        name: "CodexAppServerIndeterminateTransportError",
        mayHaveWritten: true,
        cause,
      });
      expect(harness.writes).toHaveLength(1);
    },
  );

  it("does not classify frame preparation failure as authority rejection", async () => {
    const harness = createHarness();
    const cause = new Error("cannot encode request");
    await expect(
      harness.client.request(
        "test",
        {
          toJSON: () => {
            throw cause;
          },
        },
        { withCurrent: async (write) => write() },
      ),
    ).rejects.toBe(cause);
    expect(harness.writes).toHaveLength(0);
  });
});
