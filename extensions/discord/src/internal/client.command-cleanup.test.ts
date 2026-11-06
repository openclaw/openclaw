import { describe, expect, it, vi } from "vitest";
import { DiscordError, type RequestClientOptions } from "./rest.js";
import {
  createInternalTestClient,
  createTestCommand,
  createTestHashStore,
} from "./test-builders.test-support.js";

const root = "/api/v10/applications/app1/commands";
const expectedRequests = ["GET", "PATCH keep", "POST", "DELETE a", "DELETE b"];

function fixture(
  fail?: (request: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  requestOptions?: Pick<RequestClientOptions, "callerSignal" | "timeout">,
) {
  const requests: string[] = [];
  const keep = createTestCommand("keep");
  const desired = [keep, createTestCommand("new")];
  const existing = [
    { ...keep.serialize(), description: "old", id: "keep" },
    { ...createTestCommand("old-a").serialize(), id: "a" },
    { ...createTestCommand("old-b").serialize(), id: "b" },
  ];
  const { rows, store } = createTestHashStore();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("https://discord.invalid");
    expect(url.pathname === root || url.pathname.startsWith(`${root}/`)).toBe(true);
    const request = [init?.method, url.pathname.slice(root.length + 1)].filter(Boolean).join(" ");
    requests.push(request);
    if (request === "PUT") {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON command body");
      }
      expect(JSON.parse(init.body)).toEqual(desired.map((command) => command.serialize()));
    }
    const failure = await fail?.(request, init);
    if (failure) {
      return failure;
    }
    return request === "GET" ? Response.json(existing) : new Response(null, { status: 204 });
  });
  const options = {
    requestOptions: { ...requestOptions, apiBaseUrl: "https://discord.invalid/api/v10", fetch },
    commandDeployHashStore: store,
  };
  return {
    client: createInternalTestClient(desired, options),
    restart: () => createInternalTestClient(desired, options),
    requests,
    rows,
    store,
  };
}

function apiError(status: number, code: unknown, message = "Synthetic Discord error") {
  return Response.json({ message, code }, { status });
}

describe("obsolete application-command cleanup through RequestClient", () => {
  it.each([10063, "10063"])(
    "finishes cleanup and registers the desired hash for parsed code %s",
    async (code) => {
      const f = fixture((request) =>
        request === "DELETE a" ? apiError(404, code, "Unknown application command") : undefined,
      );
      const outcome = await f.client.deployCommands().then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect({
        outcome,
        requests: f.requests,
        rows: f.rows.size,
        registrations: f.store.register.mock.calls.length,
      }).toEqual({
        outcome: "resolved",
        requests: expectedRequests,
        rows: 1,
        registrations: 1,
      });
      await f.client.deployCommands();
      await f.restart().deployCommands();
      expect(f.requests).toEqual(expectedRequests);
      expect(f.store.register).toHaveBeenCalledExactlyOnceWith(
        "app:app1:global:reconcile",
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
    },
  );

  it("completes ordinary successful cleanup", async () => {
    const f = fixture();
    await f.client.deployCommands();
    expect(f.requests).toEqual(expectedRequests);
    expect(f.rows.size).toBe(1);
  });

  it.each([
    ["another 404", 404, 10003],
    ["forbidden", 403, 50013],
    ["server failure", 500, 0],
    ["server failure with 10063", 500, 10063],
    ["missing code", 404, undefined],
    ["fractional code", 404, 10063.5],
    ["unexpected status with 10063", 403, 10063],
    ["malformed code", 404, "10063x"],
    ["unexpected code object", 404, { value: 10063 }],
  ])("preserves %s from obsolete DELETE", async (_label, status, code) => {
    const f = fixture((request) => (request === "DELETE a" ? apiError(status, code) : undefined));
    await expect(f.client.deployCommands()).rejects.toBeInstanceOf(DiscordError);
    expect(f.requests).toEqual(expectedRequests.slice(0, 4));
    expect(f.store.register).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });

  it.each(["GET", "PATCH keep", "POST"])("does not swallow 10063 from %s", async (request) => {
    const f = fixture((current) => (current === request ? apiError(404, 10063) : undefined));
    await expect(f.client.deployCommands()).rejects.toMatchObject({
      name: "DiscordError",
      status: 404,
      discordCode: 10063,
    });
    expect(f.requests).toEqual(expectedRequests.slice(0, expectedRequests.indexOf(request) + 1));
    expect(f.store.register).not.toHaveBeenCalled();
  });

  it("uses bulk overwrite for the parsed command-limit error without deleting first", async () => {
    const f = fixture((request) => (request === "POST" ? apiError(400, 30032) : undefined));
    await f.client.deployCommands();
    expect(f.requests).toEqual(["GET", "PATCH keep", "POST", "PUT"]);
    expect(f.rows.size).toBe(1);
  });

  it("retries a rate-limited obsolete DELETE before continuing cleanup", async () => {
    let limited = true;
    const f = fixture((request) => {
      if (request === "DELETE a" && limited) {
        limited = false;
        return Response.json(
          { message: "Rate limited", retry_after: 0, global: false },
          { status: 429 },
        );
      }
      return undefined;
    });
    await f.client.deployCommands();
    expect(f.requests).toEqual([...expectedRequests.slice(0, 4), "DELETE a", "DELETE b"]);
    expect(f.rows.size).toBe(1);
  });

  it("preserves cancellation before dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    controller.abort(reason);
    const f = fixture(undefined, { callerSignal: controller.signal });
    await expect(f.client.deployCommands()).rejects.toBe(reason);
    expect(f.requests).toEqual([]);
    expect(f.store.register).not.toHaveBeenCalled();
  });

  it("preserves an obsolete DELETE timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(
        (request, init) =>
          request === "DELETE a"
            ? new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                signal?.addEventListener(
                  "abort",
                  () => reject(new Error("synthetic fetch aborted")),
                  {
                    once: true,
                  },
                );
              })
            : undefined,
        { timeout: 10 },
      );
      const outcome = expect(f.client.deployCommands()).rejects.toThrow("synthetic fetch aborted");
      await vi.runAllTimersAsync();
      await outcome;
      expect(f.requests).toEqual(expectedRequests.slice(0, 4));
      expect(f.store.register).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves network failure identity and retries reconciliation on the next deploy", async () => {
    const failure = new TypeError("synthetic network failure");
    let fail = true;
    const f = fixture((request) => {
      if (request === "DELETE a" && fail) {
        throw failure;
      }
      return undefined;
    });
    await expect(f.client.deployCommands()).rejects.toBe(failure);
    expect(f.requests).toEqual(expectedRequests.slice(0, 4));
    expect(f.store.register).not.toHaveBeenCalled();
    fail = false;
    await f.client.deployCommands();
    expect(f.requests).toEqual([...expectedRequests.slice(0, 4), ...expectedRequests]);
    expect(f.rows.size).toBe(1);
  });
});
