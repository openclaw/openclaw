import { describe, expect, it } from "vitest";
import {
  buildPayloads,
  makePayloadAssistant as makeAssistant,
  makePayloadToolAssistant,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool warnings", () => {
  const makeStoppedAssistant = (text = "") =>
    makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: text ? [{ type: "text", text }] : [],
    });

  function expectSinglePayloadSummary(
    payloads: ReturnType<typeof buildPayloads>,
    expected: { text: string; isError?: boolean },
  ) {
    expectSinglePayloadText(payloads, expected.text);
    expect(payloads[0]?.isError).toBe(expected.isError);
  }

  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    expect(buildPayloads(params)).toHaveLength(0);
  }

  function execWarning(
    meta: string,
    options: Parameters<typeof buildPayloads>[0] = {},
    error = "Command exited with code 1",
  ) {
    return buildPayloads({
      lastToolError: { toolName: "exec", meta, error, mutatingAction: true },
      toolResultFormat: "markdown",
      verboseLevel: "full",
      ...options,
    });
  }

  it.each([
    ["browser", "Browser", "tab not found", "off"],
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

  it("does not add tool error fallback when assistant output exists", () => {
    const payloads = buildPayloads({
      assistantTexts: ["All good"],
      lastAssistant: makeStoppedAssistant("All good"),
      lastToolError: { toolName: "browser", error: "tab not found" },
    });

    expectSinglePayloadText(payloads, "All good");
  });

  it.each([
    { sessionKey: "agent:main:discord:channel:c123" },
    { sessionKey: "agent:main:telegram:group:g123" },
    { sessionKey: "agent:main:discord:direct:u123", didSendViaMessagingTool: true },
    {},
  ])("does not add synthetic completion text: %j", (options) => {
    expectNoPayloads({ ...options, lastAssistant: makeStoppedAssistant() });
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

    expectSinglePayloadSummary(payloads, {
      text: "Checked the page and recovered with final answer.",
    });
  });

  it.each(["bash", "write"])(
    "includes a semantic %s timeout explanation at normal verbosity",
    (toolName) => {
      const timeoutExplanation = "approval wait expired";
      const payloads = buildPayloads({
        lastToolError: {
          toolName,
          error: timeoutExplanation,
          errorCode: "approval_timeout",
          timedOut: true,
        },
        verboseLevel: "on",
      });

      expect(payloads[0]?.text).toContain(timeoutExplanation);
    },
  );

  it("treats a user-facing reply as authoritative after a mutating tool failure", () => {
    const payloads = buildPayloads({
      assistantTexts: ["No issues found. The update is complete."],
      lastAssistant: makeStoppedAssistant("No issues found. The update is complete."),
      lastToolError: { toolName: "edit", error: "file missing" },
    });

    expectSinglePayloadSummary(payloads, {
      text: "No issues found. The update is complete.",
    });
  });

  it("hides exec command and cwd metadata without full verbosity", () => {
    expectSinglePayloadSummary(
      execWarning("run python3 /path/to/daily-cost-audit.py (in /private/workspace)", {
        verboseLevel: "off",
      }),
      { text: "⚠️ Exec failed (exit 1)", isError: true },
    );
  });

  it("keeps full-verbose exec failure labels outside markdown command text", () => {
    const payloads = execWarning("run python3 /path/to/daily-cost-audit.py");

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Exec failed: `python3 /path/to/daily-cost-audit.py`: Command exited with code 1",
      isError: true,
    });
    expect(payloads[0]?.text).not.toContain("`run python3");
  });

  it.each([
    [false, "off", "⚠️ Exec blocked (exit 7)"],
    [false, "full", "⚠️ Exec blocked: `make build`: Command exited with code 7"],
    [true, "off", "⚠️ Exec failed (exit 7)"],
    [true, "full", "⚠️ Exec failed: `make build`: Command exited with code 7"],
    [undefined, "off", "⚠️ Exec failed (exit 7)"],
    [undefined, "full", "⚠️ Exec failed: `make build`: Command exited with code 7"],
  ] as const)(
    "renders executionStarted=%s at %s verbosity from structured state",
    (executionStarted, verboseLevel, expected) => {
      expectSinglePayloadText(
        buildPayloads({
          lastToolError: {
            toolName: "exec",
            executionStarted,
            meta: "run make build",
            error: "Command exited with code 7",
          },
          toolResultFormat: "markdown",
          verboseLevel,
        }),
        expected,
      );
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
      expectSinglePayloadText(
        buildPayloads({
          lastToolError: {
            toolName,
            executionStarted: false,
            validationErrorSummary: `${toolName} tool validation failed: invalid arguments`,
            error: "PRIVATE_VALIDATOR_DETAIL",
          },
          verboseLevel,
        }),
        expected,
        true,
      );
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
      expectSinglePayloadSummary(execWarning(meta, { toolResultFormat }), {
        text: `⚠️ Exec failed: ${formatted}: Command exited with code 1`,
        isError: true,
      });
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
    expectSinglePayloadSummary(execWarning(meta, {}, error), {
      text: `⚠️ Exec failed: \`${formatted}\`: ${error}`,
      isError: true,
    });
  });

  it("wraps markdown-capable mutating tool warnings so mention-looking names stay inert", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "bash",
        meta: "show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt (workspace)",
        error: "Command exited with code 1",
        mutatingAction: true,
      },
      toolResultFormat: "markdown",
      verboseLevel: "full",
    });

    expectSinglePayloadSummary(payloads, {
      text: "⚠️ Bash failed: `show matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt` (workspace): Command exited with code 1",
      isError: true,
    });
  });
});
