import { expect, it } from "vitest";
import {
  CLIENT_URL,
  channelHeader,
  fixture,
  microphone,
  page,
  PageNode,
  qaNode,
} from "./slack-huddles-platform-adapter.test-helpers.js";

const MARKER = {
  identity: "slack-huddle:T0123ABCD:C0123ABCD",
  sessionId: "session-1",
  bindable: true,
};

/** Slack's huddle window: an unnamed same-origin about:blank window that only window.open returns. */
function huddleWindow(...nodes: PageNode[]) {
  const document = page(...nodes);
  return { closed: false, location: new URL(CLIENT_URL), document };
}

const OTHER_CHANNEL_URL = "https://app.slack.com/client/T0123ABCD/C9999ABCD";

function slackWindow(opened: ReturnType<typeof huddleWindow>, marker?: Record<string, unknown>) {
  return {
    ...(marker ? { __openclawSlackHuddle: { ...marker } } : {}),
    open: (url: string) => (url === "about:blank" ? opened : undefined),
  };
}

function muteControl(on: boolean) {
  return new PageNode(
    "button",
    {
      "data-qa": "segmented-mute-button-main",
      "aria-label": on ? "Mute microphone" : "Unmute microphone",
    },
    "",
  );
}

it.each([
  { href: `${CLIENT_URL}?open=start_huddle`, clicks: 1, mode: "transcribe" as const },
  // The launcher's origin never holds the talk-back microphone grant, so it never asks for it.
  { href: `${CLIENT_URL}?open=start_huddle`, clicks: 1, mode: "agent" as const },
  {
    href: "https://app.slack.com/client/T0123ABCD/C9999ABCD?open=start_huddle",
    clicks: 0,
    mode: "agent" as const,
  },
  // Slack draws the launcher before its link; that loading page must not end a talk-back join.
  { href: undefined, clicks: 0, mode: "agent" as const },
])(
  "follows Slack's desktop-app launcher only to the requested huddle ($clicks, $mode)",
  async ({ href, clicks, mode }) => {
    const link = new PageNode(
      "a",
      { "data-qa": "ssb_redirect_open_in_browser", ...(href ? { href } : {}) },
      "use Slack in your browser",
    );
    const result = await fixture({
      document: href ? page(link) : page(),
      currentUrl: "https://slack.com/huddle/C0123ABCD",
      microphonePermission: "prompt",
    }).status({ mode });
    expect(link.clicks).toBe(clicks);
    expect(result.clickedContinueInBrowser).toBe(clicks === 1);
    expect(result.manualAction).toBeUndefined();
  },
);

it.each([
  { body: "Someone is currently in the huddle.", idleForMs: 0, clicks: 1, reason: undefined },
  // Slack can draw the prompt idle while it loads; a first idle reading keeps waiting.
  { body: "No one is in the huddle yet.", idleForMs: 0, clicks: 0, reason: undefined },
  {
    body: "No one is in the huddle yet.",
    idleForMs: 5_000,
    clicks: 0,
    reason: "slack-huddle-not-active",
  },
])(
  "answers the huddle link prompt: $body (idle $idleForMs ms)",
  async ({ body, idleForMs, clicks, reason }) => {
    const go = qaNode("huddle_from_link_speed_bump_modal_default_go", "Join Huddle");
    const prompt = qaNode("huddle_from_link_speed_bump_modal_default", body, "div").append(go);
    const browser = fixture({
      document: page(channelHeader(false), prompt),
      currentUrl: CLIENT_URL,
      window: idleForMs
        ? { __openclawSlackHuddleIdlePrompt: { prompt, since: Date.now() - idleForMs } }
        : {},
    });
    const result = await browser.status();
    expect(go.clicks).toBe(clicks);
    // The prompt only opens Slack's huddle window; Join is recorded once its preview is clicked.
    expect(result.clickedJoin).toBe(false);
    expect(browser.window).toMatchObject({
      __openclawSlackHuddle: { identity: MARKER.identity, sessionId: "session-1" },
    });
    expect(browser.window).not.toMatchObject({ __openclawSlackHuddle: { joinRequested: true } });
    if (reason) {
      expect(result).toMatchObject({ manualAction: { reason } });
    } else {
      expect(result.manualAction).toBeUndefined();
    }
  },
);

it.each([
  { micDisabled: false, permission: "prompt" as const, micClicks: 1, joins: true },
  // Without Chrome microphone access Slack shows the preview switch on but disabled; it sends nothing.
  { micDisabled: true, permission: "prompt" as const, micClicks: 0, joins: true },
  // With access granted, a disabled switch that reads on may still be live, so Join stays refused.
  { micDisabled: true, permission: "granted" as const, micClicks: 0, joins: false },
])(
  "joins muted from the huddle window's preview (mic disabled=$micDisabled, $permission)",
  async ({ micDisabled, permission, micClicks, joins }) => {
    const mic = microphone(true, true);
    if (micDisabled) {
      mic.setAttribute("aria-disabled", "true");
    }
    // Slack labels this button only through aria-label.
    const join = new PageNode("button", {
      "data-qa": "huddle_invite_window_with_preview_content_join_button",
      "aria-label": "Join",
    });
    // Observe-only Chrome never grants the microphone, so Slack's preview shows this banner.
    const banner = new PageNode(
      "div",
      { role: "dialog" },
      "Allow microphone access. Please enable your microphone in your browser's address bar.",
    );
    const opened = huddleWindow(banner, mic, join);
    const go = qaNode("huddle_from_link_speed_bump_modal_default_go", "Join Huddle");
    const prompt = qaNode(
      "huddle_from_link_speed_bump_modal_default",
      "Someone is currently in the huddle.",
      "div",
    ).append(go);
    const document = page(channelHeader(false), prompt);
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: slackWindow(opened),
      microphonePermission: permission,
    });
    go.onClick = () => {
      (browser.window.open as (url: string) => unknown)("about:blank");
      document.body.children.splice(document.body.children.indexOf(prompt), 1);
    };
    await browser.status();
    let microphoneAtJoin: string | null = null;
    join.onClick = () => {
      microphoneAtJoin = mic.getAttribute("aria-checked");
    };
    const result = await browser.status();
    expect(go.clicks).toBe(1);
    expect(mic.clicks).toBe(micClicks);
    expect(join.clicks).toBe(joins ? 1 : 0);
    expect(result.clickedJoin).toBe(joins);
    if (joins) {
      expect(microphoneAtJoin).toBe(micDisabled ? "true" : "false");
    } else {
      expect(result).toMatchObject({ manualAction: { reason: "slack-microphone-required" } });
    }
  },
);

it.each([
  { tracked: true, windowUrl: CLIENT_URL, reason: undefined },
  { tracked: false, windowUrl: CLIENT_URL, reason: "slack-microphone-required" },
  // A tracked window left on another huddle never supplies controls for the requested one.
  { tracked: true, windowUrl: OTHER_CHANNEL_URL, reason: "slack-microphone-required" },
])(
  "reads in-call controls from the huddle window (tracked=$tracked, $windowUrl)",
  async ({ tracked, windowUrl, reason }) => {
    const mute = muteControl(false);
    const opened = huddleWindow(mute, qaNode("huddle_toolbar__leave_button", "Leave"));
    opened.location = new URL(windowUrl);
    const document = page(channelHeader(true), qaNode("huddle_toolbar__leave_button", "Leave"));
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: slackWindow(opened, { ...MARKER, joinRequested: true }),
    });
    // Slack opens its window while Join settles; only a window opened after the hook is reachable.
    await browser.status({ readOnly: true });
    if (tracked) {
      (browser.window.open as (url: string) => unknown)("about:blank");
    }
    const result = await browser.status();
    expect(result.inCall).toBe(true);
    expect(mute.clicks).toBe(0);
    if (reason) {
      expect(result).toMatchObject({ manualAction: { reason } });
    } else {
      expect(result.manualAction).toBeUndefined();
      expect(result.micMuted).toBe(true);
    }
  },
);

it("unmutes talk-back once the huddle window shows the preferred virtual microphone", async () => {
  const mute = muteControl(false);
  mute.onClick = () => mute.setAttribute("aria-label", "Mute microphone");
  const opened = huddleWindow(
    mute,
    new PageNode("div", { id: "microphone-info" }, "OpenClaw Meeting Audio (Preferred)"),
  );
  const browser = fixture({
    document: page(channelHeader(true), qaNode("huddle_toolbar__leave_button", "Leave")),
    currentUrl: CLIENT_URL,
    window: slackWindow(opened, { ...MARKER, joinRequested: true }),
  });
  await browser.status({ readOnly: true });
  (browser.window.open as (url: string) => unknown)("about:blank");
  const result = await browser.status({ mode: "agent" });
  expect(mute.clicks).toBe(1);
  expect(result).toMatchObject({ audioInputRouted: true, micMuted: false, inCall: true });
});

function captionRow(speaker: string, words: string) {
  return new PageNode("div").append(
    new PageNode("span", { class: "p-huddle_closed_caption_event__member_name" }, speaker),
    new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(
      new PageNode(
        "span",
        {
          "data-qa": "huddle_closed_caption_event",
          class: "p-huddle_closed_caption_event__transcription",
        },
        words,
      ),
    ),
  );
}

it.each([
  { inTab: false, expected: [{ speaker: "Morgan:", text: "The next step is ready." }] },
  // Captions in the channel tab are still collected while a huddle window is tracked.
  {
    inTab: true,
    expected: [
      { speaker: "Morgan:", text: "The next step is ready." },
      { speaker: "Riley:", text: "Tab captions still count." },
    ],
  },
])(
  "captures captions from the huddle window and the tab (tab captions=$inTab)",
  async ({ inTab, expected }) => {
    const opened = huddleWindow(
      muteControl(false),
      captionRow("Morgan:", "The next step is ready."),
    );
    const browser = fixture({
      document: page(
        channelHeader(true),
        qaNode("huddle_toolbar__leave_button", "Leave"),
        ...(inTab ? [captionRow("Riley:", "Tab captions still count.")] : []),
      ),
      currentUrl: CLIENT_URL,
      window: slackWindow(opened, { ...MARKER, joinRequested: true }),
    });
    await browser.status({ readOnly: true });
    (browser.window.open as (url: string) => unknown)("about:blank");
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: true,
      recentTranscript: expected,
    });
    // The live-caption observer watches the huddle window, not only the channel tab.
    expect(browser.observed).toContain(opened.document.body);
  },
);

it("leaves a tracked huddle window untouched once another session owns the tab", async () => {
  const mute = muteControl(true);
  const opened = huddleWindow(mute, captionRow("Morgan:", "Not for the old session."));
  const browser = fixture({
    document: page(channelHeader(true), qaNode("huddle_toolbar__leave_button", "Leave")),
    currentUrl: CLIENT_URL,
    window: slackWindow(opened, { ...MARKER, joinRequested: true }),
  });
  await browser.status({ readOnly: true });
  (browser.window.open as (url: string) => unknown)("about:blank");
  // A newer session takes over the page marker during this session's awaited work.
  Object.assign(browser.window, { __openclawSlackHuddle: { ...MARKER, sessionId: "session-2" } });
  const result = await browser.status({ allowSessionAdoption: false, captureCaptions: true });
  expect(mute.clicks).toBe(0);
  expect(result).toMatchObject({ captioning: false, transcriptLines: 0 });
});

it.each([
  { windowTeam: "T0123ABCD", reason: undefined },
  // Channel ids are workspace-scoped: the same channel id in another workspace is another huddle.
  { windowTeam: "T9999ABCD", reason: "slack-microphone-required" },
])(
  "binds a channel-only session's huddle window to the tab's workspace ($windowTeam)",
  async ({ windowTeam, reason }) => {
    const mute = muteControl(false);
    const opened = huddleWindow(mute, qaNode("huddle_toolbar__leave_button", "Leave"));
    opened.location = new URL(`https://app.slack.com/client/${windowTeam}/C0123ABCD`);
    const browser = fixture({
      document: page(channelHeader(true), qaNode("huddle_toolbar__leave_button", "Leave")),
      currentUrl: CLIENT_URL,
      window: {
        ...slackWindow(opened, {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          bindable: true,
          joinRequested: true,
        }),
        __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
      },
    });
    const channelOnly = { url: "https://app.slack.com/huddle/C0123ABCD" };
    await browser.status({ ...channelOnly, readOnly: true });
    (browser.window.open as (url: string) => unknown)("about:blank");
    const result = await browser.status(channelOnly);
    expect(result.inCall).toBe(true);
    if (reason) {
      expect(result).toMatchObject({ manualAction: { reason } });
    } else {
      expect(result.manualAction).toBeUndefined();
    }
  },
);
