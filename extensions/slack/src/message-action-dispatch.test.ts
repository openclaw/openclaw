import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./message-action-dispatch.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    ok: true,
    content: action,
  }));
}

describe("handleSlackMessageAction", () => {
  it("maps upload-file to the internal uploadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          to: "user:U1",
          filePath: "/tmp/report.png",
          initialComment: "fresh build",
          filename: "build.png",
          title: "Build Screenshot",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadTs: "111.222",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file aliases to upload params", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          channelId: "C1",
          media: "/tmp/chart.png",
          message: "chart attached",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "C1",
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
        threadTs: "333.444",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file path alias to filePath", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          to: "channel:C1",
          path: "/tmp/report.txt",
          initialComment: "path alias",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        to: "channel:C1",
        filePath: "/tmp/report.txt",
        initialComment: "path alias",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("requires filePath, path, or media for upload-file", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "upload-file",
          cfg: {},
          params: {
            to: "channel:C1",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);
  });

  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          channelId: "C1",
          fileId: "F123",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
        threadId: "111.222",
      }),
      expect.any(Object),
    );
  });

  it("maps download-file target aliases to scope fields", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      providerId: "slack",
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          to: "channel:C2",
          fileId: "F999",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        fileId: "F999",
        channelId: "channel:C2",
        threadId: "333.444",
      }),
      expect.any(Object),
    );
  });

  it("throws a friendly error when download-file gets messageId instead of fileId (Friday-2026-04-29 regression guard)", async () => {
    // Production-shape failure: the LLM passed the Slack message ts as
    // messageId and omitted fileId. The strict 'fileId required' was
    // unrecoverable in one round-trip; this friendlier error tells the
    // model exactly how to fix the call.
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {
            channel: "slack",
            messageId: "1777423717.666499",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/Did you mean to pass fileId\?/i);
  });

  it("also recognizes the snake_case message_id alias when steering the friendly download-file error", async () => {
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {
            channel: "slack",
            message_id: "1777423717.666499",
          },
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/Did you mean to pass fileId\?/i);
  });

  it("still emits the original required-field error when neither fileId nor messageId is provided", async () => {
    // Don't lose the existing failure mode — callers that omit both fields
    // shouldn't get the new "did you mean fileId?" wording, because there's
    // no messageId to confuse for fileId.
    await expect(
      handleSlackMessageAction({
        providerId: "slack",
        ctx: {
          action: "download-file",
          cfg: {},
          params: {},
        } as never,
        invoke: createInvokeSpy() as never,
      }),
    ).rejects.toThrow(/fileId/i);
  });
});
