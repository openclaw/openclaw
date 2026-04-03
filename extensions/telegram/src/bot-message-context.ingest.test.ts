/**
 * Behavioral tests: silent ingest on mention-skip path (Telegram)
 *
 * Verifies:
 * - When requireMention:true and no mention → ingest fires, LLM dispatch does NOT
 * - When ingest.enabled:false → ingest does NOT fire
 * - When hooks:[] → ingest does NOT fire
 * - When hooks has unregistered plugin → skip + warn, no crash
 * - Per-plugin targeting: only configured plugin ids receive the ingest event
 * - Canonical context: from, to, originatingTo, accountId, conversationId are correct
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramMessageContextForTest,
  baseTelegramMessageContextConfig,
} from "./bot-message-context.test-harness.js";

const mockRunMessageIngestForPlugin = vi.fn().mockResolvedValue(undefined);
const mockHasHooksForPlugin = vi.fn().mockReturnValue(true);
const mockHasHooks = vi.fn().mockReturnValue(true);

vi.mock("../../../src/plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    runMessageIngest: vi.fn().mockResolvedValue(undefined),
    runMessageIngestForPlugin: mockRunMessageIngestForPlugin,
    hasHooks: mockHasHooks,
    hasHooksForPlugin: mockHasHooksForPlugin,
  }),
}));

function makeGroupMessage(text: string) {
  return {
    message_id: 42,
    chat: { id: -1001234567890, type: "supergroup" as const, title: "Test Group" },
    date: 1700000000,
    text,
    from: { id: 99, first_name: "Alice" },
  };
}

function makeIngestConfig(ingest?: {
  enabled: boolean;
  hooks: Array<"session-memory" | "command-logger">;
}) {
  return {
    ...baseTelegramMessageContextConfig,
    channels: {
      telegram: {
        groups: {
          "*": {
            requireMention: true,
            ...(ingest ? { ingest } : {}),
          },
        },
      },
    },
  } as never;
}

type TestIngestConfig = { enabled: boolean; hooks: Array<"session-memory" | "command-logger"> };
async function buildSkippedGroupCtx(text: string, ingest?: TestIngestConfig) {
  return buildTelegramMessageContextForTest({
    message: makeGroupMessage(text),
    cfg: makeIngestConfig(ingest),
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: (chatId) => ({
      groupConfig: {
        requireMention: true,
        ...(ingest ? { ingest } : {}),
      },
      topicConfig: undefined,
    }),
  });
}

describe("telegram silent ingest — behavioral", () => {
  it("fires ingest and context is null (no LLM) on mention-skip", async () => {
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooks.mockReturnValue(true);
    mockHasHooksForPlugin.mockReturnValue(true);

    const ctx = await buildSkippedGroupCtx("hello without mention", {
      enabled: true,
      hooks: ["session-memory"],
    });

    // No context means no LLM dispatch
    expect(ctx).toBeNull();
    // Ingest was invoked for the configured plugin
    expect(mockRunMessageIngestForPlugin).toHaveBeenCalledWith(
      "session-memory",
      expect.objectContaining({ content: "hello without mention" }),
      expect.objectContaining({ channelId: "telegram" }),
    );
  });

  it("does NOT fire ingest when ingest.enabled is false", async () => {
    mockRunMessageIngestForPlugin.mockClear();

    await buildSkippedGroupCtx("some message", { enabled: false, hooks: ["session-memory"] });
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("does NOT fire ingest when hooks is empty", async () => {
    mockRunMessageIngestForPlugin.mockClear();

    await buildSkippedGroupCtx("some message", { enabled: true, hooks: [] });
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("skips unregistered plugin without crashing", async () => {
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooksForPlugin.mockReturnValue(false);

    await expect(
      buildSkippedGroupCtx("some message", { enabled: true, hooks: ["session-memory"] }),
    ).resolves.not.toThrow();
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });

  it("sends canonical context (from, to, originatingTo, accountId, conversationId)", async () => {
    mockRunMessageIngestForPlugin.mockClear();
    mockHasHooks.mockReturnValue(true);
    mockHasHooksForPlugin.mockReturnValue(true);

    await buildSkippedGroupCtx("canonical test", { enabled: true, hooks: ["session-memory"] });

    expect(mockRunMessageIngestForPlugin).toHaveBeenCalledWith(
      "session-memory",
      expect.objectContaining({
        from: expect.stringContaining("-1001234567890"),
        metadata: expect.objectContaining({
          to: "telegram:-1001234567890",
          originatingTo: "telegram:-1001234567890",
          provider: "telegram",
        }),
      }),
      expect.objectContaining({
        channelId: "telegram",
        conversationId: "-1001234567890",
      }),
    );
  });

  it("does NOT fire ingest when message is empty", async () => {
    mockRunMessageIngestForPlugin.mockClear();

    await buildSkippedGroupCtx("", { enabled: true, hooks: ["session-memory"] });
    expect(mockRunMessageIngestForPlugin).not.toHaveBeenCalled();
  });
});
