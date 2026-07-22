import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

const STATUS_LINE = "▸ Exec: run tests · 2m · reply to steer";

const workLine = (id: string, label: string): ChannelProgressDraftLine => ({
  id,
  kind: "tool",
  text: `🛠️ ${label}`,
  label,
  toolName: "exec",
});

describe("renderTelegramProgressDraftPreview status line", () => {
  it("renders the status line last on the plain path", () => {
    const preview = renderTelegramProgressDraftPreview(
      "🛠️ First\n🛠️ Second",
      [workLine("t1", "First"), workLine("t2", "Second")],
      false,
      false,
      STATUS_LINE,
    );

    expect(preview.text).toContain("reply to steer");
    expect(preview.text.lastIndexOf("reply to steer")).toBeGreaterThan(
      preview.text.lastIndexOf("Second"),
    );
  });

  it("renders the status line last under a status headline", () => {
    const preview = renderTelegramProgressDraftPreview(
      "Implementing the change.\n🛠️ First",
      [workLine("t1", "First")],
      false,
      true,
      STATUS_LINE,
    );

    expect(preview.text).toContain("reply to steer");
    expect(preview.text.lastIndexOf("reply to steer")).toBeGreaterThan(
      preview.text.lastIndexOf("First"),
    );
  });

  it("keeps the status line in the plain text of a rich preview", () => {
    const preview = renderTelegramProgressDraftPreview(
      "🛠️ First",
      [workLine("t1", "First")],
      true,
      false,
      STATUS_LINE,
    );

    expect(preview.text.endsWith(STATUS_LINE)).toBe(true);
  });

  it("omits the line entirely when no status line is supplied", () => {
    const preview = renderTelegramProgressDraftPreview(
      "🛠️ First",
      [workLine("t1", "First")],
      false,
      false,
    );

    expect(preview.text).not.toContain("reply to steer");
  });
});
