import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserRequests,
  browserErrors,
  browserPageText,
  browserEmulateSetting,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./client-actions.js";
import { browserCloseTabByRawTargetId } from "./client-tab-close.runtime.js";
import {
  browserDoctor,
  browserOpenTab,
  browserSnapshot,
  browserStatus,
  browserTabs,
} from "./client.js";

const baseUrl = "http://127.0.0.1:18791";
type FetchCall = { url: string; init?: RequestInit & { timeoutMs?: number } };

function captureFetch(body: unknown, responseFor?: (url: string, init?: RequestInit) => unknown) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: FetchCall["init"]) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(responseFor ? responseFor(url, init) : body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("browser client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps connection failures with a sandbox hint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: refused,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed));

    await expect(browserStatus(baseUrl)).rejects.toThrow(/sandboxed session/i);
  });

  it("preserves unavailable tab state from a disconnected browser", async () => {
    captureFetch({ running: false, tabs: [] });

    await expect(browserTabs(baseUrl)).resolves.toEqual({
      running: false,
      tabs: [],
    });
  });

  it("adds useful cancellation messaging for abort-like failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(browserStatus(baseUrl)).rejects.toThrow(/cancelled/i);
  });

  it.each<[string, Parameters<typeof browserSnapshot>[1], Record<string, string>]>([
    [
      "labels and efficient mode",
      { format: "ai", labels: true, mode: "efficient" },
      { labels: "1", mode: "efficient" },
    ],
    ["ARIA refs", { format: "ai", refs: "aria" }, { refs: "aria" }],
    ["server capability defaults", { profile: "chrome" }, { profile: "chrome" }],
    ["explicit timeout", { format: "ai", timeoutMs: 4321 }, { timeoutMs: "4321" }],
    [
      "clamped timeout",
      { format: "ai", timeoutMs: Number.MAX_SAFE_INTEGER },
      { timeoutMs: String(MAX_TIMER_TIMEOUT_MS) },
    ],
    ["default timeout", { format: "ai" }, { timeoutMs: "20000" }],
  ])("encodes snapshot %s", async (_name, options, query) => {
    const calls = captureFetch({ ok: true, format: "ai" });
    await expect(browserSnapshot(baseUrl, options)).resolves.toMatchObject({
      ok: true,
      format: "ai",
    });
    const parsed = new URL(calls[0]!.url);
    expect(parsed.pathname).toBe("/snapshot");
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject(query);
    expect(parsed.searchParams.has("format")).toBe(options.format !== undefined);
  });

  it("encodes observation filters and routes emulation through the selected profile", async () => {
    const calls = captureFetch({ ok: true });
    const profile = "test profile";
    await browserRequests(baseUrl, { targetId: "t1", filter: "/api?q=a&b", clear: false, profile });
    await browserPageText(baseUrl, {
      targetId: "t1",
      selector: "article > p",
      maxChars: 123,
      profile,
    });
    await browserEmulateSetting(baseUrl, {
      setting: "device",
      body: { targetId: "t1", name: "iPhone 15" },
      profile,
    });
    await browserErrors(baseUrl, { targetId: "tab & one", clear: false, profile });
    expect(calls).toHaveLength(4);
    expect(
      calls.map(({ url }) => {
        const parsed = new URL(url);
        return [parsed.pathname, Object.fromEntries(parsed.searchParams)];
      }),
    ).toEqual([
      ["/requests", { targetId: "t1", filter: "/api?q=a&b", clear: "false", profile }],
      ["/text", { targetId: "t1", selector: "article > p", maxChars: "123", profile }],
      ["/set/device", { profile }],
      ["/errors", { targetId: "tab & one", clear: "false", profile }],
    ]);
    expect(calls[2]!.init?.method).toBe("POST");
    const deviceBody = calls[2]!.init?.body;
    if (typeof deviceBody !== "string") {
      throw new Error("expected a JSON request body");
    }
    expect(JSON.parse(deviceBody)).toEqual({ targetId: "t1", name: "iPhone 15" });
  });

  it("uses the expected endpoints + methods for common calls", async () => {
    const download = {
      url: "https://y/report.csv",
      suggestedFilename: "report.csv",
      path: "/tmp/openclaw/downloads/report.csv",
    };
    const downloads = [
      {
        url: "https://x/report.pdf",
        suggestedFilename: "report.pdf",
        path: "/tmp/openclaw/downloads/report.pdf",
      },
    ];
    const responses: Record<string, object> = {
      "/tabs": { running: true, tabs: [{ targetId: "t1", title: "T", url: "https://x" }] },
      "/tabs/open": { targetId: "t2" },
      "/navigate": { ok: true, targetId: "t1", download },
      "/act": {
        ok: true,
        targetId: "t1",
        results: [{ ok: true }],
        downloads,
      },
      "/hooks/file-chooser": { ok: true },
      "/hooks/dialog": { ok: true },
      "/console": { ok: true, targetId: "t1", messages: [] },
      "/pdf": { ok: true, path: "/tmp/a.pdf" },
      "/screenshot": { ok: true, path: "/tmp/a.png" },
      "/snapshot": { ok: true, format: "aria" },
      "/doctor": { ok: true, profile: "openclaw" },
      "/": { running: true, cdpPort: 18792 },
    };
    const calls = captureFetch(undefined, (url, init) => {
      const pathname = new URL(url).pathname;
      return responses[pathname === "/tabs" && init?.method !== undefined ? "/" : pathname];
    });

    const check = async (path: string, request: Promise<unknown>) => {
      await expect(request).resolves.toEqual(expect.objectContaining(responses[path]!));
    };
    await check("/", browserStatus(baseUrl));
    await check("/doctor", browserDoctor(baseUrl));
    await check("/doctor", browserDoctor(baseUrl, { profile: "openclaw", deep: true }));
    await expect(browserTabs(baseUrl)).resolves.toEqual({
      running: true,
      tabs: [expect.objectContaining({ targetId: "t1" })],
    });
    await check("/tabs/open", browserOpenTab(baseUrl, "https://example.com"));
    await check("/snapshot", browserSnapshot(baseUrl, { format: "aria", limit: 1 }));
    await check("/navigate", browserNavigate(baseUrl, { url: "https://example.com" }));
    await check("/act", browserAct(baseUrl, { kind: "click", ref: "1" }));
    await check("/hooks/file-chooser", browserArmFileChooser(baseUrl, { paths: ["/tmp/a.txt"] }));
    await check("/hooks/dialog", browserArmDialog(baseUrl, { accept: true }));
    await check("/console", browserConsoleMessages(baseUrl, { level: "error" }));
    await check("/pdf", browserPdfSave(baseUrl));
    await check(
      "/screenshot",
      browserScreenshotAction(baseUrl, { fullPage: true, timeoutMs: 12_345 }),
    );
    await check("/screenshot", browserScreenshotAction(baseUrl, { targetId: "t-default" }));

    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.endsWith("/tabs"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/doctor"))).toBe(true);
    const status = calls.find((c) => c.url.endsWith("/"));
    expect(status?.init?.timeoutMs).toBe(7_500);
    const doctor = calls.find((c) => c.url.endsWith("/doctor"));
    expect(doctor?.init?.timeoutMs).toBe(7_500);
    const deepDoctor = calls.find(({ url }) => {
      const parsed = new URL(url);
      return parsed.pathname === "/doctor" && parsed.searchParams.get("deep") === "true";
    });
    expect(Object.fromEntries(new URL(deepDoctor!.url).searchParams)).toEqual({
      profile: "openclaw",
      deep: "true",
    });
    expect(deepDoctor?.init?.timeoutMs).toBe(10_000);
    const open = calls.find((c) => c.url.endsWith("/tabs/open"));
    expect(open?.init?.method).toBe("POST");

    const screenshotCalls = calls.filter((c) => c.url.endsWith("/screenshot"));
    const screenshot = screenshotCalls[0];
    expect(screenshot?.init).toMatchObject({ method: "POST", timeoutMs: 12_345 });
    const screenshotBody = JSON.parse(
      typeof screenshot?.init?.body === "string" ? screenshot.init.body : "{}",
    ) as { fullPage?: unknown; timeoutMs?: unknown };
    expect(screenshotBody).toMatchObject({ fullPage: true, timeoutMs: 12_345 });
    const defaultScreenshot = screenshotCalls[1];
    expect(defaultScreenshot?.init?.timeoutMs).toBe(20_000);
    const defaultScreenshotBody = JSON.parse(
      typeof defaultScreenshot?.init?.body === "string" ? defaultScreenshot.init.body : "{}",
    ) as { targetId?: unknown; timeoutMs?: unknown };
    expect(defaultScreenshotBody).toMatchObject({ targetId: "t-default", timeoutMs: 20_000 });
  });

  it("marks internally selected close targets as exact", async () => {
    const calls = captureFetch({ ok: true });

    await browserCloseTabByRawTargetId(baseUrl, "RAW_TARGET", {
      profile: "openclaw",
    });

    const { url, init } = calls[0]!;
    expect(url).toBe("http://127.0.0.1:18791/tabs/RAW_TARGET?targetIdMode=raw&profile=openclaw");
    expect(init).toMatchObject({ method: "DELETE" });
    expect(init?.body).toBeUndefined();
  });

  it("gives browser act requests enough client timeout for long waits", async () => {
    const calls = captureFetch({ ok: true, targetId: "t1" });

    await browserAct(baseUrl, { kind: "click", ref: "1" });
    await browserAct(baseUrl, {
      kind: "wait",
      timeMs: 10_000,
      text: "ready",
      timeoutMs: 20_000,
    });
    await browserAct(baseUrl, {
      kind: "wait",
      text: "ready",
      timeoutMs: 45_000,
    });
    await browserAct(baseUrl, {
      kind: "batch",
      actions: [
        { kind: "wait", timeMs: 30_000 },
        {
          kind: "batch",
          actions: [
            { kind: "wait", timeMs: 30_000 },
            { kind: "wait", timeMs: 30_000 },
          ],
        },
      ],
    });
    await browserAct(baseUrl, { kind: "wait", timeMs: 30_000 }, { timeoutMs: 12_345 });

    expect(calls.map((call) => call.init?.timeoutMs)).toEqual([
      126_250, 56_250, 96_250, 95_000, 12_345,
    ]);
  });

  it("clamps oversized browser action timeouts before forwarding", async () => {
    const calls = captureFetch({ ok: true, targetId: "t1", path: "/tmp/a.png" });

    await browserAct("http://127.0.0.1:18791", {
      kind: "wait",
      text: "ready",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });
    await browserAct(
      "http://127.0.0.1:18791",
      { kind: "wait", text: "ready" },
      { timeoutMs: Number.MAX_SAFE_INTEGER },
    );
    await browserScreenshotAction("http://127.0.0.1:18791", {
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(calls.map(({ url, init }) => [new URL(url).pathname, init?.timeoutMs])).toEqual([
      ["/act", MAX_TIMER_TIMEOUT_MS],
      ["/act", MAX_TIMER_TIMEOUT_MS],
      ["/screenshot", MAX_TIMER_TIMEOUT_MS],
    ]);
    const screenshot = calls[2];
    const screenshotBody = JSON.parse(
      typeof screenshot?.init?.body === "string" ? screenshot.init.body : "{}",
    ) as { timeoutMs?: unknown };
    expect(screenshotBody.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
