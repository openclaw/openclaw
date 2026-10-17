import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildContractReplyPayloads } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { getDefaultLocalRoots } from "openclaw/plugin-sdk/web-media";
import { expect, it, vi } from "vitest";
import type { CodexCommandExecParams } from "./command-exec-protocol.js";
import { agentMessage } from "./native-subagent-monitor.test-support.js";
import { itemNotification } from "./protocol.test-helpers.js";
import * as test from "./run-attempt-test-harness.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";

test.setupRunAttemptTestHooks();

const execFileAsync = promisify(execFile);
const artifactName = "project-artifact.txt";

async function writeArtifact(dir: string, contents: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, artifactName), contents);
}

it.each(["partial", "async", "denied", "cancel"] as const)(
  "delivers remote reply media without reading stale Gateway files: %s",
  async (scenario) => {
    const workspaceDir = path.join(test.tempDir, "gateway-workspace");
    const remoteWorkspaceRoot = path.join(test.tempDir, "codex-workspace");
    const remoteContents = "authoritative Codex project artifact\n";
    await Promise.all([
      writeArtifact(workspaceDir, "stale Gateway project artifact\n"),
      writeArtifact(remoteWorkspaceRoot, remoteContents),
    ]);
    const params = test.createParams(path.join(test.tempDir, "final-media.jsonl"), workspaceDir);
    await attachSqliteSessionTarget(
      params,
      path.join(test.tempDir, "final-media.sqlite"),
      "final-media",
    );
    if (scenario === "denied") {
      params.config = { tools: { toolsBySender: { "*": { deny: ["read"] } } } };
    }
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const onBlockReply = vi.fn<NonNullable<typeof params.onBlockReply>>();
    params.onBlockReply = onBlockReply;
    await test.bindProductionHarnessHostCapabilitiesForTest(params);
    let remoteReads = 0;
    const harness = test.createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/start") {
        return test.threadStartResult("thread-1", { cwd: remoteWorkspaceRoot });
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
    const run = test.runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { transport: "stdio", remoteWorkspaceRoot } },
    });
    await harness.waitForMethod("turn/start");
    const sourcePath =
      scenario === "partial" ? `${remoteWorkspaceRoot}/./${artifactName}` : `./${artifactName}`;
    const sourceText = `Artifact ready\n${scenario === "partial" ? "MEDIA:./missing-artifact.txt\n" : ""}MEDIA:${sourcePath}`;
    const item = {
      ...agentMessage("final-artifact", sourceText, "final_answer"),
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
        itemNotification(
          "item/completed",
          agentMessage("terminal-answer", "Finished.", "final_answer"),
        ),
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
    const assistant = expect.objectContaining({ role: "assistant", content: sourceContent });
    expect(result.messagesSnapshot).toContainEqual(assistant);
    expect(await readTranscriptMessagesByIdentity(params)).toContainEqual(assistant);

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
    const replyText = payloads.map((payload) => payload.text).join("\n");
    if (scenario === "denied") {
      expect(mediaUrls).toEqual([]);
      expect(replyText).toContain(artifactName);
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
      expect(replyText).toContain("missing-artifact.txt");
    }
    const delivered = await loadOutboundMediaFromUrl(mediaUrls[0]!, {
      workspaceDir,
      mediaLocalRoots: [workspaceDir, ...getDefaultLocalRoots()],
      maxBytes: 1024,
    });
    expect(delivered.buffer.toString()).toBe(remoteContents);
  },
);
