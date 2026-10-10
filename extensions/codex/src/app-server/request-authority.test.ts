import { describe, expect, it } from "vitest";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
} from "./request.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";

describe("Codex physical request authority", () => {
  it.each([false, true])(
    "classifies scoped helper authority rejection (written: %s)",
    async (written) => {
      const harness = createClientHarness();
      const failure = new Error("lineage guard unavailable");
      const withCurrent = async (write: () => void) => {
        if (written) {
          write();
        }
        throw failure;
      };
      try {
        const request = requestCodexAppServerClientJson({
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
    },
  );

  it("preserves non-Error rejection causes from the prewrite assertion", async () => {
    const harness = createClientHarness();
    const cause = { reason: "lineage replaced" };
    try {
      await expect(
        harness.client.request(
          "thread/list",
          {},
          {
            withCurrent: async (write) => write(),
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
  });

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

  it("rejects an authority callback that resolves without admitting a write", async () => {
    const harness = createClientHarness();
    try {
      await expect(
        harness.client.request("thread/list", {}, { withCurrent: async () => {} }),
      ).rejects.toMatchObject({
        name: "CodexAppServerScopedRequestRejectedError",
        cause: { message: "Codex request authority did not admit the wire write" },
      });
      expect(harness.writes).toHaveLength(0);
    } finally {
      harness.client.close();
    }
  });
});
