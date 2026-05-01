import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  buildMattermostToolStatusText,
  createMattermostDraftPreviewBoundaryController,
  createMattermostDraftStream,
  summarizeMattermostToolArgs,
} from "./draft-stream.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

function createMockClient(): {
  client: MattermostClient;
  calls: RequestRecord[];
  requestMock: ReturnType<typeof vi.fn>;
} {
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  };
  const requestMock = vi.fn(requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  return { client, calls, requestMock };
}

describe("createMattermostDraftStream", () => {
  it("creates a preview post and updates it on later changes", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Running `read`…");
    await stream.flush();
    stream.update("Running `read`…");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");

    const createBody = JSON.parse((calls[0]?.init?.body as string | undefined) ?? "{}");
    expect(createBody).toMatchObject({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "Running `read`…",
    });
    expect(stream.postId()).toBe("post-1");
  });

  it("does not resend identical updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Working...");
    await stream.flush();

    expect(calls).toHaveLength(1);
  });

  it("clears the preview post when no final reply is delivered", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.clear();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(calls[1]?.init?.method).toBe("DELETE");
    expect(stream.postId()).toBeUndefined();
  });

  it("discardPending keeps the preview post but ignores later updates", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    await stream.discardPending();
    stream.update("Late update");
    await stream.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("seal keeps the preview post and cancels pending final overwrites", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 0,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale final draft");
    await stream.seal();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/posts");
    expect(stream.postId()).toBe("post-1");
  });

  it("stop flushes the last pending update and ignores later ones", async () => {
    const { client, calls } = createMockClient();
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      rootId: "root-1",
      throttleMs: 1000,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale partial");
    await stream.stop();
    stream.update("Late partial");
    await stream.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(JSON.parse((calls[1]?.init?.body as string | undefined) ?? "{}")).toMatchObject({
      message: "Stale partial",
    });
  });

  it("warns and stops when preview creation fails", async () => {
    const warn = vi.fn();
    const requestImpl: MattermostClient["request"] = async () => {
      throw new Error("boom");
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 0,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Still working...");
    await stream.flush();

    expect(warn).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(stream.postId()).toBeUndefined();
  });

  it("does not resend after an update failure followed by stop", async () => {
    const warn = vi.fn();
    const calls: RequestRecord[] = [];
    let failNextPatch = true;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push({ path, init });
      if (path === "/posts") {
        return { id: "post-1" } as T;
      }
      if (path === "/posts/post-1") {
        if (failNextPatch) {
          failNextPatch = false;
          throw new Error("patch failed");
        }
        return { id: "patched" } as T;
      }
      return {} as T;
    };
    const requestMock = vi.fn(requestImpl);
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "token",
      request: requestMock as MattermostClient["request"],
      fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
    };
    const stream = createMattermostDraftStream({
      client,
      channelId: "channel-1",
      throttleMs: 1000,
      warn,
    });

    stream.update("Working...");
    await stream.flush();
    stream.update("Will fail");
    await stream.flush();
    await stream.stop();

    expect(warn).toHaveBeenCalledWith("mattermost stream preview failed: patch failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe("/posts");
    expect(calls[1]?.path).toBe("/posts/post-1");
  });
});

describe("buildMattermostToolStatusText", () => {
  it("renders a bare status with the tool name when no args are given", () => {
    expect(buildMattermostToolStatusText({ name: "read" })).toBe("Running `read`…");
  });

  it("falls back to a generic running tool status when no name is given", () => {
    expect(buildMattermostToolStatusText({})).toBe("Running tool…");
  });

  it("renders the exec command in a bash-tagged code block", () => {
    expect(
      buildMattermostToolStatusText({
        name: "exec",
        args: { command: "ls -la /tmp" },
      }),
    ).toBe("Running `exec`\n```bash\nls -la /tmp\n```");
  });

  it("renders the read path in an untagged code block", () => {
    expect(
      buildMattermostToolStatusText({
        name: "read",
        args: { path: "/etc/hosts" },
      }),
    ).toBe("Running `read`\n```\n/etc/hosts\n```");
  });

  it("renders single non-canonical args as key=value in a code block", () => {
    expect(
      buildMattermostToolStatusText({
        name: "web_search",
        args: { query: "openclaw streaming bug" },
      }),
    ).toBe("Running `web_search`\n```\nquery=openclaw streaming bug\n```");
  });

  it("renders multi-arg payloads as one key=value per line", () => {
    expect(
      buildMattermostToolStatusText({
        name: "edit",
        args: { path: "/tmp/x", oldText: "a", newText: "b" },
      }),
    ).toBe("Running `edit`\n```\npath=/tmp/x\noldText=a\nnewText=b\n```");
  });

  it("preserves multi-line shell commands inside the code block", () => {
    const status = buildMattermostToolStatusText({
      name: "exec",
      args: {
        command: "python3 -c \"import json\nprint('hi')\"\necho done",
      },
    });
    expect(status).toContain("```bash");
    expect(status).toContain('python3 -c "import json');
    expect(status).toContain("echo done");
    expect(status).toContain("```");
  });
});

describe("summarizeMattermostToolArgs", () => {
  it("returns undefined for missing or empty args", () => {
    expect(summarizeMattermostToolArgs(undefined)).toBeUndefined();
    expect(summarizeMattermostToolArgs({})).toBeUndefined();
    expect(summarizeMattermostToolArgs({ ignored: undefined })).toBeUndefined();
  });

  it("unwraps a single canonical key", () => {
    expect(summarizeMattermostToolArgs({ command: "ls" })).toBe("ls");
    expect(summarizeMattermostToolArgs({ path: "/x" })).toBe("/x");
    expect(summarizeMattermostToolArgs({ input: "hi" })).toBe("hi");
    expect(summarizeMattermostToolArgs({ text: "abc" })).toBe("abc");
  });

  it("prefixes other single keys with key=", () => {
    expect(summarizeMattermostToolArgs({ url: "https://example.com" })).toBe(
      "url=https://example.com",
    );
  });

  it("serializes object/array values as pretty-printed JSON", () => {
    expect(summarizeMattermostToolArgs({ args: { a: 1, b: ["x", "y"] } })).toBe(
      `args=${JSON.stringify({ a: 1, b: ["x", "y"] }, null, 2)}`,
    );
  });

  it("preserves newlines inside command args so multi-line shells render verbatim", () => {
    expect(summarizeMattermostToolArgs({ command: "echo one\necho two" })).toBe(
      "echo one\necho two",
    );
  });

  it("trims leading/trailing whitespace without collapsing internal newlines", () => {
    expect(summarizeMattermostToolArgs({ command: "  ls\n\n  " })).toBe("ls");
  });

  it("truncates with an ellipsis once the limit is exceeded", () => {
    const summary = summarizeMattermostToolArgs({ command: "x".repeat(500) }, { maxChars: 50 });
    expect(summary?.length).toBe(50);
    expect(summary?.endsWith("…")).toBe(true);
  });
});

describe("createMattermostDraftPreviewBoundaryController", () => {
  function createDraftStreamStub() {
    return {
      forceNewMessage: vi.fn(),
    };
  }

  it("is a no-op when splitAtBoundaries is false", () => {
    const draftStream = createDraftStreamStub();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: false,
    });

    controller.markStreamedContent();
    expect(controller.signalBoundary()).toBe(false);
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("does not split when no streamed content has been marked", () => {
    const draftStream = createDraftStreamStub();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
    });

    expect(controller.signalBoundary()).toBe(false);
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("splits at boundary when streamed content has been marked", () => {
    const draftStream = createDraftStreamStub();
    const onSplit = vi.fn();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
      onSplit,
    });

    controller.markStreamedContent();
    expect(controller.signalBoundary()).toBe(true);
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it("does not split twice in a row without new content", () => {
    const draftStream = createDraftStreamStub();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
    });

    controller.markStreamedContent();
    expect(controller.signalBoundary()).toBe(true);
    expect(controller.signalBoundary()).toBe(false);
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("splits again after fresh content is marked", () => {
    const draftStream = createDraftStreamStub();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
    });

    controller.markStreamedContent();
    expect(controller.signalBoundary()).toBe(true);

    controller.markStreamedContent();
    expect(controller.signalBoundary()).toBe(true);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(2);
  });

  it("reports whether it is splitting at boundaries", () => {
    const draftStream = createDraftStreamStub();
    const splitting = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
    });
    const nonSplitting = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: false,
    });

    expect(splitting.isSplittingAtBoundaries()).toBe(true);
    expect(nonSplitting.isSplittingAtBoundaries()).toBe(false);
  });

  it("models a thinking → tool → partial reply → final turn without overwrites", () => {
    const draftStream = createDraftStreamStub();
    const controller = createMattermostDraftPreviewBoundaryController({
      draftStream,
      splitAtBoundaries: true,
    });

    // Phase 1: "Thinking…" appears in the preview post.
    controller.markStreamedContent();

    // Phase 2: tool starts → boundary BEFORE the new tool status update.
    expect(controller.signalBoundary()).toBe(true);
    // Tool status is now in a fresh post.
    controller.markStreamedContent();

    // Phase 3: assistant message starts → boundary BEFORE partial reply.
    expect(controller.signalBoundary()).toBe(true);
    controller.markStreamedContent();

    // Three distinct posts created (one initial, two splits) for the
    // three phases. Only the two boundaries call forceNewMessage().
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(2);
  });
});
