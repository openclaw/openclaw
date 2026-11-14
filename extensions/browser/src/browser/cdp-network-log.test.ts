import { describe, expect, it } from "vitest";
import { createCdpNetworkLog } from "./cdp-network-log.js";

function fixture() {
  const log = createCdpNetworkLog();
  const event = (method: string, params: Record<string, unknown>, sessionId = "page-session") =>
    log.receive({ method, params, sessionId });
  const attach = (sessionId: string, targetId: string, type = "page", parent?: string) =>
    event("Target.attachedToTarget", { sessionId, targetInfo: { targetId, type } }, parent);
  attach("page-session", "page");
  const request = (requestId: string, sessionId = "page-session", extra = {}) =>
    event(
      "Network.requestWillBeSent",
      {
        requestId,
        type: "Fetch",
        request: { url: `https://example.test/${requestId}`, method: "POST", ...extra },
      },
      sessionId,
    );
  return { log, event, attach, request };
}

describe("CDP network metadata log", () => {
  it.each([
    ["XHR", "xhr"],
    ["CSPViolationReport", "cspreport"],
    ["Preflight", "other"],
    ["constructor", "other"],
  ])("preserves resource type %s as %s", (type, expected) => {
    const { log, event } = fixture();
    event("Network.requestWillBeSent", {
      requestId: "type",
      type,
      request: { url: "https://example.test", method: "GET" },
    });
    expect(log.read("page")[0]?.resourceType).toBe(expected);
  });

  it("bounds retained metadata and unfinished associations without retaining POST payloads", () => {
    const { log, event, request } = fixture();
    request("inline", undefined, { url: "data:text/plain,synthetic" });
    expect(log.read("page")).toEqual([]);
    const payload = { postData: "secret synthetic body", postDataEntries: [{ bytes: "Ynl0ZXM=" }] };
    request("first", undefined, { ...payload, url: `https://example.test/${"x".repeat(3_000)}` });
    const first = log.read("page")[0]!;
    expect(first).toEqual({
      id: "r1",
      timestamp: expect.any(String),
      method: "POST",
      url: `https://example.test/${"x".repeat(3_000)}`.slice(0, 2_048),
      resourceType: "fetch",
    });
    for (let index = 0; index < 500; index++) {
      request(String(index));
    }
    expect(log.read("page")).toHaveLength(500);
    expect(log.read("page")[0]?.id).toBe("r2");
    event("Network.responseReceived", { requestId: "first", response: { status: 500 } });
    expect(first.status).toBeUndefined();
  });

  it("records redirects, terminal statuses, failures and clear without reusing IDs", () => {
    const { log, event, request } = fixture();
    request("redirect");
    event("Network.requestWillBeSent", {
      requestId: "redirect",
      type: "Document",
      redirectResponse: { status: 302 },
      request: { url: "https://example.test/final", method: "GET" },
    });
    event("Network.responseReceived", { requestId: "redirect", response: { status: 200 } });
    event("Network.loadingFinished", { requestId: "redirect" });
    request("failed");
    event("Network.loadingFailed", { requestId: "failed", errorText: "f".repeat(3_000) });
    expect(
      log.read("page").map(({ id, status, ok, failureText }) => ({ id, status, ok, failureText })),
    ).toEqual([
      { id: "r1", status: 302, ok: false, failureText: undefined },
      { id: "r2", status: 200, ok: true, failureText: undefined },
      { id: "r3", status: undefined, ok: false, failureText: "f".repeat(2_048) },
    ]);
    request("no-content");
    event("Network.responseReceived", { requestId: "no-content", response: { status: 204 } });
    event("Network.loadingFailed", { requestId: "no-content", errorText: "net::ERR_ABORTED" });
    expect(log.read("page").at(-1)).toMatchObject({ status: 204, ok: true });
    expect(log.read("page").at(-1)?.failureText).toBeUndefined();
    request("pending");
    const cleared = log.read("page", true);
    expect(log.read("page")).toEqual([]);
    event("Network.responseReceived", { requestId: "pending", response: { status: 200 } });
    expect(cleared.at(-1)?.status).toBeUndefined();
    request("later");
    expect(log.read("page")[0]?.id).toBe("r6");
  });

  it.each(["iframe", "worker"])(
    "correlates %s transitions, isolates pages, and ignores auxiliary sessions",
    (type) => {
      const { log, event, attach, request } = fixture();
      attach("child-session", "child", type, "page-session");
      attach("auxiliary", "page");
      request("same");
      request("child", "child-session");
      request("ignored", "auxiliary");
      event(
        "Network.responseReceived",
        { requestId: "same", response: { status: 201 } },
        "child-session",
      );
      event("Target.detachedFromTarget", { sessionId: "auxiliary" });
      expect(log.read("page").map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "r1", status: 201 },
        { id: "r2", status: undefined },
      ]);
      event(
        "Network.loadingFailed",
        { requestId: "same", errorText: "net::ERR_FAILED" },
        "child-session",
      );
      expect(log.read("page")[0]).toMatchObject({ ok: false, failureText: "net::ERR_FAILED" });
      attach("other-session", "other-page");
      request("same", "other-session");
      event(
        "Network.responseReceived",
        { requestId: "same", response: { status: 200 } },
        "other-session",
      );
      expect(log.read("other-page")[0]).toMatchObject({ status: 200, ok: true });
      expect(log.read("page")[0]?.ok).toBe(false);
      event("Target.detachedFromTarget", { sessionId: "child-session" });
      request("detached", "child-session");
      expect(log.read("page")).toHaveLength(2);
      event("Target.detachedFromTarget", { sessionId: "page-session" });
      expect(log.read("page")).toEqual([]);
      attach("new-page-session", "page");
      request("new", "new-page-session");
      expect(log.read("page")).toHaveLength(1);
      log.clear();
      request("cleared", "new-page-session");
      expect(log.read("page")).toEqual([]);
    },
  );
});
