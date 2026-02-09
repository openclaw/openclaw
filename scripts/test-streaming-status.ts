/**
 * Streaming status pipeline test. Replays realistic tool-call sequences
 * through createSmartStatus and createUnifiedToolFeedback to show exactly
 * what each channel would display during multi-tool agent runs.
 *
 * Usage: bun scripts/test-streaming-status.ts [test-name]
 *
 * Available tests:
 *   calendar-today   - Check today's calendar (multi-tool)
 *   calendar-week    - Check this week's calendar (many tool calls)
 *   file-search      - Find and read files (multi-step)
 *   git-status       - Check git status and recent commits
 *   mixed-tools      - Mixed tool types with thinking + text
 *   all              - Run all tests sequentially
 *
 * Results are saved to ~/streaming-test-<name>-<timestamp>.txt
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentStreamEvent } from "../src/auto-reply/types.js";
import { createSmartStatus } from "../src/auto-reply/smart-status.js";
import { createUnifiedToolFeedback } from "../src/auto-reply/tool-feedback-filter.js";

type StatusUpdate = {
  elapsed: number;
  source: "smart-status" | "tool-feedback";
  text: string;
};

type ToolStatusInfo = {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
};

type TimelineEntry = {
  delayMs: number;
  event?: AgentStreamEvent;
  toolStatus?: ToolStatusInfo;
  toolResult?: { toolCallId: string; isError: boolean };
  description: string;
};

// Realistic test scenarios with typical tool-call timings.
const TEST_SCENARIOS: Record<
  string,
  {
    prompt: string;
    timeline: TimelineEntry[];
  }
> = {
  "calendar-today": {
    prompt: "Check my calendar for today. Show me all events with their times.",
    timeline: [
      {
        delayMs: 0,
        event: { type: "thinking", text: "I need to check the user's calendar for today..." },
        description: "Thinking about the task",
      },
      {
        delayMs: 500,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-1",
          input: { date: "2026-02-09", timeZone: "America/Los_Angeles" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-1",
          input: { date: "2026-02-09", timeZone: "America/Los_Angeles" },
        },
        description: "Start calendar list for today",
      },
      {
        delayMs: 2200,
        event: { type: "tool_result", toolCallId: "tc-1", isError: false },
        toolResult: { toolCallId: "tc-1", isError: false },
        description: "Calendar results returned",
      },
      {
        delayMs: 300,
        event: {
          type: "text",
          text: "Here are your events for today, February 9th:\n\n",
        },
        description: "Start of reply text",
      },
      {
        delayMs: 100,
        event: {
          type: "text",
          text: "**9:00 AM** - Team standup (30 min)\n**10:30 AM** - Design review with Sarah\n",
        },
        description: "Calendar event listing",
      },
      {
        delayMs: 100,
        event: {
          type: "text",
          text: "**1:00 PM** - Lunch with Alex\n**3:00 PM** - Sprint planning\n**4:30 PM** - 1:1 with manager",
        },
        description: "More calendar events",
      },
    ],
  },

  "calendar-week": {
    prompt: "Check my calendar for each day this week (Monday through Friday).",
    timeline: [
      {
        delayMs: 0,
        event: { type: "thinking", text: "Let me check each day of the week..." },
        description: "Thinking about multi-day calendar check",
      },
      // Monday
      {
        delayMs: 400,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-mon",
          input: { date: "2026-02-09", label: "Monday" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-mon",
          input: { date: "2026-02-09", label: "Monday" },
        },
        description: "Fetch Monday's calendar",
      },
      // Tuesday - starts in parallel
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-tue",
          input: { date: "2026-02-10", label: "Tuesday" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-tue",
          input: { date: "2026-02-10", label: "Tuesday" },
        },
        description: "Fetch Tuesday's calendar (parallel)",
      },
      // Wednesday
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-wed",
          input: { date: "2026-02-11", label: "Wednesday" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-wed",
          input: { date: "2026-02-11", label: "Wednesday" },
        },
        description: "Fetch Wednesday's calendar (parallel)",
      },
      // Thursday
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-thu",
          input: { date: "2026-02-12", label: "Thursday" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-thu",
          input: { date: "2026-02-12", label: "Thursday" },
        },
        description: "Fetch Thursday's calendar (parallel)",
      },
      // Friday
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "calendar_list_events",
          toolCallId: "tc-fri",
          input: { date: "2026-02-13", label: "Friday" },
        },
        toolStatus: {
          toolName: "calendar_list_events",
          toolCallId: "tc-fri",
          input: { date: "2026-02-13", label: "Friday" },
        },
        description: "Fetch Friday's calendar (parallel)",
      },
      // Results arrive
      {
        delayMs: 1800,
        event: { type: "tool_result", toolCallId: "tc-mon", isError: false },
        toolResult: { toolCallId: "tc-mon", isError: false },
        description: "Monday results",
      },
      {
        delayMs: 200,
        event: { type: "tool_result", toolCallId: "tc-tue", isError: false },
        toolResult: { toolCallId: "tc-tue", isError: false },
        description: "Tuesday results",
      },
      {
        delayMs: 300,
        event: { type: "tool_result", toolCallId: "tc-wed", isError: false },
        toolResult: { toolCallId: "tc-wed", isError: false },
        description: "Wednesday results",
      },
      {
        delayMs: 100,
        event: { type: "tool_result", toolCallId: "tc-thu", isError: false },
        toolResult: { toolCallId: "tc-thu", isError: false },
        description: "Thursday results",
      },
      {
        delayMs: 200,
        event: { type: "tool_result", toolCallId: "tc-fri", isError: false },
        toolResult: { toolCallId: "tc-fri", isError: false },
        description: "Friday results",
      },
      // Reply text
      {
        delayMs: 500,
        event: {
          type: "text",
          text: "Here is your weekly calendar overview:\n\n**Monday (Feb 9)**\n- 9:00 AM: Team standup\n- 2:00 PM: Code review\n\n",
        },
        description: "Start of weekly summary",
      },
      {
        delayMs: 200,
        event: {
          type: "text",
          text: "**Tuesday (Feb 10)**\n- 10:00 AM: Product sync\n- 3:00 PM: 1:1 with manager\n\n**Wednesday (Feb 11)**\n- All day: Focus time (no meetings)\n\n",
        },
        description: "Tue/Wed summary",
      },
      {
        delayMs: 200,
        event: {
          type: "text",
          text: "**Thursday (Feb 12)**\n- 9:30 AM: Sprint retro\n- 1:00 PM: Lunch & learn\n\n**Friday (Feb 13)**\n- 11:00 AM: Demo day\n- 4:00 PM: Happy hour",
        },
        description: "Thu/Fri summary",
      },
    ],
  },

  "file-search": {
    prompt: "Find and read a random interesting file in my git projects.",
    timeline: [
      {
        delayMs: 0,
        event: {
          type: "thinking",
          text: "I'll look through the user's git projects for something interesting...",
        },
        description: "Thinking about file search",
      },
      {
        delayMs: 600,
        event: {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tc-ls",
          input: { command: "ls ~/git" },
        },
        toolStatus: {
          toolName: "bash",
          toolCallId: "tc-ls",
          input: { command: "ls ~/git" },
        },
        description: "List git directories",
      },
      {
        delayMs: 800,
        event: { type: "tool_result", toolCallId: "tc-ls", isError: false },
        toolResult: { toolCallId: "tc-ls", isError: false },
        description: "Directory listing returned",
      },
      {
        delayMs: 400,
        event: {
          type: "thinking",
          text: "Found several projects. Let me find something interesting in openclaw...",
        },
        description: "Deciding which project to explore",
      },
      {
        delayMs: 300,
        event: {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tc-find",
          input: { command: "find ~/git/openclaw/src -name '*.ts' | shuf | head -1" },
        },
        toolStatus: {
          toolName: "bash",
          toolCallId: "tc-find",
          input: { command: "find ~/git/openclaw/src -name '*.ts' | shuf | head -1" },
        },
        description: "Find a random TypeScript file",
      },
      {
        delayMs: 1200,
        event: { type: "tool_result", toolCallId: "tc-find", isError: false },
        toolResult: { toolCallId: "tc-find", isError: false },
        description: "Random file found",
      },
      {
        delayMs: 200,
        event: {
          type: "tool_start",
          toolName: "read_file",
          toolCallId: "tc-read",
          input: { path: "~/git/openclaw/src/auto-reply/smart-status.ts" },
        },
        toolStatus: {
          toolName: "read_file",
          toolCallId: "tc-read",
          input: { path: "~/git/openclaw/src/auto-reply/smart-status.ts" },
        },
        description: "Read the file contents",
      },
      {
        delayMs: 600,
        event: { type: "tool_result", toolCallId: "tc-read", isError: false },
        toolResult: { toolCallId: "tc-read", isError: false },
        description: "File contents returned",
      },
      {
        delayMs: 400,
        event: {
          type: "text",
          text: "I found an interesting file: `smart-status.ts` in the auto-reply module!\n\nThis module converts streaming agent events into human-readable status text. ",
        },
        description: "Start explaining the file",
      },
      {
        delayMs: 200,
        event: {
          type: "text",
          text: 'It watches for tool starts, results, and thinking to generate live progress like "Checking calendar..." or "Reading file...".',
        },
        description: "Continue explanation",
      },
    ],
  },

  "git-status": {
    prompt: "Check the git status and last 5 commits. Also check for uncommitted changes.",
    timeline: [
      {
        delayMs: 0,
        event: {
          type: "thinking",
          text: "I'll run git status and git log to get the info requested.",
        },
        description: "Planning git commands",
      },
      // Parallel git commands
      {
        delayMs: 300,
        event: {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tc-status",
          input: { command: "git status" },
        },
        toolStatus: {
          toolName: "bash",
          toolCallId: "tc-status",
          input: { command: "git status" },
        },
        description: "Run git status",
      },
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tc-log",
          input: { command: "git log --oneline -5" },
        },
        toolStatus: {
          toolName: "bash",
          toolCallId: "tc-log",
          input: { command: "git log --oneline -5" },
        },
        description: "Run git log (parallel)",
      },
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "bash",
          toolCallId: "tc-diff",
          input: { command: "git diff --stat" },
        },
        toolStatus: {
          toolName: "bash",
          toolCallId: "tc-diff",
          input: { command: "git diff --stat" },
        },
        description: "Run git diff (parallel)",
      },
      // Results
      {
        delayMs: 1000,
        event: { type: "tool_result", toolCallId: "tc-status", isError: false },
        toolResult: { toolCallId: "tc-status", isError: false },
        description: "git status returned",
      },
      {
        delayMs: 200,
        event: { type: "tool_result", toolCallId: "tc-log", isError: false },
        toolResult: { toolCallId: "tc-log", isError: false },
        description: "git log returned",
      },
      {
        delayMs: 100,
        event: { type: "tool_result", toolCallId: "tc-diff", isError: false },
        toolResult: { toolCallId: "tc-diff", isError: false },
        description: "git diff returned",
      },
      // Reply
      {
        delayMs: 300,
        event: {
          type: "text",
          text: "Here is the current git state:\n\n**Branch:** discord-streaming-updates (clean)\n\n",
        },
        description: "Start of git summary",
      },
      {
        delayMs: 150,
        event: {
          type: "text",
          text: "**Last 5 commits:**\n```\nc6e312a Discard pre-tool block replies\n89d69eb Disallow MCP wrapper tool\n72e3c9f Fix lint issues\n11a8ebb Enable native CLI tools\n53bb4c4 Add tool-first guidance\n```\n\nNo uncommitted changes.",
        },
        description: "Commit listing",
      },
    ],
  },

  "mixed-tools": {
    prompt: "What time is it in Tokyo? Also check if there are any GitHub notifications.",
    timeline: [
      {
        delayMs: 0,
        event: {
          type: "thinking",
          text: "Two tasks: time conversion and GitHub notifications check...",
        },
        description: "Planning multiple tasks",
      },
      // Parallel tool calls for different tasks
      {
        delayMs: 400,
        event: {
          type: "tool_start",
          toolName: "get_current_time",
          toolCallId: "tc-time",
          input: { timezone: "Asia/Tokyo" },
        },
        toolStatus: {
          toolName: "get_current_time",
          toolCallId: "tc-time",
          input: { timezone: "Asia/Tokyo" },
        },
        description: "Get Tokyo time",
      },
      {
        delayMs: 50,
        event: {
          type: "tool_start",
          toolName: "github_notifications",
          toolCallId: "tc-gh",
          input: { filter: "unread" },
        },
        toolStatus: {
          toolName: "github_notifications",
          toolCallId: "tc-gh",
          input: { filter: "unread" },
        },
        description: "Check GitHub notifications (parallel)",
      },
      // Time result comes back fast
      {
        delayMs: 500,
        event: { type: "tool_result", toolCallId: "tc-time", isError: false },
        toolResult: { toolCallId: "tc-time", isError: false },
        description: "Time result returned",
      },
      // GitHub takes longer
      {
        delayMs: 2500,
        event: { type: "tool_result", toolCallId: "tc-gh", isError: false },
        toolResult: { toolCallId: "tc-gh", isError: false },
        description: "GitHub notifications returned",
      },
      // Reply
      {
        delayMs: 300,
        event: {
          type: "text",
          text: "**Current time in Tokyo:** 10:34 AM JST (Monday, February 9)\n\n",
        },
        description: "Time result",
      },
      {
        delayMs: 200,
        event: {
          type: "text",
          text: '**GitHub Notifications (3 unread):**\n- PR #142: "Add streaming status" - review requested\n- Issue #98: New bug report on calendar sync\n- PR #139: "Fix typo" - merged',
        },
        description: "GitHub notifications",
      },
    ],
  },
};

function timestamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "").slice(0, 15);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest(
  testName: string,
  scenario: { prompt: string; timeline: TimelineEntry[] },
): Promise<{
  timeline: Array<{
    elapsed: number;
    description: string;
    event?: AgentStreamEvent;
    toolStatus?: ToolStatusInfo;
  }>;
  statusUpdates: StatusUpdate[];
  durationMs: number;
}> {
  const statusUpdates: StatusUpdate[] = [];
  const recordedTimeline: Array<{
    elapsed: number;
    description: string;
    event?: AgentStreamEvent;
    toolStatus?: ToolStatusInfo;
  }> = [];
  const startTime = Date.now();

  // Set up smart status (what Discord/Slack status bar shows)
  const smartStatus = createSmartStatus({
    userMessage: scenario.prompt,
    onUpdate: (text) => {
      statusUpdates.push({
        elapsed: Date.now() - startTime,
        source: "smart-status",
        text,
      });
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [${elapsedSec}s] Smart Status: "${text}"`);
    },
    config: { minIntervalMs: 0 },
  });

  // Set up tool feedback (what Discord/Slack shows as grouped tool info)
  const toolFeedback = createUnifiedToolFeedback({
    onUpdate: (text) => {
      statusUpdates.push({
        elapsed: Date.now() - startTime,
        source: "tool-feedback",
        text,
      });
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [${elapsedSec}s] Tool Feedback: "${text}"`);
    },
    config: { bufferMs: 500, maxWaitMs: 2000, cooldownMs: 0 },
  });

  // Replay timeline events with realistic delays
  for (const entry of scenario.timeline) {
    if (entry.delayMs > 0) {
      await sleep(entry.delayMs);
    }

    const elapsed = Date.now() - startTime;
    const elapsedSec = (elapsed / 1000).toFixed(1);

    recordedTimeline.push({
      elapsed,
      description: entry.description,
      event: entry.event,
      toolStatus: entry.toolStatus,
    });

    // Log the raw event
    if (entry.event) {
      switch (entry.event.type) {
        case "thinking":
          console.log(`  [${elapsedSec}s] [thinking] ${entry.event.text.slice(0, 80)}`);
          break;
        case "tool_start":
          console.log(
            `  [${elapsedSec}s] [tool:start] ${entry.event.toolName} ${entry.event.input ? JSON.stringify(entry.event.input).slice(0, 80) : ""}`,
          );
          break;
        case "tool_result":
          console.log(
            `  [${elapsedSec}s] [tool:result] ${entry.event.toolCallId} ${entry.event.isError ? "(ERROR)" : "(ok)"}`,
          );
          break;
        case "text":
          console.log(
            `  [${elapsedSec}s] [text] ${entry.event.text.slice(0, 80).replace(/\n/g, "\\n")}${entry.event.text.length > 80 ? "..." : ""}`,
          );
          break;
      }

      // Feed to smart status
      smartStatus.push(entry.event);
    }

    // Feed tool status events separately (as onToolStatus would)
    if (entry.toolStatus) {
      toolFeedback.push(entry.toolStatus);
    }

    // Feed tool results to smart status
    if (entry.toolResult) {
      smartStatus.push({
        type: "tool_result",
        toolCallId: entry.toolResult.toolCallId,
        isError: entry.toolResult.isError,
      });
    }
  }

  // Let any pending debounced updates fire
  await sleep(300);

  smartStatus.dispose();
  toolFeedback.dispose();

  return {
    timeline: recordedTimeline,
    statusUpdates,
    durationMs: Date.now() - startTime,
  };
}

function writeReport(
  testName: string,
  scenario: { prompt: string; timeline: TimelineEntry[] },
  result: {
    timeline: Array<{
      elapsed: number;
      description: string;
      event?: AgentStreamEvent;
      toolStatus?: ToolStatusInfo;
    }>;
    statusUpdates: StatusUpdate[];
    durationMs: number;
  },
): string {
  const ts = timestamp();
  const outPath = path.join(os.homedir(), `streaming-test-${testName}-${ts}.txt`);

  const lines: string[] = [];
  lines.push(`=== Streaming Status Test: ${testName} ===`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Prompt: "${scenario.prompt}"`);
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Timeline events: ${result.timeline.length}`);
  lines.push(`Status updates: ${result.statusUpdates.length}`);
  lines.push("");

  // Raw event timeline
  lines.push("--- Event Timeline ---");
  for (const entry of result.timeline) {
    const sec = (entry.elapsed / 1000).toFixed(1);
    let detail = entry.description;
    if (entry.event) {
      switch (entry.event.type) {
        case "thinking":
          detail += ` | thinking: "${entry.event.text.slice(0, 100)}"`;
          break;
        case "tool_start":
          detail += ` | tool_start: ${entry.event.toolName}(${entry.event.input ? JSON.stringify(entry.event.input) : ""})`;
          break;
        case "tool_result":
          detail += ` | tool_result: ${entry.event.toolCallId} ${entry.event.isError ? "ERROR" : "ok"}`;
          break;
        case "text":
          detail += ` | text: "${entry.event.text.slice(0, 120).replace(/\n/g, "\\n")}"`;
          break;
      }
    }
    lines.push(`[${sec}s] ${detail}`);
  }
  lines.push("");

  // Status updates (what users see across channels)
  lines.push("--- Status Updates (what users see) ---");
  lines.push("");
  lines.push("These are the live status messages shown in Discord thread status,");
  lines.push("Slack thread status, or used to refresh typing indicators on");
  lines.push("Telegram/Signal/WhatsApp during the agent run.");
  lines.push("");

  if (result.statusUpdates.length === 0) {
    lines.push("(no status updates generated)");
  }

  const smartUpdates = result.statusUpdates.filter((u) => u.source === "smart-status");
  const toolFeedbackUpdates = result.statusUpdates.filter((u) => u.source === "tool-feedback");

  if (smartUpdates.length > 0) {
    lines.push("  Smart Status (Discord/Slack status bar):");
    for (const update of smartUpdates) {
      const sec = (update.elapsed / 1000).toFixed(1);
      lines.push(`    [${sec}s] "${update.text}"`);
    }
    lines.push("");
  }

  if (toolFeedbackUpdates.length > 0) {
    lines.push("  Tool Feedback (Discord/Slack grouped tool info):");
    for (const update of toolFeedbackUpdates) {
      const sec = (update.elapsed / 1000).toFixed(1);
      // Show multi-line tool feedback with indentation
      const feedbackLines = update.text.split("\n");
      lines.push(`    [${sec}s]`);
      for (const line of feedbackLines) {
        lines.push(`      ${line}`);
      }
    }
    lines.push("");
  }

  // Summary
  lines.push("--- Summary ---");
  const toolStarts = result.timeline.filter((e) => e.event?.type === "tool_start");
  const toolResults = result.timeline.filter((e) => e.event?.type === "tool_result");
  const thinkingEvents = result.timeline.filter((e) => e.event?.type === "thinking");
  const textEvents = result.timeline.filter((e) => e.event?.type === "text");
  lines.push(`Tool starts: ${toolStarts.length}`);
  lines.push(`Tool results: ${toolResults.length}`);
  lines.push(`Thinking events: ${thinkingEvents.length}`);
  lines.push(`Text events: ${textEvents.length}`);
  lines.push(`Smart status updates: ${smartUpdates.length}`);
  lines.push(`Tool feedback updates: ${toolFeedbackUpdates.length}`);
  lines.push("");

  // Tools used
  if (toolStarts.length > 0) {
    lines.push("--- Tools Used ---");
    for (const entry of toolStarts) {
      if (entry.event?.type === "tool_start") {
        const args = entry.event.input ? JSON.stringify(entry.event.input).slice(0, 120) : "";
        lines.push(`  ${entry.event.toolName} ${args}`);
      }
    }
    lines.push("");
  }

  // Channel behavior matrix
  lines.push("--- Channel Behavior ---");
  lines.push("  Discord:  Smart status in thread status bar + tool feedback");
  lines.push("  Slack:    Smart status in thread status bar + tool feedback");
  lines.push("  Telegram: Typing indicator refreshed on each status update");
  lines.push("  Signal:   Typing indicator refreshed on each status update");
  lines.push("  WhatsApp: Composing indicator refreshed on each status update");
  lines.push("  iMessage: No status mechanism (skipped)");
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
  return outPath;
}

async function main() {
  const arg = process.argv[2] ?? "all";
  const testNames = arg === "all" ? Object.keys(TEST_SCENARIOS) : [arg];

  console.log("=== Streaming Status Pipeline Tests ===");
  console.log("Replays realistic tool-call sequences through the status pipeline.\n");

  const results: string[] = [];

  for (const testName of testNames) {
    const scenario = TEST_SCENARIOS[testName];
    if (!scenario) {
      console.error(`Unknown test: "${testName}"`);
      console.error(`Available: ${Object.keys(TEST_SCENARIOS).join(", ")}, all`);
      process.exit(1);
    }

    console.log(`\n--- Test: ${testName} ---`);
    console.log(`Prompt: "${scenario.prompt}"\n`);

    try {
      const result = await runTest(testName, scenario);
      const outPath = writeReport(testName, scenario, result);
      results.push(outPath);

      console.log(`\n  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log(`  Timeline events: ${result.timeline.length}`);
      console.log(`  Status updates: ${result.statusUpdates.length}`);
      console.log(`  Report: ${outPath}`);
    } catch (err) {
      console.error(`  Test failed: ${err}`);
    }
  }

  console.log("\n=== All Tests Complete ===");
  console.log("Reports saved to:");
  for (const p of results) {
    console.log(`  ${p}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
