// Msteams tests cover Graph REST client deadline wiring end-to-end through the
// actual Graph helper layer and at the guard level.
import { createProviderOperationDeadline } from "openclaw/plugin-sdk/provider-http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guardSpy = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock("../runtime-api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../runtime-api.js")>();
  return {
    ...original,
    fetchWithSsrFGuard: guardSpy,
  };
});

type OperationOutcome =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown }
  | {
      status: "pending";
    };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<OperationOutcome> {
  return await Promise.race([
    promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    delay(timeoutMs).then(() => ({ status: "pending" as const })),
  ]);
}

async function expectTimeoutRejection(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const outcome = await settleWithin(promise, timeoutMs);
  expect(outcome.status).toBe("rejected");
  if (outcome.status !== "rejected") {
    throw new Error(`expected timeout rejection, got ${outcome.status}`);
  }
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.error instanceof Error ? outcome.error.name : "").toMatch(
    /^(AbortError|TimeoutError)$/,
  );
}

async function withHangingLoopbackServer(
  run: (server: {
    baseUrl: string;
    received: Promise<void>;
    requestCount: () => number;
  }) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  let notifyRequest: () => void = () => {};
  const received = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  await withServer(
    (request) => {
      requestCount += 1;
      notifyRequest();
      // Never send a response — connection hangs open.
      request.resume();
    },
    async (baseUrl) => run({ baseUrl, received, requestCount: () => requestCount }),
  );
}

describe("MS Teams Graph helper deadline wiring", () => {
  beforeEach(() => {
    guardSpy.mockReset();
    guardSpy.mockResolvedValue({
      response: new Response("{}"),
      finalUrl: "http://localhost/unused",
      release: async () => undefined,
    });
  });

  it("fetchGraphAbsoluteUrl passes resolved deadline timeoutMs to fetchWithSsrFGuard", async () => {
    const { fetchGraphAbsoluteUrl } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 5_000 });
    await fetchGraphAbsoluteUrl({
      token: "test-token",
      url: "https://graph.example.com/test",
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(5_000);
  });

  it("fetchGraphAbsoluteUrl defaults to 30s when deadline omitted", async () => {
    const { fetchGraphAbsoluteUrl } = await import("./graph.js");
    await fetchGraphAbsoluteUrl({
      token: "test-token",
      url: "https://graph.example.com/test",
    }).catch(() => {});

    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(30_000);
  });

  it("fetchGraphJson passes resolved deadline through requestGraph to fetchWithSsrFGuard", async () => {
    const { fetchGraphJson } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 3_000 });
    await fetchGraphJson({
      token: "test-token",
      path: "/users",
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(3_000);
  });

  it("fetchAllGraphPages passes resolved deadline to each paginated fetch", async () => {
    guardSpy
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            value: [{ id: "1" }],
            "@odata.nextLink": "https://graph.example.com/next",
          }),
        ),
        finalUrl: "https://graph.example.com/page1",
        release: async () => undefined,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ value: [{ id: "2" }] })),
        finalUrl: "https://graph.example.com/page2",
        release: async () => undefined,
      });

    const { fetchAllGraphPages } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 4_000 });
    await fetchAllGraphPages({
      token: "test-token",
      path: "/groups",
      maxPages: 2,
      deadline,
    });

    expect(guardSpy).toHaveBeenCalledTimes(2);
    for (const call of guardSpy.mock.calls) {
      const params = call[0] as Record<string, unknown>;
      expect(params.timeoutMs).toBe(4_000);
    }
  });

  it("postGraphJson passes resolved deadline to fetchWithSsrFGuard", async () => {
    const { postGraphJson } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 2_500 });
    await postGraphJson({
      token: "test-token",
      path: "/channels",
      body: { displayName: "test" },
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(2_500);
  });

  it("deleteGraphRequest passes resolved deadline to fetchWithSsrFGuard", async () => {
    const { deleteGraphRequest } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 1_500 });
    await deleteGraphRequest({
      token: "test-token",
      path: "/messages/1",
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(1_500);
  });

  it("patchGraphJson passes resolved deadline to fetchWithSsrFGuard", async () => {
    const { patchGraphJson } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 6_000 });
    await patchGraphJson({
      token: "test-token",
      path: "/messages/1",
      body: { content: "updated" },
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(6_000);
  });

  it("postGraphBetaJson passes resolved deadline to fetchWithSsrFGuard", async () => {
    const { postGraphBetaJson } = await import("./graph.js");
    const deadline = createProviderOperationDeadline({ label: "test", timeoutMs: 8_000 });
    await postGraphBetaJson({
      token: "test-token",
      path: "/teams/1/channels",
      body: { displayName: "General" },
      deadline,
    }).catch(() => {});

    expect(guardSpy).toHaveBeenCalledOnce();
    const params = guardSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params.timeoutMs).toBe(8_000);
  });
});

describe("MS Teams guarded fetch timeout end-to-end", () => {
  it("rejects a hanging loopback request at the configured timeout via fetchWithSsrFGuard", async () => {
    await withHangingLoopbackServer(async (server) => {
      const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
      const request = fetchWithSsrFGuard({
        url: `${server.baseUrl}/hang`,
        init: {},
        policy: { allowPrivateNetwork: true },
        timeoutMs: 100,
        auditContext: "msteams.graph.timeout-test",
      });

      await server.received;
      expect(server.requestCount()).toBe(1);
      await expectTimeoutRejection(request, 1_500);
    });
  });

  it("resolves a normal loopback request before the timeout fires", async () => {
    await withServer(
      (request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${baseUrl}/ok`,
          init: {},
          policy: { allowPrivateNetwork: true },
          timeoutMs: 5_000,
          auditContext: "msteams.graph.timeout-test",
        });
        try {
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body).toEqual({ ok: true });
        } finally {
          await release();
        }
      },
    );
  });
});
