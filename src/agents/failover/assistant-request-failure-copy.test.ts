import { describe, expect, it } from "vitest";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { formatUserFacingAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  renderAssistantRequestFailureCopy,
  renderRuntimeCoordinationFailureCopy,
} from "./assistant-request-failure-copy.js";

describe("renderAssistantRequestFailureCopy", () => {
  const target = { provider: "openai", model: "test-model" };
  const runFailure =
    "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.";

  it.each([
    [
      "Invalid session transcript entry: model_change PRIVATE_CANARY",
      "OpenClaw couldn't read this conversation's history. Try /compact, or start a new conversation with /new.",
    ],
    [
      "invalid session",
      "⚠️ Your AI session expired. Start a new conversation with /new. If it happens again, sign in under Models in the Control UI.",
    ],
  ])("distinguishes local transcript errors from provider expiry: %s", (errorMessage, expected) => {
    expect(
      formatUserFacingAssistantErrorText(makeAssistantMessageFixture({ ...target, errorMessage })),
    ).toBe(expected);
  });

  it.each([
    [{ errcode: 261 }, "SQLITE_BUSY"],
    [{ errcode: 13, message: "database is locked" }, "SQLITE_FULL"],
    [{ errstr: "attempt to write a readonly database" }, "SQLITE_READONLY"],
    [{ errorCode: "SQLITE_IOERR_WRITE", errorMessage: "PRIVATE_CANARY" }, "SQLITE_IOERR"],
    [{ code: "SQLITE_LOCKED_SHAREDCACHE" }, "SQLITE_LOCKED"],
    [
      { errorMessage: "session writer claim changed before transcript persistence" },
      "transcript_writer_fenced",
    ],
  ] as const)("classifies storage facts %j", (error, expected) => {
    expect(classifyGatewayStorageFailure(error)).toBe(expected);
    expect(
      renderAssistantRequestFailureCopy({ storageFailure: classifyGatewayStorageFailure(error) }),
    ).not.toContain("PRIVATE_CANARY");
  });

  it.each([
    ["database is locked", "busy saving", "check the conversation"],
    ["database or disk is full", "disk is full", "Free up space"],
    ["attempt to write a readonly database", "permission to save", "Check folder permissions"],
    ["disk I/O error", "couldn't save", "Check the storage"],
  ])(
    "gives useful storage guidance without internal details: %s",
    (errorMessage, detail, nextStep) => {
      const copy = formatUserFacingAssistantErrorText(
        makeAssistantMessageFixture({ ...target, errorMessage }),
      );
      expect(copy).toContain(detail);
      expect(copy).toContain(nextStep);
      expect(copy).toContain("openclaw logs --follow");
      expect(copy).not.toMatch(/SQLite|openai\/test-model|I\/O/);
    },
  );

  it("preserves an incomplete tool-call diagnosis without exposing provider text", () => {
    const error = makeAssistantMessageFixture({
      ...target,
      errorCode: "incomplete_tool_call",
      errorMessage: "PRIVATE_PROVIDER_DETAIL",
    });
    expect(formatUserFacingAssistantErrorText(error)).toBe(
      "⚠️ The task couldn't finish. Some actions may have completed; check their results before continuing.",
    );
  });

  it.each([
    [
      "CodexNodeExecServerDisconnectedError",
      "codex_node_disconnected",
      "⚠️ Codex execution node disconnected. Start a fresh attempt.",
    ],
    [
      "NodeRunnerUpdateRequiredError",
      "node_runner_update_required",
      "⚠️ The device worker requires an update before it can host sessions. Run `openclaw update`, reconnect it, then run `openclaw node restart` on a headless node before trying again.",
    ],
    [
      "WorkerRunnerUnavailableError",
      "runner-offline",
      "⚠️ The device runner is offline. Reconnect it, retry later, or bring the session back to this gateway.",
    ],
  ])("renders bounded guidance for typed runtime code %s", (name, code, expected) => {
    const error = Object.assign(new Error("private runtime diagnostic"), { name, code });
    expect(renderRuntimeCoordinationFailureCopy(error, code)).toBe(expected);
  });

  it("gives recovery guidance after a tool-result request is rejected", () => {
    const detail = "A maximum of 4 blocks with cache_control may be provided. Found 5.";
    const errorBody = JSON.stringify({
      error: {
        message: "All target providers failed.",
        attempts: [
          { status: 400, details: { error: { type: "invalid_request_error", message: detail } } },
        ],
      },
    });
    expect(
      formatUserFacingAssistantErrorText(
        makeAssistantMessageFixture({
          ...target,
          errorCode: "400",
          errorMessage: `400: ${errorBody}`,
          errorBody,
        }),
      ),
    ).toBe(
      "The AI service couldn't accept this conversation. Start a new conversation with /new, or choose another model in the Control UI.",
    );
  });

  it("keeps provider bodies containing SQLite text redacted", () => {
    const errorMessage = '{"error":{"message":"database is locked PRIVATE_CANARY"}}';
    expect(
      formatUserFacingAssistantErrorText(makeAssistantMessageFixture({ ...target, errorMessage })),
    ).toBe(runFailure);
  });

  it.each([undefined, null, "unclassified", "unknown"] as const)(
    "keeps technical context out of the reply when reason is %s",
    (reason) => {
      expect(renderAssistantRequestFailureCopy({ ...target, reason })).toBe(runFailure);
    },
  );

  it("distinguishes empty replies from failures without details", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, reason: "empty_response" })).toContain(
      "empty reply",
    );
    expect(renderAssistantRequestFailureCopy({ reason: "empty_response" })).toContain(
      "empty reply",
    );
    expect(renderAssistantRequestFailureCopy({ ...target, reason: "no_error_details" })).toBe(
      runFailure,
    );
    expect(renderAssistantRequestFailureCopy({ reason: "no_error_details" })).toBeUndefined();
  });

  it.each([
    [{ provider: "openai" }, runFailure],
    [{ model: "test-model" }, runFailure],
    [{}, undefined],
  ] as const)("handles partial model context %j", (facts, expected) => {
    expect(renderAssistantRequestFailureCopy(facts)).toBe(expected);
  });

  it("requires a valid HTTP status before asserting a request failure", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, status: 0 })).toBe(runFailure);
    expect(renderAssistantRequestFailureCopy({ ...target, status: 400 })).toBe(runFailure);
  });

  it("retains classified guidance without an HTTP status", () => {
    expect(renderAssistantRequestFailureCopy({ ...target, reason: "auth" })).toBe(
      "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    );
  });
});
