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

vi.mock("./session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-state.js")>()),
  clearStoredZaloCredentials: vi.fn(),
  loadStoredZaloCredentials: vi.fn(),
  loadStoredZaloCredentialsAsync: vi.fn(),
  refreshStoredZaloCredentials: vi.fn(),
  saveStoredZaloCredentials: vi.fn(),
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
  it.each(["message.text", "sendText", "sendPayload"] as const)(
    "%s delivers valid text through the real SDK",
    async (route) => {
      const result = await harness.send(route);
      expect(result.messageId).toBe("message-1");
      expect(harness.requests).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/api/message/sms",
          params: expect.objectContaining({ message: "hello", toid: "200" }),
        }),
      ]);
    },
  );

  it.each(["message.text", "sendText", "sendPayload"] as const)(
    "%s stops cancellation during SDK cookie preparation",
    async (route) => {
      const cookie = harness.holdCookie();
      const caller = new AbortController();
      const send = harness.send(route, { signal: caller.signal });
      await cookie.entered.promise;
      caller.abort(new Error("caller canceled"));
      cookie.release.resolve();
      await expect(send).rejects.toThrow("caller canceled");
      expect(harness.requests).toEqual([]);
    },
  );

  it("stops a retired caller after SDK cookie preparation", async () => {
    const cookie = harness.holdCookie();
    let current = true;
    const send = harness.send("message.text", {
      assertDirectAdapterHandoff: () => {
        if (!current) {
          throw new Error("caller retired");
        }
      },
    });
    await cookie.entered.promise;
    current = false;
    cookie.release.resolve();
    await expect(send).rejects.toThrow("caller retired");
    expect(harness.requests).toEqual([]);
  });

  it("rechecks the caller after the asynchronous dispatch notification", async () => {
    const dispatch = harness.gate();
    let current = true;
    const send = harness.send("message.text", {
      assertDirectAdapterHandoff: () => {
        if (!current) {
          throw new Error("caller retired during dispatch notification");
        }
      },
      onPlatformSendDispatch: async () => {
        dispatch.entered.resolve();
        await dispatch.release.promise;
      },
    });
    await dispatch.entered.promise;
    current = false;
    dispatch.release.resolve();
    await expect(send).rejects.toThrow("caller retired during dispatch notification");
    expect(harness.requests).toEqual([]);
  });

  it.each(["message.media", "sendMedia", "sendPayload"] as const)(
    "%s uploads and delivers an allowed image",
    async (route) => {
      const result = await harness.send(route, { mediaUrl: imageUrl, to: "group:300" });
      expect(result.messageId).toBe("message-1");
      expect(harness.requests.map(({ path }) => path)).toEqual([
        "/api/group/photo_original/upload",
        "/api/group/photo_original/send",
      ]);
      expect(harness.requests[1]?.params).toMatchObject({ grid: "300", desc: "hello" });
    },
  );

  it.each(["message.media", "sendMedia", "sendPayload"] as const)(
    "%s stops before an upload after cancellation during SDK preparation",
    async (route) => {
      const cookie = harness.holdCookie();
      const caller = new AbortController();
      const send = harness.send(route, { mediaUrl: imageUrl, signal: caller.signal });
      await cookie.entered.promise;
      caller.abort(new Error("caller canceled"));
      cookie.release.resolve();
      await expect(send).rejects.toThrow("caller canceled");
      expect(harness.requests).toEqual([]);
    },
  );

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

  it("does not mark an image upload as visible delivery or send after its wait", async () => {
    const upload = harness.gate();
    const caller = new AbortController();
    let visibleDispatch = false;
    harness.response = async (request) => {
      if (request.path.endsWith("/upload")) {
        upload.entered.resolve();
        await upload.release.promise;
      }
      return harness.respond(request);
    };
    const send = harness.send("message.media", {
      text: "",
      signal: caller.signal,
      onPlatformSendDispatch: async () => {
        visibleDispatch = true;
      },
    });
    await upload.entered.promise;
    expect(visibleDispatch).toBe(false);
    caller.abort(new Error("caller canceled"));
    upload.release.resolve();
    await expect(send).rejects.toThrow("caller canceled");
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/message/photo_original/upload",
    ]);
  });

  it.each(["upload completion", "voice HEAD"] as const)(
    "does not mark %s as visible delivery or send after its wait",
    async (stage) => {
      useAudioFixture();
      const wait = harness.gate();
      const caller = new AbortController();
      let visibleDispatch = false;
      if (stage === "upload completion") {
        harness.uploadWait = wait;
      } else {
        harness.response = async (request) => {
          if (request.method === "HEAD") {
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
        stage === "upload completion"
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

  it("reports accepted audio caption progress before a later upload error", async () => {
    useAudioFixture();
    const ids: Array<string | undefined> = [];
    harness.response = (request) =>
      request.path.endsWith("/upload")
        ? new Response(null, { status: 503 })
        : encryptResponse({ msgId: "accepted-caption" });
    const send = harness.send("message.media", {
      text: "caption",
      onDeliveryResult: (result) => {
        ids.push(result.messageId);
      },
    });
    await expect(send).rejects.toThrow("503");
    await expect(send).rejects.toMatchObject({
      deliveryResult: {
        messageIds: ["accepted-caption"],
        visibleReplySent: true,
        receipt: { platformMessageIds: ["accepted-caption"] },
      },
    });
    expect(ids).toEqual(["accepted-caption"]);
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/message/sms",
      "/api/message/asyncfile/upload",
    ]);
  });

  it("does not turn an opaque SDK partial-media rejection into success", async () => {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.from("fixture-document"),
      kind: "document",
      contentType: "text/plain",
      fileName: "document.txt",
    });
    const ids: Array<string | undefined> = [];
    harness.response = (request) =>
      request.path.endsWith("/upload")
        ? new Response(null, { status: 503 })
        : encryptResponse({ msgId: "sdk-private-caption" });
    const send = harness.send("sendPayload", {
      text: "caption",
      mediaUrl: imageUrl,
      onDeliveryResult: (result) => {
        ids.push(result.messageId);
      },
    });
    await expect(send).rejects.toThrow("503");
    expect(ids).toEqual([]);
    expect(harness.requests.map(({ path }) => path)).toEqual([
      "/api/message/sms",
      "/api/message/asyncfile/upload",
    ]);
  });

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
