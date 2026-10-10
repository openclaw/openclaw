import { afterEach, describe, expect, it, vi } from "vitest";
import { updateLiveEditDiffProgress } from "./embedded-agent-live-edit-diff.js";

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

  it("counts canonical write and patch arguments", () => {
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
  });

  it("reports counts-only input progress for any tool, throttled and without content", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const state = new Map();
    const secret = "SECRET-ARGUMENT-CONTENT";
    const call = (partialJson: string) =>
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: "draft-1", name: "Sites_Update_Draft", partialJson }),
      );

    const first = call(`{"html":"${secret}`);
    expect(first).toEqual({
      toolCallId: "draft-1",
      name: "sites_update_draft",
      inputChars: `{"html":"${secret}`.length,
    });
    expect(JSON.stringify(first)).not.toContain(secret);

    vi.setSystemTime(3_100);
    expect(call(`{"html":"${secret}${secret}`)).toBeUndefined();

    vi.setSystemTime(3_250);
    const large = `{"html":"${"x".repeat(2 * 1024 * 1024)}`;
    expect(call(large)).toEqual({
      toolCallId: "draft-1",
      name: "sites_update_draft",
      inputChars: large.length,
    });

    vi.setSystemTime(3_500);
    expect(call(large)).toBeUndefined();

    updateLiveEditDiffProgress(
      state,
      toolCallEvent({ type: "toolcall_end", id: "draft-1", name: "x", partialJson: "" }),
    );
    expect(state.size).toBe(0);
  });

  it("keeps edit counts frozen past the parse cap while length keeps reporting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const state = new Map();
    const prefix = '{"path":"a","content":"one\\ntwo\\n';
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: "write-big", name: "write", partialJson: prefix }),
      )?.diff,
    ).toEqual({ added: 2, removed: 0 });

    vi.setSystemTime(4_250);
    const oversized = `${prefix}${"three\\n".repeat(200_000)}`;
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: "write-big", name: "write", partialJson: oversized }),
      ),
    ).toEqual({
      toolCallId: "write-big",
      name: "write",
      inputChars: oversized.length,
      diff: { added: 2, removed: 0 },
    });
  });

  it("bounds tracked calls", () => {
    const state = new Map();
    for (let index = 0; index < 64; index += 1) {
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: `call-${index}`, name: "exec", partialJson: "{" }),
      );
    }
    expect(
      updateLiveEditDiffProgress(
        state,
        toolCallEvent({ id: "call-overflow", name: "exec", partialJson: "{" }),
      ),
    ).toBeUndefined();
    expect(state.size).toBe(64);
  });
});
