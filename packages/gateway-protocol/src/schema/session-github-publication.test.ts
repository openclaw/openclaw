import { describe, it } from "vitest";
import { schemaValidation, withOverrides } from "./protocol-validation.test-support.js";
import {
  SessionGitHubConfirmParamsSchema,
  SessionGitHubOptionsResultSchema,
  SessionGitHubPublicationResultSchema,
  SessionGitHubPublishParamsSchema,
  SessionGitHubActionParamsSchema,
} from "./session-github-publication.js";
import { UsersGitHubAuthorizeStartParamsSchema, UsersGitHubStatusParamsSchema } from "./users.js";

const action = schemaValidation(SessionGitHubActionParamsSchema);
const options = schemaValidation(SessionGitHubOptionsResultSchema);
const publish = schemaValidation(SessionGitHubPublishParamsSchema);
const confirm = schemaValidation(SessionGitHubConfirmParamsSchema);
const result = schemaValidation(SessionGitHubPublicationResultSchema);
const requestId = "a1111111-1111-4111-8111-111111111111";
const head = "a".repeat(40);
const account = { accountId: 101, login: "alice" };
const selection = { source: "personal", generation: requestId, account };
const sessionKey = "agent:main:publication";
const emptyOptions = { personal: null, shared: null, pendingPersonal: null, latestShared: null };
const request = (operation: string) => ({ sessionKey, action: operation });

describe("session GitHub publication protocol", () => {
  it("binds review requests to the current PR without freeform text", () => {
    const review = { ...request("request_review"), requestId, expectedHeadCommit: head };
    action.accepts(review);
    action.rejects(
      ...[
        { body: "@clawsweeper stop" },
        { focus: "maintainer instructions" },
        { publishingSessionKey: "child" },
        { repository: "other/repo" },
        { url: "https://github.com/other/repo/pull/1" },
        { mergeMethod: "squash" },
        { requestId: undefined },
        { expectedHeadCommit: undefined },
      ].map(withOverrides(review)),
    );
  });
  it("bounds current-workspace refresh and conflict acknowledgment", () => {
    const refresh = request("refresh_base");
    action.accepts(refresh, { ...refresh, conflictsResolved: true, baseCommit: head });
    action.rejects(
      ...[
        { repository: "other/repo" },
        { ref: "main" },
        { publishingSessionKey: "other" },
        { requestId },
        { mergeMethod: "merge" },
        { baseCommit: "main" },
      ].map(withOverrides(refresh)),
    );
  });
  it("binds metadata edits without target or lifecycle selectors", () => {
    const edit = request("edit");
    action.accepts(edit, {
      ...edit,
      title: "New title",
      expectedTitle: "Old title",
      body: "Full description",
      expectedBody: "Previous description",
      requestId,
      expectedHeadCommit: head,
    });
    action.rejects(
      ...[
        { publishingSessionKey: "other" },
        { repository: "other/repo" },
        { url: "https://github.com/other/repo/pull/1" },
        { mergeMethod: "squash" },
        { draft: false },
        { state: "closed" },
        { token: "synthetic" },
        { conflictsResolved: true },
        { body: "x".repeat(65537) },
      ].map(withOverrides(edit)),
    );
  });
  it("excludes arbitrary targets, credentials and auto-merge from PR actions", () => {
    const inspect = request("inspect");
    action.accepts(inspect);
    action.rejects(
      ...[
        { action: "auto_merge" },
        { url: "https://github.com/another/repository/pull/1" },
        { token: "synthetic" },
        { admin: true },
        { mergeMethod: "admin" },
      ].map(withOverrides(inspect)),
    );
  });
  it("admits an explicit own-PR inspection URL without publication or authority fields", () => {
    const inspection = {
      ...request("inspect_pr"),
      pullRequestUrl: "https://github.com/example/repository/pull/1",
    };
    action.accepts(inspection);
    action.rejects(
      ...[
        { pullRequestUrl: undefined },
        { pullRequestUrl: "" },
        { publishingSessionKey: "child" },
        { expectedHeadCommit: head },
        { requestId },
        { title: "Write" },
        { token: "synthetic" },
        { profileId: "other" },
        { mergeMethod: "merge" },
      ].map(withOverrides(inspection)),
    );
  });
  it("accepts typed unavailability rather than arbitrary diagnostics", () => {
    options.accepts(
      ...["unavailable", "changed", "rate_limited", "unverified", "unsupported_workspace"].map(
        (sharedUnavailableReason) => Object.assign({}, emptyOptions, { sharedUnavailableReason }),
      ),
    );
    options.rejects({ ...emptyOptions, sharedUnavailableReason: "raw diagnostics" });
  });
  it("accepts shared-only options and closed personal recovery descriptors", () => {
    const sharedOnly = {
      ...emptyOptions,
      shared: { source: "system-detected", accountId: 42, login: "bot" },
    };
    const latestShared = {
      result: {
        requestId: "b1111111-1111-4111-8111-111111111111",
        status: "published",
        publisher: sharedOnly.shared,
        url: "https://github.com/org/repo/pull/1",
        repository: "org/repo",
        branch: "topic",
        headCommit: head,
      },
      confirmation: null,
    };
    const pendingPersonal = {
      result: {
        requestId,
        status: "needs_confirmation",
        publisher: { source: "personal", ...account },
        message: "Confirm the original request.",
      },
      confirmation: {
        requestDigest: "a".repeat(64),
        generation: requestId,
        account,
        pushRepository: "alice/repo",
        repository: "org/repo",
        branch: "topic",
        baseBranch: "main",
        sourceHeadCommit: head,
        sourceIndexTree: "b".repeat(40),
        workspaceTree: "c".repeat(40),
      },
    };
    options.accepts(
      sharedOnly,
      { ...sharedOnly, latestShared },
      { ...sharedOnly, pendingPersonal },
    );
    for (const field of ["pendingPersonal", "latestShared"]) {
      options.rejects(
        ...[
          [pendingPersonal],
          { ...pendingPersonal, owner: "another-profile" },
          {
            ...pendingPersonal,
            confirmation: { ...pendingPersonal.confirmation, token: "synthetic" },
          },
        ].map((invalid) => Object.assign({}, sharedOnly, { [field]: invalid })),
      );
    }
  });
  it("requires display preconditions, never caller-owned bearer authority", () => {
    const personal = { sessionKey: "agent:main:main", idempotencyKey: "personal", selection };
    publish.accepts(personal);
    publish.rejects(
      ...["ownerProfileId", "token", "profileDir", "repository"].map((key) =>
        Object.assign({}, personal, {
          selection: Object.assign({}, selection, { [key]: "caller-owned" }),
        }),
      ),
      { ...personal, selection: { source: "personal", account } },
    );
    const confirmation = {
      sessionKey: personal.sessionKey,
      requestId,
      generation: requestId,
      account,
      requestDigest: "a".repeat(64),
    };
    confirm.accepts(confirmation);
    confirm.rejects({ ...confirmation, repository: "other/repo" });
    for (const schema of [UsersGitHubAuthorizeStartParamsSchema, UsersGitHubStatusParamsSchema]) {
      const user = schemaValidation(schema);
      user.accepts({});
      user.rejects({ ownerProfileId: "other" }, { token: "synthetic-PAT" });
    }
  });
  it.each([undefined, false, true, "true", 1, null])("validates draft choice %s", (draft) => {
    const value = { idempotencyKey: "draft-choice", ...(draft !== undefined ? { draft } : {}) };
    if (draft === undefined || typeof draft === "boolean") {
      publish.accepts(value);
    } else {
      publish.rejects(value);
    }
  });
  it("bounds intent and excludes model-controlled commit trailers", () => {
    const intent = { idempotencyKey: "tool-call-1", title: "Fix the gateway" };
    publish.accepts({ ...intent, body: "Explains the change." });
    publish.rejects(
      { ...intent, title: "Fix the gateway\nCo-authored-by: unverified <unverified@example.test>" },
      { ...intent, commitMessage: "model-controlled trailer" },
    );
  });
  it("rejects caller-owned token authority independently", () => {
    publish.rejects({ idempotencyKey: "tool-call-1", token: "secret" });
  });
  it("rejects extra fields from terminal results", () => {
    result.rejects({
      requestId: "request-1",
      status: "failed",
      code: "push_rejected",
      message: "GitHub publication failed.",
      nextAction: "Check branch access and retry.",
      token: "secret",
    });
  });
});
