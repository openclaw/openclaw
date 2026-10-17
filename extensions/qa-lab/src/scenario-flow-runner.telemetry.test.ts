import { statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { nestedToolActivityFixture } from "../test/nested-tool-activity-fixture.js";
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
  | "reordered"
  | "unmatched"
  | "failed"
  | "fake"
  | "tied-parallel"
  | "early-result"
  | "early-artifact";

const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const toolCall = (id: string, name: string, args: unknown) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
const assistant = (timestamp: number, call: ReturnType<typeof toolCall>) => ({
  role: "assistant",
  timestamp,
  content: [call],
});
const toolResult = (
  toolCallId: string,
  toolName: string,
  timestamp: number,
  isError: boolean,
  content: unknown[] = [{ type: "text", text: "completed" }],
) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  isError,
  timestamp,
  content,
});

async function runTaskEvidence(codeMode: boolean, fault?: Fault) {
  const workspaceDir = tempDirs.make("qa-task-evidence-");
  let messages: unknown[] = [];
  const trace = [paths.ledger, paths.note, paths.artifact].map((file, index) => ({
    name: index === 2 ? "write" : "read",
    arguments: { path: path.join(workspaceDir, file) },
  }));
  const tied = !fault || fault === "tied-parallel";
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
      if (codeMode && !fault) {
        order.push(3);
      }
      messages = [];
      const deferredResults: unknown[] = [];
      for (const [index, operation] of order.entries()) {
        const toolName = operation === 2 ? "write" : "read";
        const file = operation === 0 ? paths.ledger : operation === 1 ? paths.note : paths.artifact;
        const input = { path: path.join(workspaceDir, file) };
        const toolCallId = `task-${index}`;
        const startedAt = tied ? terminalAt - 50 : terminalAt - 70 + index * 10;
        const timestamp =
          fault === "early-result" && operation === 2
            ? terminalAt + 1
            : tied
              ? startedAt
              : startedAt + 5;
        const wrapperId = `wrapper-${index < 2 || fault === "tied-parallel" ? 0 : 2}`;
        const isError = fault === "failed" && operation === 2;
        if (codeMode) {
          if (index === 0 || (index === 2 && fault !== "tied-parallel")) {
            messages.push(
              entry(
                `wrapper-entry-${index}`,
                assistant(
                  startedAt - 1,
                  toolCall(`wrapper-${index}`, "exec", { code: "dispatch task tools" }),
                ),
              ),
            );
          }
          const receipt = nestedToolActivityFixture({
            toolName,
            toolCallId: fault === "unmatched" && operation === 2 ? "" : toolCallId,
            input,
            text: "completed",
            isError,
          });
          Object.assign(receipt, { timestamp: startedAt });
          Object.assign(receipt.details, {
            afterEntryId: !fault && index > 0 ? `receipt-${index - 1}` : "wrapper-entry-0",
            startOrder: index,
            parentToolCallId: wrapperId,
            startedAt,
            timestamp,
          });
          messages.push(entry(`receipt-${index}`, receipt));
          if ((index === 1 && fault !== "tied-parallel") || index === order.length - 1) {
            messages.push(toolResult(wrapperId, "exec", timestamp + 1, false, []));
          }
        } else {
          messages.push(assistant(startedAt, toolCall(toolCallId, toolName, input)));
          const result = toolResult(
            fault === "unmatched" && operation === 2 ? "unrelated" : toolCallId,
            toolName,
            timestamp,
            isError,
          );
          (fault === "tied-parallel" ? deferredResults : messages).push(result);
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
        text: reply,
        timestamp: fault === "early-artifact" ? statSync(artifactPath).mtimeMs - 1 : terminalAt,
        toolCalls: trace,
      });
    },
  });
}

describe.each([false, true])("task telemetry evidence with codeMode=%s", (codeMode) => {
  it("accepts correlated serial task work with tied timestamps", async () => {
    await expect(runTaskEvidence(codeMode)).resolves.toMatchObject({
      status: "pass",
    });
  });

  // Common task assertions need one mode; correlation and ordering use both adapters.
  const faults: Fault[] = codeMode
    ? ["unmatched", "failed", "tied-parallel"]
    : ["reordered", "unmatched", "fake", "tied-parallel", "early-result", "early-artifact"];
  it.each(faults)("rejects %s despite a plausible start trace and artifact", async (fault) => {
    const result = runTaskEvidence(codeMode, fault);
    await expect(result).rejects.toThrow(/task|artifact|claim/);
    if (fault === "tied-parallel") {
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
