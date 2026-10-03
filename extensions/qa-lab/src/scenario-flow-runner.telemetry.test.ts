import { statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { projectQaToolActivity } from "./tool-activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const reply = [
  "Pending: maintainer feedback before publishing",
  "Blocked: publishing needs explicit user approval",
  "Done: local evidence captured in personal-task-status.txt",
].join("\n");
const artifact = `Personal task followthrough\n${reply}`;
const paths = {
  ledger: "PERSONAL_TASK_LEDGER.md",
  note: "FOLLOWTHROUGH_NOTE.md",
  artifact: "personal-task-status.txt",
};
type Fault =
  | "missing-read"
  | "missing-write"
  | "reordered"
  | "unmatched"
  | "failed"
  | "fake"
  | "parallel"
  | "tied-parallel"
  | "early-result"
  | "early-artifact"
  | "overclaim"
  | "repeat-write";

async function runTaskEvidence(codeMode: boolean, fault?: Fault, tiedSerial = false) {
  const workspaceDir = tempDirs.make("qa-task-evidence-");
  let messages: unknown[] = [];
  return await runLoadedScenarioFlow("telemetry-task-evidence-followthrough", {
    api: {
      fs,
      path,
      buildAgentSessionKey,
      normalizeLowercaseStringOrEmpty,
      env: { providerMode: "mock-openai", cfg: {}, gateway: { workspaceDir } },
      readSessionTranscriptSummary: async () => ({ eventCursor: 0 }),
      readSessionToolActivity: async () => projectQaToolActivity(messages),
    },
    onWaitForOutboundMessage: ({ state }) => {
      const inbound = state
        .getSnapshot()
        .messages.find((message) => message.direction === "inbound");
      if (!inbound) {
        throw new Error("missing fixture inbound");
      }
      const artifactPath = path.join(workspaceDir, paths.artifact);
      writeFileSync(artifactPath, artifact);
      const terminalAt = Math.ceil(statSync(artifactPath).mtimeMs) + 100;
      const order = fault === "reordered" ? [1, 0, 2] : [0, 1, 2];
      if (fault === "repeat-write") {
        order.push(2);
      }
      if (codeMode && !fault) {
        order.push(3);
      }
      messages = [];
      const deferredResults: unknown[] = [];
      for (const [index, operation] of order.entries()) {
        if (
          (fault === "missing-read" && operation === 1) ||
          (fault === "missing-write" && operation === 2)
        ) {
          continue;
        }
        const toolName = operation === 2 ? "write" : "read";
        const file = operation === 0 ? paths.ledger : operation === 1 ? paths.note : paths.artifact;
        const input = { path: path.join(workspaceDir, file) };
        const toolCallId = `task-${index}`;
        const startedAt =
          fault === "tied-parallel" || tiedSerial ? terminalAt - 50 : terminalAt - 70 + index * 10;
        const timestamp =
          fault === "early-result" && operation === 2
            ? terminalAt + 1
            : fault === "parallel" && operation === 0
              ? terminalAt - 40
              : fault === "tied-parallel" || tiedSerial
                ? startedAt
                : startedAt + 5;
        if (codeMode) {
          if (index === 0 || (index === 2 && fault !== "tied-parallel")) {
            messages.push({
              type: "message",
              id: `wrapper-entry-${index}`,
              message: {
                role: "assistant",
                timestamp: startedAt - 1,
                content: [
                  {
                    type: "toolCall",
                    id: `wrapper-${index}`,
                    name: "exec",
                    arguments: { code: "dispatch task tools" },
                  },
                ],
              },
            });
          }
          messages.push({
            type: "message",
            id: `receipt-${index}`,
            message: {
              role: "custom",
              customType: "openclaw.nested-tool.v1",
              display: true,
              excludeFromContext: true,
              content: "",
              timestamp: startedAt,
              details: {
                runId: "task-run",
                scopeId: "task-scope",
                afterEntryId: tiedSerial && index > 0 ? `receipt-${index - 1}` : "wrapper-entry-0",
                startOrder: index,
                parentToolCallId: `wrapper-${index < 2 || fault === "tied-parallel" ? 0 : 2}`,
                toolCallId: fault === "unmatched" && operation === 2 ? "" : toolCallId,
                toolName,
                input,
                result: { content: [{ type: "text", text: "completed" }] },
                isError: fault === "failed" && operation === 2,
                startedAt,
                timestamp,
              },
            },
          });
          if ((index === 1 && fault !== "tied-parallel") || index === order.length - 1) {
            messages.push({
              role: "toolResult",
              toolCallId: `wrapper-${index < 2 || fault === "tied-parallel" ? 0 : 2}`,
              toolName: "exec",
              isError: false,
              timestamp: timestamp + 1,
              content: [],
            });
          }
        } else {
          messages.push({
            role: "assistant",
            timestamp: startedAt,
            content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input }],
          });
          const result = {
            role: "toolResult",
            toolCallId: fault === "unmatched" && operation === 2 ? "unrelated" : toolCallId,
            toolName,
            isError: fault === "failed" && operation === 2,
            timestamp,
            content: [{ type: "text", text: "completed" }],
          };
          if (fault === "tied-parallel") {
            deferredResults.push(result);
          } else {
            messages.push(result);
          }
        }
      }
      messages.push(...deferredResults);
      if (fault === "fake") {
        messages = [
          { role: "assistant", content: [{ type: "text", text: JSON.stringify(messages) }] },
        ];
      }
      state.addOutboundMessage({
        to: `dm:${inbound.conversation.id}`,
        replyToId: inbound.id,
        text: fault === "overclaim" ? `${reply}\nPublished successfully` : reply,
        timestamp: fault === "early-artifact" ? statSync(artifactPath).mtimeMs - 1 : terminalAt,
        toolCalls: (codeMode
          ? ["exec", "read", "read", "exec", "write", "read"]
          : ["read", "read", "write"]
        ).map((name) => ({ name, arguments: { path: "[redacted]" } })),
      });
    },
  });
}

describe.each([false, true])("task telemetry evidence with codeMode=%s", (codeMode) => {
  it.each([false, true])("accepts correlated serial task work with tied=%s", async (tied) => {
    await expect(runTaskEvidence(codeMode, undefined, tied)).resolves.toMatchObject({
      status: "pass",
    });
  });

  // Common task assertions need one mode; correlation and ordering use both adapters.
  const faults: Fault[] = codeMode
    ? ["unmatched", "failed", "parallel", "tied-parallel"]
    : [
        "missing-read",
        "missing-write",
        "reordered",
        "unmatched",
        "failed",
        "fake",
        "parallel",
        "tied-parallel",
        "early-result",
        "early-artifact",
        "overclaim",
        "repeat-write",
      ];
  it.each(faults)("rejects %s despite a plausible start trace and artifact", async (fault) => {
    const result = runTaskEvidence(codeMode, fault);
    await expect(result).rejects.toThrow(/task|artifact|claim/);
    if (fault === "parallel" || fault === "tied-parallel") {
      const error = await result.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const message = String(error);
      expect(message).toContain('{"inbound":');
      const evidence = JSON.parse(message.slice(message.indexOf('{"inbound":')));
      expect(evidence).toEqual({
        inbound: expect.any(Number),
        outbound: expect.any(Number),
        logical: ["read", "read", "write"].map((toolName) => ({
          toolName,
          startedAt: expect.any(Number),
          timestamp: expect.any(Number),
          startAfterIndex: expect.any(Number),
          resultIndex: expect.any(Number),
          completed: true,
          successful: true,
        })),
      });
      expect(message).not.toContain(paths.ledger);
      expect(message).not.toContain(paths.note);
      expect(message).not.toContain(paths.artifact);
    }
  });
});
