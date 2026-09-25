import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  createMockPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexDynamicToolCallResponse, JsonValue } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const requireRecord = createRequireRecord("object", "expected-label");

function textToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function deliveredMessageDetails(primaryPlatformMessageId: string) {
  return {
    messageDelivery: {
      status: "settled",
      partialDelivery: false,
      createdThreadIds: [],
      primaryPlatformMessageId,
    },
  };
}

function createMessageBridge(
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  const execute = vi.fn(async (_callId: string, _args: unknown) => toolResult);
  const tool: AnyAgentTool = {
    name: "message",
    label: "message",
    description: "Send a message attachment.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute,
  };
  const bridge = createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    hookContext,
  });
  return { bridge, execute };
}

function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  args: JsonValue,
) {
  return bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: "message",
    arguments: args,
  });
}

function expectInputText(response: CodexDynamicToolCallResponse, text: string) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text }],
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex dynamic tool media delivery", () => {
  it.each(["unchanged", "reclassified"] as const)(
    "records outbound media with a %s result sink",
    async (sink) => {
      if (sink === "reclassified") {
        const registry = createEmptyPluginRegistry();
        const handler = async (event: { result: AgentToolResult<unknown> }) => {
          const details = requireRecord(event.result.details, "outbound delivery details");
          details.sourceReplySink = "internal-ui";
          details.sourceReply = {
            text: "fabricated source reply",
            mediaUrls: ["/tmp/generated-song.mp3"],
          };
        };
        registry.agentToolResultMiddlewares.push({
          pluginId: "sink-rewriter",
          pluginName: "Sink rewriter",
          rawHandler: handler,
          handler,
          runtimes: ["codex"],
          source: "test",
        });
        setActivePluginRegistry(registry);
      }
      const { bridge } = createMessageBridge(
        textToolResult("Sent.", deliveredMessageDetails("message-1")),
      );

      const result = await handleMessageToolCall(bridge, {
        action: "send",
        text: "song attached",
        media: "/tmp/generated-song.mp3",
        attachments: [{ filePath: "/tmp/generated-cover.png" }],
      });

      expectInputText(result, "Sent.");
      expect(bridge.telemetry.didSendViaMessagingTool).toBe(true);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([
        "/tmp/generated-song.mp3",
        "/tmp/generated-cover.png",
      ]);
      expect(bridge.telemetry.messagingToolSentTargets).toEqual([
        {
          tool: "message",
          provider: "message",
          to: undefined,
          threadId: undefined,
          text: "song attached",
          mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
        },
      ]);
      expect(bridge.telemetry.messagingToolSourceReplyPayloads).toEqual([]);
      expect(bridge.telemetry.confirmedMediaDeliveries).toEqual([
        {
          kind: "outbound",
          target: bridge.telemetry.messagingToolSentTargets[0],
          sourceUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
        },
      ]);
    },
  );

  it.each([
    {
      name: "a failed send",
      dryRun: false,
      details: { status: "error", error: "attachment delivery failed" },
    },
    {
      name: "a dry-run argument",
      dryRun: true,
      details: {
        messageDelivery: { status: "dryRun", partialDelivery: false, createdThreadIds: [] },
      },
    },
    {
      name: "a dry-run receipt",
      dryRun: false,
      details: {
        dryRun: true,
        deliveryStatus: "dry_run",
        messageDelivery: { status: "dryRun", partialDelivery: false, createdThreadIds: [] },
      },
    },
    {
      name: "a partial receipt without attachment confirmation",
      dryRun: false,
      details: {
        deliveryStatus: "partial_failed",
        sentBeforeError: true,
        messageDelivery: {
          status: "settled",
          partialDelivery: true,
          createdThreadIds: [],
          primaryPlatformMessageId: "partially-delivered-message",
        },
      },
    },
  ])("does not claim requested media was delivered from $name", async ({ dryRun, details }) => {
    const { bridge } = createMessageBridge(textToolResult("Delivery result.", details));

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      channel: "slack",
      to: "channel:C123",
      text: "two attachments requested",
      mediaUrl: "/tmp/requested-cover.png",
      attachments: [{ filePath: "/tmp/requested-song.mp3" }],
      ...(dryRun ? { dryRun: true } : {}),
    });

    expect(result.executionStarted).toBe(true);
    expect(bridge.telemetry.messagingToolSentMediaUrls).toEqual([]);
    expect(
      bridge.telemetry.messagingToolSentTargets.flatMap((target) => target.mediaUrls ?? []),
    ).toEqual([]);
  });

  it.each([
    { name: "the staged remote file", replaceUpload: false },
    { name: "the hook-selected file", replaceUpload: true },
  ])("records $name after remote Slack upload preparation", async ({ replaceUpload }) => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "codex-remote-slack-upload-",
    });
    const workspaceDir = tempDirs.make("codex-remote-upload-");
    try {
      const relativePath = "reports/slack-upload.txt";
      const localPath = path.join(workspaceDir, relativePath);
      const remoteContent = "authoritative remote Slack attachment\n";
      await mkdir(path.dirname(localPath), { recursive: true });
      await writeFile(localPath, remoteContent);

      const remotePath = `/remote/codex-workspace/${relativePath}`;
      const hookSelectedPath = path.join(workspaceDir, "hook-selected-upload.txt");
      if (replaceUpload) {
        await writeFile(hookSelectedPath, "hook-selected attachment\n");
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              handler: vi.fn(async () => ({ params: { filePath: hookSelectedPath } })),
            },
          ]),
        );
      }
      const readRemoteWorkspaceFile = vi.fn<CodexRemoteWorkspaceFileReader>(async () => ({
        dataBase64: Buffer.from(remoteContent).toString("base64"),
      }));
      const { bridge, execute } = createMessageBridge(
        textToolResult("Uploaded.", deliveredMessageDetails("message-1")),
        {
          workspaceDir,
          remoteWorkspaceRoot: "/remote/codex-workspace",
          remoteWorkspaceRequestTimeoutMs: 90_000,
        },
      );
      bridge.setRemoteWorkspaceFileReader?.(readRemoteWorkspaceFile);

      const result = await handleMessageToolCall(bridge, {
        action: "upload-file",
        channel: "slack",
        to: "channel:C123",
        filePath: remotePath,
      });

      expectInputText(result, "Uploaded.");
      const executedArgs = requireRecord(execute.mock.calls[0]?.[1], "upload args");
      const deliveredPath = executedArgs.filePath;
      expect(execute).toHaveBeenCalledWith(
        "call-1",
        {
          action: "upload-file",
          channel: "slack",
          to: "channel:C123",
          filePath: deliveredPath,
        },
        expect.any(AbortSignal),
        undefined,
      );
      expect(result.executedArguments).toEqual(executedArgs);
      expect(bridge.telemetry.messagingToolSentMediaUrls).toContain(deliveredPath);
      expect(bridge.telemetry.messagingToolSentTargets).toEqual([
        expect.objectContaining({
          provider: "slack",
          to: "channel:C123",
          mediaUrls: expect.arrayContaining([deliveredPath]),
        }),
      ]);
      expect(readRemoteWorkspaceFile).toHaveBeenCalledWith({
        path: remotePath,
        maxBytes: 64 * 1024 * 1024,
        workspaceRoot: "/remote/codex-workspace",
        signal: expect.any(AbortSignal),
        timeoutMs: expect.any(Number),
      });
      expect(readRemoteWorkspaceFile.mock.calls[0]?.[0].timeoutMs).toBeGreaterThan(0);
      expect(readRemoteWorkspaceFile.mock.calls[0]?.[0].timeoutMs).toBeLessThanOrEqual(90_000);
      if (replaceUpload) {
        expect(deliveredPath).toBe(hookSelectedPath);
        expect(bridge.telemetry.messagingToolSentMediaUrls).not.toContain(remotePath);
        expect(bridge.telemetry.messagingToolSentMediaUrls).not.toContain(localPath);
        expect(
          bridge.telemetry.messagingToolSentTargets.flatMap((target) => target.mediaUrls ?? []),
        ).not.toContain(remotePath);
        await expect(readFile(String(deliveredPath), "utf8")).resolves.toBe(
          "hook-selected attachment\n",
        );
      } else {
        expect(deliveredPath).not.toBe(localPath);
        expect(deliveredPath).toEqual(
          expect.stringContaining(`${path.sep}media${path.sep}outbound${path.sep}`),
        );
        await expect(readFile(String(deliveredPath), "utf8")).resolves.toBe(remoteContent);
      }
      await expect(readFile(localPath, "utf8")).resolves.toBe(remoteContent);
    } finally {
      await openClawState.cleanup();
    }
  });
});
