import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
} from "./request.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";

describe("Codex physical request authority", () => {
  it("ignores duplicate admission of one wire request", async () => {
    const harness = createClientHarness();
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
    try {
      expect(harness.writes).toHaveLength(1);
      const sent = JSON.parse(await harness.waitForWrite(0));
      harness.send({ id: sent.id, result: { data: [] } });
      await expect(result).resolves.toEqual({ data: [] });
    } finally {
      harness.client.close();
    }
  });

  it("settles a request when authority returns without admission", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
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
    const harness = createClientHarness();
    const failure = new Error("lineage guard unavailable");
    const withCurrent = async (write: () => void) => {
      if (written) {
        write();
      }
      throw failure;
    };
    try {
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
    } finally {
      harness.client.close();
    }
  });

  it.each(["authority", "prewrite assertion"] as const)(
    "preserves non-Error rejection causes from %s",
    async (stage) => {
      const harness = createClientHarness();
      const cause = { reason: "lineage replaced" };
      try {
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
      } finally {
        harness.client.close();
      }
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
      const harness = createClientHarness();
      try {
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
      } finally {
        harness.client.close();
      }
    },
  );

  it("does not classify frame preparation failure as authority rejection", async () => {
    const harness = createClientHarness();
    const cause = new Error("cannot encode request");
    try {
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
    } finally {
      harness.client.close();
    }
  });

  it("passes scoped wire authority unchanged to the physical client", async () => {
    const harness = createClientHarness();
    const cause = new Error("owner replaced");
    const withCurrent = async () => {
      throw cause;
    };
    const request = vi.spyOn(harness.client, "request");
    try {
      await expect(
        requestCodexAppServerClientJson({
          client: harness.client,
          method: "thread/list",
          requestParams: {},
          withCurrent,
        }),
      ).rejects.toMatchObject({ cause });
      expect(request).toHaveBeenCalledWith(
        "thread/list",
        {},
        expect.objectContaining({ withCurrent }),
      );
    } finally {
      request.mockRestore();
      harness.client.close();
    }
  });
});
