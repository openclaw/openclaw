// Sms tests cover outbound MMS media hosting behavior.
import fs from "node:fs";
import path from "node:path";
import {
  MediaFetchError,
  type unlinkIfExists as unlinkIfExistsType,
} from "openclaw/plugin-sdk/media-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { loadWebMedia as loadWebMediaType } from "openclaw/plugin-sdk/web-media";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  materializeSmsInboundMedia,
  prepareHostedSmsMedia,
  tryHandleHostedSmsMediaRequest,
} from "./media.js";
import { setSmsRuntime } from "./runtime.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

const assertSmsCredentialOwnerAvailable = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());
const unlinkIfExistsMock = vi.hoisted(() =>
  vi.fn<typeof unlinkIfExistsType>(async () => undefined),
);
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const OTHER_ACCOUNT_SID = `AC${"b".repeat(32)}`;
const MESSAGE_SID = `MM${"c".repeat(32)}`;
const OTHER_MESSAGE_SID = `MM${"d".repeat(32)}`;
const MEDIA_SID = `ME${"e".repeat(32)}`;
const OTHER_MEDIA_SID = `ME${"f".repeat(32)}`;
vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));
vi.mock("./credential-availability.js", () => ({ assertSmsCredentialOwnerAvailable }));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  unlinkIfExists: unlinkIfExistsMock,
}));

const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: fs.mkdtempSync(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-sms-media-"),
  ),
};

function createAccount(): ResolvedSmsAccount {
  const publicWebhookUrl = new URL("https://gateway.example.com/public/sms");
  publicWebhookUrl.searchParams.set("upstream-token", "keep");
  publicWebhookUrl.hash = "rp=all";
  return createSmsTestAccount({
    accountId: "default",
    accountSid: ACCOUNT_SID,
    webhookPath: "/internal/sms",
    publicWebhookUrl: publicWebhookUrl.toString(),
  });
}

async function prepareHostedSmsMediaUrl(
  params: Parameters<typeof prepareHostedSmsMedia>[0],
): Promise<string> {
  return (await prepareHostedSmsMedia(params)).url;
}

async function preparePhotoUrl(account = createAccount()): Promise<URL> {
  return new URL(
    await prepareHostedSmsMediaUrl({ account, mediaUrl: "https://example.com/photo.png" }),
  );
}

function twilioMediaUrl(
  params: {
    accountSid?: string;
    messageSid?: string;
    mediaSid?: string;
  } = {},
): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${
    params.accountSid ?? ACCOUNT_SID
  }/Messages/${params.messageSid ?? MESSAGE_SID}/Media/${params.mediaSid ?? MEDIA_SID}`;
}

function createInboundMessage(overrides: Partial<SmsInboundMessage> = {}): SmsInboundMessage {
  return {
    accountSid: ACCOUNT_SID,
    from: "+15551234567",
    to: "+15557654321",
    body: "photo",
    messageSid: MESSAGE_SID,
    media: [{ url: twilioMediaUrl(), contentType: "image/jpeg" }],
    ...overrides,
  };
}

function installRuntime(bulkReads = true) {
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests("sms", { ...options, env: testStateEnv });
    return { ...store, lookupMany: bulkReads ? store.lookupMany : undefined };
  });
  setSmsRuntime({
    state: {
      openKeyedStore,
    },
  } as unknown as PluginRuntime);
  return openKeyedStore;
}

function trackChunkReads<T>(store: PluginStateKeyedStore<T>) {
  const lookup = vi.spyOn(store, "lookup");
  const lookupMany = store.lookupMany ? vi.spyOn(store, "lookupMany") : undefined;
  return () => lookup.mock.calls.length + (lookupMany?.mock.calls.length ?? 0);
}

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end: vi.fn(),
    },
  };
}

describe("SMS outbound hosted media", () => {
  let openKeyedStore: ReturnType<typeof installRuntime>;

  beforeEach(() => {
    openKeyedStore = installRuntime();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
  });

  it("retries a hosted MMS cleanup after a transient store failure", async () => {
    const prepared = await prepareHostedSmsMedia({
      account: { ...createAccount(), accountId: "cleanup-retry" },
      mediaUrl: "https://example.com/photo.png",
    });
    const chunkStore = openKeyedStore.mock.results[1]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const originalDelete = chunkStore.delete.bind(chunkStore);
    let failed = false;
    vi.spyOn(chunkStore, "delete").mockImplementation(async (key) => {
      if (!failed) {
        failed = true;
        throw new Error("transient chunk delete failure");
      }
      return await originalDelete(key);
    });

    await expect(prepared.cleanup()).rejects.toThrow("transient chunk delete failure");
    await expect(prepared.cleanup()).resolves.toBeUndefined();
  });

  it.each([true])(
    "hosts repeat GET/HEAD fetches on the exact webhook path (bulk: %s)",
    async (bulkReads) => {
      openKeyedStore = installRuntime(bulkReads);
      const publicUrl = await preparePhotoUrl();
      const chunkStore = openKeyedStore.mock.results[1]?.value;
      if (!chunkStore) {
        throw new Error("expected hosted media chunk store");
      }
      const chunkReads = trackChunkReads(chunkStore);

      expect(publicUrl.origin).toBe("https://gateway.example.com");
      expect(publicUrl.pathname).toBe("/public/sms");
      expect(publicUrl.searchParams.get("upstream-token")).toBe("keep");
      expect(publicUrl.hash).toBe("");
      const tokenEntry = [...publicUrl.searchParams.entries()].find(([key]) =>
        key.startsWith("__openclaw_mms_token_"),
      );
      const id = tokenEntry?.[0].slice("__openclaw_mms_token_".length);
      expect(id).toMatch(/^[a-f0-9]{24}$/u);
      expect(publicUrl.searchParams.get(`__openclaw_mms_token_${id}`)).toMatch(/^[a-f0-9]{48}$/u);

      const internalUrl = `/internal/sms${publicUrl.search}`;
      const getResponse = createMockResponse();
      await tryHandleHostedSmsMediaRequest(
        { method: "GET", url: internalUrl } as never,
        getResponse.res as never,
      );
      expect(getResponse.res.statusCode).toBe(200);
      expect(getResponse.headers.get("Content-Type")).toBe("image/png");
      expect(getResponse.headers.get("Content-Disposition")).toMatch(
        /^inline; filename="mms-[a-f0-9]{10}\.png"$/u,
      );
      expect(getResponse.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));
      expect(chunkReads()).toBeGreaterThan(0);

      const readsBeforeHead = chunkReads();
      const headResponse = createMockResponse();
      await tryHandleHostedSmsMediaRequest(
        { method: "HEAD", url: internalUrl } as never,
        headResponse.res as never,
      );
      expect(headResponse.res.statusCode).toBe(200);
      expect(headResponse.res.end).toHaveBeenCalledWith(undefined);
      expect(chunkReads()).toBe(readsBeforeHead);

      const repeatedGetResponse = createMockResponse();
      await tryHandleHostedSmsMediaRequest(
        { method: "GET", url: internalUrl } as never,
        repeatedGetResponse.res as never,
      );
      expect(repeatedGetResponse.res.statusCode).toBe(200);
      expect(chunkReads()).toBeGreaterThan(readsBeforeHead);
    },
  );

  it("rejects hosted media requests with the wrong token", async () => {
    const hostedUrl = await preparePhotoUrl();
    const tokenEntry = [...hostedUrl.searchParams.entries()].find(([key]) =>
      key.startsWith("__openclaw_mms_token_"),
    );
    const id = tokenEntry?.[0].slice("__openclaw_mms_token_".length) ?? "";
    const tokenParam = `__openclaw_mms_token_${id}`;
    hostedUrl.searchParams.set(tokenParam, "wrong");
    const chunkStore = openKeyedStore.mock.results[1]?.value;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkReads = trackChunkReads(chunkStore);
    const response = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      {
        method: "GET",
        url: `/internal/sms${hostedUrl.search}`,
      } as never,
      response.res as never,
    );

    expect(response.res.statusCode).toBe(401);
    expect(response.res.end).toHaveBeenCalledWith("Unauthorized");
    expect(chunkReads()).toBe(0);
  });

  it("rejects multiple hosted-media token candidates before reading state", async () => {
    const response = createMockResponse();
    const firstId = "a".repeat(24);
    const secondId = "b".repeat(24);

    await expect(
      tryHandleHostedSmsMediaRequest(
        {
          method: "GET",
          url: `/internal/sms?__openclaw_mms_token_${firstId}=first&__openclaw_mms_token_${secondId}=second`,
        } as never,
        response.res as never,
      ),
    ).resolves.toBe(true);

    expect(response.res.statusCode).toBe(400);
    expect(response.res.end).toHaveBeenCalledWith("Bad Request");
    expect(openKeyedStore).not.toHaveBeenCalled();
  });

  it("does not serve media when metadata disappears before chunk hydration", async () => {
    const hostedUrl = await preparePhotoUrl();
    const metadataStore = openKeyedStore.mock.results[0]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    const chunkStore = openKeyedStore.mock.results[1]?.value as
      | PluginStateKeyedStore<unknown>
      | undefined;
    if (!metadataStore || !chunkStore) {
      throw new Error("expected hosted media stores");
    }
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      const metadata = await originalLookup(key);
      await metadataStore.delete(key);
      return metadata;
    });
    const chunkReads = trackChunkReads(chunkStore);
    const response = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      {
        method: "GET",
        url: `/internal/sms${hostedUrl.search}`,
      } as never,
      response.res as never,
    );

    expect(response.res.statusCode).toBe(404);
    expect(response.res.end).toHaveBeenCalledWith("Not Found");
    expect(chunkReads()).toBe(0);
  });

  it("ignores tokenless webhook requests before enforcing media methods", async () => {
    const response = createMockResponse();

    await expect(
      tryHandleHostedSmsMediaRequest(
        { method: "POST", url: "/internal/sms" } as never,
        response.res as never,
      ),
    ).resolves.toBe(false);

    expect(response.res.end).not.toHaveBeenCalled();
  });

  it("isolates hosted media by SMS account", async () => {
    const hostedUrl = await preparePhotoUrl({ ...createAccount(), accountId: "secondary" });
    const internalUrl = `/internal/sms${hostedUrl.search}`;
    const wrongAccountResponse = createMockResponse();

    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      wrongAccountResponse.res as never,
      "default",
    );
    expect(wrongAccountResponse.res.statusCode).toBe(404);

    const correctAccountResponse = createMockResponse();
    await tryHandleHostedSmsMediaRequest(
      { method: "GET", url: internalUrl } as never,
      correctAccountResponse.res as never,
      "secondary",
    );
    expect(correctAccountResponse.res.statusCode).toBe(200);
    expect(correctAccountResponse.res.end).toHaveBeenCalledWith(Buffer.from("image-bytes"));
  });

  it("requires a public webhook URL before hosting outbound MMS", async () => {
    await expect(
      prepareHostedSmsMediaUrl({
        account: { ...createAccount(), publicWebhookUrl: "" },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("MMS send requires channels.sms.publicWebhookUrl");
  });

  it("rejects public webhook URLs that require HTTP authentication", async () => {
    const authenticatedUrl = new URL("https://gateway.example.com/public/sms");
    authenticatedUrl.username = "user";
    authenticatedUrl.password = "password";

    await expect(
      prepareHostedSmsMediaUrl({
        account: {
          ...createAccount(),
          publicWebhookUrl: authenticatedUrl.toString(),
        },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("without embedded HTTP authentication");
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS public webhook URL", async () => {
    await expect(
      prepareHostedSmsMediaUrl({
        account: { ...createAccount(), publicWebhookUrl: "http://gateway.example.com/public/sms" },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("requires an HTTPS publicWebhookUrl with a hostname");
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "image/heic", byteLength: 500_001, outcome: "rejects" },
    { contentType: "application/msword", byteLength: 1, outcome: "unsupported" },
  ])(
    "$outcome detected $contentType media at $byteLength bytes",
    async ({ contentType, byteLength, outcome }) => {
      loadWebMediaMock.mockResolvedValueOnce({
        buffer: Buffer.alloc(byteLength),
        kind: "document",
        contentType,
        fileName: "attachment.bin",
      });
      const prepared = prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/attachment.bin",
      });

      if (outcome === "accepts") {
        await expect(prepared).resolves.toMatch(/^https:\/\/gateway\.example\.com\//u);
      } else if (outcome === "unsupported") {
        await expect(prepared).rejects.toThrow(
          `Twilio MMS does not support media type ${contentType}`,
        );
      } else {
        const expectedLimit = ["image/gif", "image/jpeg", "image/jpg", "image/png"].some((type) =>
          contentType.startsWith(type),
        )
          ? "5,000,000"
          : "500,000";
        await expect(prepared).rejects.toThrow(
          `Twilio MMS media exceeds the ${expectedLimit} byte limit`,
        );
      }
      expect(loadWebMediaMock).toHaveBeenLastCalledWith(
        "https://example.com/attachment.bin",
        expect.objectContaining({ maxBytes: 4_999_999 }),
      );
    },
  );

  it("rejects captioned media types that Twilio only accepts as media-only MMS", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("BEGIN:VCARD"),
      kind: "document",
      contentType: "application/vcard",
      fileName: "contact.vcf",
    });

    await expect(
      prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/contact.vcf",
        captionByteLength: 7,
      }),
    ).rejects.toThrow("Twilio MMS media type application/vcard must be sent without a caption");
  });

  it("enforces Twilio's aggregate body-and-media limit", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.alloc(4_999_997),
      kind: "image",
      contentType: "image/png",
      fileName: "attachment.png",
    });

    await expect(
      prepareHostedSmsMediaUrl({
        account: createAccount(),
        mediaUrl: "https://example.com/attachment.png",
        captionByteLength: 3,
      }),
    ).rejects.toThrow("attachment and caption must total less than 5,000,000 bytes");
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      "https://example.com/attachment.png",
      expect.objectContaining({ maxBytes: 4_999_996 }),
    );
  });
});

describe("SMS inbound MMS materialization", () => {
  beforeEach(() => {
    assertSmsCredentialOwnerAvailable.mockReset();
    unlinkIfExistsMock.mockClear();
  });

  async function expectInboundMediaFailure(error: MediaFetchError, retryable: boolean) {
    const pending = materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage({ body: "keep this caption" }),
      mediaRuntime: {
        media: {
          saveRemoteMedia: async () => {
            throw error;
          },
        },
      } as never,
    });

    if (retryable) {
      await expect(pending).rejects.toBe(error);
    } else {
      await expect(pending).resolves.toMatchObject({
        body: "keep this caption\n\n[1 Twilio MMS attachment unavailable]",
        media: [],
      });
    }
  }

  it.each([
    {
      name: "aggregate containing blocked SSRF and transient failure",
      cause: new AggregateError(
        [
          Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          new SsrFBlockedError("blocked private address"),
        ],
        "mixed failures",
      ),
      retryable: false,
    },
    {
      name: "local storage permission",
      cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      retryable: false,
    },
  ])("classifies $name without poisoning a sender lane", async ({ cause, retryable }) => {
    await expectInboundMediaFailure(
      new MediaFetchError("fetch_failed", "download failed", { cause }),
      retryable,
    );
  });

  it.each(["reason"] as const)(
    "does not retry when .$field contains an SSRF denial",
    async (field) => {
      const cause = Object.assign(
        new Error("fetch failed", {
          cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        }),
        { [field]: new SsrFBlockedError("blocked private address") },
      );

      await expectInboundMediaFailure(
        new MediaFetchError("fetch_failed", "download failed", { cause }),
        false,
      );
    },
  );

  it("keeps oversized MMS visible without retrying its sender lane", async () => {
    await expectInboundMediaFailure(new MediaFetchError("max_bytes", "too large"), false);
  });

  it("keeps the message visible when declared attachments exceed the download bound", async () => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage({
        body: "many photos",
        media: [],
        unavailableMediaCount: 2,
      }),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("many photos");
    expect(result.body).toContain("[2 Twilio MMS attachments unavailable]");
  });

  it("rejects non-Twilio media hosts and exposes a visible failure notice", async () => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage({
        body: "",
        media: [{ url: "https://example.com/not-twilio.jpg", contentType: "image/jpeg" }],
      }),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("Twilio MMS attachment unavailable");
  });

  it.each([
    {
      name: "a different Twilio account",
      url: twilioMediaUrl({ accountSid: OTHER_ACCOUNT_SID }),
    },
    {
      name: "a different parent message",
      url: twilioMediaUrl({ messageSid: OTHER_MESSAGE_SID }),
    },
    {
      name: "embedded URL credentials",
      url: twilioMediaUrl().replace("https://", "https://user:password@"),
    },
  ])("rejects $name before adding Twilio credentials", async ({ url }) => {
    const saveRemoteMedia = vi.fn();

    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage({
        body: "",
        media: [{ url, contentType: "image/jpeg" }],
      }),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });

    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expect(result.media).toEqual([]);
    expect(result.body).toContain("Twilio MMS attachment unavailable");
  });

  it.each([{ name: "padded", accountSid: ` ${ACCOUNT_SID} ` }])(
    "refuses downloads when AccountSid is $name",
    async ({ accountSid }) => {
      const saveRemoteMedia = vi.fn();

      const result = await materializeSmsInboundMedia({
        account: createAccount(),
        msg: createInboundMessage({ accountSid, body: "caption" }),
        mediaRuntime: { media: { saveRemoteMedia } } as never,
      });

      expect(saveRemoteMedia).not.toHaveBeenCalled();
      expect(result.media).toEqual([]);
      expect(result.body).toContain("caption");
      expect(result.body).toContain("Twilio MMS attachment unavailable");
    },
  );

  it("propagates durable claim cancellation instead of hiding it as unavailable media", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("SMS ingress claim superseded");
    abortController.abort(abortReason);
    const saveRemoteMedia = vi.fn();

    await expect(
      materializeSmsInboundMedia({
        account: createAccount(),
        msg: createInboundMessage(),
        mediaRuntime: { media: { saveRemoteMedia } } as never,
        abortSignal: abortController.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it.each(["claim cancellation", "retryable provider failure", "credential loss"])(
    "cleans already-saved files when a later attachment ends with %s",
    async (failureKind) => {
      const abortController = new AbortController();
      const abortReason =
        failureKind === "claim cancellation"
          ? new Error("SMS ingress claim superseded")
          : failureKind === "credential loss"
            ? new Error("SMS credential owner became unavailable")
            : new MediaFetchError("http_error", "Twilio temporarily unavailable", { status: 503 });
      if (failureKind === "credential loss") {
        assertSmsCredentialOwnerAvailable
          .mockImplementationOnce(() => {})
          .mockImplementationOnce(() => {
            throw abortReason;
          });
      }
      const saveRemoteMedia = vi
        .fn()
        .mockImplementationOnce(async (options) => {
          options.beforeRequest?.();
          return { path: "/tmp/first.jpg", size: 128, contentType: "image/jpeg" };
        })
        .mockImplementationOnce(async (options) => {
          if (failureKind === "claim cancellation") {
            abortController.abort(abortReason);
          }
          options.beforeRequest?.();
          throw abortReason;
        });

      await expect(
        materializeSmsInboundMedia({
          account: createAccount(),
          msg: createInboundMessage({
            body: "photos",
            media: [
              { url: twilioMediaUrl(), contentType: "image/jpeg" },
              { url: twilioMediaUrl({ mediaSid: OTHER_MEDIA_SID }), contentType: "image/jpeg" },
            ],
          }),
          mediaRuntime: { media: { saveRemoteMedia } } as never,
          abortSignal: abortController.signal,
        }),
      ).rejects.toBe(abortReason);

      expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
      expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/first.jpg");
    },
  );

  it("exposes idempotent cleanup for successfully materialized files", async () => {
    const result = await materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage(),
      mediaRuntime: {
        media: {
          saveRemoteMedia: async () => ({
            path: "/tmp/photo.jpg",
            size: 128,
            contentType: "image/jpeg",
          }),
        },
      } as never,
    });

    await Promise.all([result.cleanup(), result.cleanup()]);
    expect(unlinkIfExistsMock).toHaveBeenCalledOnce();
    expect(unlinkIfExistsMock).toHaveBeenCalledWith("/tmp/photo.jpg");
  });

  it("bounds the complete inbound MMS download batch below the ingress watchdog", async () => {
    const batchAbort = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(batchAbort.signal);
    const saveRemoteMedia = vi.fn(
      async (options: { requestInit?: { signal?: AbortSignal } }) =>
        await new Promise<never>((_resolve, reject) => {
          options.requestInit?.signal?.addEventListener(
            "abort",
            () => {
              const reason = options.requestInit?.signal?.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
            },
            { once: true },
          );
        }),
    );
    const pending = materializeSmsInboundMedia({
      account: createAccount(),
      msg: createInboundMessage(),
      mediaRuntime: { media: { saveRemoteMedia } } as never,
    });
    await vi.waitFor(() => expect(saveRemoteMedia).toHaveBeenCalledOnce());

    const timeoutReason = new DOMException("MMS batch timed out", "TimeoutError");
    batchAbort.abort(timeoutReason);

    await expect(pending).rejects.toBe(timeoutReason);
    expect(timeoutSpy).toHaveBeenCalledWith(4 * 60_000);
    timeoutSpy.mockRestore();
  });
});
