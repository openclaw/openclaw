import { describe, expect, it } from "vitest";
import {
  buildPayloads,
  makePayloadAssistant as makeAssistant,
  makePayloadToolAssistant,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";
import { buildFailureWarning } from "./tool-error-warning.js";

describe("embedded run tool warnings", () => {
  const makeStoppedAssistant = (text = "") =>
    makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: text ? [{ type: "text", text }] : [],
    });

  function warning(
    lastToolError: Parameters<typeof buildFailureWarning>[0]["lastToolError"],
    options: Partial<Omit<Parameters<typeof buildFailureWarning>[0], "lastToolError">> = {},
  ) {
    return buildFailureWarning({
      lastToolError,
      hasUserFacingReply: false,
      useMarkdown: true,
      verboseLevel: "full",
      ...options,
    });
  }
  const execWarning = (meta: string, useMarkdown = true, error = "Command exited with code 1") =>
    warning({ toolName: "exec", meta, error, mutatingAction: true }, { useMarkdown });

  it.each([
    ["browser", "Browser", "connection timeout", "on"],
    ["browser", "Browser", "connection timeout", "full"],
    ["exec", "Exec", "/bin/bash: line 1: python: command not found", "off"],
  ] as const)("renders %s (%s): %s at %s verbosity", (toolName, title, error, verboseLevel) => {
    const payloads = buildPayloads({
      lastToolError: { toolName, error, ...(toolName === "exec" ? { mutatingAction: true } : {}) },
      verboseLevel,
    });
    expectSingleToolErrorPayload(payloads, {
      title,
      ...(verboseLevel === "full"
        ? { detail: error }
        : { absentDetail: toolName === "exec" ? "python: command not found" : error }),
    });
  });

  it("does not add synthetic completion text", () => {
    expect(buildPayloads({ lastAssistant: makeStoppedAssistant() })).toHaveLength(0);
  });

  it("adds compact tool error fallback when the assistant only invoked tools and verbose mode is on", () => {
    const payloads = buildPayloads({
      lastAssistant: makePayloadToolAssistant("exec", { command: "echo hi" }),
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "code 1",
    });
  });

  it("does not add tool error fallback when assistant text exists after tool calls", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Checked the page and recovered with final answer."],
      lastAssistant: makePayloadToolAssistant("browser", {
        action: "search",
        query: "openclaw docs",
      }),
      currentAssistant: makeStoppedAssistant("Checked the page and recovered with final answer."),
      lastToolError: { toolName: "browser", error: "connection timeout" },
    });

    expectSinglePayloadText(payloads, "Checked the page and recovered with final answer.");
    expect(payloads[0]?.isError).toBeUndefined();
  });

  it.each(["bash", "write"])(
    "includes a semantic %s timeout explanation at normal verbosity",
    (toolName) => {
      const timeoutExplanation = "approval wait expired";
      expect(
        warning(
          {
            toolName,
            error: timeoutExplanation,
            errorCode: "approval_timeout",
            timedOut: true,
          },
          { verboseLevel: "on" },
        ),
      ).toContain(timeoutExplanation);
    },
  );

  it.each([
    [false, "off", "⚠️ Exec blocked (exit 7)"],
    [false, "full", "⚠️ Exec blocked: `make build`: Command exited with code 7"],
    [undefined, "off", "⚠️ Exec failed (exit 7)"],
    [undefined, "full", "⚠️ Exec failed: `make build`: Command exited with code 7"],
  ] as const)(
    "renders executionStarted=%s at %s verbosity from structured state",
    (executionStarted, verboseLevel, expected) => {
      expect(
        warning(
          {
            toolName: "exec",
            executionStarted,
            meta: "run make build",
            error: "Command exited with code 7",
          },
          { verboseLevel },
        ),
      ).toBe(expected);
    },
  );

  it.each([
    { toolName: "browser", verboseLevel: "off", expected: "⚠️ Browser failed: invalid arguments" },
    { toolName: "exec", verboseLevel: "on", expected: "⚠️ Exec failed: invalid arguments" },
    {
      toolName: "exec",
      verboseLevel: "full",
      expected: "⚠️ Exec failed: PRIVATE_VALIDATOR_DETAIL",
    },
  ] as const)(
    "describes $toolName validation errors at $verboseLevel verbosity",
    ({ toolName, verboseLevel, expected }) => {
      expect(
        warning(
          {
            toolName,
            executionStarted: false,
            validationErrorSummary: `${toolName} tool validation failed: invalid arguments`,
            error: "PRIVATE_VALIDATOR_DETAIL",
          },
          { verboseLevel },
        ),
      ).toBe(expected);
    },
  );

  it.each([
    ["run python3 /tmp/audit.py · `python3 /tmp/audit.py`", "`python3 /tmp/audit.py`"],
    [
      "run node inline script, `node -e 'console.log(1, `x`)'`",
      "``node -e 'console.log(1, `x`)'``",
    ],
    [
      "run node inline script, `node -e 'console.log(1, `x`)'`",
      "node -e 'console.log(1, `x`)'",
      "plain",
    ],
    [
      "run python3 /tmp/audit.py, node: mac-1, `python3 /tmp/audit.py`",
      "`node: mac-1 · python3 /tmp/audit.py`",
    ],
    ['search "foo,bar" in src, `rg "foo,bar" src`', '`rg "foo,bar" src`'],
    ['list files in (in progress) · `ls "(in progress)"`', '`ls "(in progress)"`'],
    ['print text (repo) · `printf "%s" "(repo)"`', '`printf "%s" "(repo)"`'],
    [
      "run python3 /tmp/audit.py (in /tmp/build @everyone)",
      "`python3 /tmp/audit.py (in /tmp/build @everyone)`",
    ],
    [
      "run python3 audit.py (in /tmp/build) · `python3 audit.py`",
      "`python3 audit.py (in /tmp/build)`",
    ],
    [
      "run python3 audit.py (workspace), node: mac-1, `python3 audit.py`",
      "`node: mac-1 · python3 audit.py (workspace)`",
    ],
    ["check git status (repo), `git status`", "`git status (repo)`"],
  ] as const)(
    "formats raw exec context: %s",
    (meta, formatted, toolResultFormat: "plain" | "markdown" = "markdown") => {
      expect(execWarning(meta, toolResultFormat !== "plain")).toBe(
        `⚠️ Exec failed: ${formatted}: Command exited with code 1`,
      );
    },
  );

  it.each([
    ["run make build", "make build", 2],
    ["run tests", "run tests", 1],
    ["run deploy", "run deploy", 1],
    ["run tests → install dependencies", "run tests → install dependencies", 1],
    ["run node inline script", "run node inline script", 1],
    ["run python3 inline script (heredoc)", "run python3 inline script (heredoc)", 1],
    ["run sed on file", "run sed on file", 1],
    ["run tests -> show first 3 lines", "run tests -> show first 3 lines", 1],
  ] as const)("formats exec summary: %s", (meta, formatted, exit) => {
    const error = `Command failed with exit code ${exit}`;
    expect(execWarning(meta, true, error)).toBe(`⚠️ Exec failed: \`${formatted}\`: ${error}`);
  });

  it("wraps markdown-capable mutating tool warnings so mention-looking names stay inert", () => {
    expect(
      warning({
        toolName: "bash",
        meta: "show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt (workspace)",
        error: "Command exited with code 1",
        mutatingAction: true,
      }),
    ).toBe(
      "⚠️ Bash failed: `show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` (workspace): Command exited with code 1",
    );
  });
});
