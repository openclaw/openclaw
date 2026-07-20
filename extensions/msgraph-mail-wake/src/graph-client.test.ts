// Microsoft Graph Mail Wake tests cover Graph request contracts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  release: vi.fn(async () => {}),
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

import { createGraphClient, GraphRequestError } from "./graph-client.js";

beforeEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.release.mockClear();
});

describe("createGraphClient", () => {
  it("PATCHes only the supported expiration field on the existing subscription", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({
          id: "sub-1",
          expirationDateTime: "2026-07-24T00:00:00.000Z",
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    await expect(
      client.renewSubscription({
        subscriptionId: "sub-1",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ id: "sub-1" });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const call = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0] as {
      url: string;
      init: RequestInit;
    };
    expect(call.url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-1");
    expect(call.init.method).toBe("PATCH");
    expect(typeof call.init.body).toBe("string");
    if (typeof call.init.body !== "string") {
      throw new Error("expected Graph PATCH body to be JSON text");
    }
    expect(JSON.parse(call.init.body)).toEqual({
      expirationDateTime: "2026-07-24T00:00:00.000Z",
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("PATCHes the supported notification URL without immutable subscription fields", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({
          id: "sub-1",
          expirationDateTime: "2026-07-24T00:00:00.000Z",
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    await expect(
      client.renewSubscription({
        subscriptionId: "sub-1",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
        notificationUrl: "https://new-gateway.example.com/plugins/msgraph-mail-wake",
      }),
    ).resolves.toMatchObject({ id: "sub-1" });

    const call = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0] as {
      url: string;
      init: RequestInit;
    };
    expect(call.init.method).toBe("PATCH");
    expect(typeof call.init.body).toBe("string");
    if (typeof call.init.body !== "string") {
      throw new Error("expected Graph PATCH body to be JSON text");
    }
    expect(JSON.parse(call.init.body)).toEqual({
      expirationDateTime: "2026-07-24T00:00:00.000Z",
      notificationUrl: "https://new-gateway.example.com/plugins/msgraph-mail-wake",
    });
    expect(JSON.parse(call.init.body)).not.toHaveProperty("resource");
    expect(JSON.parse(call.init.body)).not.toHaveProperty("changeType");
    expect(JSON.parse(call.init.body)).not.toHaveProperty("lifecycleNotificationUrl");
  });

  it("returns null when the subscription no longer exists", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: { ok: false, status: 404 } as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    await expect(
      client.renewSubscription({
        subscriptionId: "sub-missing",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
      }),
    ).resolves.toBeNull();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("throws a sanitized GraphRequestError carrying only op, status, and code", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 403,
        json: vi.fn(async () => ({
          error: {
            code: "Forbidden",
            // Sensitive material that must NEVER reach the thrown error.
            message: "Access denied for https://graph.microsoft.com/users/ops@example.com/messages",
          },
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    const error = await client
      .createSubscription({
        resource: "users/ops%40example.com/messages",
        changeType: "created",
        notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
        clientState: "state",
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(GraphRequestError);
    if (!(error instanceof GraphRequestError)) {
      throw new Error("expected a GraphRequestError");
    }
    expect(error.message).toBe(
      "Graph request failed: op=create_subscription status=403 code=Forbidden",
    );
    expect(error.op).toBe("create_subscription");
    expect(error.status).toBe(403);
    expect(error.graphErrorCode).toBe("Forbidden");
    expect(error.expirationMaxMinutes).toBeUndefined();
    // The raw Graph message and mailbox identifiers never leak onto the error.
    expect(error.message).not.toContain("ops@example.com");
    expect(error.message).not.toContain("graph.microsoft.com");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("parses the tenant expiration ceiling out of the Graph error message", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 400,
        json: vi.fn(async () => ({
          error: {
            code: "ExtensionError",
            message: "Subscription expiration can only be 10070 minutes in the future.",
          },
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    const error = await client
      .createSubscription({
        resource: "users/ops%40example.com/messages",
        changeType: "created",
        notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
        clientState: "state",
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(GraphRequestError);
    if (!(error instanceof GraphRequestError)) {
      throw new Error("expected a GraphRequestError");
    }
    expect(error.graphErrorCode).toBe("ExtensionError");
    expect(error.expirationMaxMinutes).toBe(10_070);
    // Even the parsed-out integer never brings the raw message along.
    expect(error.message).toBe(
      "Graph request failed: op=create_subscription status=400 code=ExtensionError",
    );
  });

  it("drops a non-enum-like Graph error code so crafted text never reaches the message", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: false,
        status: 400,
        json: vi.fn(async () => ({
          error: {
            // A crafted `code` that embeds a URL and spaces: must be rejected
            // by the enum-like guard and never appear in the thrown message.
            code: "Bearer abc123 https://graph.microsoft.com/users/ops@example.com",
            message: "denied",
          },
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    const error = await client
      .createSubscription({
        resource: "users/ops%40example.com/messages",
        changeType: "created",
        notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
        clientState: "state",
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(GraphRequestError);
    if (!(error instanceof GraphRequestError)) {
      throw new Error("expected a GraphRequestError");
    }
    // The unsafe code is dropped → surfaced as `code=?`, and nothing from the
    // crafted value leaks into the message.
    expect(error.graphErrorCode).toBeUndefined();
    expect(error.message).toBe("Graph request failed: op=create_subscription status=400 code=?");
    expect(error.message).not.toContain("Bearer");
    expect(error.message).not.toContain("graph.microsoft.com");
    expect(error.message).not.toContain("ops@example.com");
  });

  it("throws GraphRequestError with status=no_id when the create response has no id", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        status: 201,
        json: vi.fn(async () => ({})),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    const error = await client
      .createSubscription({
        resource: "users/ops%40example.com/messages",
        changeType: "created",
        notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
        expirationDateTime: "2026-07-24T00:00:00.000Z",
        clientState: "state",
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(GraphRequestError);
    if (!(error instanceof GraphRequestError)) {
      throw new Error("expected a GraphRequestError");
    }
    expect(error.status).toBe("no_id");
    expect(error.expirationMaxMinutes).toBeUndefined();
  });

  it("lists only the id/notificationUrl fields of each subscription", async () => {
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({
          value: [
            {
              id: "sub-1",
              notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
              // Not consumed and mailbox-identifying: must never be returned.
              resource: "users/ops%40example.com/messages",
              clientState: "should-not-be-returned",
            },
            { id: "sub-2" },
            { notificationUrl: "https://other/no-id" },
          ],
        })),
      } as unknown as Response,
      release: mocks.release,
    });
    const client = createGraphClient({
      tokenProvider: { getAccessToken: vi.fn(async () => "test-token") },
    });

    await expect(client.listSubscriptions()).resolves.toEqual([
      {
        id: "sub-1",
        notificationUrl: "https://gateway.example.com/plugins/msgraph-mail-wake",
      },
      { id: "sub-2" },
    ]);

    const call = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    expect(call.init.method).toBe("GET");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
