import { describe, expect, it } from "vitest";
import {
  resolveSuccessfulToolTerminalFallback,
  resolveToolLoopAbortFallback,
  resolveToolLoopAbortFallbackPayload,
} from "./tool-loop-fallback.js";

describe("tool-loop terminal fallback", () => {
  it("uses a public terminal summary returned by any tool without runner-side registration", () => {
    const resolution = resolveToolLoopAbortFallback({
      observations: [
        {
          toolName: "workspace_status",
          argsHash: "current",
          resultHash: "result-1",
          resultText: "raw diagnostic payload not meant for delivery",
          terminalSummary: {
            privacy: "public",
            text: "Workspace status: healthy",
          },
        },
        {
          toolName: "workspace_status",
          argsHash: "current",
          resultHash: "blocked",
          blockedReason: "tool-loop",
          blockedMessage: "CRITICAL: repeated workspace_status calls.",
        },
      ],
    });

    expect(resolution).toEqual({
      toolName: "workspace_status",
      payload: { text: "Workspace status: healthy" },
    });
  });

  it("uses a tool-declared safe text fallback without runner-side tool registration", () => {
    const resolution = resolveToolLoopAbortFallback({
      observations: [
        {
          toolName: "status",
          argsHash: "current",
          resultHash: "result-1",
          resultText: "healthy",
          terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
        },
        {
          toolName: "status",
          argsHash: "current",
          resultHash: "blocked",
          blockedReason: "tool-loop",
          blockedMessage: "CRITICAL: repeated status calls.",
        },
      ],
    });

    expect(resolution).toEqual({
      toolName: "status",
      payload: { text: "Status:\nhealthy" },
    });
  });

  it("redacts tool-declared safe text fallbacks centrally", () => {
    const resolution = resolveToolLoopAbortFallback({
      observations: [
        {
          toolName: "status",
          argsHash: "current",
          resultHash: "result-1",
          resultText: "API_KEY=secret-value\nhealthy",
          terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
        },
        {
          toolName: "status",
          argsHash: "current",
          resultHash: "blocked",
          blockedReason: "tool-loop",
          blockedMessage: "CRITICAL: repeated status calls.",
        },
      ],
    });

    expect(resolution).toEqual({
      toolName: "status",
      payload: { text: "Status:\nAPI_KEY=***\nhealthy" },
    });
  });

  it("does not treat failed tool observations as successful terminal fallback candidates", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "status",
            argsHash: "current",
            resultHash: "error-result",
            resultText: "network unavailable",
            failed: true,
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not reuse a successful terminal fallback that precedes a later failure", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "status",
            argsHash: "first",
            resultHash: "success-result",
            resultText: "healthy",
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "second",
            resultHash: "failed-result",
            resultText: "network unavailable",
            failed: true,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("uses a successful terminal fallback that follows the latest failure", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "status",
            argsHash: "first",
            resultHash: "failed-result",
            resultText: "network unavailable",
            failed: true,
          },
          {
            toolName: "status",
            argsHash: "second",
            resultHash: "success-result",
            resultText: "healthy",
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
        ],
      }),
    ).toEqual({
      toolName: "status",
      payload: { text: "Status:\nhealthy" },
    });
  });

  it("does not reuse a stale success after the blocked tool later fails", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "status",
            argsHash: "first",
            resultHash: "success-result",
            resultText: "healthy",
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "second",
            resultHash: "failed-result",
            resultText: "network unavailable",
            failed: true,
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "third",
            resultHash: "blocked",
            blockedReason: "tool-loop",
          },
        ],
      }),
    ).toEqual({
      text:
        "I stopped because status repeated the same tool call without progress. " +
        "No user-facing result text was provided.",
    });
  });

  it("uses a blocked tool success that occurred after its latest failure", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "status",
            argsHash: "first",
            resultHash: "failed-result",
            resultText: "network unavailable",
            failed: true,
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "second",
            resultHash: "success-result",
            resultText: "healthy",
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "third",
            resultHash: "blocked",
            blockedReason: "tool-loop",
          },
        ],
      }),
    ).toEqual({ text: "Status:\nhealthy" });
  });

  it("parses raw JSON before truncating structured fallback output", () => {
    const resolution = resolveToolLoopAbortFallback({
      observations: [
        {
          toolName: "web_fetch",
          argsHash: "url",
          resultHash: "result-1",
          resultText: JSON.stringify({
            url: "https://example.com",
            status: 200,
            title: "Example Domain",
            text: "x".repeat(10_000),
          }),
          terminalResultFallback: {
            mode: "structured_summary",
            maxChars: 80,
            fields: [
              { label: "URL", paths: [["url"]] },
              { label: "Status", paths: [["status"]] },
              { label: "Title", paths: [["title"]] },
            ],
          },
        },
        {
          toolName: "web_fetch",
          argsHash: "url",
          resultHash: "blocked",
          blockedReason: "tool-loop",
        },
      ],
    });

    expect(resolution?.payload).toEqual({
      text: "URL: https://example.com\nStatus: 200\nTitle: Example Domain",
    });
  });

  it("prefers returned public terminal summaries over declared raw-result fallback formatting", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "status",
            argsHash: "current",
            resultHash: "result-1",
            resultText: "verbose internal status",
            terminalSummary: {
              privacy: "public",
              text: "Status is healthy",
            },
            terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
          },
          {
            toolName: "status",
            argsHash: "current",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated status calls.",
          },
        ],
      }),
    ).toEqual({ text: "Status is healthy" });
  });

  it("redacts returned public terminal summaries centrally", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "status",
            argsHash: "current",
            resultHash: "result-1",
            resultText: "verbose internal status",
            terminalSummary: {
              privacy: "public",
              text: "Status is healthy. API_KEY=secret-value",
            },
          },
          {
            toolName: "status",
            argsHash: "current",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated status calls.",
          },
        ],
      }),
    ).toEqual({ text: "Status is healthy. API_KEY=***" });
  });

  it("does not present undeclared tool results", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "exec",
            argsHash: "cat-secret",
            resultHash: "secret-result",
            resultText: "TOKEN=secret-value\nstatus: ok",
          },
          {
            toolName: "exec",
            argsHash: "cat-secret",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated exec calls.",
          },
        ],
      }),
    ).toEqual({
      text:
        "I stopped because exec repeated the same tool call without progress. " +
        "No user-facing result text was provided.",
    });
  });

  it("does not present result text when a tool opts out", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "secrets_lookup",
            argsHash: "current",
            resultHash: "secret-result",
            resultText: "internal customer payload",
            terminalResultFallback: { mode: "none" },
          },
          {
            toolName: "secrets_lookup",
            argsHash: "current",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated secrets_lookup calls.",
          },
        ],
      }),
    ).toEqual({
      text:
        "I stopped because secrets_lookup repeated the same tool call without progress. " +
        "No user-facing result text was provided.",
    });
  });

  it("uses the same safe fallback path for post-compaction loop aborts", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "gateway",
            argsHash: "lookup",
            resultHash: "result",
            resultText: "resolved value",
            terminalResultFallback: { mode: "safe_text", prefix: "Gateway:" },
          },
          {
            toolName: "gateway",
            argsHash: "lookup",
            resultHash: "result",
            blockedReason: "post-compaction-loop",
            blockedMessage: "CRITICAL: repeated gateway calls after compaction.",
          },
        ],
      }),
    ).toEqual({ text: "Gateway:\nresolved value" });
  });

  it("uses only the blocked tool's declared fallback when successful observations are mixed across tools", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            resultText: '{ "enabled": true, "jobs": 0, "nextWakeAtMs": null }',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [{ label: "Jobs", paths: [["jobs"]], format: "count" }],
            },
          },
          {
            toolName: "exec",
            argsHash: "pwd",
            resultHash: "exec-result",
            resultText: "/private/workspace",
          },
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated cron calls.",
          },
        ],
      }),
    ).toEqual({
      text: "Jobs: 0",
    });
  });

  it("does not fall back to raw text when a declared structured summary cannot parse the result", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "web_fetch",
            argsHash: "docs",
            resultHash: "fetch-result",
            resultText: [
              "SECURITY NOTICE: external content",
              '<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
              "Source: Web Fetch",
              "---",
              "---",
              'title: "OpenClaw"',
              "---",
              "# OpenClaw",
              '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
            ].join("\n"),
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [{ label: "Title", paths: [["title"]], missingText: "none" }],
            },
          },
        ],
      }),
    ).toEqual({
      toolName: "web_fetch",
      payload: {
        text:
          "web_fetch completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    });
  });

  it("unwraps external content markers from declared structured fields", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "web_fetch",
            argsHash: "example",
            resultHash: "result",
            resultText: JSON.stringify({
              url: "https://example.com",
              status: 200,
              title: [
                '<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
                "Source: Web Fetch",
                "---",
                "Example Domain",
                '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>',
              ].join("\n"),
            }),
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "URL", paths: [["url"]] },
                { label: "Status", paths: [["status"]] },
                { label: "Title", paths: [["title"]], missingText: "none" },
              ],
            },
          },
          {
            toolName: "web_fetch",
            argsHash: "example",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated web_fetch calls.",
          },
        ],
      }),
    ).toEqual({
      text: "URL: https://example.com\nStatus: 200\nTitle: Example Domain",
    });
  });

  it("formats a declared structured summary from safe JSON fields", () => {
    expect(
      resolveToolLoopAbortFallbackPayload({
        observations: [
          {
            toolName: "cron",
            argsHash: "list",
            resultHash: "list-result",
            resultText: '{\n  "jobs": [],\n  "total": 0,\n  "offset": 0,\n  "limit": 50\n}',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "Scheduler enabled", paths: [["enabled"]], missingText: "unknown" },
                {
                  label: "Jobs",
                  paths: [["jobs"], ["total"]],
                  format: "count",
                  missingText: "unknown",
                },
                {
                  label: "Next wake",
                  paths: [["nextWakeAtMs"]],
                  format: "none-if-nullish-or-zero",
                  missingText: "unknown",
                },
              ],
            },
          },
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            resultText: '{\n  "enabled": true,\n  "jobs": 0,\n  "nextWakeAtMs": null\n}',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "Scheduler enabled", paths: [["enabled"]], missingText: "unknown" },
                {
                  label: "Jobs",
                  paths: [["jobs"], ["total"]],
                  format: "count",
                  missingText: "unknown",
                },
                {
                  label: "Next wake",
                  paths: [["nextWakeAtMs"]],
                  format: "none-if-nullish-or-zero",
                  missingText: "unknown",
                },
              ],
            },
          },
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "blocked",
            blockedReason: "tool-loop",
            blockedMessage: "CRITICAL: repeated cron calls.",
          },
        ],
      }),
    ).toEqual({
      text: "Scheduler enabled: true\nJobs: 0\nNext wake: none",
    });
  });

  it("uses one latest result for every structured fallback field", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "web_fetch",
            argsHash: "first-url",
            resultHash: "first-result",
            resultText: '{ "status": 200, "title": "Old page" }',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "Status", paths: [["status"]] },
                { label: "Title", paths: [["title"]], missingText: "none" },
              ],
            },
          },
          {
            toolName: "web_fetch",
            argsHash: "second-url",
            resultHash: "second-result",
            resultText: '{ "status": 500 }',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "Status", paths: [["status"]] },
                { label: "Title", paths: [["title"]], missingText: "none" },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      toolName: "web_fetch",
      payload: { text: "Status: 500\nTitle: none" },
    });
  });

  it("uses a tool-declared fallback for successful terminal tool work without a loop abort", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            resultText: '{\n  "enabled": true,\n  "jobs": 1,\n  "nextWakeAtMs": null\n}',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [
                { label: "Scheduler enabled", paths: [["enabled"]], missingText: "unknown" },
                {
                  label: "Jobs",
                  paths: [["jobs"], ["total"]],
                  format: "count",
                  missingText: "unknown",
                },
                {
                  label: "Next wake",
                  paths: [["nextWakeAtMs"]],
                  format: "none-if-nullish-or-zero",
                  missingText: "unknown",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      toolName: "cron",
      payload: {
        text: "Scheduler enabled: true\nJobs: 1\nNext wake: none",
      },
    });
  });

  it("does not present undeclared successful tool results", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "exec",
            argsHash: "current",
            resultHash: "result-1",
            resultText: "TOKEN=secret-value\nstdout ok",
          },
        ],
      }),
    ).toEqual({
      toolName: "exec",
      payload: {
        text:
          "exec completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    });
  });

  it("does not return a successful terminal fallback when a tool opts out", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "secrets_lookup",
            argsHash: "current",
            resultHash: "secret-result",
            resultText: "internal customer payload",
            terminalResultFallback: { mode: "none" },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not return a generic multi-tool fallback when all tools opt out", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "secrets_lookup",
            argsHash: "secrets",
            resultHash: "secret-result",
            resultText: "internal customer payload",
            terminalResultFallback: { mode: "none" },
          },
          {
            toolName: "internal_audit",
            argsHash: "audit",
            resultHash: "audit-result",
            resultText: "internal audit payload",
            terminalResultFallback: { mode: "none" },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("requires declared presentable fallbacks when requested", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "write-result",
            resultText: "updated report.md",
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "write-result",
            resultText: "updated report.md",
            terminalSummary: {
              text: "Updated report.md.",
              privacy: "public",
            },
          },
        ],
      })?.payload,
    ).toEqual({ text: "Updated report.md." });
  });

  it("does not let one declared fallback hide another successful tool when required", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "write-result",
            resultText: "updated report.md",
          },
          {
            toolName: "status_probe",
            argsHash: "status",
            resultHash: "status-result",
            terminalSummary: {
              text: "Status healthy.",
              privacy: "public",
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not let a later unrelated tool failure hide an earlier successful action", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "write-result",
            mutatingAction: true,
          },
          {
            toolName: "status_probe",
            argsHash: "first-status",
            resultHash: "failed-status-result",
            failed: true,
          },
          {
            toolName: "status_probe",
            argsHash: "second-status",
            resultHash: "successful-status-result",
            terminalSummary: {
              text: "Status healthy.",
              privacy: "public",
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not hide an unresolved tool failure behind an earlier unrelated fallback", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "status_probe",
            argsHash: "status",
            resultHash: "status-result",
            terminalSummary: {
              text: "Status healthy.",
              privacy: "public",
            },
          },
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "failed-write-result",
            failed: true,
            mutatingAction: true,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not let an earlier same-tool fallback hide a later uncovered action", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            terminalSummary: {
              text: "Scheduler has 2 jobs.",
              privacy: "public",
            },
          },
          {
            toolName: "cron",
            argsHash: "add",
            resultHash: "add-result",
            mutatingAction: true,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "public summary",
      earlier: {
        terminalSummary: {
          text: "Scheduler has 2 jobs.",
          privacy: "public" as const,
        },
      },
    },
    {
      name: "safe text",
      earlier: {
        resultText: "Scheduler has 2 jobs.",
        terminalResultFallback: { mode: "safe_text" as const, prefix: "Scheduler:" },
      },
    },
    {
      name: "structured summary",
      earlier: {
        resultText: '{"jobs":2}',
        terminalResultFallback: {
          mode: "structured_summary" as const,
          fields: [{ label: "Jobs", paths: [["jobs"]] }],
        },
      },
    },
  ])("does not reuse an earlier same-tool $name after later uncovered work", ({ earlier }) => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            ...earlier,
          },
          {
            toolName: "cron",
            argsHash: "runs",
            resultHash: "runs-result",
            resultText: "internal runs payload",
          },
        ],
      }),
    ).toEqual({
      toolName: "cron",
      payload: {
        text:
          "cron completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    });
  });

  it("honors a latest same-tool fallback opt-out after an earlier public summary", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            terminalSummary: {
              text: "Scheduler has 2 jobs.",
              privacy: "public",
            },
          },
          {
            toolName: "cron",
            argsHash: "runs",
            resultHash: "runs-result",
            terminalResultFallback: { mode: "none" },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("requires every mixed successful tool to produce presentable fallback output when requested", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        requireDeclaredPresentableFallback: true,
        observations: [
          {
            toolName: "write",
            argsHash: "write",
            resultHash: "write-result",
            resultText: "",
            terminalResultFallback: { mode: "safe_text", prefix: "Write:" },
          },
          {
            toolName: "status_probe",
            argsHash: "status",
            resultHash: "status-result",
            terminalSummary: {
              text: "Status healthy.",
              privacy: "public",
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("does not use one tool's declared successful fallback across mixed tool owners", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "cron",
            argsHash: "status",
            resultHash: "status-result",
            resultText: '{"enabled":true}',
            terminalResultFallback: {
              mode: "structured_summary",
              fields: [{ label: "Scheduler enabled", paths: [["enabled"]] }],
            },
          },
          {
            toolName: "workspace_status",
            argsHash: "current",
            resultHash: "result-1",
            terminalSummary: {
              privacy: "public",
              text: "Workspace status: healthy",
            },
          },
        ],
      }),
    ).toEqual({
      toolName: "multiple_tools",
      payload: {
        text: [
          "Tool work completed, but the model did not provide a final answer.",
          "Result from cron:\nScheduler enabled: true",
          "Result from workspace_status:\nWorkspace status: healthy",
        ].join("\n\n"),
      },
    });
  });

  it("uses public terminal summaries in mixed successful terminal fallbacks", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "workspace_status",
            argsHash: "current",
            resultHash: "result-1",
            terminalSummary: {
              privacy: "public",
              text: "Workspace status: healthy",
            },
          },
          {
            toolName: "diagnostics",
            argsHash: "current",
            resultHash: "result-1",
            terminalSummary: {
              privacy: "public",
              text: "Diagnostics complete. TOKEN=secret-value",
            },
          },
        ],
      }),
    ).toEqual({
      toolName: "multiple_tools",
      payload: {
        text: [
          "Tool work completed, but the model did not provide a final answer.",
          "Result from workspace_status:\nWorkspace status: healthy",
          "Result from diagnostics:\nDiagnostics complete. TOKEN=***",
        ].join("\n\n"),
      },
    });
  });

  it("omits undeclared and opted-out tool text from mixed fallback payloads", () => {
    expect(
      resolveSuccessfulToolTerminalFallback({
        observations: [
          {
            toolName: "secrets_lookup",
            argsHash: "current",
            resultHash: "secret-result",
            resultText: "internal customer payload",
            terminalResultFallback: { mode: "none" },
          },
          {
            toolName: "workspace_status",
            argsHash: "current",
            resultHash: "status-result",
            resultText: "workspace healthy",
          },
        ],
      }),
    ).toEqual({
      toolName: "multiple_tools",
      payload: {
        text:
          "Tool work completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    });
  });
});
