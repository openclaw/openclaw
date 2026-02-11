/**
 * End-to-end test: CLI streaming → tool event parsing → tool display formatting.
 *
 * Runs the Claude CLI in stream-json mode with a tool-triggering prompt,
 * captures tool_use events, and formats them through the same tool display
 * pipeline used by Discord/channel feedback.
 *
 * Usage: bun scripts/test-tool-feedback.ts
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { formatToolFeedbackDiscord, resolveToolDisplay } from "../src/agents/tool-display.js";

const PROMPT = "list files in /tmp/openclaw using ls, then read the first file you find";

console.log("--- Tool Feedback E2E Test ---");
console.log(`Prompt: "${PROMPT}"`);
console.log("Running Claude CLI in stream-json mode...\n");

const child = spawn(
  "claude",
  [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "haiku",
    "--dangerously-skip-permissions",
  ],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  },
);

child.stdin.write(PROMPT);
child.stdin.end();

let buffer = "";
const toolEvents: Array<{ name: string; input?: Record<string, unknown> }> = [];
const feedbackMessages: string[] = [];

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_use" && block.name && block.id) {
            const toolName = block.name;
            const input = block.input as Record<string, unknown> | undefined;
            toolEvents.push({ name: toolName, input });

            // Format through the same pipeline used by Discord feedback
            const display = resolveToolDisplay({ name: toolName, args: input });
            const feedback = formatToolFeedbackDiscord(display);
            feedbackMessages.push(feedback);

            console.log(`[tool_start] name=${toolName} input=${JSON.stringify(input)}`);
            console.log(`[feedback]   ${feedback}`);
            console.log();
          }
        }
      }
      if (event.type === "result" && event.result) {
        console.log(
          `[result] ${event.result.slice(0, 200)}${event.result.length > 200 ? "..." : ""}`,
        );
      }
    } catch {
      // skip non-JSON lines
    }
  }
});

child.stderr.on("data", () => {
  // ignore stderr (hook output, etc.)
});

child.on("close", (code) => {
  console.log("\n--- Summary ---");
  console.log(`Exit code: ${code}`);
  console.log(`Tool events captured: ${toolEvents.length}`);
  if (feedbackMessages.length > 0) {
    console.log("Feedback messages that would appear in Discord:");
    for (const msg of feedbackMessages) {
      console.log(`  ${msg}`);
    }
  } else {
    console.log("WARNING: No tool events captured!");
  }

  // Save results to home directory
  const outputPath = `${process.env.HOME}/tool-feedback-test-results.txt`;
  const output = [
    "--- Tool Feedback E2E Test Results ---",
    `Date: ${new Date().toISOString()}`,
    `Prompt: "${PROMPT}"`,
    `Exit code: ${code}`,
    `Tool events captured: ${toolEvents.length}`,
    "",
    "Feedback messages (as they would appear in Discord):",
    ...feedbackMessages.map((m) => `  ${m}`),
    "",
  ].join("\n");
  writeFileSync(outputPath, output);
  console.log(`Results saved to ${outputPath}`);

  // Validate
  const noEmojis = feedbackMessages.every((m) => !/[\u{1F000}-\u{1FFFF}]/u.test(m));
  const allItalic = feedbackMessages.every((m) => m.startsWith("*") && m.endsWith("*"));
  const noColons = feedbackMessages.every((m) => !m.includes(":"));
  const passed =
    toolEvents.length > 0 &&
    noEmojis &&
    allItalic &&
    noColons &&
    feedbackMessages.every((m) => !m.includes("Claude Code"));
  console.log(`\nTest ${passed ? "PASSED" : "FAILED"}`);
  if (toolEvents.length === 0) {
    console.log("  No tools were used. The prompt may not have triggered tool use.");
  }
  if (!noEmojis) {
    console.log("  Emojis found in feedback messages.");
  }
  if (!allItalic) {
    console.log("  Not all messages wrapped in italic markers.");
  }
  if (!noColons) {
    console.log("  Colons found in feedback messages.");
  }
  if (feedbackMessages.some((m) => m.includes("Claude Code"))) {
    console.log('  "Claude Code" label appeared in feedback.');
  }
  process.exit(passed ? 0 : 1);
});
