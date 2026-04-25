import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBlueBubblesShortIdState,
  resolveReplyContextFromCache,
} from "./monitor-reply-cache.js";
import {
  _resetBlueBubblesReplyFetchState,
  fetchBlueBubblesReplyContext,
} from "./monitor-reply-fetch.js";

const baseParams = {
  accountId: "default",
  baseUrl: "http://localhost:1234",
  password: "s3cret",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  _resetBlueBubblesReplyFetchState();
  _resetBlueBubblesShortIdState();
});

afterEach(() => {
  _resetBlueBubblesReplyFetchState();
  _resetBlueBubblesShortIdState();
});

describe("fetchBlueBubblesReplyContext", () => {
  it("returns null when replyToId is empty", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "  ",
      fetchImpl,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when baseUrl or password are missing", async () => {
    const fetchImpl = vi.fn();
    expect(
      await fetchBlueBubblesReplyContext({
        accountId: "default",
        baseUrl: "",
        password: "x",
        replyToId: "msg-1",
        fetchImpl,
      }),
    ).toBeNull();
    expect(
      await fetchBlueBubblesReplyContext({
        accountId: "default",
        baseUrl: "http://localhost:1234",
        password: "",
        replyToId: "msg-1",
        fetchImpl,
      }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches the BB API and returns body + normalized sender on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          text: "  hello world  ",
          handle: { address: " +15551234567 " },
        },
      }),
    );
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-1",
      fetchImpl,
    });
    expect(result).toEqual({ body: "hello world", sender: "+15551234567" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("/api/v1/message/msg-1");
    expect(calledUrl).toContain("password=s3cret");
  });

  it("lowercases email handles via normalizeBlueBubblesHandle", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { text: "hi", handle: { address: "Foo@Example.COM" } },
      }),
    );
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-email",
      fetchImpl,
    });
    expect(result?.sender).toBe("foo@example.com");
  });

  it("populates the reply cache so subsequent lookups hit RAM", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { text: "cached me", handle: { address: "+15551112222" } },
      }),
    );
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-cache",
      chatGuid: "iMessage;-;+15551112222",
      fetchImpl,
    });
    const cached = resolveReplyContextFromCache({
      accountId: "default",
      replyToId: "msg-cache",
      chatGuid: "iMessage;-;+15551112222",
    });
    expect(cached?.body).toBe("cached me");
    expect(cached?.senderLabel).toBe("+15551112222");
    expect(cached?.shortId).toBeTruthy();
  });

  it("falls back through text → body → subject for the message body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { body: "from body field" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { subject: "from subject field" } }));
    const a = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-a",
      fetchImpl,
    });
    expect(a?.body).toBe("from body field");
    const b = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-b",
      fetchImpl,
    });
    expect(b?.body).toBe("from subject field");
  });

  it("falls back through handle.address → handle.id → senderId → sender for the sender", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { text: "x", handle: { id: "+15550000001" } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { text: "x", senderId: "+15550000002" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { text: "x", sender: "+15550000003" } }));
    const a = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-a",
      fetchImpl,
    });
    expect(a?.sender).toBe("+15550000001");
    const b = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-b",
      fetchImpl,
    });
    expect(b?.sender).toBe("+15550000002");
    const c = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "h-c",
      fetchImpl,
    });
    expect(c?.sender).toBe("+15550000003");
  });

  it("accepts the BB response either wrapped under `data` or at the top level", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ text: "no envelope", handle: { address: "user@host" } }));
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-flat",
      fetchImpl,
    });
    expect(result?.body).toBe("no envelope");
    expect(result?.sender).toBe("user@host");
  });

  it("returns null on non-2xx without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "missing",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error / timeout)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "boom",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it("returns null when JSON parsing fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "garbage",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it("returns null when neither body nor sender can be extracted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { irrelevant: 1 } }));
    const result = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "blank",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  it("dedupes concurrent fetches for the same accountId + replyToId", async () => {
    let resolveOnce: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveOnce = resolve;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    const a = fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "shared",
      fetchImpl,
    });
    const b = fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "shared",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveOnce(
      jsonResponse({ data: { text: "shared body", handle: { address: "+15558675309" } } }),
    );
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual({ body: "shared body", sender: "+15558675309" });
    expect(resB).toEqual(resA);
  });

  it("does not dedupe across different accountIds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { text: "a", handle: { address: "+15551000001" } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { text: "b", handle: { address: "+15551000002" } } }),
      );
    const [a, b] = await Promise.all([
      fetchBlueBubblesReplyContext({
        ...baseParams,
        accountId: "acct-a",
        replyToId: "same",
        fetchImpl,
      }),
      fetchBlueBubblesReplyContext({
        ...baseParams,
        accountId: "acct-b",
        replyToId: "same",
        fetchImpl,
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(a?.body).toBe("a");
    expect(b?.body).toBe("b");
  });

  it("releases the in-flight slot once a request completes (next call re-fetches)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { text: "first", handle: { address: "+15552000001" } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { text: "second", handle: { address: "+15552000002" } } }),
      );
    const first = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-x",
      fetchImpl,
    });
    const second = await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "msg-x",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first?.body).toBe("first");
    expect(second?.body).toBe("second");
  });

  it("propagates the SSRF private-network opt-in to the fetch policy", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { text: "x", handle: { address: "+15553000001" } } }),
      );
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-on",
      accountConfig: { network: { dangerouslyAllowPrivateNetwork: true } },
      fetchImpl,
    });
    const policy = fetchImpl.mock.calls[0]?.[3];
    expect(policy).toEqual({ allowPrivateNetwork: true });
  });

  it("omits the SSRF policy when private-network opt-in is disabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { text: "x", handle: { address: "+15554000001" } } }),
      );
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "ssrf-off",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("uses the configured timeout", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { text: "x", handle: { address: "+15555000001" } } }),
      );
    await fetchBlueBubblesReplyContext({
      ...baseParams,
      replyToId: "tm",
      timeoutMs: 1234,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[2]).toBe(1234);
  });
});
