import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { deleteQaBusMessage, editQaBusMessage, sendQaBusMessage } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import { createQaInboundParams, firstRunAssembledParams } from "./inbound.test-harness.js";

vi.mock("./bus-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bus-client.js")>()),
  deleteQaBusMessage: vi.fn(async () => ({ message: {} })),
  editQaBusMessage: vi.fn(async () => ({ message: {} })),
  sendQaBusMessage: vi.fn(async () => ({ message: { id: "preview-1" } })),
}));

async function assembledTurn() {
  const runtime = createPluginRuntimeMock();
  setQaChannelRuntime(runtime);
  await handleQaInbound(createQaInboundParams());
  return firstRunAssembledParams(runtime);
}

describe("QA preview terminal ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("cannot edit a promoted final from a late partial", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "answer" }));
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("does not delete a promoted answer during later error cleanup", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    turn.delivery.onError?.(new Error("later dispatch failure"), { kind: "final" });
    // This queued callback drains the same lock after the cleanup callback.
    await turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("does not create a preview after a final without an earlier preview", async () => {
    const turn = await assembledTurn();
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).not.toHaveBeenCalled();
  });

  it("acknowledges a repeated promoted final without a duplicate message", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("retains distinct final chunks rather than dropping all later delivery", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer one" }, { kind: "final" });
    await turn.delivery.deliver({ text: "answer two" }, { kind: "final" });
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledTimes(2);
    expect(sendQaBusMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "answer two" }),
    );
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("still permits previews after a nonterminal block", async () => {
    const turn = await assembledTurn();
    await turn.delivery.deliver({ text: "block" }, { kind: "block" });
    await turn.replyOptions?.onPartialReply?.({ text: "next draft" });
    expect(sendQaBusMessage).toHaveBeenCalledTimes(2);
    expect(sendQaBusMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "next draft" }),
    );
  });

  it("removes an unfinished preview on an empty final and rejects later partials", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
    await turn.delivery.deliver({ text: "" }, { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late" });
    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).not.toHaveBeenCalled();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("does not close previews for an empty nonterminal block", async () => {
    const turn = await assembledTurn();
    await turn.delivery.deliver({ text: "" }, { kind: "block" });
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("stops partials queued while the final edit is still in flight", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    vi.mocked(editQaBusMessage).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { message: {} } as Awaited<ReturnType<typeof editQaBusMessage>>;
    });
    const final = turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await entered.promise;
    const late = turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    release.resolve();
    await Promise.all([final, late]);
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("keeps cleanup ownership when the final edit failed", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    vi.mocked(editQaBusMessage).mockRejectedValueOnce(new Error("final edit failed"));
    await expect(turn.delivery.deliver({ text: "answer" }, { kind: "final" })).rejects.toThrow(
      "final edit failed",
    );
    turn.delivery.onError?.(new Error("dispatch failed"), { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late" });
    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("does not revive a preview after cleanup of a failed turn", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    turn.delivery.onError?.(new Error("dispatch failed"), { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late" });
    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).not.toHaveBeenCalled();
  });
});
