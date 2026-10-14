import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionGitHubConfirmParamsSchema,
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResultSchema,
  SessionGitHubPublishParamsSchema,
} from "./session-github-publication.js";
import { UsersGitHubAuthorizeStartParamsSchema, UsersGitHubStatusParamsSchema } from "./users.js";

describe("session GitHub publication protocol", () => {
  it("accepts typed publication unavailability without accepting arbitrary diagnostics", () => {
    const options = { personal: null, shared: null, pendingPersonal: null, latestShared: null };
    for (const sharedUnavailableReason of [
      "unavailable",
      "changed",
      "rate_limited",
      "unverified",
      "unsupported_workspace",
    ]) {
      expect(
        Value.Check(SessionGitHubOptionsResultSchema, { ...options, sharedUnavailableReason }),
      ).toBe(true);
    }
    expect(
      Value.Check(SessionGitHubOptionsResultSchema, {
        ...options,
        sharedUnavailableReason: "raw diagnostics",
      }),
    ).toBe(false);
  });

  it("allows shared-only options and one closed personal recovery descriptor", () => {
    const sharedOnly = {
      personal: null,
      shared: { source: "system-detected", accountId: 42, login: "bot" },
      pendingPersonal: null,
      latestShared: null,
    };
    expect(Value.Check(SessionGitHubOptionsResultSchema, sharedOnly)).toBe(true);
    const latestShared = {
      result: {
        requestId: "b1111111-1111-4111-8111-111111111111",
        status: "published",
        publisher: sharedOnly.shared,
        url: "https://github.com/org/repo/pull/1",
        repository: "org/repo",
        branch: "topic",
        headCommit: "a".repeat(40),
      },
      confirmation: null,
    };
    expect(Value.Check(SessionGitHubOptionsResultSchema, { ...sharedOnly, latestShared })).toBe(
      true,
    );
    const pendingPersonal = {
      result: {
        requestId: "a1111111-1111-4111-8111-111111111111",
        status: "needs_confirmation",
        publisher: { source: "personal", accountId: 101, login: "alice" },
        message: "Confirm the original request.",
      },
      confirmation: {
        requestDigest: "a".repeat(64),
        generation: "a1111111-1111-4111-8111-111111111111",
        account: { accountId: 101, login: "alice" },
        pushRepository: "alice/repo",
        repository: "org/repo",
        branch: "topic",
        baseBranch: "main",
        sourceHeadCommit: "a".repeat(40),
        sourceIndexTree: "b".repeat(40),
        workspaceTree: "c".repeat(40),
      },
    };
    expect(Value.Check(SessionGitHubOptionsResultSchema, { ...sharedOnly, pendingPersonal })).toBe(
      true,
    );
    for (const invalid of [
      [pendingPersonal],
      { ...pendingPersonal, owner: "another-profile" },
      { ...pendingPersonal, confirmation: { ...pendingPersonal.confirmation, token: "synthetic" } },
    ]) {
      for (const field of ["pendingPersonal", "latestShared"] as const) {
        expect(
          Value.Check(SessionGitHubOptionsResultSchema, { ...sharedOnly, [field]: invalid }),
        ).toBe(false);
      }
    }
  });

  it("closes personal selection and confirmation over display preconditions without accepting bearer authority", () => {
    const selection = {
      source: "personal",
      generation: "a1111111-1111-4111-8111-111111111111",
      account: { accountId: 101, login: "alice" },
    };
    const request = { sessionKey: "agent:main:main", idempotencyKey: "personal", selection };
    expect(Value.Check(SessionGitHubPublishParamsSchema, request)).toBe(true);
    for (const key of ["ownerProfileId", "token", "profileDir", "repository"]) {
      expect(
        Value.Check(SessionGitHubPublishParamsSchema, {
          ...request,
          selection: { ...selection, [key]: "caller-owned" },
        }),
        key,
      ).toBe(false);
    }
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        ...request,
        selection: { source: "personal", account: selection.account },
      }),
    ).toBe(false);
    const confirmation = {
      sessionKey: request.sessionKey,
      requestId: selection.generation,
      generation: selection.generation,
      account: selection.account,
      requestDigest: "a".repeat(64),
    };
    expect(Value.Check(SessionGitHubConfirmParamsSchema, confirmation)).toBe(true);
    expect(
      Value.Check(SessionGitHubConfirmParamsSchema, { ...confirmation, repository: "other/repo" }),
    ).toBe(false);
    for (const schema of [UsersGitHubAuthorizeStartParamsSchema, UsersGitHubStatusParamsSchema]) {
      expect(Value.Check(schema, {})).toBe(true);
      expect(Value.Check(schema, { ownerProfileId: "other" })).toBe(false);
      expect(Value.Check(schema, { token: "synthetic-PAT" })).toBe(false);
    }
  });
  it("accepts bounded intent without caller-owned repository authority", () => {
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway",
        body: "Explains the change.",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway\nCo-authored-by: unverified <unverified@example.test>",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionGitHubPublishParamsSchema, {
        idempotencyKey: "tool-call-1",
        title: "Fix the gateway",
        commitMessage: "model-controlled trailer",
      }),
    ).toBe(false);
  });

  it.each([["token", "secret"]])(
    "rejects caller-owned %s authority independently",
    (field, value) => {
      expect(
        Value.Check(SessionGitHubPublishParamsSchema, {
          idempotencyKey: "tool-call-1",
          [field]: value,
        }),
      ).toBe(false);
    },
  );

  it("rejects extra fields from terminal results", () => {
    expect(
      Value.Check(SessionGitHubPublicationResultSchema, {
        requestId: "request-1",
        status: "failed",
        code: "push_rejected",
        message: "GitHub publication failed.",
        nextAction: "Check branch access and retry.",
        token: "secret",
      }),
    ).toBe(false);
  });
});
