import { runInNewContext } from "node:vm";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { leaveChromeMeet } from "./chrome.js";
import { meetLeaveScript } from "./google-meet-page-scripts.js";
import {
  forceMeetEnglishUi,
  isSameMeetUrlForReuse,
  normalizeMeetUrlForReuse,
} from "./google-meet-urls.js";

it("overrides an existing hl and keeps other params", () => {
  expect(forceMeetEnglishUi("https://meet.google.com/abc-defg-hij?hl=zh-TW&authuser=1")).toBe(
    "https://meet.google.com/abc-defg-hij?hl=en&authuser=1",
  );
});
it("keeps /new launchable but excludes it from reusable meeting identity", () => {
  expect(forceMeetEnglishUi("https://meet.google.com/new")).toBe(
    "https://meet.google.com/new?hl=en",
  );
  expect(normalizeMeetUrlForReuse("https://meet.google.com/new")).toBeUndefined();
  expect(isSameMeetUrlForReuse("https://meet.google.com/new", "https://meet.google.com/new")).toBe(
    false,
  );
  expect(normalizeMeetUrlForReuse("https://meet.google.com/abc-defg-hij?authuser=1")).toBe(
    "https://meet.google.com/abc-defg-hij",
  );
});
it("requires the resolved canonical room before leaving a /new tab", () => {
  const context = {
    URL,
    location: { href: "https://meet.google.com/abc-defg-hij?authuser=1" },
    document: { querySelectorAll: () => [] },
  };
  const leave = (url: string) =>
    JSON.parse(runInNewContext(`(${meetLeaveScript(url)})()`, context) as string);
  expect(leave("https://meet.google.com/new")).toEqual({ departed: false });
  expect(leave("https://meet.google.com/abc-defg-hij")).toEqual({
    departed: false,
    urlMatched: true,
  });
});
it("reports malformed node proxy payloadJSON through the leave route", async () => {
  const invoke = vi.fn(async () => ({ ok: true, payloadJSON: "{not json" }));
  const runtime = { nodes: { invoke } } as unknown as PluginRuntime;

  await expect(
    leaveChromeMeet({
      runtime,
      config: resolveGoogleMeetConfig({ chrome: { joinTimeoutMs: 1_000 } }),
      transport: "chrome-node",
      nodeId: "node-1",
      meetingSessionId: "malformed-proxy",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      tab: { targetId: "meet-tab", openedByPlugin: false },
    }),
  ).resolves.toStrictEqual({
    left: false,
    note: "Browser control could not leave the Meet tab: Google Meet browser proxy returned malformed payloadJSON.",
  });

  expect(invoke).toHaveBeenCalledWith({
    nodeId: "node-1",
    command: "browser.proxy",
    params: {
      method: "GET",
      path: "/tabs",
      body: undefined,
      timeoutMs: 1_000,
    },
    timeoutMs: 6_000,
    scopes: ["operator.admin"],
  });
});
