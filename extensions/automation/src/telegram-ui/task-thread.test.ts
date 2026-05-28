import { describe, expect, it } from "vitest";
import {
  buildTaskAwaitingInput,
  buildTaskComplete,
  buildTaskError,
  buildTaskProgress,
} from "./task-thread.js";

describe("task-thread", () => {
  it("uses task-scoped retry callback when taskId is provided", () => {
    const reply = buildTaskComplete("任務A", false, "失敗", 1200, [], "task-123");
    const buttonsBlock = reply.blocks.find((block) => block.type === "buttons");
    expect(buttonsBlock?.type).toBe("buttons");
    if (!buttonsBlock || buttonsBlock.type !== "buttons") {
      return;
    }
    expect(buttonsBlock.buttons[0]?.value).toBe("sc:retry:task-123");
  });

  it("keeps fallback retry callback when taskId is missing", () => {
    const reply = buildTaskComplete("任務B", false, "失敗", 1200, []);
    const buttonsBlock = reply.blocks.find((block) => block.type === "buttons");
    expect(buttonsBlock?.type).toBe("buttons");
    if (!buttonsBlock || buttonsBlock.type !== "buttons") {
      return;
    }
    expect(buttonsBlock.buttons[0]?.value).toBe("sc:retry");
  });

  it("renders stable progress bar when total step is zero", () => {
    const reply = buildTaskProgress("任務C", "thinking", 1, 0, "分析中", 500);
    const textBlock = reply.blocks.find((block) => block.type === "text");
    expect(textBlock?.type).toBe("text");
    if (!textBlock || textBlock.type !== "text") {
      return;
    }
    expect(textBlock.text).toContain("0%");
    expect(textBlock.text).not.toContain("NaN");
    expect(textBlock.text).not.toContain("Infinity");
  });

  it("builds awaiting-input defaults with task-scoped callbacks", () => {
    const reply = buildTaskAwaitingInput("任務D", "請確認", "task-456");
    const buttonsBlock = reply.blocks.find((block) => block.type === "buttons");
    expect(buttonsBlock?.type).toBe("buttons");
    if (!buttonsBlock || buttonsBlock.type !== "buttons") {
      return;
    }
    expect(buttonsBlock.buttons.map((btn) => btn.value)).toEqual([
      "sc:approve:task-456",
      "sc:deny:task-456",
      "sc:edit:task-456",
    ]);
  });

  it("builds task error actions with task-scoped callbacks", () => {
    const reply = buildTaskError("任務E", "boom", "task-789");
    const buttonsBlock = reply.blocks.find((block) => block.type === "buttons");
    expect(buttonsBlock?.type).toBe("buttons");
    if (!buttonsBlock || buttonsBlock.type !== "buttons") {
      return;
    }
    expect(buttonsBlock.buttons.map((btn) => btn.value)).toEqual([
      "sc:retry:task-789",
      "sc:analyze:task-789",
      "sc:skip:task-789",
    ]);
  });
});
