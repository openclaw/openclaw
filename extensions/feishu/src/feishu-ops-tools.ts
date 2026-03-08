/**
 * Register Feishu Ops tools: contacts, groups, send, calendar.
 *
 * These expose the functionality from contacts.ts, groups.ts,
 * proactive-send.ts, and calendar.ts as callable agent tools.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { searchContactsOrSync } from "./contacts.js";
import { listGroupsOrSync, searchGroupsOrSync } from "./groups.js";
import { sendTextMessage, sendFileMessage, sendMentionAll } from "./proactive-send.js";
import { createCalendarEvent } from "./calendar.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ContactsSchema = Type.Object({
  action: Type.Unsafe<"search">(
    { type: "string", enum: ["search"], description: "Action: search" },
  ),
  keyword: Type.String({ description: "Name, English name, or email to search for" }),
});
type ContactsParams = Static<typeof ContactsSchema>;

const GroupsSchema = Type.Object({
  action: Type.Unsafe<"list" | "search">(
    { type: "string", enum: ["list", "search"], description: "Action: list | search" },
  ),
  keyword: Type.Optional(Type.String({ description: "Group name keyword to search (required for search action)" })),
});
type GroupsParams = Static<typeof GroupsSchema>;

const SendSchema = Type.Object({
  action: Type.Unsafe<"text" | "file" | "mention_all">(
    { type: "string", enum: ["text", "file", "mention_all"], description: "Send action: text | file | mention_all" },
  ),
  receive_id: Type.String({ description: "Recipient ID (open_id for user, chat_id for group)" }),
  receive_id_type: Type.Unsafe<"open_id" | "chat_id">(
    { type: "string", enum: ["open_id", "chat_id"], description: "ID type: open_id (user) | chat_id (group)" },
  ),
  text: Type.Optional(Type.String({ description: "Message text (required for text and mention_all actions)" })),
  file_path: Type.Optional(Type.String({ description: "Local file path to send (required for file action)" })),
});
type SendParams = Static<typeof SendSchema>;

const CalendarSchema = Type.Object({
  action: Type.Unsafe<"create">(
    { type: "string", enum: ["create"], description: "Action: create" },
  ),
  summary: Type.String({ description: "Event title" }),
  start_timestamp: Type.String({ description: "Start time as Unix timestamp in seconds (e.g. '1741402800')" }),
  end_timestamp: Type.String({ description: "End time as Unix timestamp in seconds" }),
  description: Type.Optional(Type.String({ description: "Event description" })),
  attendee_open_ids: Type.Optional(Type.Array(Type.String(), { description: "List of attendee open_ids to invite" })),
});
type CalendarParams = Static<typeof CalendarSchema>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFeishuOpsTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_ops: No config available, skipping ops tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_ops: No Feishu accounts configured, skipping ops tools");
    return;
  }

  const registered: string[] = [];

  // --- feishu_contacts ---
  api.registerTool(
    {
      name: "feishu_contacts",
      label: "Feishu Contacts",
      description:
        "Search Feishu organization contacts by name, English name, or email to get their open_id. " +
        "Use this tool FIRST when the user asks to send a message to someone, schedule a meeting, " +
        "or look up a person. Returns open_id needed by feishu_send and feishu_calendar. " +
        "Auto-syncs from API if not found locally.",
      parameters: ContactsSchema,
      async execute(_toolCallId, params) {
        const p = params as ContactsParams;
        try {
          const result = await searchContactsOrSync({
            keyword: p.keyword,
            cfg: api.config!,
            log: (msg) => api.logger.info?.(msg),
          });
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_contacts" },
  );
  registered.push("feishu_contacts");

  // --- feishu_groups ---
  api.registerTool(
    {
      name: "feishu_groups",
      label: "Feishu Groups",
      description:
        "List or search Feishu groups (chats) the bot is a member of. " +
        "Use this tool when the user wants to send a message to a group. " +
        "Returns chat_id needed by feishu_send. " +
        "If search finds no match, tells the user to add the bot to the target group first.",
      parameters: GroupsSchema,
      async execute(_toolCallId, params) {
        const p = params as GroupsParams;
        try {
          if (p.action === "search") {
            if (!p.keyword) {
              return json({ error: "keyword is required for search action" });
            }
            return json(
              await searchGroupsOrSync({
                keyword: p.keyword,
                cfg: api.config!,
                log: (msg) => api.logger.info?.(msg),
              }),
            );
          }
          // action === "list"
          return json(
            await listGroupsOrSync({
              cfg: api.config!,
              log: (msg) => api.logger.info?.(msg),
            }),
          );
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_groups" },
  );
  registered.push("feishu_groups");

  // --- feishu_send ---
  api.registerTool(
    {
      name: "feishu_send",
      label: "Feishu Send",
      description:
        "Send messages to Feishu users or groups proactively. " +
        "IMPORTANT: Before using this tool, resolve the recipient ID first: " +
        "use feishu_contacts to get open_id (for users) or feishu_groups to get chat_id (for groups). " +
        "Actions: text (send text), file (upload and send file), mention_all (send @all in group).",
      parameters: SendSchema,
      async execute(_toolCallId, params) {
        const p = params as SendParams;
        try {
          switch (p.action) {
            case "text":
              if (!p.text) return json({ error: "text is required for text action" });
              return json(
                await sendTextMessage({
                  cfg: api.config!,
                  receiveId: p.receive_id,
                  receiveIdType: p.receive_id_type,
                  text: p.text,
                  log: (msg) => api.logger.info?.(msg),
                }),
              );
            case "file":
              if (!p.file_path) return json({ error: "file_path is required for file action" });
              return json(
                await sendFileMessage({
                  cfg: api.config!,
                  receiveId: p.receive_id,
                  receiveIdType: p.receive_id_type,
                  filePath: p.file_path,
                  log: (msg) => api.logger.info?.(msg),
                }),
              );
            case "mention_all":
              if (!p.text) return json({ error: "text is required for mention_all action" });
              return json(
                await sendMentionAll({
                  cfg: api.config!,
                  chatId: p.receive_id,
                  text: p.text,
                  log: (msg) => api.logger.info?.(msg),
                }),
              );
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_send" },
  );
  registered.push("feishu_send");

  // --- feishu_calendar ---
  api.registerTool(
    {
      name: "feishu_calendar",
      label: "Feishu Calendar",
      description:
        "Create Feishu calendar events and invite attendees. " +
        "Use feishu_contacts first to resolve attendee names to open_ids. " +
        "Timestamps are Unix seconds as strings.",
      parameters: CalendarSchema,
      async execute(_toolCallId, params) {
        const p = params as CalendarParams;
        try {
          return json(
            await createCalendarEvent({
              cfg: api.config!,
              event: {
                summary: p.summary,
                startTimestamp: p.start_timestamp,
                endTimestamp: p.end_timestamp,
                description: p.description,
                attendeeOpenIds: p.attendee_open_ids,
              },
              log: (msg) => api.logger.info?.(msg),
            }),
          );
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_calendar" },
  );
  registered.push("feishu_calendar");

  api.logger.info?.(`feishu_ops: Registered ${registered.join(", ")}`);
}
