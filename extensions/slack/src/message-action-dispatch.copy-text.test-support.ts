import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slackSetupPlugin } from "./channel.setup.js";
import { handleSlackMessageAction } from "./message-action-dispatch.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({ ok: true, content: action }));
}

describe("Slack copy-text action dispatch", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
    );
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  it("keeps copy-text backticks and mentions literal in text-only edits", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "edit",
        cfg: {},
        params: {
          channelId: "C1",
          messageId: "171234.567",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Copy",
                    action: { type: "copy-text", text: "x`<!channel> <@U1>" },
                  },
                ],
              },
            ],
          },
        },
      } as never,
      invoke: invoke as never,
    });

    const action = invoke.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const content = String(action?.content);
    expect(content).toBe("- Copy [not copyable: contains backtick]: `x[backtick]<!channel> <@U1>`");
    expect([...content.matchAll(/`([^`]*)`/gs)]).toHaveLength(1);
    expect(content.replace(/`[^`]*`/gs, "")).not.toMatch(/<!channel>|<@U1>/);
  });
});
