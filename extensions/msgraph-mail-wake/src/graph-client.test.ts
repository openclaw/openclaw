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

import { createGraphClient } from "./graph-client.js";

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
});
