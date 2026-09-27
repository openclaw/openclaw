import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import * as redaction from "../logging/redact.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { sanitizeToolResult } from "./embedded-agent-tool-results.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

afterEach(() => vi.restoreAllMocks());

it("deep-redacts one result once across persistence, trajectory and both lifecycle schedulers", async () => {
  const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
  const secret = "sk-or-v1-abcdef0123456789";
  const output = `OPENROUTER_API_KEY=${secret}\n${"src/example.ts: build completed successfully\n".repeat(7_200)}`;
  const measurements: { inputChars?: number; threadCpuMs: number }[] = [];
  const diagnostic = channel("openclaw.redaction");
  const capture = (event: unknown) => {
    measurements.push(event as (typeof measurements)[number]);
  };
  const samples: {
    elapsedMs: number;
    threadCpuMs: number;
    redactionCalls: number;
    redactionCpuMs: number;
  }[] = [];
  const repetitions = 10;
  diagnostic.subscribe(capture);
  try {
    for (let index = 0; index < repetitions; index++) {
      const exposed: unknown[] = [];
      const sm = SessionManager.inMemory();
      installSessionToolResultGuard(sm, {
        transformMessageForPersistence: redactTranscriptMessage,
      });
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `sanitize-reuse-${index}`,
        trajectoryRecorder: {
          recordEvent: (_type, event) => {
            exposed.push(event);
          },
          flush: async () => {},
        },
        onAgentToolResult: (event) => {
          exposed.push(event.result);
        },
      });
      const result = {
        content: [
          { type: "text" as const, text: output },
          { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: { status: "completed", aggregated: output, credentials: { apiKey: secret } },
      };
      const callId = `call-${index}`;
      measurements.length = 0;
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      try {
        await subscription.runToolLifecycle({
          toolName: "exec",
          toolCallId: callId,
          args: {},
          execute: async (onImplementationStart) => {
            onImplementationStart();
            sm.appendMessage({
              role: "toolResult",
              toolCallId: callId,
              toolName: "exec",
              ...result,
              isError: false,
              timestamp: 0,
            });
            return result;
          },
          onTerminal: (terminal) => {
            exposed.push(sanitizeToolResult(terminal.result));
          },
        });
        emit({
          type: "tool_execution_end",
          toolName: "exec",
          toolCallId: callId,
          result,
          isError: false,
        });
        await subscription.waitForPendingEvents();
        const used = process.threadCpuUsage(cpu);
        samples.push({
          elapsedMs: performance.now() - started,
          threadCpuMs: (used.user + used.system) / 1_000,
          redactionCalls: measurements.length,
          redactionCpuMs: measurements.reduce((sum, event) => sum + event.threadCpuMs, 0),
        });
        expect(exposed.length).toBeGreaterThanOrEqual(5);
        expect(JSON.stringify(exposed)).not.toContain(secret);
        expect(JSON.stringify(sm.getEntries())).not.toContain(secret);
        expect(sanitizeToolResult(result)).toMatchObject({
          content: [{ type: "text" }, { type: "image", bytes: 5, omitted: true }],
          details: { credentials: { apiKey: expect.not.stringContaining(secret) } },
        });
      } finally {
        subscription.unsubscribe();
      }
    }
  } finally {
    diagnostic.unsubscribe(capture);
  }
  const measured = samples.slice(1);
  const mean = (key: keyof (typeof samples)[number]) =>
    measured.reduce((sum, sample) => sum + sample[key], 0) / measured.length;
  console.info(
    "sanitize-result benchmark",
    JSON.stringify({
      outputChars: output.length,
      executions: repetitions,
      deepPassesPerExecution: deepRedact.mock.calls.length / repetitions,
      elapsedMs: mean("elapsedMs"),
      threadCpuMs: mean("threadCpuMs"),
      redactionCalls: mean("redactionCalls"),
      redactionCpuMs: mean("redactionCpuMs"),
      rssMiB: process.memoryUsage().rss / 1024 / 1024,
    }),
  );
  expect(deepRedact).toHaveBeenCalledTimes(repetitions);
});
