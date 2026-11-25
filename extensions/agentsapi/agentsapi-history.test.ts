import {
  createAgentHarnessAssistantMessage,
  createAgentHarnessToolResultMessage,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import { buildAgentsApiHistoryContext } from "./agentsapi-history.js";

it("quotes prior outcomes and summaries without exposing reasoning or image payloads", () => {
  const messages: AgentMessage[] = [
    {
      role: "compactionSummary",
      summary: "Original task: finish the report.",
      tokensBefore: 100,
      timestamp: 1,
    },
    { role: "user", content: "Continue", timestamp: 2 },
    createAgentHarnessAssistantMessage(
      { api: "openai-responses", provider: "openai", modelId: "fixture" },
      "The upload completed.",
      {
        aborted: false,
        content: [
          { type: "thinking", thinking: "Private reasoning must not be copied." },
          { type: "text", text: "The upload completed." },
          { type: "toolCall", id: "upload-1", name: "upload", arguments: { file: "report.txt" } },
        ],
      },
    ),
    createAgentHarnessToolResultMessage(
      {
        id: "upload-1",
        name: "upload",
        isError: false,
        content: [
          { type: "text", text: "Uploaded report.txt, receipt 123." },
          { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
        ],
      },
      3,
    ),
  ];
  const history = buildAgentsApiHistoryContext(messages, undefined, 8192);
  expect(history).toContain("Original task: finish the report.");
  expect(history).toContain("Continue");
  expect(history).toContain("upload-1");
  expect(history).toContain("Uploaded report.txt, receipt 123.");
  expect(history).not.toContain("Private reasoning");
  expect(history).not.toContain("PRIVATE_IMAGE_BYTES");
});

it("bounds escaped serialized history while retaining a summary and the newest record", () => {
  const history = buildAgentsApiHistoryContext(
    [
      {
        role: "compactionSummary",
        summary: "Original task " + String.fromCharCode(0).repeat(4000),
        tokensBefore: 100,
        timestamp: 1,
      },
      { role: "user", content: "Older work".repeat(1000), timestamp: 2 },
      { role: "user", content: "Newest work " + "😀".repeat(4000), timestamp: 3 },
    ],
    undefined,
    1024,
  );
  expect(history.length).toBeLessThanOrEqual(2048);
  const records = history
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  expect(records).toEqual([
    expect.objectContaining({
      role: "compactionSummary",
      truncated: true,
      text: expect.stringContaining("Original task"),
    }),
    expect.objectContaining({
      role: "user",
      truncated: true,
      text: expect.stringContaining("Newest work"),
    }),
  ]);
  expect(history).not.toContain("Older work");
});
