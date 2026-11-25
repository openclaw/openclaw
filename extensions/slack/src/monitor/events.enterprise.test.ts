// Slack tests cover Enterprise Grid event registration boundaries.
import { describe, expect, it, vi } from "vitest";
import { registerSlackCommonEvents, registerSlackWorkspaceEvents } from "./events.js";
import { createSlackSystemEventTestHarness } from "./events/system-event-test-harness.js";

function createRegistrationHarness() {
  const { ctx } = createSlackSystemEventTestHarness();
  const events: string[] = [];
  vi.spyOn(ctx.app, "event").mockImplementation((name) => {
    events.push(String(name));
  });
  const action = vi.spyOn(ctx.app, "action");
  const shortcut = vi.spyOn(ctx.app, "shortcut");
  const view = vi.spyOn(ctx.app, "view");
  return { ctx, events, action, shortcut, view };
}

const commonEvents = [
  "message",
  "app_mention",
  "reaction_added",
  "reaction_removed",
  "pin_added",
  "pin_removed",
  "member_joined_channel",
  "member_left_channel",
  "channel_created",
  "channel_rename",
];

const workspaceEvents = [
  "channel_id_changed",
  "app_home_opened",
  "app_context_changed",
  "agent_session_stopped",
  "agent_session_title_changed",
  "assistant_thread_started",
  "assistant_thread_context_changed",
];

describe("Slack event registration", () => {
  it("registers the Enterprise-capable common event set without workspace-only listeners", () => {
    const harness = createRegistrationHarness();
    registerSlackCommonEvents({ ctx: harness.ctx, handleSlackMessage: vi.fn() });

    expect(harness.events).toEqual(commonEvents);
    expect(harness.action).toHaveBeenCalledOnce();
    expect(harness.shortcut).toHaveBeenCalledOnce();
    expect(harness.view).toHaveBeenCalledTimes(2);
  });

  it("adds workspace-only listeners without duplicating the common event set", () => {
    const harness = createRegistrationHarness();
    registerSlackCommonEvents({ ctx: harness.ctx, handleSlackMessage: vi.fn() });
    registerSlackWorkspaceEvents({ ctx: harness.ctx });

    expect(harness.events).toEqual([...commonEvents, ...workspaceEvents]);
    expect(new Set(harness.events).size).toBe(harness.events.length);
    expect(harness.action).toHaveBeenCalledOnce();
    expect(harness.shortcut).toHaveBeenCalledOnce();
    expect(harness.view).toHaveBeenCalledTimes(2);
  });
});
