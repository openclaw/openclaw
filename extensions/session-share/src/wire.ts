import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
  type SessionCatalogSourceProfileRelation,
  type SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const shortString = { type: "string", minLength: 1, maxLength: 512 };
const label = { type: "string", minLength: 1, maxLength: 200 };
const text = { type: "string", maxLength: 6000 };
const cursor = { type: "string", minLength: 1, maxLength: 2048, pattern: "^[A-Za-z0-9_-]+$" };
const identity = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "pluginId", "domain", "idKind", "id"],
      properties: {
        type: { const: "remote" },
        pluginId: shortString,
        domain: shortString,
        idKind: shortString,
        id: shortString,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "pluginId", "accountId", "senderKind", "id"],
      properties: {
        type: { const: "observation" },
        pluginId: { anyOf: [shortString, { type: "null" }] },
        accountId: { anyOf: [shortString, { type: "null" }] },
        senderKind: { enum: ["human", "bot", "unknown"] },
        id: shortString,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id"],
      properties: { type: { const: "agent" }, id: shortString },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "actorType", "source", "id"],
      properties: {
        type: { const: "legacy" },
        actorType: shortString,
        source: { anyOf: [shortString, { type: "null" }] },
        id: text,
      },
    },
  ],
};
const participant = {
  type: "object",
  additionalProperties: false,
  required: ["identity"],
  properties: { identity, label, avatarUrl: shortString },
};
const actor = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: { enum: ["human", "agent", "system"] },
    id: shortString,
    identity,
    label,
    avatarUrl: shortString,
  },
};
function sessionPageSchema(includeLinks: boolean, relationScoped: boolean): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sessions"],
    properties: {
      nextCursor: cursor,
      ...(relationScoped ? { relationUnresolved: { const: true } } : {}),
      sessions: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["threadId", "status", "archived", "canContinue", "canArchive"],
          properties: {
            threadId: shortString,
            ...(includeLinks
              ? { originalPath: { type: "string", minLength: 1, maxLength: 2048 } }
              : {}),
            name: text,
            color: shortString,
            cwd: text,
            status: { enum: ["live", "idle", "archived"] },
            createdAt: { type: "number" },
            updatedAt: { type: "number" },
            recencyAt: { type: "number" },
            gitBranch: text,
            archived: { type: "boolean" },
            createdActor: actor,
            canContinue: { const: false },
            canArchive: { const: false },
            canOpenTerminal: { const: false },
          },
        },
      },
    },
  };
}
const sessionPageSchemas = {
  plain: sessionPageSchema(false, false),
  plainScoped: sessionPageSchema(false, true),
  linked: sessionPageSchema(true, false),
  linkedScoped: sessionPageSchema(true, true),
};
const transcriptPageSchema: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["threadId", "items"],
  properties: {
    threadId: shortString,
    nextCursor: cursor,
    items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            enum: ["userMessage", "agentMessage", "reasoning", "toolCall", "toolResult", "other"],
          },
          id: shortString,
          text,
          timestamp: shortString,
          model: shortString,
          sender: participant,
          truncated: { type: "boolean" },
        },
      },
    },
  },
};
export type SessionShareSession = SessionCatalogSession & { originalPath?: string };
type SessionSharePage = {
  sessions: SessionShareSession[];
  nextCursor?: string;
  /** The source could not resolve the requested relation target; the receiver filters client-side. */
  relationUnresolved?: true;
};
type SessionShareTranscriptPage = {
  threadId: string;
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

function isSessionPage(
  value: unknown,
  includeLinks: boolean,
  relationScoped: boolean,
): value is SessionSharePage {
  const name = `${includeLinks ? "linked" : "plain"}${relationScoped ? "-scoped" : ""}`;
  const schema = includeLinks
    ? relationScoped
      ? sessionPageSchemas.linkedScoped
      : sessionPageSchemas.linked
    : relationScoped
      ? sessionPageSchemas.plainScoped
      : sessionPageSchemas.plain;
  return validateJsonSchemaValue({ schema, cacheKey: `session-share.sessions.${name}.v1`, value })
    .ok;
}

function isTranscriptPage(value: unknown): value is SessionShareTranscriptPage {
  return validateJsonSchemaValue({
    schema: transcriptPageSchema,
    cacheKey: "session-share.transcript.v1",
    value,
  }).ok;
}

function unwrapPayload(value: unknown): unknown {
  if (isRecord(value) && typeof value.payloadJSON === "string") {
    if (value.payloadJSON.length > 2 * 1024 * 1024) {
      throw new Error("Session catalog response exceeded the page limit");
    }
    return JSON.parse(value.payloadJSON);
  }
  return value;
}

// The wire vocabulary deliberately excludes profile identities and local sessionKey.
// Only the receiver's explicit binding may turn a paired node claim into local attribution.
export function parseSessionSharePage(
  raw: unknown,
  includeLinks = false,
  query?: SessionCatalogSourceProfileRelation,
): SessionSharePage {
  const value = unwrapPayload(raw);
  if (
    !isSessionPage(value, includeLinks, query !== undefined) ||
    (value.nextCursor !== undefined && !sessionCatalogPaging.isExactCursor(value.nextCursor, query))
  ) {
    throw new Error("Invalid OpenClaw session page from paired node");
  }
  return value;
}

export function parseSessionShareTranscriptPage(
  raw: unknown,
  threadId: string,
): SessionShareTranscriptPage {
  const value = unwrapPayload(raw);
  if (!isTranscriptPage(value) || value.threadId !== threadId) {
    throw new Error("Invalid OpenClaw chat history page from paired node");
  }
  return value;
}
