import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildContractReplyPayloads } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDefaultLocalRoots } from "openclaw/plugin-sdk/web-media";
import { expect, it, vi } from "vitest";
import type { CodexCommandExecParams } from "./command-exec-protocol.js";
import { createCodexGeneratedMediaTool } from "./generated-media-tool.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

const execFileAsync = promisify(execFile);

it.each(["partial", "async", "denied", "cancel"] as const)(
  "delivers remote reply media without reading stale Gateway files: %s",
  async (scenario) => {
    const workspaceDir = path.join(tempDir, "gateway-workspace");
    const remoteWorkspaceRoot = path.join(tempDir, "codex-workspace");
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(remoteWorkspaceRoot, { recursive: true }),
    ]);
    const artifactName = "project-artifact.txt";
    const remoteContents = "authoritative Codex project artifact\n";
    await Promise.all([
      fs.writeFile(path.join(workspaceDir, artifactName), "stale Gateway project artifact\n"),
      fs.writeFile(path.join(remoteWorkspaceRoot, artifactName), remoteContents),
    ]);
    const params = createParams(path.join(tempDir, "final-media.jsonl"), workspaceDir);
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "final-media.sqlite"),
      "final-media",
    );
    if (scenario === "denied") {
      params.config = { tools: { toolsBySender: { "*": { deny: ["read"] } } } };
    }
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const onBlockReply = vi.fn<NonNullable<typeof params.onBlockReply>>();
    params.onBlockReply = onBlockReply;
    await bindProductionHarnessHostCapabilitiesForTest(params);
    let remoteReads = 0;
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1", { cwd: remoteWorkspaceRoot });
      }
      if (method === "command/exec") {
        // The only synthetic boundary is the remote transport: execute the native
        // bounded reader against a separate workspace with different file bytes.
        remoteReads += 1;
        const request = requestParams as CodexCommandExecParams;
        expect(request.command[0]).toBe("node");
        const result = await execFileAsync(process.execPath, request.command.slice(1), {
          maxBuffer: request.outputBytesCap ?? 1024 * 1024,
          timeout: request.timeoutMs ?? 5_000,
        });
        if (scenario === "cancel") {
          abort.abort(new Error("Cancelled while retrieving reply media"));
        }
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { transport: "stdio", remoteWorkspaceRoot } },
    });
    await harness.waitForMethod("turn/start");
    const sourcePath =
      scenario === "partial" ? `${remoteWorkspaceRoot}/./${artifactName}` : `./${artifactName}`;
    const sourceText = `Artifact ready\n${scenario === "partial" ? "MEDIA:./missing-artifact.txt\n" : ""}MEDIA:${sourcePath}`;
    const item = {
      id: "final-artifact",
      type: "agentMessage",
      phase: "final_answer",
      text: sourceText,
      ...(scenario === "async" ? { delivery: "async" } : {}),
    };
    await harness.notify(itemNotification("item/started", { ...item, text: "" }));
    await harness.notify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: item.id, delta: sourceText },
    });
    await harness.notify(itemNotification("item/completed", item));
    if (scenario === "async") {
      await harness.notify(
        itemNotification("item/completed", {
          id: "terminal-answer",
          type: "agentMessage",
          phase: "final_answer",
          text: "Finished.",
        }),
      );
    }
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    const remoteReadsAfterRun = remoteReads;
    if (scenario === "cancel") {
      expect(result.terminal).toMatchObject({ kind: "aborted" });
      expect(result.toolMetas).toEqual([]);
      return;
    }
    expect(result.terminal).toMatchObject({ kind: "ok" });

    const sourceContent = [{ type: "text", text: sourceText }];
    expect(result.messagesSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: sourceContent }),
      ]),
    );
    const transcriptTarget = params.sessionTarget;
    if (!transcriptTarget?.sessionId || !transcriptTarget.sessionKey) {
      throw new Error("expected the fixture's persisted session identity");
    }
    const savedAssistants = (
      await readSessionTranscriptEvents({
        ...transcriptTarget,
        sessionId: transcriptTarget.sessionId,
        sessionKey: transcriptTarget.sessionKey,
      })
    ).flatMap((event) => {
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      return message?.role === "assistant" ? [message] : [];
    });
    expect(savedAssistants).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: sourceContent })]),
    );

    const finalPayloads = buildContractReplyPayloads({
      attempt: result,
      runParams: {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir,
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
        config: params.config,
        provider: params.provider,
        model: params.modelId,
      },
    });
    expect(remoteReads).toBe(remoteReadsAfterRun);
    const payloads =
      scenario === "async" ? onBlockReply.mock.calls.map(([payload]) => payload) : finalPayloads;
    const mediaUrls = payloads.flatMap(
      (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
    );
    if (scenario === "denied") {
      expect(mediaUrls).toEqual([]);
      expect(payloads.map((payload) => payload.text).join("\n")).toContain(artifactName);
      expect(remoteReads).toBe(0);
      return;
    }
    if (scenario === "async") {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply.mock.calls[0]?.[1]?.deliveryIntentId).toBe(
        "block-reply:v1:codex-app-server:thread-1:turn-1:final-artifact",
      );
      expect(finalPayloads.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([]);
    }
    expect(mediaUrls).toHaveLength(1);
    if (scenario === "partial") {
      expect(
        payloads.flatMap((payload) =>
          collectReplyMediaEntries(payload, resolveSendableOutboundReplyParts(payload).mediaUrls),
        ),
      ).toEqual([
        {
          url: mediaUrls[0],
          attachment: { name: artifactName, mimeType: "text/plain", trustedLocalMedia: true },
          sourceUrls: [sourcePath],
        },
      ]);
      expect(payloads.map((payload) => payload.text).join("\n")).toContain("missing-artifact.txt");
    }
    const delivered = await loadOutboundMediaFromUrl(mediaUrls[0]!, {
      workspaceDir,
      mediaLocalRoots: [workspaceDir, ...getDefaultLocalRoots()],
      maxBytes: 1024,
    });
    expect(delivered.buffer.toString()).toBe(remoteContents);
  },
);

it("discards an image candidate through the turn's dynamic tool before final delivery", async () => {
  const params = createParams(
    path.join(tempDir, "discard-media.jsonl"),
    path.join(tempDir, "workspace"),
  );
  setCodexTestModelSupportsTools(params, true);
  params.runtimePlan = createCodexRuntimePlanFixture();
  let retainedTool: ReturnType<typeof createCodexGeneratedMediaTool>;
  setCodexTestToolFactory(params, (options) => {
    retainedTool = createCodexGeneratedMediaTool({
      toolBindings: options?.toolBindings,
      assertInvocationCurrent: () => params.hostCapabilities.assertActive(),
    });
    return retainedTool ? [retainedTool] : [];
  });
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  await harness.waitForMethod("turn/start");
  const callTool = (callId: string, args: JsonObject) =>
    harness.handleServerRequest({
      id: callId,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId,
        namespace: null,
        tool: "generated_media",
        arguments: args,
      },
    });
  for (const [id, bytes] of [
    ["ig_a", "draft candidate"],
    ["ig_b", "chosen candidate"],
  ] as const) {
    await harness.notify(
      itemNotification("item/completed", {
        type: "imageGeneration",
        id,
        status: "completed",
        result: Buffer.from(bytes).toString("base64"),
        savedPath: `/tmp/codex-home/generated_images/session-1/${id}.png`,
      }),
    );
  }
  const listed = await callTool("list-call", {
    action: "list",
  });
  assert(isJsonObject(listed) && Array.isArray(listed.contentItems));
  expect(listed.success).toBe(true);
  const content = listed.contentItems[0];
  assert(isJsonObject(content) && typeof content.text === "string");
  const inventory: unknown = JSON.parse(content.text);
  assert(isJsonObject(inventory) && Array.isArray(inventory.images));
  expect(inventory.images).toMatchObject([
    { itemId: "ig_a", discarded: false },
    { itemId: "ig_b", discarded: false },
  ]);
  const draft = inventory.images[0];
  assert(
    isJsonObject(draft) && typeof draft.itemId === "string" && typeof draft.mediaUrl === "string",
  );
  expect(
    await callTool("discard-call", {
      action: "discard",
      itemIds: [draft.itemId],
    }),
  ).toMatchObject({ success: true });
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  const result = await run;
  expect(result.hostOwnedToolMediaUrls).toEqual(result.toolMediaUrls);
  expect(result.toolMediaUrls).toHaveLength(1);
  await expect(fs.readFile(result.toolMediaUrls?.[0] ?? "")).resolves.toEqual(
    Buffer.from("chosen candidate"),
  );
  await expect(fs.readFile(draft.mediaUrl)).resolves.toEqual(Buffer.from("draft candidate"));
  expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  assert(retainedTool);
  await expect(retainedTool.execute("stale-call", { action: "list" })).rejects.toThrow(
    "Generated media is unavailable outside the active Codex turn.",
  );
});
