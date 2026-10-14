import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { readSessionWorkspaceRecoveryRequiredError } from "../error-details.js";
import {
  ErrorCodes,
  CronJobNotFoundErrorDetailsSchema,
  ClawHubRiskAcknowledgementRequiredErrorDetailsSchema,
  ClawReviewRequiredErrorDetailsSchema,
  GatewayErrorDetailCodes,
  GatewayErrorDetailsSchema,
  GitHubPublicationSelectionRejectedErrorDetailsSchema,
  isMcpAppViewExpiredError,
  McpAppViewExpiredErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  OutboundDeliveryQueuedErrorDetailsSchema,
  SessionWorkspaceRecoveryRequiredErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
  missingScopeErrorShape,
  readMissingScopeError,
  readMissingScopeErrorDetails,
  readCronJobNotFoundError,
  readClawHubRiskAcknowledgementRequiredError,
  readClawReviewRequiredError,
  readGitHubPublicationSelectionRejectedError,
  UnknownAgentIdErrorDetailsSchema,
} from "./error-codes.js";
import { ErrorShapeSchema } from "./frames.js";

describe("gateway error details", () => {
  it("reads only structured ClawHub release consent warnings", () => {
    const details = {
      code: GatewayErrorDetailCodes.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
      warning: "Security analysis is pending for this release.",
    };
    const error = { code: ErrorCodes.INVALID_REQUEST, message: "Consent required", details };

    expect(Value.Check(ClawHubRiskAcknowledgementRequiredErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(readClawHubRiskAcknowledgementRequiredError(error)).toEqual(details);
    expect(
      readClawHubRiskAcknowledgementRequiredError({ ...error, code: ErrorCodes.UNAVAILABLE }),
    ).toBeNull();
    expect(
      readClawHubRiskAcknowledgementRequiredError({
        ...error,
        details: { ...details, warning: "" },
      }),
    ).toBeNull();
    expect(readClawHubRiskAcknowledgementRequiredError(new Error("Consent required"))).toBeNull();
  });

  it("distinguishes plugin and skill review requests from ordinary errors", () => {
    for (const kind of ["plugin", "skill"] as const) {
      const details = { code: GatewayErrorDetailCodes.CLAW_REVIEW_REQUIRED, kind };
      const error = { code: ErrorCodes.INVALID_REQUEST, message: "Review required", details };
      expect(Value.Check(ClawReviewRequiredErrorDetailsSchema, details)).toBe(true);
      expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
      expect(readClawReviewRequiredError(error)).toEqual(details);
      expect(readClawReviewRequiredError({ ...error, code: ErrorCodes.UNAVAILABLE })).toBeNull();
    }
    expect(
      readClawReviewRequiredError({
        code: ErrorCodes.INVALID_REQUEST,
        details: { code: GatewayErrorDetailCodes.CLAW_REVIEW_REQUIRED, kind: "unknown" },
      }),
    ).toBeNull();
  });

  it("validates and reads exact pending workspace recovery routes", () => {
    const details = {
      code: GatewayErrorDetailCodes.SESSION_WORKSPACE_RECOVERY_REQUIRED,
      cause: "device_offline" as const,
      recoveryAction: "continue_on_gateway" as const,
      sessionId: "session-1",
      source: { generation: 5, environmentId: "environment-1", ownerEpoch: 70 },
    };
    const error = { code: ErrorCodes.UNAVAILABLE, message: "Recover workspace", details };

    expect(Value.Check(SessionWorkspaceRecoveryRequiredErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(ErrorShapeSchema, error)).toBe(true);
    expect(readSessionWorkspaceRecoveryRequiredError(error)).toEqual(details);
    expect(
      readSessionWorkspaceRecoveryRequiredError({
        ...error,
        details: { ...details, source: { ...details.source, ownerEpoch: 0 } },
      }),
    ).toBeNull();
    expect(
      readSessionWorkspaceRecoveryRequiredError({ ...error, code: ErrorCodes.FORBIDDEN }),
    ).toBeNull();
  });

  it("reads only closed, keyed publication selection rejections", () => {
    const details = {
      code: GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED,
      idempotencyKey: "publication-invocation",
    };
    const response = { code: ErrorCodes.UNAVAILABLE, message: "Review the publisher.", details };
    expect(Value.Check(GitHubPublicationSelectionRejectedErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(ErrorShapeSchema, response)).toBe(true);
    expect(readGitHubPublicationSelectionRejectedError(response)).toEqual(details);
    for (const malformed of [
      null,
      [],
      { ...details, idempotencyKey: "" },
      { ...details, idempotencyKey: 1 },
      { ...details, accepted: true },
    ]) {
      expect(Value.Check(GitHubPublicationSelectionRejectedErrorDetailsSchema, malformed)).toBe(
        false,
      );
      expect(
        readGitHubPublicationSelectionRejectedError({ ...response, details: malformed }),
      ).toBeNull();
    }
    expect(
      readGitHubPublicationSelectionRejectedError({ ...response, code: ErrorCodes.FORBIDDEN }),
    ).toBeNull();
    expect(readGitHubPublicationSelectionRejectedError(new Error(response.message))).toBeNull();
  });

  it("validates and reads cron job lookup misses", () => {
    const details = {
      code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND,
      jobId: "job-123",
    };

    expect(Value.Check(CronJobNotFoundErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(readCronJobNotFoundError({ details })).toEqual(details);
    expect(readCronJobNotFoundError({ details: { ...details, jobId: "" } })).toBeNull();
  });

  it("validates missing-scope details", () => {
    const details = {
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.write",
      requiredScopes: ["operator.write"],
    };

    expect(Value.Check(MissingScopeErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(MissingScopeErrorDetailsSchema, { ...details, requiredScopes: [] })).toBe(
      false,
    );
  });

  it("identifies MCP App lease expiry without message parsing", () => {
    const details = { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED };
    expect(Value.Check(McpAppViewExpiredErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(isMcpAppViewExpiredError({ details })).toBe(true);
    expect(isMcpAppViewExpiredError(new Error("upstream token expired"))).toBe(false);
  });

  it("validates queued outbound delivery details", () => {
    const details = { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED };
    expect(Value.Check(OutboundDeliveryQueuedErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(OutboundDeliveryQueuedErrorDetailsSchema, { ...details, retry: true })).toBe(
      false,
    );
  });

  it("validates unknown-agent details", () => {
    const details = { code: GatewayErrorDetailCodes.UNKNOWN_AGENT_ID, agentId: "retired" };
    expect(Value.Check(UnknownAgentIdErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(UnknownAgentIdErrorDetailsSchema, { ...details, agentId: "" })).toBe(false);
  });

  it("validates typed project clone failures", () => {
    const details = {
      code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
      cause: "auth_required",
    };
    expect(Value.Check(ProjectCloneErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(GatewayErrorDetailsSchema, details)).toBe(true);
    expect(Value.Check(ProjectCloneErrorDetailsSchema, { ...details, cause: "unknown" })).toBe(
      false,
    );
  });

  it("builds a distinct forbidden missing-scope response", () => {
    expect(
      missingScopeErrorShape({
        missingScope: "operator.approvals",
        requiredScopes: ["operator.read", "operator.approvals"],
      }),
    ).toEqual({
      code: ErrorCodes.FORBIDDEN,
      message: "missing scope: operator.approvals",
      details: {
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.approvals",
        requiredScopes: ["operator.read", "operator.approvals"],
      },
    });
  });

  it("keeps requiredScopes non-empty when a caller has no method metadata", () => {
    expect(
      missingScopeErrorShape({ missingScope: "operator.admin", requiredScopes: [] }).details,
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.admin",
      requiredScopes: ["operator.admin"],
    });
  });

  it("reads structured missing-scope details without parsing the message", () => {
    expect(
      readMissingScopeError({
        code: ErrorCodes.FORBIDDEN,
        message: "permission denied",
        details: {
          code: GatewayErrorDetailCodes.MISSING_SCOPE,
          missingScope: "operator.questions",
          requiredScopes: ["operator.read", "operator.questions"],
        },
      }),
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.questions",
      requiredScopes: ["operator.read", "operator.questions"],
    });
  });

  it("falls back to the legacy message only for authorization error codes", () => {
    expect(
      readMissingScopeError({
        gatewayCode: ErrorCodes.INVALID_REQUEST,
        message: "missing scope: operator.read",
      }),
    ).toEqual({
      code: GatewayErrorDetailCodes.MISSING_SCOPE,
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    });
    expect(
      readMissingScopeError({
        code: ErrorCodes.UNAVAILABLE,
        message: "missing scope: operator.read",
      }),
    ).toBeNull();
  });

  it("rejects malformed structured details", () => {
    expect(
      readMissingScopeErrorDetails({
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.read",
        requiredScopes: [],
      }),
    ).toBeNull();
    expect(
      readMissingScopeErrorDetails({
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope: "operator.read",
        requiredScopes: ["operator.read", 42],
      }),
    ).toBeNull();
  });
});
