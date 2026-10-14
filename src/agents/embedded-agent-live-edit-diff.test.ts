import { afterEach, describe, expect, it, vi } from "vitest";
import {
  updateLiveEditDiffProgress,
  updateLiveEditDiffProgressFromInput,
} from "./embedded-agent-live-edit-diff.js";

function toolCallEvent(params: {
  type?: "toolcall_delta" | "toolcall_end";
  id: string;
  name: string;
  partialJson: string;
}) {
  const block = {
    type: "toolCall",
    id: params.id,
    name: params.name,
    arguments: {},
    partialJson: params.partialJson,
  };
  return {
    type: params.type ?? "toolcall_delta",
    contentIndex: 0,
    partial: { role: "assistant", content: [block] },
    ...(params.type === "toolcall_end" ? { toolCall: block } : { delta: params.partialJson }),
  };
}

describe("updateLiveEditDiffProgress", () => {
  it("bounds cumulative argument assembly before parsing across CLI and embedded callers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state = new Map();
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
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state = new Map();

    const first = updateLiveEditDiffProgress(
      state,
      toolCallEvent({
        id: "edit-1",
        name: "edit",
        partialJson: '{"edits":[{"oldText":"old\\n',
      }),
    );
    expect(first?.diff).toEqual({ added: 0, removed: 1 });

    vi.setSystemTime(1_100);
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({
          id: "edit-1",
          name: "edit",
          partialJson: '{"edits":[{"oldText":"old\\nline","newText":"new\\n',
        }),
      ),
    ).toBeUndefined();
    expect(state.get("edit-1")).toMatchObject({ added: 0, removed: 1 });

    vi.setSystemTime(1_250);
    const second = updateLiveEditDiffProgress(
      state,
      toolCallEvent({
        id: "edit-1",
        name: "edit",
        partialJson: '{"edits":[{"oldText":"old\\nline","newText":"new\\nline\\nnext\\n',
      }),
    );
    expect(second?.diff).toEqual({ added: 3, removed: 1 });

    updateLiveEditDiffProgress(
      state,
      toolCallEvent({ type: "toolcall_end", id: "edit-1", name: "edit", partialJson: "" }),
    );
    expect(state.size).toBe(0);
  });

  it("counts canonical write and patch arguments but ignores non-edit tools", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const state = new Map();

    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({
          id: "write-1",
          name: "write",
          partialJson: '{"path":"a","content":"one\\ntwo\\n',
        }),
      )?.diff,
    ).toEqual({ added: 2, removed: 0 });

    vi.setSystemTime(2_300);
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({
          id: "patch-1",
          name: "apply_patch",
          partialJson:
            '{"input":"*** Begin Patch\\n*** Update File: a\\n@@\\n-old\\n+new\\n+next\\n',
        }),
      )?.diff,
    ).toEqual({ added: 2, removed: 1 });

    vi.setSystemTime(2_600);
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: "read-1", name: "read", partialJson: '{"path":"a\\n' }),
      ),
    ).toBeUndefined();
    expect(state.has("read-1")).toBe(false);
  });
});
