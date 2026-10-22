import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackWorkspaceEvents } from "../events.js";
import { updateSlackSuggestedPrompts } from "../suggested-prompts.js";
import { createSlackSystemEventTestHarness } from "./system-event-test-harness.js";

function createHomeContext(params?: {
  slashCommandName?: string;
  trackEvent?: () => void;
  context?: Partial<SlackMonitorContext>;
}) {
  const harness = createSlackSystemEventTestHarness();
  const publish = vi.fn().mockResolvedValue({ ok: true });
  Object.assign(harness.ctx, params?.context);
  harness.ctx.botToken = "xoxb-test";
  (harness.ctx.app as unknown as { client: { views: { publish: typeof publish } } }).client = {
    views: { publish },
  };
  registerSlackWorkspaceEvents({
    ctx: harness.ctx,
    appHomeSlashCommandName: params?.slashCommandName,
    trackEvent: params?.trackEvent,
  });
  const handler = harness.getHandler("app_home_opened");
  if (!handler) {
    throw new Error("expected Slack Home handler");
  }
  return {
    publish,
    openHome: (event: Record<string, unknown> = {}, body: unknown = {}) =>
      handler({
        event: { type: "app_home_opened", user: "U123", channel: "D123", tab: "home", ...event },
        body,
      }),
  };
}

describe("Slack home events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the Home tab without an inactive slash command hint", async () => {
    const trackEvent = vi.fn();
    const { publish, openHome } = createHomeContext({ trackEvent });

    await openHome({ event_ts: "123.456" }, { api_app_id: "A1" });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM or mention OpenClaw in a channel to start a session.",
      },
    });
  });

  it("publishes the configured slash command name", async () => {
    const { publish, openHome } = createHomeContext({ slashCommandName: "acme" });

    await openHome();

    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM, mention OpenClaw in a channel, or use `/acme` to start a session.",
      },
    });
  });

  it("records Agent View when Slack answers the threadless probe with internal_error", async () => {
    const client = new WebClient();
    vi.spyOn(client.assistant.threads, "setSuggestedPrompts").mockRejectedValue(
      new WebAPIPlatformError({ ok: false, error: "internal_error" }),
    );
    const setSlackSuggestedPrompts = vi.fn<SlackMonitorContext["setSlackSuggestedPrompts"]>(
      (input) => updateSlackSuggestedPrompts({ ...input, botToken: "", client }),
    );
    const recordSlackAgentView = vi.fn(async () => undefined);
    const { openHome } = createHomeContext({
      context: { setSlackSuggestedPrompts, recordSlackAgentView },
    });

    await openHome({ tab: "messages" });

    expect(recordSlackAgentView).toHaveBeenCalledTimes(1);
  });

  it("does not track or publish mismatched events", async () => {
    const trackEvent = vi.fn();
    const { publish, openHome } = createHomeContext({
      trackEvent,
      context: { shouldDropMismatchedSlackEvent: () => true },
    });

    await openHome({ channel: undefined }, { api_app_id: "A_OTHER" });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
