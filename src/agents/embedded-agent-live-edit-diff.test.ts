import { afterEach, expect, it, vi } from "vitest";
import {
  updateLiveEditDiffProgress,
  updateLiveEditDiffProgressFromInput,
} from "./embedded-agent-live-edit-diff.js";

function progressHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const state = new Map();
  const update = (id: string, name: string, partialJson: string) =>
    updateLiveEditDiffProgress(state, {
      type: "toolcall_delta",
      contentIndex: 0,
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {}, partialJson }],
      },
      delta: partialJson,
    });
  return { state, update };
}

it("bounds cumulative argument assembly before parsing across CLI and embedded callers", () => {
  const { state } = progressHarness();
  const readPartialJson = vi.fn(() => '{"content":"one\\n');
  const input = { toolCallId: "write-1", name: "Write", partialJsonLength: 20, readPartialJson };
  updateLiveEditDiffProgressFromInput(state, input);
  expect(readPartialJson).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_249);
  updateLiveEditDiffProgressFromInput(state, input);
  expect(readPartialJson).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_250);
  updateLiveEditDiffProgressFromInput(state, input);
  expect(readPartialJson).toHaveBeenCalledTimes(2);
  updateLiveEditDiffProgressFromInput(state, { ...input, partialJsonLength: 1024 * 1024 + 1 });
  expect(readPartialJson).toHaveBeenCalledTimes(2);
  expect(state.size).toBe(0);
  for (let index = 0; index < 64; index++) {
    updateLiveEditDiffProgressFromInput(state, { ...input, toolCallId: `call-${index}` });
  }
  expect(state.size).toBe(64);
  readPartialJson.mockClear();
  updateLiveEditDiffProgressFromInput(state, { ...input, toolCallId: "overflow" });
  expect(readPartialJson).not.toHaveBeenCalled();
  // The embedded completion adapter releases the same counter owner's budget.
  updateLiveEditDiffProgress(state, { type: "toolcall_end", toolCall: { id: "call-0" } });
  updateLiveEditDiffProgressFromInput(state, { ...input, toolCallId: "overflow" });
  expect(readPartialJson).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps streamed edit counts monotonic, throttled, and scoped to tool completion", () => {
  const { state, update } = progressHarness();
  const edit = (partialJson: string) => update("edit-1", "edit", partialJson);
  expect(edit('{"edits":[{"oldText":"old\\n')?.diff).toEqual({ added: 0, removed: 1 });

  vi.setSystemTime(1_100);
  expect(edit('{"edits":[{"oldText":"old\\nline","newText":"new\\n')).toBeUndefined();
  expect(state.get("edit-1")).toMatchObject({ added: 0, removed: 1 });

  vi.setSystemTime(1_250);
  const second = edit('{"edits":[{"oldText":"old\\nline","newText":"new\\nline\\nnext\\n');
  expect(second?.diff).toEqual({ added: 3, removed: 1 });

  updateLiveEditDiffProgress(state, { type: "toolcall_end", toolCall: { id: "edit-1" } });
  expect(state.size).toBe(0);
});

it("counts canonical write and patch arguments but ignores non-edit tools", () => {
  const { state, update } = progressHarness();
  vi.setSystemTime(2_000);

  expect(update("write-1", "write", '{"path":"a","content":"one\\ntwo\\n')?.diff).toEqual({
    added: 2,
    removed: 0,
  });

  vi.setSystemTime(2_300);
  expect(
    update(
      "patch-1",
      "apply_patch",
      '{"input":"*** Begin Patch\\n*** Update File: a\\n@@\\n-old\\n+new\\n+next\\n',
    )?.diff,
  ).toEqual({ added: 2, removed: 1 });

  vi.setSystemTime(2_600);
  expect(update("read-1", "read", '{"path":"a\\n')).toBeUndefined();
  expect(state.has("read-1")).toBe(false);
});
