import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";

const closed = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false });
const projectUrl = Type.String({ minLength: 12, maxLength: 2048 });
const iid = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const page = Type.Integer({ minimum: 1, maximum: 20 });
const text = Type.String({ minLength: 1, maxLength: 32_768 });
const description = Type.String({ maxLength: 32_768 });
const title = Type.String({ minLength: 1, maxLength: 255 });
const labels = Type.Array(
  Type.String({ minLength: 1, maxLength: 255, pattern: "^[^,\\x00-\\x1f\\x7f]+$" }),
  { maxItems: 30 },
);
const ids = Type.Array(iid, { maxItems: 30 });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const observedAt = Type.String({ minLength: 1, maxLength: 64 });
const discussionId = Type.String({ pattern: "^[a-f0-9]{8,128}$" });
const sha = Type.String({ pattern: "^[a-f0-9]{40}$" });
const target = Type.Union([Type.Literal("issue"), Type.Literal("merge_request")]);
const linkRelation = Type.Union([
  Type.Literal("relates_to"),
  Type.Literal("blocks"),
  Type.Literal("is_blocked_by"),
]);

/** Closed, operation-specific input; projectUrl is a canonical project root, not an API URL. */
export const GitLabIssueOperationSchema = Type.Union([
  closed({
    action: Type.Literal("project.members"),
    projectUrl,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    page: Type.Optional(page),
  }),
  closed({
    action: Type.Literal("project.labels"),
    projectUrl,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    page: Type.Optional(page),
  }),
  closed({
    action: Type.Literal("project.milestones"),
    projectUrl,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    page: Type.Optional(page),
  }),
  closed({
    action: Type.Literal("issue.list"),
    projectUrl,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    state: Type.Optional(
      Type.Union([Type.Literal("opened"), Type.Literal("closed"), Type.Literal("all")]),
    ),
    page: Type.Optional(page),
  }),
  closed({ action: Type.Literal("issue.get"), projectUrl, iid }),
  closed({
    action: Type.Literal("issue.create"),
    projectUrl,
    title,
    description: Type.Optional(description),
    labels: Type.Optional(labels),
    assigneeIds: Type.Optional(ids),
    milestoneId: Type.Optional(iid),
    dueDate: Type.Optional(date),
  }),
  closed({
    action: Type.Literal("issue.update"),
    projectUrl,
    iid,
    expectedUpdatedAt: observedAt,
    title: Type.Optional(title),
    description: Type.Optional(description),
    addLabels: Type.Optional(labels),
    removeLabels: Type.Optional(labels),
    assigneeIds: Type.Optional(ids),
    milestoneId: Type.Optional(Type.Union([iid, Type.Null()])),
    dueDate: Type.Optional(Type.Union([date, Type.Null()])),
  }),
  closed({ action: Type.Literal("issue.close"), projectUrl, iid, expectedUpdatedAt: observedAt }),
  closed({ action: Type.Literal("issue.reopen"), projectUrl, iid, expectedUpdatedAt: observedAt }),
  closed({ action: Type.Literal("issue.link.list"), projectUrl, iid, page: Type.Optional(page) }),
  closed({
    action: Type.Literal("issue.link.create"),
    projectUrl,
    iid,
    targetProjectUrl: projectUrl,
    targetIid: iid,
    relation: linkRelation,
  }),
  closed({ action: Type.Literal("issue.time.get"), projectUrl, iid }),
  closed({
    action: Type.Literal("issue.time.add"),
    projectUrl,
    iid,
    duration: Type.String({
      minLength: 2,
      maxLength: 64,
      pattern: "^(?:[1-9][0-9]*(?:mo|w|d|h|m|s))+$",
    }),
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  }),
  closed({ action: Type.Literal("mr.get"), projectUrl, iid }),
  closed({ action: Type.Literal("note.list"), projectUrl, target, iid, page: Type.Optional(page) }),
  closed({ action: Type.Literal("note.create"), projectUrl, target, iid, body: text }),
  closed({
    action: Type.Literal("note.update"),
    projectUrl,
    target,
    iid,
    noteId: iid,
    expectedBody: text,
    body: text,
  }),
  closed({
    action: Type.Literal("note.delete"),
    projectUrl,
    target,
    iid,
    noteId: iid,
    expectedBody: text,
  }),
  closed({
    action: Type.Literal("discussion.note.update"),
    projectUrl,
    target,
    iid,
    discussionId,
    noteId: iid,
    expectedBody: text,
    body: text,
  }),
  closed({
    action: Type.Literal("discussion.note.delete"),
    projectUrl,
    target,
    iid,
    discussionId,
    noteId: iid,
    expectedBody: text,
  }),
  closed({
    action: Type.Literal("discussion.list"),
    projectUrl,
    target,
    iid,
    page: Type.Optional(page),
  }),
  closed({ action: Type.Literal("discussion.create"), projectUrl, target, iid, body: text }),
  closed({
    action: Type.Literal("discussion.reply"),
    projectUrl,
    target,
    iid,
    discussionId,
    body: text,
  }),
  closed({
    action: Type.Literal("discussion.resolve"),
    projectUrl,
    target: Type.Literal("merge_request"),
    iid,
    discussionId,
    expectedResolved: Type.Literal(false),
  }),
  closed({
    action: Type.Literal("discussion.reopen"),
    projectUrl,
    target: Type.Literal("merge_request"),
    iid,
    discussionId,
    expectedResolved: Type.Literal(true),
  }),
  closed({
    action: Type.Literal("discussion.create_diff"),
    projectUrl,
    target: Type.Literal("merge_request"),
    iid,
    body: text,
    expectedHeadSha: sha,
    position: closed({
      oldPath: Type.String({ minLength: 1, maxLength: 1024 }),
      newPath: Type.String({ minLength: 1, maxLength: 1024 }),
      oldLine: Type.Optional(iid),
      newLine: Type.Optional(iid),
    }),
  }),
]);

export type GitLabIssueOperation = Static<typeof GitLabIssueOperationSchema>;

export function parseGitLabIssueOperation(value: unknown): GitLabIssueOperation | undefined {
  if (!Value.Check(GitLabIssueOperationSchema, value)) {
    return undefined;
  }
  // GitLab executes slash-command lines rather than saving them as comment text.
  // Keep this closed comment/metadata contract literal; state changes use typed actions.
  const body =
    "body" in value ? value.body : "description" in value ? value.description : undefined;
  if (typeof body === "string" && /^[\t ]*\/[a-z_]+(?:[\t ]|$)/imu.test(body)) {
    return undefined;
  }
  return value;
}

export function isGitLabIssueWrite(operation: GitLabIssueOperation): boolean {
  return ![
    "project.members",
    "project.labels",
    "project.milestones",
    "issue.list",
    "issue.get",
    "issue.link.list",
    "issue.time.get",
    "mr.get",
    "note.list",
    "discussion.list",
  ].includes(operation.action);
}
