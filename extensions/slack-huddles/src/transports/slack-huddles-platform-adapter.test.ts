import { describe, expect, it } from "vitest";
import { SLACK_HUDDLES_PLATFORM_ADAPTER } from "./slack-huddles-platform-adapter.js";
import {
  channelHeader,
  CLIENT_URL,
  fixture,
  inCall,
  microphone,
  page,
  PageNode,
  preview,
  qaNode,
} from "./slack-huddles-platform-adapter.test-helpers.js";

function classify(result: Record<string, unknown>) {
  const health = SLACK_HUDDLES_PLATFORM_ADAPTER.browser.parseStatus({
    result: JSON.stringify(result),
  });
  if (!health) {
    throw new Error("Expected parsed Slack huddle status");
  }
  return SLACK_HUDDLES_PLATFORM_ADAPTER.browser.classifyManualAction(health);
}

describe("Slack huddle browser adapter", () => {
  it.each([
    "https://slack.com/signin",
    "https://workspace.slack.com/workspace-signin",
    "https://slack.com/ssb/signin",
    undefined,
  ])("requires login at %s, including a form on the huddle URL", async (currentUrl) => {
    const document = currentUrl
      ? page()
      : page(
          new PageNode("form", { action: "/signin" }).append(
            new PageNode("input", { name: "email" }),
          ),
        );
    const result = await fixture({ document, currentUrl }).status();
    expect(result).toMatchObject({ inCall: false, clickedJoin: false });
    expect(classify(result)).toEqual({
      category: "login-required",
      reason: "slack-login-required",
      message:
        "Sign the OpenClaw Chrome profile into Slack as the claw's Slack account, then retry.",
    });
  });

  it.each([
    { label: "Start Huddle", autoJoin: true, disabled: false, reason: "slack-huddle-not-active" },
    { label: "Join Huddle", autoJoin: false, disabled: false, reason: undefined },
    { label: "Join Huddle", autoJoin: true, disabled: true, reason: "slack-microphone-required" },
  ])(
    "leaves refused previews untouched: $label / autoJoin=$autoJoin / disabled=$disabled",
    async ({ label, autoJoin, disabled, reason }) => {
      const { document, join, mic } = preview(label, true);
      if (disabled) {
        mic.setAttribute("aria-disabled", "true");
      }
      const result = await fixture({ document }).status({ autoJoin });
      expect(result).toMatchObject({ clickedJoin: false });
      if (reason) {
        expect(result).toMatchObject({ manualAction: { reason } });
      }
      if (label === "Start Huddle") {
        expect(result).toMatchObject({
          manualAction: {
            message: "No one is in this huddle yet. Start the huddle in Slack, then ask again.",
          },
        });
      }
      expect(join.clicks).toBe(0);
      expect(mic.clicks).toBe(0);
    },
  );

  it.each([
    { mode: "agent" as const, initial: true, virtual: false, clicks: 1 },
    { mode: "agent" as const, initial: false, virtual: true, clicks: 0 },
    { mode: "transcribe" as const, initial: true, virtual: true, clicks: 1 },
    { mode: "transcribe" as const, initial: false, virtual: false, clicks: 0, fallback: true },
    {
      mode: "transcribe" as const,
      initial: false,
      virtual: false,
      clicks: 0,
      currentUrl: CLIENT_URL,
    },
    {
      mode: "transcribe" as const,
      initial: false,
      virtual: false,
      clicks: 0,
      currentUrl: `${CLIENT_URL}/thread/C0123ABCD-123`,
    },
  ])(
    "joins $mode muted (mic=$initial, virtual=$virtual, fallback=$fallback, URL=$currentUrl)",
    async ({ mode, initial, virtual, clicks, fallback, currentUrl }) => {
      const { document, join, mic } = preview("Join Huddle", initial, fallback);
      const unrelated = new PageNode("button", {}, "Join Huddle");
      if (fallback) {
        document.body.append(unrelated);
      }
      if (virtual) {
        document.body.append(new PageNode("div", { id: "microphone-info" }, "BlackHole 2ch"));
      }
      let microphoneAtJoin: string | null = null;
      join.onClick = () => {
        microphoneAtJoin = mic.getAttribute("aria-checked");
      };
      const result = await fixture({ document, currentUrl }).status({ mode });
      expect(result.clickedJoin).toBe(true);
      expect(join.clicks).toBe(1);
      expect(mic.clicks).toBe(clicks);
      expect(microphoneAtJoin).toBe("false");
      expect(unrelated.clicks).toBe(0);
    },
  );

  it.each([
    { qa: "huddle_join_modal", reason: "slack-confirmation-required", category: "custom" },
    {
      qa: "huddle_in_thread_speed_bump_modal",
      reason: "slack-confirmation-required",
      category: "custom",
    },
    {
      qa: "huddle_multi_device_modal_switch_device",
      reason: "slack-session-conflict",
      category: "session-conflict",
    },
    {
      qa: "huddle_multi_device_modal_use_both_device",
      reason: "slack-session-conflict",
      category: "session-conflict",
    },
    { qa: "permission", reason: "slack-permission-required", category: "permission-required" },
  ])("requires manual resolution of $qa", async ({ qa, reason, category }) => {
    const { document, join } = preview("Join Huddle");
    const control = qaNode("huddle_join_modal_go", "OK");
    const prompt =
      qa === "permission"
        ? new PageNode("div", { role: "dialog" }, "Allow Slack to use your microphone")
        : qaNode(qa, "Switch huddles?", "div");
    document.body.append(prompt.append(control));
    const action = classify(await fixture({ document }).status({ mode: "agent" }));
    expect(action).toMatchObject({ category, reason });
    if (category === "custom") {
      expect(action).toMatchObject({ message: expect.stringContaining("Switch huddles?") });
    }
    expect(control.clicks).toBe(0);
    expect(prompt.clicks).toBe(0);
    expect(join.clicks).toBe(0);
  });

  it.each([false, true])(
    "only records admission without an existing call (live=%s)",
    async (live) => {
      const request = new PageNode("button", {}, "Request to join");
      const dialog = new PageNode("div", { role: "dialog" }).append(request);
      const document = live
        ? page(qaNode("huddle_toolbar__leave_button", "Leave Huddle"), dialog)
        : page(dialog);
      const browser = fixture({ document });
      if (live) {
        expect(await browser.status()).toMatchObject({
          inCall: false,
          manualAction: { reason: "slack-session-conflict" },
        });
        document.body.children.splice(1);
        expect(await browser.status()).toMatchObject({
          inCall: false,
          manualAction: { reason: "slack-session-conflict" },
        });
      } else {
        expect(classify(await browser.status())).toMatchObject({
          category: "admission-required",
          reason: "slack-admission-required",
        });
        document.body.children.splice(0);
        document.body.append(
          qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
          microphone(false),
          channelHeader(true),
        );
        browser.location.href = CLIENT_URL;
        expect(await browser.status()).toMatchObject({ inCall: true, micMuted: true });
      }
      expect(request.clicks).toBe(0);
    },
  );

  it.each([
    { qa: "huddle_toolbar__leave_button", tag: "button", on: true, readOnly: false },
    { qa: "huddle_mini_player_leave_button", tag: "button", on: true, readOnly: false },
    { qa: "huddle_sidebar_footer", tag: "div", on: true, readOnly: false },
    { qa: "huddle_toolbar_buttons_center", tag: "div", on: true, readOnly: false },
    { qa: "huddle_toolbar__leave_button", tag: "button", on: true, readOnly: true },
    { qa: "huddle_toolbar__leave_button", tag: "button", on: false, readOnly: true },
  ])("verifies $qa mute state (on=$on, readOnly=$readOnly)", async ({ qa, tag, on, readOnly }) => {
    const { document, mic } = inCall(qaNode(qa, "", tag), on);
    expect(await fixture({ document, joined: true }).status({ readOnly })).toMatchObject({
      inCall: true,
      micMuted: readOnly ? !on : true,
    });
    expect(mic.clicks).toBe(readOnly ? 0 : 1);
  });

  it("keeps huddle ownership through a Slack SPA URL rewrite and rejects a different channel view", async () => {
    const { document, marker } = inCall();
    const browser = fixture({ document, joined: true });
    expect(await browser.status()).toMatchObject({ inCall: true });
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({ inCall: true });
    expect(browser.window).toMatchObject({
      __openclawSlackHuddle: {
        identity: "slack-huddle:T0123ABCD:C0123ABCD",
        inCallUrl: CLIENT_URL,
      },
    });
    browser.location.href = "https://app.slack.com/client/T0123ABCD/C9999ABCD";
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    expect(marker.clicks).toBe(0);
  });

  it.each([false, true])(
    "retains ownership through a toolbar rerender (channelOnly=%s)",
    async (channelOnly) => {
      const { document, marker } = inCall();
      const browser = fixture({
        document,
        currentUrl: CLIENT_URL,
        joined: true,
        ...(channelOnly
          ? {
              window: {
                __openclawSlackHuddle: {
                  identity: "slack-huddle:C0123ABCD",
                  bindable: true,
                  sessionId: "session-1",
                  joinRequested: true,
                  joinRequestedAt: Date.now(),
                },
              },
            }
          : {}),
      });
      const options = channelOnly ? { url: "https://app.slack.com/huddle/C0123ABCD" } : {};
      expect(await browser.status(options)).toMatchObject({ inCall: true });
      marker.isConnected = false;
      document.body.children.splice(document.body.children.indexOf(marker), 1);
      const interrupted = await browser.status(options);
      expect(interrupted.inCall).toBe(false);
      expect(interrupted.meetingEnded).not.toBe(true);
      document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"));
      if (!channelOnly) {
        expect(await browser.status(options)).toMatchObject({ inCall: true });
      }
      browser.location.href = "https://app.slack.com/client/T9999ABCD/C0123ABCD";
      expect(await browser.status(options)).toMatchObject({ inCall: false });
    },
  );

  it.each(["huddle_toolbar__leave_button", "huddle_mini_player_leave_button"])(
    "leaves through %s and reports departure while the root audio element remains",
    async (qa) => {
      const leave = qaNode(qa, "Leave Huddle");
      const audio = qaNode("p-huddle_audio", "", "audio");
      const endAll = qaNode("huddle_toolbar__end_huddle_for_all_menu_item", "End huddle for all");
      const header = channelHeader(true);
      const document = page(leave, audio, endAll, microphone(false), header);
      const browser = fixture({ document, joined: true });
      await browser.status();
      browser.location.href = CLIENT_URL;
      await browser.status();
      expect(browser.leave()).toMatchObject({ departed: false, leaveAction: "leave" });
      expect(leave.clicks).toBe(1);
      expect(endAll.clicks).toBe(0);
      leave.isConnected = false;
      document.body.children.splice(document.body.children.indexOf(leave), 1);
      expect(browser.leave(true)).toMatchObject({ departed: false });
      header.attributes.class = "p-huddle_channel_header_button__container";
      expect(browser.leave(true)).toMatchObject({ departed: true });
      expect(endAll.clicks).toBe(0);
    },
  );

  it.each([
    { currentUrl: undefined, member: false, joined: false, readOnly: false },
    { currentUrl: CLIENT_URL, member: false, joined: false, readOnly: false },
    {
      currentUrl: "https://app.slack.com/client/T9999ABCD/C0123ABCD",
      member: true,
      joined: true,
      readOnly: true,
    },
  ])(
    "does not adopt unowned controls at $currentUrl",
    async ({ currentUrl, member, joined, readOnly }) => {
      const { document, marker } = inCall(undefined, false, member);
      expect(await fixture({ document, currentUrl, joined }).status({ readOnly })).toMatchObject({
        inCall: false,
      });
      expect(marker.clicks).toBe(0);
    },
  );

  it("drops a pending Join that met a switch prompt beside another huddle's toolbar", async () => {
    const active = preview("Join Huddle");
    const browser = fixture({ document: active.document });
    expect(await browser.status()).toMatchObject({ clickedJoin: true });
    active.document.body.children.splice(0);
    const confirm = qaNode("huddle_join_modal", "Switch huddles?", "div");
    const leave = qaNode("huddle_toolbar__leave_button", "Leave Huddle");
    active.document.body.append(leave, confirm);
    browser.location.href = CLIENT_URL;
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-confirmation-required" },
    });
    expect(browser.leave()).toMatchObject({ departed: false });
    expect(leave.clicks).toBe(0);
    active.document.body.children.splice(active.document.body.children.indexOf(confirm), 1);
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
  });

  it.each([
    { channelOnly: false, lag: false },
    { channelOnly: false, lag: true },
    { channelOnly: true, lag: false },
  ])(
    "settles its own Join only after membership, then detects a move (channelOnly=$channelOnly, lag=$lag)",
    async ({ channelOnly, lag }) => {
      const active = preview("Join Huddle");
      const browser = fixture({
        document: active.document,
        currentUrl: channelOnly ? CLIENT_URL : undefined,
      });
      const options = channelOnly ? { url: "https://app.slack.com/huddle/C0123ABCD" } : {};
      expect(await browser.status(options)).toMatchObject({ clickedJoin: true });
      active.document.body.children.splice(0);
      const header = channelHeader(!lag);
      active.document.body.append(
        qaNode("huddle_toolbar__leave_button", "Leave Huddle"),
        microphone(false),
        header,
      );
      browser.location.href = CLIENT_URL;
      if (lag) {
        const lagging = await browser.status(options);
        expect(lagging.inCall).toBe(false);
        expect(lagging.manualAction).toBeUndefined();
        header.attributes.class += " p-huddle_channel_header_button--in_huddle";
      }
      expect(await browser.status(options)).toMatchObject({ inCall: true });
      if (channelOnly) {
        expect(browser.window).toMatchObject({
          __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
        });
      }
      header.attributes.class = "p-huddle_channel_header_button__container";
      expect(await browser.status(options)).toMatchObject({
        inCall: false,
        manualAction: { reason: "slack-session-conflict" },
      });
    },
  );

  it("does not join or touch the camera while another huddle is live in the tab", async () => {
    const active = preview("Join Huddle");
    const camera = new PageNode("button", {
      role: "switch",
      "aria-label": "Camera",
      "aria-checked": "true",
    });
    active.document.body.append(qaNode("huddle_toolbar__leave_button", "Leave Huddle"), camera);
    const result = await fixture({ document: active.document }).status();
    expect(result).toMatchObject({ manualAction: { reason: "slack-session-conflict" } });
    expect(result.clickedJoin).not.toBe(true);
    expect(active.join.clicks).toBe(0);
    expect(camera.clicks).toBe(0);
  });

  it.each([false, true])(
    "binds only a mutable owned channel-only session (settling=%s)",
    async (settling) => {
      const { document, marker } = inCall();
      const browser = fixture({
        document,
        currentUrl: CLIENT_URL,
        window: {
          __openclawSlackHuddle: {
            identity: "slack-huddle:C0123ABCD",
            bindable: true,
            sessionId: "session-1",
            ...(settling ? { joinRequested: true, joinRequestedAt: Date.now() } : {}),
          },
        },
      });
      const channelOnly = { url: "https://app.slack.com/huddle/C0123ABCD" };
      expect(await browser.status({ ...channelOnly, readOnly: true })).toMatchObject({
        inCall: false,
      });
      expect(await browser.status(channelOnly)).toMatchObject({ inCall: true });
      expect(browser.window).toMatchObject({
        __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
      });
      browser.location.href = "https://app.slack.com/client/T9999ABCD/C0123ABCD";
      expect(await browser.status(channelOnly)).toMatchObject({ inCall: false });
      expect(marker.clicks).toBe(0);
    },
  );

  it("binds the workspace before awaited work so a mid-status switch cannot claim it", async () => {
    const { document, mic } = inCall(undefined, true);
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          bindable: true,
          sessionId: "session-1",
          joinRequested: true,
          joinRequestedAt: Date.now(),
        },
      },
    });
    const camera = new PageNode("button", {
      role: "switch",
      "aria-label": "Camera",
      "aria-checked": "true",
    });
    camera.onClick = () => {
      camera.setAttribute("aria-checked", "false");
      browser.location.href = "https://app.slack.com/client/T9999ABCD/C0123ABCD";
    };
    document.body.append(camera);
    await browser.status({ url: "https://app.slack.com/huddle/C0123ABCD", mode: "transcribe" });
    expect(mic.clicks).toBe(0);
    expect(browser.window).toMatchObject({
      __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
    });
  });

  it("keeps a workspace binding when a status pass lands on another workspace's idle channel", async () => {
    const header = channelHeader(true);
    const document = page(header);
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:C0123ABCD",
          sessionId: "session-1",
          bindable: true,
        },
        __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
      },
      onPermissionQuery: () => {
        browser.location.href = "https://app.slack.com/client/T9999ABCD/C0123ABCD";
        header.attributes.class = "p-huddle_channel_header_button__container";
      },
    });
    await browser.status({ url: "https://app.slack.com/huddle/C0123ABCD", mode: "agent" });
    expect(browser.window).toMatchObject({
      __openclawSlackHuddleWorkspaces: { "slack-huddle:C0123ABCD": "T0123ABCD" },
    });
  });

  it("does not let a reloaded channel-only session bind to the workspace now showing", async () => {
    const { document, marker } = inCall();
    const browser = fixture({
      document,
      currentUrl: "https://app.slack.com/client/T9999ABCD/C0123ABCD",
    });
    const channelOnly = { url: "https://app.slack.com/huddle/C0123ABCD" };
    expect(browser.leave(false, channelOnly.url)).toMatchObject({ departed: false });
    expect(marker.clicks).toBe(0);
    expect(await browser.status(channelOnly)).toMatchObject({ inCall: false });
    expect(await browser.status(channelOnly)).toMatchObject({ inCall: false });
    expect(browser.window).not.toHaveProperty("__openclawSlackHuddleWorkspaces");
    expect(browser.leave(false, channelOnly.url)).toMatchObject({ departed: false });
    expect(marker.clicks).toBe(0);
  });

  it("adopts the huddle from Slack's own channel-header state without a join marker", async () => {
    const { document } = inCall(undefined, false, false);
    document.body.append(channelHeader(true));
    const result = await fixture({ document, currentUrl: CLIENT_URL }).status({ readOnly: true });
    expect(result).toMatchObject({ inCall: true });
  });

  it("does not claim or leave another huddle when the channel header says this device is elsewhere", async () => {
    const { document, marker } = inCall(undefined, false, false);
    document.body.append(channelHeader(false));
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:T0123ABCD:C0123ABCD",
          sessionId: "session-1",
          inCallControl: marker,
        },
      },
    });
    expect(await browser.status()).toMatchObject({
      inCall: false,
      manualAction: { reason: "slack-session-conflict" },
    });
    expect(browser.leave()).toMatchObject({ departed: false, sessionMatched: false });
    expect(marker.clicks).toBe(0);
  });

  it.each([false, true])(
    "fails closed without membership even with a recorded toolbar (stale=%s)",
    async (stale) => {
      const { document, marker } = inCall(undefined, false, false);
      const recorded = stale ? qaNode("huddle_toolbar__leave_button", "Leave Huddle") : marker;
      if (stale) {
        recorded.isConnected = false;
      }
      const browser = fixture({
        document,
        currentUrl: CLIENT_URL,
        window: {
          __openclawSlackHuddle: {
            identity: "slack-huddle:T0123ABCD:C0123ABCD",
            sessionId: "session-1",
            inCallControl: recorded,
            ...(!stale ? { inCallUrl: CLIENT_URL } : {}),
          },
        },
      });
      expect(await browser.status({ readOnly: true })).toMatchObject({ inCall: false });
      expect(browser.leave()).toMatchObject({ departed: false });
      expect(marker.clicks).toBe(0);
      await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
    },
  );

  it("does not treat the root audio element as a call and still joins an active preview", async () => {
    const document = page(qaNode("p-huddle_audio", "", "audio"));
    const browser = fixture({ document });
    expect(await browser.status()).toMatchObject({ inCall: false });
    const active = preview("Join Huddle");
    document.body.append(...active.document.body.children);
    expect(await browser.status()).toMatchObject({ inCall: false, clickedJoin: true });
    expect(active.join.clicks).toBe(1);
  });

  it.each([
    ["waiting for approval; request sent", "div"],
    ["Allow Slack to use your microphone", "div"],
    ["Request to join", "button"],
  ])("ignores channel message content %s when classifying huddle prompts", async (content, tag) => {
    const { document, join } = preview("Join Huddle");
    document.body.append(
      new PageNode("div", { "data-qa": "message_container" }).append(
        new PageNode(tag, {}, content),
      ),
    );
    const result = await fixture({ document }).status();
    expect(result).toMatchObject({ clickedJoin: true });
    expect(result.manualAction).toBeUndefined();
    expect(join.clicks).toBe(1);
  });

  it.each([
    "https://app.slack.com/client/T0123ABCD/C9999ABCD",
    "https://app.slack.com/huddle/T0123ABCD/c0123abcd",
    "https://app.slack.com/huddle/t0123abcd/C0123ABCD",
  ])("does not join an unowned or malformed channel page %s", async (currentUrl) => {
    const { document, join } = preview("Join Huddle");
    const result = await fixture({ document, currentUrl }).status();
    expect(result.inCall).toBe(false);
    expect(result.clickedJoin).not.toBe(true);
    expect(join.clicks).toBe(0);
  });

  it("captures caption speaker siblings and nested newest words once, then finalizes the transcript", async () => {
    const speaker = new PageNode(
      "span",
      { class: "p-huddle_closed_caption_event__member_name" },
      "Morgan:",
    );
    const words = new PageNode(
      "span",
      {
        "data-qa": "huddle_closed_caption_event",
        class: "p-huddle_closed_caption_event__transcription",
      },
      "The next step ",
    ).append(
      new PageNode(
        "span",
        { class: "p-huddle_closed_caption_event__transcription_new" },
        "is ready.",
      ),
    );
    const caption = new PageNode("div").append(
      speaker,
      new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
    );
    const { document } = inCall();
    document.body.append(caption);
    const browser = fixture({ document, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: true,
      transcriptLines: 1,
      recentTranscript: [{ speaker: "Morgan:", text: "The next step is ready." }],
    });
    words.textContent = "The next step is ready. Let's begin.";
    browser.mutate();
    expect(browser.transcript(true)).toMatchObject({
      lines: [{ speaker: "Morgan:", text: "The next step is ready. Let's begin." }],
      sessionMatched: true,
      urlMatched: true,
    });
  });

  it("captures audio only while Slack's header shows this device in the requested huddle", async () => {
    const { document } = inCall(undefined, false, false);
    const header = channelHeader(true);
    document.body.append(header);
    const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
    expect(await browser.status()).toMatchObject({ inCall: true });
    await expect(browser.startAudioCapture()).rejects.toThrow("audio capture passed ownership");
    header.attributes.class = "p-huddle_channel_header_button__container";
    await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
  });

  it("never lets a settling Join marker unlock audio without Slack's membership header", async () => {
    const { document, marker } = inCall(undefined, false, false);
    document.body.append(
      channelHeader(false),
      qaNode("huddle_window_titlebar_title", "Other team huddle"),
      qaNode("huddle_avatar_stack__member", ""),
    );
    const browser = fixture({
      document,
      currentUrl: CLIENT_URL,
      window: {
        __openclawSlackHuddle: {
          identity: "slack-huddle:T0123ABCD:C0123ABCD",
          sessionId: "session-1",
          joinRequested: true,
          joinRequestedAt: Date.now(),
        },
      },
    });
    const result = await browser.status({ readOnly: true });
    expect(result).toMatchObject({ inCall: false });
    expect(result.meetingTitle).toBeUndefined();
    expect(result.participantCount).toBeUndefined();
    expect(browser.leave()).toMatchObject({ departed: false });
    expect(marker.clicks).toBe(0);
    await expect(browser.startAudioCapture()).rejects.toThrow("no longer owns");
  });

  it.each(["header", "header-and-controls", "other-huddle"])(
    "stops captions after losing membership: %s",
    async (loss) => {
      const words = new PageNode(
        "span",
        {
          "data-qa": "huddle_closed_caption_event",
          class: "p-huddle_closed_caption_event__transcription",
        },
        "Owned huddle line.",
      );
      const caption = new PageNode("div").append(
        new PageNode("span", { class: "p-huddle_closed_caption_event__member_name" }, "Morgan:"),
        new PageNode("div", { class: "p-huddle_closed_caption_event__event_text" }).append(words),
      );
      const { document, marker } = inCall(undefined, false, false);
      const header = channelHeader(true);
      document.body.append(header, caption);
      const browser = fixture({ document, currentUrl: CLIENT_URL, joined: true });
      expect(await browser.status({ captureCaptions: true })).toMatchObject({ transcriptLines: 1 });
      if (loss === "other-huddle") {
        header.attributes.class = "p-huddle_channel_header_button__container";
      } else {
        for (const node of loss === "header" ? [header] : [header, marker]) {
          document.body.children.splice(document.body.children.indexOf(node), 1);
        }
      }
      const foreign = loss === "other-huddle" ? "Foreign huddle line." : "Unverified huddle line.";
      words.textContent = foreign;
      browser.mutate();
      expect(JSON.stringify(browser.transcript())).not.toContain(foreign);
    },
  );

  it("captures huddle_transcribe_event and reports unavailable captions without clicking menus", async () => {
    const { document } = inCall();
    const menu = new PageNode("button", { "aria-label": "More" }, "More");
    document.body.append(menu);
    const browser = fixture({ document, joined: true });
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: false,
      notes: expect.arrayContaining([expect.stringMatching(/captions.*preference/i)]),
    });
    expect(menu.clicks).toBe(0);
    document.body.append(
      qaNode("huddle_transcribe_event", "Caption from the alternate surface", "div"),
    );
    expect(await browser.status({ captureCaptions: true })).toMatchObject({
      captioning: true,
      recentTranscript: [{ text: "Caption from the alternate surface" }],
    });
    expect(browser.transcript()).toMatchObject({
      lines: [{ text: "Caption from the alternate surface" }],
    });
  });
});
