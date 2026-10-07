import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendHarness,
  encryptResponse,
  imageUrl,
  serviceUrl,
  useAudioFixture,
  type SendHarness,
} from "./send.handoff.test-support.js";
import { createZalouserTool } from "./tool.js";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

vi.mock("./session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-state.js")>()),
  clearStoredZaloCredentials: vi.fn(),
  loadStoredZaloCredentials: vi.fn(),
  refreshStoredZaloCredentials: vi.fn(),
  saveStoredZaloCredentials: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: vi.fn(),
}));

let harness: SendHarness;

beforeEach(() => {
  harness = createSendHarness();
});

afterEach(async () => {
  await harness.close();
});

describe("Zalouser registered send handoff", () => {
  it.each([false, true])(
    "rechecks the SDK fetch caller after effect preparation (retired=%s)",
    async (retired) => {
      const preparation = harness.gate();
      const response = harness.gate();
      const caller = new AbortController();
      effectGate.prepare = async () => {
        preparation.entered.resolve();
        await preparation.release.promise;
      };
      harness.response = async () => {
        response.entered.resolve();
        await response.release.promise;
        return encryptResponse({ msgId: "prepared-send" });
      };
      const sending = harness.send("message.text", { signal: caller.signal }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparation.entered.promise,
          response.entered.promise.then(() => {
            throw new Error("dispatched before preparation");
          }),
          sending.then(() => {
            throw new Error("settled before preparation");
          }),
        ]);
        expect(harness.requests).toEqual([]);
        if (retired) {
          caller.abort(new Error("caller retired during effect preparation"));
        }
        preparation.release.resolve();
        if (!retired) {
          await response.entered.promise;
          caller.abort(new Error("caller retired after dispatch"));
        }
        response.release.resolve();
        expect(await sending).toMatchObject(
          retired
            ? { error: { message: "caller retired during effect preparation" } }
            : { value: { messageId: "prepared-send" } },
        );
        expect(harness.requests).toHaveLength(retired ? 0 : 1);
      } finally {
        preparation.release.resolve();
        response.release.resolve();
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  it.each(["SDK cookie preparation", "dispatch notification", "payload cancellation"] as const)(
    "stops a retired caller after %s",
    async (stage) => {
      const wait = stage === "dispatch notification" ? harness.gate() : harness.holdCookie();
      const caller = new AbortController();
      let current = true;
      const send = harness.send(stage === "payload cancellation" ? "sendPayload" : "message.text", {
        ...(stage === "payload cancellation" ? { mediaUrl: imageUrl, signal: caller.signal } : {}),
        assertDirectAdapterHandoff: () => {
          if (stage !== "payload cancellation" && !current) {
            throw new Error("caller retired");
          }
        },
        onPlatformSendDispatch:
          stage === "dispatch notification"
            ? async () => {
                wait.entered.resolve();
                await wait.release.promise;
              }
            : undefined,
      });
      await wait.entered.promise;
      current = false;
      caller.abort(new Error("caller canceled"));
      wait.release.resolve();
      await expect(send).rejects.toThrow(
        stage === "payload cancellation" ? "caller canceled" : "caller retired",
      );
      expect(harness.requests).toEqual([]);
    },
  );

  it("sendPayload uploads and delivers an allowed group image", async () => {
    const result = await harness.send("sendPayload", { mediaUrl: imageUrl, to: "group:300" });
    expect(result.messageId).toBe("message-1");
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/group/photo_original/upload",
      "/api/group/photo_original/send",
    ]);
    expect(harness.requests[1]?.params).toMatchObject({ grid: "300", desc: "hello" });
  });

  it.each(["message.text", "sendPayload"] as const)(
    "%s preserves chunk progress and stops after its awaited callback",
    async (route) => {
      const progress = harness.gate();
      const caller = new AbortController();
      const ids: Array<string | undefined> = [];
      const send = harness.send(route, {
        text: "a".repeat(2001),
        signal: caller.signal,
        onDeliveryResult: async (result) => {
          ids.push(result.messageId);
          progress.entered.resolve();
          await progress.release.promise;
        },
      });
      await progress.entered.promise;
      caller.abort(new Error("caller canceled"));
      progress.release.resolve();
      await expect(send).rejects.toThrow("caller canceled");
      expect(ids).toEqual(["message-1"]);
      expect(harness.requests.map(({ params }) => params.message)).toEqual(["a".repeat(2000)]);
    },
  );

  it("keeps overlapping caller checks separate on one cached SDK client", async () => {
    await harness.send("message.text", { text: "warm client" });
    const api = harness.api;
    harness.requests.length = 0;
    const cookie = harness.holdCookie();
    const caller = new AbortController();
    const canceled = harness.send("message.text", {
      to: "user:201",
      text: "canceled A",
      signal: caller.signal,
    });
    await cookie.entered.promise;
    caller.abort(new Error("caller A canceled"));
    const allowed = await harness.send("sendText", { to: "user:202", text: "allowed B" });
    cookie.release.resolve();
    await expect(canceled).rejects.toThrow("caller A canceled");
    expect(allowed.messageId).toBe("message-2");
    expect(harness.api).toBe(api);
    expect(harness.requests).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ message: "allowed B", toid: "202" }),
      }),
    ]);
  });

  it("retires cookie-waiting upload requests when a parallel SDK request fails", async () => {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.alloc(2048),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
    const cookie = harness.holdCookie();
    harness.response = () => new Response(null, { status: 503 });
    const send = harness.send("message.media", { text: "" });
    await cookie.entered.promise;
    await expect(send).rejects.toThrow("503");
    cookie.release.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(harness.requests).toEqual([
      expect.objectContaining({
        path: "/api/message/photo_original/upload",
        params: expect.objectContaining({ chunkId: 2 }),
      }),
    ]);
  });

  it.each([false, true])("rechecks SDK redirects when canceled=%s", async (canceled) => {
    const cookie = harness.gate();
    const caller = new AbortController();
    harness.response = (request) => {
      if (request.path === "/api/message/sms") {
        harness.cookieWaits.push(cookie);
        return new Response(null, {
          status: 302,
          headers: { location: `${serviceUrl}/redirected-send` },
        });
      }
      return encryptResponse({ msgId: "redirect-accepted" });
    };
    const send = harness.send("message.text", { signal: caller.signal });
    await cookie.entered.promise;
    if (canceled) {
      caller.abort(new Error("caller canceled"));
    }
    cookie.release.resolve();
    if (canceled) {
      await expect(send).rejects.toThrow("caller canceled");
      expect(harness.requests.map(({ path }) => path)).toEqual(["/api/message/sms"]);
    } else {
      expect((await send).messageId).toBe("redirect-accepted");
      expect(harness.requests.map(({ method, path }) => [method, path])).toEqual([
        ["POST", "/api/message/sms"],
        ["GET", "/redirected-send"],
      ]);
    }
  });

  it.each(["image upload", "upload completion", "voice HEAD"] as const)(
    "does not mark %s as visible delivery or send after its wait",
    async (stage) => {
      if (stage !== "image upload") {
        useAudioFixture();
      }
      const wait = harness.gate();
      const caller = new AbortController();
      let visibleDispatch = false;
      if (stage === "upload completion") {
        harness.uploadWait = wait;
      } else {
        harness.response = async (request) => {
          if (
            stage === "image upload" ? request.path.endsWith("/upload") : request.method === "HEAD"
          ) {
            wait.entered.resolve();
            await wait.release.promise;
          }
          return harness.respond(request);
        };
      }
      const send = harness.send("message.media", {
        text: "",
        signal: caller.signal,
        onPlatformSendDispatch: async () => {
          visibleDispatch = true;
        },
      });
      await wait.entered.promise;
      expect(visibleDispatch).toBe(false);
      caller.abort(new Error("caller canceled"));
      wait.release.resolve();
      await expect(send).rejects.toThrow("caller canceled");
      expect(harness.requests.map(({ path }) => path)).toEqual(
        stage === "image upload"
          ? ["/api/message/photo_original/upload"]
          : stage === "upload completion"
            ? ["/api/message/asyncfile/upload"]
            : ["/api/message/asyncfile/upload", "/voice.aac"],
      );
    },
  );

  it("delivers allowed audio after the SDK upload callback and HEAD", async () => {
    useAudioFixture();
    let visibleDispatch = false;
    const dispatchAtRequest: Array<{ path: string; visibleDispatch: boolean }> = [];
    harness.response = (request) => {
      dispatchAtRequest.push({ path: request.path, visibleDispatch });
      return harness.respond(request);
    };
    const result = await harness.send("sendMedia", {
      text: "",
      onPlatformSendDispatch: async () => {
        visibleDispatch = true;
      },
    });
    expect(result.messageId).toBe("message-1");
    expect(result.receipt?.platformMessageIds).toEqual(["message-1"]);
    expect(dispatchAtRequest).toEqual([
      { path: "/api/message/asyncfile/upload", visibleDispatch: false },
      { path: "/voice.aac", visibleDispatch: false },
      { path: "/api/message/forward", visibleDispatch: true },
    ]);
  });

  it("preserves an accepted ID when cancellation happens after fetch handoff", async () => {
    const accepted = harness.gate();
    const caller = new AbortController();
    harness.response = async () => {
      accepted.entered.resolve();
      await accepted.release.promise;
      return encryptResponse({ msgId: "accepted-before-cancel" });
    };
    const send = harness.send("message.text", { signal: caller.signal });
    await accepted.entered.promise;
    caller.abort(new Error("caller canceled"));
    accepted.release.resolve();
    const result = await send;
    expect(result.messageId).toBe("accepted-before-cancel");
    expect(result.receipt?.platformMessageIds).toEqual(["accepted-before-cancel"]);
    expect(harness.requests.map(({ path }) => path)).toEqual(["/api/message/sms"]);
  });

  it.each(["audio", "document"] as const)(
    "preserves %s caption visibility on upload failure",
    async (kind) => {
      if (kind === "audio") {
        useAudioFixture();
      } else {
        vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
          buffer: Buffer.from("fixture-document"),
          kind: "document",
          contentType: "text/plain",
          fileName: "document.txt",
        });
      }
      const captionId = kind === "audio" ? "accepted-caption" : "sdk-private-caption";
      const ids: Array<string | undefined> = [];
      harness.response = (request) =>
        request.path.endsWith("/upload")
          ? new Response(null, { status: 503 })
          : encryptResponse({ msgId: captionId });
      const send = harness.send(kind === "audio" ? "message.media" : "sendPayload", {
        text: "caption",
        mediaUrl: imageUrl,
        onDeliveryResult: (result) => {
          ids.push(result.messageId);
        },
      });
      await expect(send).rejects.toThrow("503");
      if (kind === "audio") {
        await expect(send).rejects.toMatchObject({
          deliveryResult: {
            messageIds: [captionId],
            visibleReplySent: true,
            receipt: { platformMessageIds: [captionId] },
          },
        });
      }
      expect(ids).toEqual(kind === "audio" ? [captionId] : []);
      expect(harness.requests.map(({ path }) => path)).toEqual([
        "/api/message/sms",
        "/api/message/asyncfile/upload",
      ]);
    },
  );

  it.each([false, true])(
    "the optional tool preserves cancellation=%s at the SDK wait",
    async (canceled) => {
      const cookie = harness.holdCookie();
      const caller = new AbortController();
      const tool = createZalouserTool({ config: harness.cfg });
      const send = harness.track(
        tool.execute(
          "handoff-test",
          { action: "send", profile: harness.profile, threadId: "200", message: "tool hello" },
          caller.signal,
        ),
      );
      await cookie.entered.promise;
      if (canceled) {
        caller.abort(new Error("tool caller canceled"));
      }
      cookie.release.resolve();
      const result = await send;
      if (canceled) {
        expect(result.details).toEqual({ error: "tool caller canceled" });
        expect(harness.requests).toEqual([]);
      } else {
        expect(result.details).toEqual({ success: true, messageId: "message-1" });
        expect(harness.requests.map(({ params }) => params.message)).toEqual(["tool hello"]);
      }
    },
  );
});
