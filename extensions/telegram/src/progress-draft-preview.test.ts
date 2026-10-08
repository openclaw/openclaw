import { buildChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDraftStream, createMockDraftApi } from "./draft-stream.api.test-helpers.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "keeps tool emojis through progress sends and edits (rich: %s)",
  async (richMessages) => {
    const api = createMockDraftApi();
    const stream = createDraftStream(api, { richMessages, thread: { id: 99, scope: "forum" } });
    const options = { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 200 };
    const exec = buildChannelProgressDraftLine({
      event: "item",
      itemKind: "tool",
      name: "exec",
      status: "running",
    })!;
    stream.updatePreview(renderTelegramProgressDraftPreview({ lines: [exec] }, options));
    await stream.flush();

    if (richMessages) {
      expect(api.raw.sendRichMessage).toHaveBeenCalledOnce();
      expect(JSON.stringify(api.raw.sendRichMessage.mock.calls)).toContain("🛠️ Exec");
    } else {
      expect(api.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining("🛠️ Exec"),
        expect.objectContaining({ message_thread_id: 99, parse_mode: "HTML" }),
      );
    }

    const browser = buildChannelProgressDraftLine({ event: "tool", name: "browser" })!;
    stream.updatePreview(renderTelegramProgressDraftPreview({ lines: [browser] }, options));
    await stream.flush();

    if (richMessages) {
      expect(api.raw.editMessageText).toHaveBeenCalledOnce();
      expect(JSON.stringify(api.raw.editMessageText.mock.calls)).toContain("🌐 Browser");
    } else {
      expect(api.editMessageText).toHaveBeenCalledWith(
        123,
        17,
        expect.stringContaining("🌐 Browser"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    }
    await stream.stop();
  },
);

it.each([false, true])(
  "uses per-tool and fallback emojis without replacing explicit icons or commentary (rich: %s)",
  (richMessages) => {
    const read = buildChannelProgressDraftLine({ event: "tool", name: "read" })!;
    const search = buildChannelProgressDraftLine({
      event: "item",
      itemKind: "tool",
      name: "web_search",
    })!;
    const custom = buildChannelProgressDraftLine({ event: "tool", name: "custom_tool" })!;
    const preview = renderTelegramProgressDraftPreview(
      {
        lines: [
          read,
          search,
          custom,
          { ...read, icon: "🧪" },
          { kind: "item", label: "Commentary", text: "💬 Checking the result", prefix: false },
        ],
      },
      { richMessages, toolProgress: true, maxLines: 5, maxLineChars: 200 },
    );
    expect(preview.text).toContain("📖 Read");
    expect(preview.text).toContain("🔎 Web Search");
    expect(preview.text).toContain("🛠️ Custom Tool");
    expect(preview.text).toContain("🧪 Read");
    expect(preview.text).toContain("💬 Checking the result");
    expect(preview.text).not.toContain("🛠️ Commentary");
    expect(read.icon).toBeUndefined();
  },
);
