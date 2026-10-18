import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { crmRequest } from "./client.js";
import {
  ACTIVITY_TYPE_TO_API,
  createConfig,
  nonEmptyString,
  readActivityType,
  readOptionalBoolean,
  readOptionalInteger,
  readCrmTextParam,
  readRequiredString,
  readTimelineFilter,
} from "./tool-schema.js";

export function crmLogActivityTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_log_activity",
    label: "CRM Log Activity",
    description:
      "Log a note, call, email, meeting, or task against a company, contact, or deal. A task requires a subject and may include dueAt.",
    parameters: Type.Object(
      {
        type: Type.Union(
          [
            Type.Literal("note"),
            Type.Literal("call"),
            Type.Literal("email"),
            Type.Literal("meeting"),
            Type.Literal("task"),
          ],
          { description: "Activity kind." },
        ),
        subject: Type.Optional(Type.String({ description: "Short subject; required for tasks." })),
        body: Type.Optional(Type.String({ description: "Activity body or task notes." })),
        occurredAt: Type.Optional(
          Type.String({ description: "When the activity happened (ISO 8601)." }),
        ),
        dueAt: Type.Optional(
          Type.String({ description: "Task due date (ISO 8601). Null clears it." }),
        ),
        companyId: Type.Optional(Type.String({ description: "Company id." })),
        contactId: Type.Optional(Type.String({ description: "Contact id." })),
        dealId: Type.Optional(Type.String({ description: "Deal id." })),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const type = readActivityType(args);
      const body: Record<string, unknown> = {
        type: ACTIVITY_TYPE_TO_API[type],
      };

      const subject = readCrmTextParam(args, "subject");
      if (subject !== undefined) {
        body.subject = subject;
      }
      const text = readCrmTextParam(args, "body");
      if (text !== undefined) {
        body.body = text;
      }
      const occurredAt = readCrmTextParam(args, "occurredAt");
      if (occurredAt !== undefined) {
        body.occurredAt = occurredAt;
      }
      const dueAt = readCrmTextParam(args, "dueAt");
      if (dueAt !== undefined) {
        body.dueAt = dueAt;
      }
      const companyId = readCrmTextParam(args, "companyId");
      if (companyId !== undefined) {
        body.companyId = companyId;
      }
      const contactId = readCrmTextParam(args, "contactId");
      if (contactId !== undefined) {
        body.contactId = contactId;
      }
      const dealId = readCrmTextParam(args, "dealId");
      if (dealId !== undefined) {
        body.dealId = dealId;
      }

      if (!body.companyId && !body.contactId && !body.dealId) {
        throw new Error("Provide companyId, contactId, or dealId.");
      }
      if (type === "task" && !body.subject) {
        throw new Error("A task needs a subject.");
      }

      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "POST",
          path: "/activities",
          body,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmTimelineTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_timeline",
    label: "CRM Timeline",
    description:
      "Read the activity timeline for a company, contact, or deal. Provide exactly one of companyId, contactId, or dealId.",
    parameters: Type.Object(
      {
        companyId: Type.Optional(Type.String({ description: "Company id." })),
        contactId: Type.Optional(Type.String({ description: "Contact id." })),
        dealId: Type.Optional(Type.String({ description: "Deal id." })),
        filter: Type.Optional(
          Type.Union(
            [
              Type.Literal("all"),
              Type.Literal("history"),
              Type.Literal("notes"),
              Type.Literal("upcoming"),
              Type.Literal("done"),
              Type.Literal("email"),
              Type.Literal("meetings"),
            ],
            { description: "Timeline filter (default all)." },
          ),
        ),
        cursor: Type.Optional(Type.String({ description: "nextCursor from a previous page." })),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Entries per page (default 30).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const query: Record<string, string | number | undefined> = {};

      for (const key of ["companyId", "contactId", "dealId"] as const) {
        const value = readCrmTextParam(args, key);
        if (value !== undefined) {
          query[key] = value;
        }
      }
      const anchors = ["companyId", "contactId", "dealId"].filter((key) => query[key]);
      if (anchors.length !== 1) {
        throw new Error("Provide exactly one of companyId, contactId, or dealId.");
      }

      const filter = readTimelineFilter(args);
      if (filter !== undefined) {
        query.filter = filter;
      }
      const cursor = readCrmTextParam(args, "cursor");
      if (cursor !== undefined) {
        query.cursor = cursor;
      }
      const limit = readOptionalInteger(args, "limit", { min: 1, max: 100 });
      if (limit !== undefined) {
        query.limit = limit;
      }

      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "GET",
          path: "/activities",
          query,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmMyTasksTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_my_tasks",
    label: "CRM My Tasks",
    description:
      "List the current user's open CRM tasks, optionally limited to overdue or upcoming.",
    parameters: Type.Object(
      {
        window: Type.Optional(
          Type.Union([Type.Literal("overdue"), Type.Literal("upcoming"), Type.Literal("all")], {
            description: "Task window (default all).",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: "Tasks to return (default 25).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const query: Record<string, string | number | undefined> = {};
      const window = readCrmTextParam(args, "window");
      if (window !== undefined && !["overdue", "upcoming", "all"].includes(window)) {
        throw new Error('window must be "overdue", "upcoming", or "all".');
      }
      if (window !== undefined) {
        query.window = window;
      }
      const limit = readOptionalInteger(args, "limit", { min: 1, max: 100 });
      if (limit !== undefined) {
        query.limit = limit;
      }

      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "GET",
          path: "/activities/my-tasks",
          query,
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}

export function crmCompleteActivityTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "crm_complete_activity",
    label: "CRM Complete Activity",
    description: "Mark a CRM task or activity complete, or reopen it.",
    parameters: Type.Object(
      {
        id: nonEmptyString("Activity id."),
        completed: Type.Optional(
          Type.Boolean({ description: "True marks complete (default true); false reopens." }),
        ),
      },
      { additionalProperties: false },
    ),
    resultContentSource: "network",
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const args = asOptionalRecord(params) ?? {};
      const id = readRequiredString(args, "id", "activity id");
      const completed = readOptionalBoolean(args, "completed") ?? true;
      return jsonResult(
        await crmRequest(createConfig(api), {
          method: "PATCH",
          path: `/activities/${encodeURIComponent(id)}/complete`,
          body: { completed },
          ...(signal ? { signal } : {}),
        }),
      );
    },
  };
}
