// Test for openMeetWithBrowserRequest tab selection logic (regression #103385)
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import type { BrowserTab } from "./chrome-browser-proxy.js";

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
};

type BrowserRequestCaller = (params: BrowserRequestParams) => Promise<unknown>;

describe("openMeetWithBrowserRequest tab selection (regression #103385)", () => {
  let callBrowser: BrowserRequestCaller;
  const meetingCode = "abc-defg-hij";
  const englishUrl = `https://meet.google.com/${meetingCode}?hl=en`;
  const japaneseUrl = `https://meet.google.com/${meetingCode}?hl=ja`;

  beforeEach(() => {
    callBrowser = vi.fn() as BrowserRequestCaller;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips localized tab and opens new English-pinned tab", async () => {
    const japaneseTab: BrowserTab = {
      targetId: "jp-tab-123",
      url: japaneseUrl,
      title: "Google Meet",
    };

    callBrowser.mockImplementation((params) => {
      if (params.method === "GET" && params.path === "/tabs") {
        return Promise.resolve({ tabs: [japaneseTab] });
      }
      if (params.method === "POST" && params.path === "/tabs/open") {
        return Promise.resolve({ targetId: "new-en-tab-456", url: englishUrl });
      }
      if (params.method === "POST" && params.path === "/tabs/focus") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const config: GoogleMeetConfig = {
      chrome: {
        launch: true,
        reuseExistingTab: true,
        guestName: "Test",
        joinTimeoutMs: 5000,
      },
    } as any;

    const { testing } = await import("./chrome.js");
    await testing.openMeetWithBrowserRequestForTest({
      callBrowser,
      config,
      mode: "transcribe" as GoogleMeetMode,
      url: `https://meet.google.com/${meetingCode}`,
    });

    // Should NOT have focused the Japanese tab
    const focusCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/focus",
    );
    expect(focusCalls).toHaveLength(0);

    // Should have opened a new tab with hl=en
    const openCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/open",
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][0].body.url).toContain("hl=en");
  });

  it("reuses existing English tab without opening new one", async () => {
    const englishTab: BrowserTab = {
      targetId: "en-tab-789",
      url: englishUrl,
      title: "Google Meet",
    };

    callBrowser.mockImplementation((params) => {
      if (params.method === "GET" && params.path === "/tabs") {
        return Promise.resolve({ tabs: [englishTab] });
      }
      if (params.method === "POST" && params.path === "/tabs/focus") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const config: GoogleMeetConfig = {
      chrome: {
        launch: true,
        reuseExistingTab: true,
        guestName: "Test",
        joinTimeoutMs: 5000,
      },
    } as any;

    const { testing } = await import("./chrome.js");
    await testing.openMeetWithBrowserRequestForTest({
      callBrowser,
      config,
      mode: "transcribe" as GoogleMeetMode,
      url: `https://meet.google.com/${meetingCode}`,
    });

    // Should have focused the English tab
    const focusCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/focus",
    );
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0][0].body.targetId).toBe("en-tab-789");

    // Should NOT have opened a new tab
    const openCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/open",
    );
    expect(openCalls).toHaveLength(0);
  });

  it("prefers English tab when both exist", async () => {
    const japaneseTab: BrowserTab = {
      targetId: "jp-tab-111",
      url: japaneseUrl,
      title: "Google Meet",
    };

    const englishTab: BrowserTab = {
      targetId: "en-tab-222",
      url: englishUrl,
      title: "Google Meet",
    };

    callBrowser.mockImplementation((params) => {
      if (params.method === "GET" && params.path === "/tabs") {
        // Japanese first (should be skipped)
        return Promise.resolve({ tabs: [japaneseTab, englishTab] });
      }
      if (params.method === "POST" && params.path === "/tabs/focus") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });

    const config: GoogleMeetConfig = {
      chrome: {
        launch: true,
        reuseExistingTab: true,
        guestName: "Test",
        joinTimeoutMs: 5000,
      },
    } as any;

    const { testing } = await import("./chrome.js");
    await testing.openMeetWithBrowserRequestForTest({
      callBrowser,
      config,
      mode: "transcribe" as GoogleMeetMode,
      url: `https://meet.google.com/${meetingCode}`,
    });

    // Should have focused the English tab
    const focusCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/focus",
    );
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0][0].body.targetId).toBe("en-tab-222");
  });

  it("skips tab without hl parameter (ambiguous locale)", async () => {
    // ClawSweeper P1: No hl parameter is ambiguous - could be localized by account
    const ambiguousTab: BrowserTab = {
      targetId: "ambiguous-tab-333",
      url: `https://meet.google.com/${meetingCode}`, // No hl parameter
      title: "Google Meet",
    };

    callBrowser.mockImplementation((params) => {
      if (params.method === "GET" && params.path === "/tabs") {
        return Promise.resolve({ tabs: [ambiguousTab] });
      }
      if (params.method === "POST" && params.path === "/tabs/open") {
        return Promise.resolve({ targetId: "new-en-tab-444", url: englishUrl });
      }
      return Promise.resolve({});
    });

    const config: GoogleMeetConfig = {
      chrome: {
        launch: true,
        reuseExistingTab: true,
        guestName: "Test",
        joinTimeoutMs: 5000,
      },
    } as any;

    const { testing } = await import("./chrome.js");
    await testing.openMeetWithBrowserRequestForTest({
      callBrowser,
      config,
      mode: "transcribe" as GoogleMeetMode,
      url: `https://meet.google.com/${meetingCode}`,
    });

    // Should NOT have focused the ambiguous tab
    const focusCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/focus",
    );
    expect(focusCalls).toHaveLength(0);

    // Should have opened a new tab with hl=en
    const openCalls = callBrowser.mock.calls.filter(
      (call: any) => call[0].method === "POST" && call[0].path === "/tabs/open",
    );
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0][0].body.url).toContain("hl=en");
  });
});
