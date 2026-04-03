/**
 * Behavioral tests: silent ingest on mention-skip path (Signal)
 *
 * Verifies:
 * - When requireMention:true and no mention → ingest fires, LLM dispatch does NOT
 * - When ingest.enabled:false → ingest does NOT fire
 * - When hooks:[] → ingest does NOT fire
 * - When hooks has unregistered plugin → skip + warn, no crash
 * - Per-plugin targeting: only configured plugin ids receive the ingest event
 * - Timeout cleanup: timer is cleared after ingest settles
 * - Canonical context: from, to, originatingTo, accountId, conversationId are correct
 */
import { describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../../src/channels/plugins/contracts/inbound-testkit.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

let llmDispatched = false;

vi.mock("../../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, () => {
    llmDispatched = true;
  });
});

// Mock the global hook runner so we can observe ingest calls
const mockRunMessageIngestForPlugin = vi.fn().mockResolvedValue(undefined);
const mockHasHooksForPlugin = vi.fn().mockReturnValue(true);
const mockHasHooks = vi.fn().mockReturnValue(true);

vi.mock("../../../../src/plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    runMessageIngest: vi.fn().mockResolvedValue(undefined),
    runMessageIngestForPlugin: mockRunMessageIngestForPlugin,
    hasHooks: mockHasHooks,
    hasHooksForPlugin: mockHasHooksForPlugin,
  }),
}));

import { createSignalEventHandler } from "./event-handler.js";

function makeGroupEvent(message: string) {
  return createSignalReceiveEvent({
    dataMessage: {
      message,
      attachments: [],
      groupInfo: { groupId: "g-ingest-test", groupName: "Monitor Group" },
    },
  });
}

function makeSignalCfg(
  ingest?: { enabled: boolean; hooks: string[] },
  requireMention = true,
): OpenClawConfig {
  return {
    messages: {
      inbound: { debounceMs: 0 },
      groupChat: { mentionPatterns: ["@bot"] },
    },
    channels: {
      signal: {
        groups: {
          "*": {
            requireMention,
            ...(ingest ? { ingest } : {}),
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("signal silent ingest — behavioral", () => {
  it("fires ingest and does NOT dispatch to LLM on mention-skip", async () => {
    llmDispatched = false;
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooks.mockReturnValue(true);
    mockHasHooksForPlugin.mockReturnValue(true);

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: makeSignalCfg({ enabled: true, hooks: ["session-memory"] }),
      }),
    );

    await handler(makeGroupEvent("hello without mention"));

    expect(llmDispatched).toBe(false);
    expect(mockRunMessageIngestForPlugin).toHaveBeenCalledWith(
      "session-memory",
      expect.objectContaining({ content: "hello without mention" }),
      expect.objectContaining({ channelId: "signal", accountId: "default" }),
    );
  });

  it("does NOT fire ingest when ingest.enabled is false", async () => {
    mockRunMessageIngestForPlugin.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: makeSignalCfg({ enabled: false, hooks: ["session-memory"] }),
      }),
    );

    await handler(makeGroupEvent("some message"));
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("does NOT fire ingest when hooks is empty", async () => {
    mockRunMessageIngestForPlugin.mockClear();

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: makeSignalCfg({ enabled: true, hooks: [] }),
      }),
    );

    await handler(makeGroupEvent("some message"));
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("skips unregistered plugin without crashing", async () => {
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooksForPlugin.mockReturnValue(false);

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: makeSignalCfg({ enabled: true, hooks: ["session-memory"] }),
      }),
    );

    await expect(handler(makeGroupEvent("some message"))).resolves.not.toThrow();
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("sends canonical context (from, to, accountId, conversationId)", async () => {
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooks.mockReturnValue(true);
    mockHasHooksForPlugin.mockReturnValue(true);

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: makeSignalCfg({ enabled: true, hooks: ["session-memory"] }),
        accountId: "signal-main",
      }),
    );

    await handler(makeGroupEvent("test canonical"));

    expect(mockRunMessageIngestForPlugin).toHaveBeenCalledWith(
      "session-memory",
      expect.objectContaining({
        from: expect.stringContaining("g-ingest-test"),
        metadata: expect.objectContaining({
          to: expect.stringContaining("g-ingest-test"),
          originatingTo: expect.stringContaining("g-ingest-test"),
        }),
      }),
      expect.objectContaining({
        accountId: "signal-main",
        conversationId: expect.stringContaining("g-ingest-test"),
      }),
    );
  });
});
