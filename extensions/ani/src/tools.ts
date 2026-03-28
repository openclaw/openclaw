import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AniAttachment } from "./monitor/send.js";
import type { ChannelAgentTool } from "./sdk-compat.js";
import {
  createAniTask,
  deleteAniTask,
  getAniTask,
  listAniTasks,
  sendAniMessage,
  updateAniTask,
  uploadAniFile,
  type AniTask,
} from "./monitor/send.js";
import { resolveAniCredentials, getMimeType, messageTextOf } from "./utils.js";

const TASK_STATUS_VALUES = ["pending", "in_progress", "done", "cancelled", "handed_over"] as const;
const TASK_PRIORITY_VALUES = ["low", "medium", "high"] as const;

function formatTask(task: AniTask): string {
  const assignee =
    task.assignee?.display_name ??
    (task.assignee_id != null ? `#${task.assignee_id}` : "unassigned");
  const creator = task.creator?.display_name ?? `#${task.created_by}`;
  const due = task.due_date ? `, due ${task.due_date}` : "";
  const parent = task.parent_task_id != null ? `, parent #${task.parent_task_id}` : "";
  return [
    `#${task.id} ${task.title}`,
    `status=${task.status}, priority=${task.priority}, assignee=${assignee}, creator=${creator}${due}${parent}`,
    task.description?.trim() ? `description: ${task.description.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function validateTaskStatus(status: string | undefined): string | null {
  if (!status) return null;
  return TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])
    ? status
    : `Error: status must be one of ${TASK_STATUS_VALUES.join(", ")}`;
}

function validateTaskPriority(priority: string | undefined): string | null {
  if (!priority) return null;
  return TASK_PRIORITY_VALUES.includes(priority as (typeof TASK_PRIORITY_VALUES)[number])
    ? priority
    : `Error: priority must be one of ${TASK_PRIORITY_VALUES.join(", ")}`;
}

/**
 * Agent tool: ani_send_file
 *
 * Unified file sending tool — handles both generated text content and existing
 * files on disk. The tool auto-detects the mode based on which parameter is provided:
 *
 * - `file_path`: Read binary/text file from disk and send (for screenshots, PDFs, etc.)
 * - `content`: Create a new file from text content and send (for generated .md, .csv, etc.)
 *
 * If both are provided, `file_path` takes precedence.
 */
export function createSendFileTool(): ChannelAgentTool {
  return {
    label: "Send File to ANI",
    name: "ani_send_file",
    description: [
      "Send a file to the current ANI conversation as a downloadable attachment.",
      "Two modes: (1) provide file_path to send an existing file from disk (screenshot, PDF, image, etc.),",
      "or (2) provide content to create and send a new text file (.md, .csv, .json, etc.).",
      "You MUST provide conversation_id. Provide either file_path OR content (not both).",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID to send the file to",
      }),
      file_path: Type.Optional(
        Type.String({
          description: "Absolute path to an existing file on disk to send",
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description:
            "Filename with extension (required when using content mode, optional for file_path mode)",
        }),
      ),
      content: Type.Optional(
        Type.String({
          description: "Text content to create as a new file (for .md, .csv, .json, .txt, etc.)",
        }),
      ),
      caption: Type.Optional(
        Type.String({
          description: "Optional message text to accompany the file",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        file_path?: string;
        filename?: string;
        content?: string;
        caption?: string;
      };

      const conversationId = params.conversation_id;
      if (!conversationId) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }

      const filePath = params.file_path?.trim();
      const textContent = params.content;
      const caption = params.caption?.trim() ?? "";

      if (!filePath && !textContent) {
        return {
          content: [{ type: "text" as const, text: "Error: provide either file_path or content" }],
        };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        let buffer: Buffer;
        let filename: string;

        if (filePath) {
          // Mode 1: Read existing file from disk
          // Path traversal protection: restrict file access to the workspace directory
          const resolved = path.resolve(filePath);
          const workspace = process.cwd();
          if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Access denied: file must be within workspace (${workspace})`,
                },
              ],
            };
          }
          const stat = await fs.stat(resolved);
          if (!stat.isFile()) {
            return {
              content: [{ type: "text" as const, text: `Error: ${resolved} is not a file` }],
            };
          }
          if (stat.size > 32 * 1024 * 1024) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 32MB)`,
                },
              ],
            };
          }
          buffer = await fs.readFile(resolved);
          filename = params.filename?.trim() || path.basename(filePath);
        } else {
          // Mode 2: Create file from text content
          filename = params.filename?.trim() || "file.txt";
          buffer = Buffer.from(textContent!, "utf-8");
        }

        const mimeType = getMimeType(filename);

        // Upload to ANI backend
        const uploaded = await uploadAniFile({ serverUrl, apiKey, buffer, filename });

        // Determine attachment type from MIME
        let attachType = "file";
        if (mimeType.startsWith("image/")) attachType = "image";
        else if (mimeType.startsWith("audio/")) attachType = "audio";
        else if (mimeType.startsWith("video/")) attachType = "video";

        // Send message with attachment
        const attachments: AniAttachment[] = [
          {
            type: attachType,
            url: uploaded.url,
            filename: uploaded.filename,
            mime_type: mimeType,
            size: buffer.length,
          },
        ];

        const result = await sendAniMessage({
          serverUrl,
          apiKey,
          conversationId,
          text: caption || `📎 ${filename}`,
          attachments,
          contentType: attachType,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `File "${filename}" (${(buffer.length / 1024).toFixed(1)}KB, ${mimeType}) sent to conversation ${conversationId}. Message ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

/**
 * Agent tool: ani_fetch_chat_history_messages
 *
 * Fetch the FULL conversation history directly from the ANI platform.
 * This is different from sessions_history which only shows messages YOU received.
 * This tool returns ALL messages — including those between other participants,
 * messages sent while you were offline, and messages you were not @mentioned in.
 */
export function createGetHistoryTool(): ChannelAgentTool {
  return {
    label: "Fetch Chat Messages from ANI",
    name: "ani_fetch_chat_history_messages",
    description: [
      "Retrieve the full message history of an ANI conversation directly from the platform.",
      "Returns ALL messages including those you were NOT @mentioned in — human-to-human messages, other bots' replies, files shared while you were offline, etc.",
      "Use this when:",
      "- A user says 'look at what I sent earlier' or 'check the file I shared'",
      "- You need context about what happened in the group before you were @mentioned",
      "- You want to summarize the entire conversation, not just your interactions",
      "- sessions_history is missing messages you know exist",
      "Default: returns the 5 most recent messages. Use limit to get more (max 50).",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description:
          "The conversation ID to fetch messages from. You can find this in the system prompt under 'Current Conversation'.",
      }),
      limit: Type.Optional(
        Type.Number({
          description:
            "Number of messages to return. Default: 5, max: 50. Use 50 to get a fuller picture.",
          default: 5,
        }),
      ),
      since_id: Type.Optional(
        Type.Number({
          description:
            "Only return messages with ID greater than this value. Useful for incremental fetching — pass the ID of the last message you already have.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        limit?: number;
        since_id?: number;
      };

      const conversationId = params.conversation_id;
      if (!conversationId) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }

      const limit = Math.min(Math.max(params.limit ?? 5, 1), 50);

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        let url = `${serverUrl}/api/v1/conversations/${conversationId}/messages?limit=${limit}`;
        if (params.since_id) {
          url += `&since_id=${params.since_id}`;
        }

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          return {
            content: [
              { type: "text" as const, text: `Error fetching history: HTTP ${res.status}` },
            ],
          };
        }

        const json = (await res.json()) as { data?: { messages?: Array<Record<string, unknown>> } };
        const messages = json.data?.messages ?? [];

        // Format messages for LLM readability
        const formatted = messages
          .map((m: Record<string, unknown>) => {
            const sender =
              (m.sender as Record<string, unknown>)?.display_name ?? `entity-${m.sender_id}`;
            const text = messageTextOf({
              layers:
                (m.layers as { summary?: string; detail?: string; data?: unknown }) ?? undefined,
            });
            const time = m.created_at as string;
            const atts = (m.attachments as Array<Record<string, unknown>>) ?? [];
            const attDesc =
              atts.length > 0
                ? ` [${atts.length} attachment(s): ${atts.map((a) => a.filename ?? a.type).join(", ")}]`
                : "";
            return `[${time}] ${sender}: ${text}${attDesc}`;
          })
          .reverse(); // oldest first for readability

        return {
          content: [
            {
              type: "text" as const,
              text: `Conversation ${conversationId} — last ${messages.length} messages:\n\n${formatted.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

export function createListTasksTool(): ChannelAgentTool {
  return {
    label: "List ANI Conversation Tasks",
    name: "ani_list_conversation_tasks",
    description: [
      "List the current task roadmap for an ANI conversation.",
      "Use this to inspect task titles, assignees, priorities, parent dependencies, and statuses",
      "before planning work or reporting progress.",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID whose tasks should be listed.",
      }),
      status: Type.Optional(
        Type.String({
          description:
            "Optional status filter: pending, in_progress, done, cancelled, handed_over.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as { conversation_id?: number; status?: string };
      if (!params.conversation_id) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }
      const statusErr = validateTaskStatus(params.status);
      if (statusErr) {
        return { content: [{ type: "text" as const, text: statusErr }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        const tasks = await listAniTasks({
          serverUrl,
          apiKey,
          conversationId: params.conversation_id,
          status: params.status,
        });

        if (tasks.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Conversation ${params.conversation_id} has no tasks${params.status ? ` with status ${params.status}` : ""}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Conversation ${params.conversation_id} tasks (${tasks.length}):\n\n${tasks.map(formatTask).join("\n\n")}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing tasks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

export function createGetTaskTool(): ChannelAgentTool {
  return {
    label: "Get ANI Task Details",
    name: "ani_get_task",
    description: "Get the full details and current status for a single ANI task by task ID.",
    parameters: Type.Object({
      task_id: Type.Number({
        description: "The ANI task ID to retrieve.",
      }),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as { task_id?: number };
      if (!params.task_id) {
        return { content: [{ type: "text" as const, text: "Error: task_id is required" }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        const task = await getAniTask({ serverUrl, apiKey, taskId: params.task_id });
        return {
          content: [{ type: "text" as const, text: formatTask(task) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting task: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

export function createCreateTaskTool(): ChannelAgentTool {
  return {
    label: "Create ANI Task",
    name: "ani_create_task",
    description: [
      "Create a new task in the current ANI conversation roadmap.",
      "The ANI backend will enforce conversation membership and any existing task permissions.",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID where the task should be created.",
      }),
      title: Type.String({
        description: "Short task title.",
      }),
      description: Type.Optional(
        Type.String({
          description: "Optional detailed description.",
        }),
      ),
      assignee_id: Type.Optional(
        Type.Number({
          description: "Optional entity ID to assign the task to.",
        }),
      ),
      priority: Type.Optional(
        Type.String({
          description: "Optional priority: low, medium, or high.",
        }),
      ),
      due_date: Type.Optional(
        Type.String({
          description: "Optional due date as RFC3339 timestamp.",
        }),
      ),
      parent_task_id: Type.Optional(
        Type.Number({
          description: "Optional parent task ID for dependency trees.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        title?: string;
        description?: string;
        assignee_id?: number;
        priority?: string;
        due_date?: string;
        parent_task_id?: number;
      };

      if (!params.conversation_id) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }
      if (!params.title?.trim()) {
        return { content: [{ type: "text" as const, text: "Error: title is required" }] };
      }
      const priorityErr = validateTaskPriority(params.priority);
      if (priorityErr) {
        return { content: [{ type: "text" as const, text: priorityErr }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        const task = await createAniTask({
          serverUrl,
          apiKey,
          conversationId: params.conversation_id,
          title: params.title.trim(),
          description: params.description?.trim(),
          assignee_id: params.assignee_id,
          priority: params.priority,
          due_date: params.due_date,
          parent_task_id: params.parent_task_id,
        });
        return {
          content: [{ type: "text" as const, text: `Task created:\n${formatTask(task)}` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating task: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

export function createUpdateTaskTool(): ChannelAgentTool {
  return {
    label: "Update ANI Task",
    name: "ani_update_task",
    description: [
      "Update an existing ANI task.",
      "Use this to change status, title, description, assignee, priority, due date, or sort order.",
      "The ANI backend enforces existing permissions for creator, assignee, and admin roles.",
    ].join(" "),
    parameters: Type.Object({
      task_id: Type.Number({
        description: "The ANI task ID to update.",
      }),
      title: Type.Optional(Type.String({ description: "Optional new task title." })),
      description: Type.Optional(Type.String({ description: "Optional new description." })),
      assignee_id: Type.Optional(Type.Number({ description: "Optional new assignee entity ID." })),
      status: Type.Optional(
        Type.String({
          description: "Optional new status: pending, in_progress, done, cancelled, handed_over.",
        }),
      ),
      priority: Type.Optional(
        Type.String({ description: "Optional new priority: low, medium, high." }),
      ),
      due_date: Type.Optional(
        Type.String({ description: "Optional new due date as RFC3339 timestamp." }),
      ),
      sort_order: Type.Optional(Type.Number({ description: "Optional new sort order integer." })),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        task_id?: number;
        title?: string;
        description?: string;
        assignee_id?: number;
        status?: string;
        priority?: string;
        due_date?: string;
        sort_order?: number;
      };

      if (!params.task_id) {
        return { content: [{ type: "text" as const, text: "Error: task_id is required" }] };
      }
      if (
        params.title === undefined &&
        params.description === undefined &&
        params.assignee_id === undefined &&
        params.status === undefined &&
        params.priority === undefined &&
        params.due_date === undefined &&
        params.sort_order === undefined
      ) {
        return {
          content: [{ type: "text" as const, text: "Error: provide at least one field to update" }],
        };
      }
      const statusErr = validateTaskStatus(params.status);
      if (statusErr) {
        return { content: [{ type: "text" as const, text: statusErr }] };
      }
      const priorityErr = validateTaskPriority(params.priority);
      if (priorityErr) {
        return { content: [{ type: "text" as const, text: priorityErr }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        const task = await updateAniTask({
          serverUrl,
          apiKey,
          taskId: params.task_id,
          title: params.title?.trim(),
          description: params.description?.trim(),
          assignee_id: params.assignee_id,
          status: params.status,
          priority: params.priority,
          due_date: params.due_date,
          sort_order: params.sort_order,
        });
        return {
          content: [{ type: "text" as const, text: `Task updated:\n${formatTask(task)}` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error updating task: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}

export function createDeleteTaskTool(): ChannelAgentTool {
  return {
    label: "Delete ANI Task",
    name: "ani_delete_task",
    description: [
      "Delete an ANI task by task ID.",
      "Use with care; the ANI backend still enforces creator/admin permissions.",
    ].join(" "),
    parameters: Type.Object({
      task_id: Type.Number({
        description: "The ANI task ID to delete.",
      }),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as { task_id?: number };
      if (!params.task_id) {
        return { content: [{ type: "text" as const, text: "Error: task_id is required" }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        await deleteAniTask({ serverUrl, apiKey, taskId: params.task_id });
        return {
          content: [{ type: "text" as const, text: `Task #${params.task_id} deleted.` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error deleting task: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  };
}
