import type { WebClient } from "@slack/web-api";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WebMediaResult } from "openclaw/plugin-sdk/web-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./blocks.test-helpers.js";
import { createSlackWriteClient } from "./client.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown): Promise<WebMediaResult> => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const fetchWithSsrFGuard = vi.fn(
  async (
    params: Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0],
  ) => {
    if (!params.signal) {
      throw new Error("guarded Slack upload fetch requires a finite timeout signal");
    }
    params.beforeRequest?.();
    return {
      response: await fetch(params.url, {
        ...params.init,
        signal: params.signal,
      }),
      finalUrl: params.url,
      release: async () => {},
    } as const;
  },
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) =>
      fetchWithSsrFGuard(...(args as [params: Parameters<typeof actual.fetchWithSsrFGuard>[0]])),
  };
});

vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
      ...params,
      mode: "trusted_env_proxy",
    }),
  };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/outbound-media")>(
    "openclaw/plugin-sdk/outbound-media",
  );
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

const { sendMessageSlack } = await import("./send.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type UploadOverrides = Omit<Partial<Parameters<typeof sendMessageSlack>[2]>, "cfg" | "client">;
type UploadParams = UploadOverrides & { mediaUrl: string };

function sendUpload(client: WebClient, params: UploadParams) {
  return sendMessageSlack("channel:C123CHAN", "caption", {
    token: "xoxb-test",
    cfg: SLACK_TEST_CFG,
    client,
    ...params,
  });
}

function createRegisteredUploadTestClient(
  params: {
    afterUploadUrl?: () => void;
  } = {},
): { client: WebClient; apiRequests: string[] } {
  const apiRequests: string[] = [];
  const client = createSlackWriteClient("xoxb-test", {
    fetch: async (input) => {
      const url = String(input);
      apiRequests.push(url);
      if (url.endsWith("/files.getUploadURLExternal")) {
        params.afterUploadUrl?.();
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://files.slack.com/upload",
            file_id: "F001",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true, ts: "171234.567" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, apiRequests };
}

describe("Slack upload authority", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fences the byte upload when authority closes after URL allocation", async () => {
    let authorityActive = true;
    const registered = createRegisteredUploadTestClient({
      afterUploadUrl: () => {
        authorityActive = false;
      },
    });

    const caught = await sendUpload(registered.client, {
      mediaUrl: "/tmp/closed-before-upload.png",
      assertDirectAdapterHandoff: () => {
        if (!authorityActive) {
          throw new TypeError("upload authority is no longer active");
        }
      },
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(registered.apiRequests).toHaveLength(1);
  });

  it("rechecks authority after held DNS preparation and before upload bytes", async () => {
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    const networkFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    fetchWithSsrFGuard.mockImplementationOnce(async (params) =>
      actual.fetchWithSsrFGuard({
        ...params,
        mode: "strict",
        fetchImpl: networkFetch,
        lookupFn: async () => {
          lookupStarted.resolve();
          await releaseLookup.promise;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    let authorityActive = true;
    const registered = createRegisteredUploadTestClient();
    const pending = sendUpload(registered.client, {
      mediaUrl: "/tmp/closed-during-dns.png",
      assertDirectAdapterHandoff: () => {
        if (!authorityActive) {
          throw new TypeError("upload authority is no longer active");
        }
      },
    }).catch((error: unknown) => error);
    await lookupStarted.promise;
    authorityActive = false;
    releaseLookup.resolve();

    const caught = await pending;
    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(networkFetch).not.toHaveBeenCalled();
    expect(registered.apiRequests).toHaveLength(1);
  });

  it("rechecks authority after held redirect preparation and before the next hop", async () => {
    const redirectLookupStarted = createDeferred<void>();
    const releaseRedirectLookup = createDeferred<void>();
    const networkFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://files.slack.com/upload-next" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
      "openclaw/plugin-sdk/ssrf-runtime",
    );
    let lookupCount = 0;
    fetchWithSsrFGuard.mockImplementationOnce(async (params) =>
      actual.fetchWithSsrFGuard({
        ...params,
        mode: "strict",
        fetchImpl: networkFetch,
        lookupFn: async () => {
          lookupCount += 1;
          if (lookupCount === 2) {
            redirectLookupStarted.resolve();
            await releaseRedirectLookup.promise;
          }
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    let authorityActive = true;
    const registered = createRegisteredUploadTestClient();
    const pending = sendUpload(registered.client, {
      mediaUrl: "/tmp/closed-during-redirect.png",
      assertDirectAdapterHandoff: () => {
        if (!authorityActive) {
          throw new TypeError("upload authority is no longer active");
        }
      },
    }).catch((error: unknown) => error);
    await redirectLookupStarted.promise;
    authorityActive = false;
    releaseRedirectLookup.resolve();

    const caught = await pending;
    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(registered.apiRequests).toHaveLength(1);
  });

  it("keeps dispatch evidence when authority closes after the byte upload", async () => {
    let authorityActive = true;
    globalThis.fetch = vi.fn(async () => {
      authorityActive = false;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const onPlatformSendDispatch = vi.fn();
    const registered = createRegisteredUploadTestClient();

    const caught = await sendUpload(registered.client, {
      mediaUrl: "/tmp/closed-before-completion.png",
      onPlatformSendDispatch,
      assertDirectAdapterHandoff: () => {
        if (!authorityActive) {
          throw new TypeError("completion authority is no longer active");
        }
      },
    }).catch((error: unknown) => error);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(registered.apiRequests).toHaveLength(1);
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });
});
