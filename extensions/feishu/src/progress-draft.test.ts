import { describe, expect, it } from "vitest";
import { buildFeishuCompactionProgressLine, stripFeishuProgressLabel } from "./progress-draft.js";

describe("feishu progress draft helpers", () => {
  it("strips the leading status label line but keeps progress lines", () => {
    expect(stripFeishuProgressLabel("Working\n🧩 Search: query\n🧩 Read: file", "Working")).toBe(
      "🧩 Search: query\n🧩 Read: file",
    );
  });

  it("tolerates blank separator lines after the label", () => {
    expect(stripFeishuProgressLabel("Thinking\n\n🧩 Search", "Thinking")).toBe("🧩 Search");
  });

  it("keeps the draft unchanged without a matching label", () => {
    expect(stripFeishuProgressLabel("🧩 Search", undefined)).toBe("🧩 Search");
    expect(stripFeishuProgressLabel("🧩 Search", "Working")).toBe("🧩 Search");
  });

  it("builds compaction progress lines with a stable id", () => {
    expect(buildFeishuCompactionProgressLine("start")).toMatchObject({
      id: "context-compaction",
      kind: "item",
    });
    expect(buildFeishuCompactionProgressLine("complete").label).toBe("Compaction complete");
  });
});
