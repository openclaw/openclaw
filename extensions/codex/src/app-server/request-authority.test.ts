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

const clients: ReturnType<typeof createClientHarness>["client"][] = [];
const createHarness = (options: Parameters<typeof createClientHarness>[0] = {}) => {
  const harness = createClientHarness(options);
  clients.push(harness.client);
  return harness;
};
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

describe("Codex physical request authority", () => {
  it.each([false, true])(
    "runs one fresh check after acquisition and guards the final write (revoked: %s)",
    async (revoke) => {
      let current = true;
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const freshCheck = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
      });
      const harness = createHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number };
          send({ id: request.id, result: { data: [] } });
        },
      });
      const acquire = vi
        .spyOn(sharedClient, "getLeasedSharedCodexAppServerClient")
        .mockImplementation(async (options) => {
          await options?.assertCurrentAsync?.();
          expect(freshCheck).not.toHaveBeenCalled();
          return harness.client;
        });
      const result = withCodexAppServerJsonClient(
        {
          assertCurrent: () => {
            if (!current) {
              throw new Error("credential revoked");
            }
          },
          assertDispatchCurrentAsync: freshCheck,
        },
        (send) => send({ method: "thread/list", requestParams: {} }),
      );
      const settled = revoke
        ? expect(result).rejects.toThrow("credential revoked")
        : expect(result).resolves.toEqual({ data: [] });
      try {
        await entered.promise;
        current = !revoke;
        resume.resolve();
        await settled;
        expect(freshCheck).toHaveBeenCalledOnce();
        expect(harness.writes).toHaveLength(revoke ? 0 : 1);
      } finally {
        resume.resolve();
        await result.catch(() => {});
        acquire.mockRestore();
        await harness.client.closeAndWait();
      }
    },
  );

  it.each(["current", "scope-revoked", "request-revoked"] as const)(
    "checks each caller authority once at the physical write: %s",
    async (outcome) => {
      let scopeCurrent = true;
      let requestCurrent = true;
      const assertScopeCurrent = vi.fn(() => {
        if (!scopeCurrent) {
          throw new Error("scope authority revoked");
        }
      });
      const assertRequestCurrent = vi.fn(() => {
        if (!requestCurrent) {
          throw new Error("request authority revoked");
        }
      });
      const harness = createHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number };
          send({ id: request.id, result: { data: [] } });
        },
      });
      const acquire = vi
        .spyOn(sharedClient, "getLeasedSharedCodexAppServerClient")
        .mockResolvedValue(harness.client);
      try {
        const result = withCodexAppServerJsonClient(
          {
            assertCurrent: assertScopeCurrent,
            assertCurrentAsync: async () => {
              await Promise.resolve();
              scopeCurrent = outcome !== "scope-revoked";
              requestCurrent = outcome !== "request-revoked";
            },
          },
          (send) =>
            send({
              method: "thread/list",
              requestParams: {},
              assertCurrent: assertRequestCurrent,
            }),
        );
        if (outcome === "current") {
          await expect(result).resolves.toEqual({ data: [] });
          expect(harness.writes).toHaveLength(1);
        } else {
          await expect(result).rejects.toThrow(
            outcome === "scope-revoked" ? "scope authority revoked" : "request authority revoked",
          );
          expect(harness.writes).toEqual([]);
        }
        expect(assertScopeCurrent).toHaveBeenCalledOnce();
        expect(assertRequestCurrent).toHaveBeenCalledTimes(outcome === "scope-revoked" ? 0 : 1);
      } finally {
        acquire.mockRestore();
        await harness.client.closeAndWait();
      }
    },
  );

  it("ignores duplicate admission of one wire request", async () => {
    const harness = createHarness();
    const result = harness.client
      .request(
        "thread/list",
        {},
        {
          withCurrent: async (write) => {
            write();
            write();
          },
        },
      )
      .catch((error: unknown) => error);
    expect(harness.writes).toHaveLength(1);
    const sent = JSON.parse(await harness.waitForWrite(0));
    harness.send({ id: sent.id, result: { data: [] } });
    await expect(result).resolves.toEqual({ data: [] });
  });

  it("settles a request when authority returns without admission", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let failure: unknown;
    const request = harness.client
      .request("thread/list", {}, { withCurrent: async () => {} })
      .catch((error: unknown) => {
        failure = error;
      });
    try {
      await vi.runAllTimersAsync();
      expect(failure).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
      expect(failure).toMatchObject({
        cause: { message: "Codex request authority did not admit the wire write" },
      });
      expect(harness.writes).toHaveLength(0);
      await request;
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
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
    const request =
      entry === "client"
        ? harness.client.request("thread/list", {}, { withCurrent })
        : requestCodexAppServerClientJson({
            client: harness.client,
            method: "thread/list",
            requestParams: {},
            withCurrent,
          });
    await expect(request).rejects.toMatchObject(
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
      await expect(
        harness.client.request(
          "thread/list",
          {},
          {
            withCurrent: async (write) => {
              if (stage === "authority") {
                // oxlint-disable-next-line typescript/only-throw-error -- Deliberate non-Error fixture verifies exact cause preservation.
                throw cause;
              }
              write();
            },
            assertCurrent: () => {
              // oxlint-disable-next-line typescript/only-throw-error -- Deliberate non-Error fixture verifies exact cause preservation.
              throw cause;
            },
          },
        ),
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
        harness.client.request(
          "thread/list",
          {},
          {
            withCurrent: async (write) => {
              write();
              throw cause;
            },
          },
        ),
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
