import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClaudeUpstreamActivity, linkContinued } from "./session-upstream-activity.js";

const CLAUDE_UPSTREAM_SCAN_BYTES = 1024 * 1024;
const claudeUpstreamWorkspaceRoot = resolvePreferredOpenClawTmpDir();

function createClaudeUpstreamWorkspace(label?: string) {
  return tempWorkspace({
    rootDir: claudeUpstreamWorkspaceRoot,
    prefix: `openclaw-claude-upstream-${label ? `${label}-` : ""}`,
  });
}

function localProbe(
  filePath: string,
  marker: SessionUpstreamProbe["marker"],
  sessionKey = "agent:main:adopted:claude",
  threadId = path.basename(filePath, ".jsonl"),
): SessionUpstreamProbe {
  return {
    sessionKey,
    threadId,
    agentId: "main",
    hostId: "gateway:local",
    upstreamKind: "claude-cli",
    upstreamRef: { filePath },
    marker,
    ownRecentUserTexts: [],
  };
}

async function checkActivity(probe: SessionUpstreamProbe) {
  return (await checkClaudeUpstreamActivity([probe]))[0];
}

function continueLink(overrides: Partial<Parameters<typeof linkContinued>[0]>) {
  return linkContinued({
    sessionKey: "agent:main:adopted",
    hostId: "node:devbox",
    threadId: "thread-1",
    listLocalSessions: async () => [],
    readRemote: async () => [],
    ...overrides,
  });
}

function row(type: "user" | "assistant", content: unknown, timestamp: string) {
  return JSON.stringify({ type, timestamp, message: { role: type, content } }) + "\n";
}

async function injectFileShortReads(filePath: string, maxBytes: number): Promise<void> {
  const handle = await fs.open(filePath, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const realRead = Object.getOwnPropertyDescriptor(prototype, "read")?.value;
  await handle.close();
  if (typeof realRead !== "function") {
    throw new Error("FileHandle.read is unavailable");
  }
  vi.spyOn(prototype, "read").mockImplementation(function (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) {
    return Reflect.apply(realRead, this, [buffer, offset, Math.min(length, maxBytes), position]);
  } as FileHandle["read"]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Claude upstream activity", () => {
  it("stats without reading when the file did not grow", async () => {
    await using workspace = await createClaudeUpstreamWorkspace("static");
    const filePath = path.join(workspace.dir, "thread-2.jsonl");
    await fs.writeFile(filePath, "{}\n");
    await expect(checkActivity(localProbe(filePath, { size: 3 }))).resolves.toBeUndefined();
  });

  it("completes bounded scan windows across positional short reads", async () => {
    await using workspace = await createClaudeUpstreamWorkspace("short-read");
    const filePath = path.join(workspace.dir, "thread-short-read.jsonl");
    await fs.writeFile(filePath, row("user", "short-read prompt", "2026-07-13T10:05:00.000Z"));
    await injectFileShortReads(filePath, 17);
    const completeSize = (await fs.stat(filePath)).size;

    await expect(checkActivity(localProbe(filePath, { offset: 0 }))).resolves.toEqual(
      expect.objectContaining({
        kind: "activity",
        humanTurns: 1,
        nextMarker: { offset: completeSize },
      }),
    );

    await fs.appendFile(filePath, '{"type":"user"');
    await expect(
      checkActivity(localProbe(filePath, { offset: completeSize })),
    ).resolves.toBeUndefined();
  });

  it("swallows non-missing local transcript errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(error);

    await expect(
      checkActivity(localProbe("/unreadable/thread.jsonl", { offset: 3 })),
    ).resolves.toBeUndefined();
  });

  it("isolates a missing transcript from healthy probes", async () => {
    await using workspace = await createClaudeUpstreamWorkspace("batch");
    const filePath = path.join(workspace.dir, "thread-good.jsonl");
    await fs.writeFile(filePath, row("user", "new prompt", "2026-07-13T10:06:00.000Z"));
    const baseProbe: SessionUpstreamProbe = localProbe(filePath, { size: 0 }, "healthy");

    await expect(
      checkClaudeUpstreamActivity([
        { ...baseProbe, sessionKey: "stale", upstreamRef: { filePath: `${filePath}.missing` } },
        baseProbe,
      ]),
    ).resolves.toEqual([
      { kind: "missing", sessionKey: "stale" },
      expect.objectContaining({ kind: "activity", sessionKey: "healthy", humanTurns: 1 }),
    ]);
  });

  it("keeps continuation successful when baseline enumeration fails", async () => {
    await expect(
      continueLink({
        sessionKey: "session-key",
        hostId: "gateway:local",
        listLocalSessions: async () => {
          throw new Error("catalog unavailable");
        },
      }),
    ).resolves.toEqual({ sessionKey: "session-key" });
  });

  it("classifies bounded paired-node transcript pages past the UUID marker", async () => {
    const remoteProbe: SessionUpstreamProbe = {
      sessionKey: "remote",
      agentId: "main",
      threadId: "thread-remote",
      hostId: "node:node-a",
      upstreamKind: "claude-cli",
      upstreamRef: { nodeId: "node-a", threadId: "thread-remote" },
      marker: { uuid: "item-1" },
      ownRecentUserTexts: [],
    };

    await expect(
      checkClaudeUpstreamActivity([remoteProbe], async () => [
        { type: "agentMessage", text: "reply", uuid: "item-3" },
        {
          type: "userMessage",
          content: "native prompt",
          timestamp: "2026-07-13T10:07:00.000Z",
          uuid: "item-2",
        },
        { type: "userMessage", text: "old", uuid: "item-1" },
      ]),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "remote",
        occurredAt: Date.parse("2026-07-13T10:07:00.000Z"),
        humanTurns: 1,
        nextMarker: { uuid: "item-3" },
        dedupeId: "item-3",
      },
    ]);
  });

  it("scans forward across bounded ticks without skipping a middle user row", async () => {
    await using workspace = await createClaudeUpstreamWorkspace("chunks");
    const filePath = path.join(workspace.dir, "thread-chunks.jsonl");
    const firstRow = row(
      "assistant",
      "x".repeat(CLAUDE_UPSTREAM_SCAN_BYTES - 200),
      "2026-07-13T10:08:00.000Z",
    );
    const userRow = row("user", "middle prompt", "2026-07-13T10:09:00.000Z");
    const finalRow = row("assistant", "y".repeat(512 * 1024), "2026-07-13T10:10:00.000Z");
    await fs.writeFile(filePath, firstRow + userRow + finalRow);
    const baseProbe: SessionUpstreamProbe = localProbe(filePath, { offset: 0 });

    const first = await checkActivity(baseProbe);
    expect(first).toEqual({
      kind: "activity",
      sessionKey: baseProbe.sessionKey,
      humanTurns: 0,
      nextMarker: { offset: Buffer.byteLength(firstRow) },
    });
    if (first?.kind !== "activity") {
      throw new Error("expected activity marker");
    }
    await expect(checkActivity({ ...baseProbe, marker: first.nextMarker })).resolves.toEqual(
      expect.objectContaining({
        kind: "activity",
        humanTurns: 1,
        nextMarker: { offset: Buffer.byteLength(firstRow + userRow + finalRow) },
      }),
    );
  });

  it("declines a remote link when the newest history item lacks a UUID", async () => {
    const declined = await continueLink({
      readRemote: async () => [{ type: "userMessage", text: "hi" }] as never,
    });
    // UUID-less newest item cannot baseline safely; no upstream link is seeded.
    expect(declined).toEqual({ sessionKey: "agent:main:adopted" });

    const linked = await continueLink({
      readRemote: async () => [{ type: "userMessage", text: "hi", uuid: "u-9" }] as never,
    });
    expect(linked.upstream?.marker).toEqual({ uuid: "u-9" });
  });
});
