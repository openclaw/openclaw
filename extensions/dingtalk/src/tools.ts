/**
 * 钉钉 Agent Tool 注册
 *
 * 将待办、日程、文档能力注册为 AI Agent 可调用的 tool，
 * 让 AI 在对话中自动识别用户意图并调用对应的钉钉 API。
 *
 * 参照 extensions/feishu/src/wiki.ts 的注册模式。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/dingtalk";
import {
  listApprovalTemplates,
  createApprovalInstance,
  getApprovalInstance,
  listApprovalInstances,
} from "./approval-management.js";
import { DingtalkApprovalSchema, type DingtalkApprovalParams } from "./approval-tool-schema.js";
import {
  getAttendanceRecords,
  getAttendanceStatus,
  getLeaveRecords,
} from "./attendance-management.js";
import {
  DingtalkAttendanceSchema,
  type DingtalkAttendanceParams,
} from "./attendance-tool-schema.js";
import {
  renderEventCard,
  renderEventListCard,
  renderEventCreatedCard,
  renderEventUpdatedCard,
  renderEventDeletedCard,
} from "./calendar-card.js";
import {
  createCalendarEvent,
  getCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
} from "./calendar-management.js";
import { DingtalkCalendarSchema, type DingtalkCalendarParams } from "./calendar-tool-schema.js";
import type { DingtalkConfig } from "./config.js";
import {
  listDepartments,
  getDepartment,
  listDepartmentUsers,
  getUserInfo,
  getUserInfoByStaffId,
  getUserByAuthCode,
} from "./contact-management.js";
import { DingtalkContactSchema, type DingtalkContactParams } from "./contact-tool-schema.js";
import { createTopBox, closeTopBox } from "./coolapp-management.js";
import { DingtalkCoolAppSchema, type DingtalkCoolAppParams } from "./coolapp-tool-schema.js";
import {
  listDocSpaces,
  createDocument,
  getDocumentInfo,
  listDocNodes,
  deleteDocNode,
} from "./doc-management.js";
import { DingtalkDocSchema, type DingtalkDocParams } from "./doc-tool-schema.js";
import {
  listProjectSpaces,
  listProjectTasks,
  getProjectTask,
  createProjectTask,
  updateProjectTask,
} from "./project-management.js";
import { DingtalkProjectSchema, type DingtalkProjectParams } from "./project-tool-schema.js";
import {
  createTodoTask,
  getTodoTask,
  updateTodoTask,
  deleteTodoTask,
  updateTodoExecutorStatus,
  listTodoTasks,
} from "./todo-management.js";
import { DingtalkTodoSchema, type DingtalkTodoParams } from "./todo-tool-schema.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * 性能日志辅助函数
 * 创建一个计时器,用于测量操作耗时
 */
function createPerfTimer(label: string) {
  const startTime = Date.now();
  return {
    end: (logger?: { info?: (msg: string) => void }) => {
      const elapsed = Date.now() - startTime;
      logger?.info?.(`[PERF] ${label}: ${elapsed}ms`);
      return elapsed;
    },
  };
}

function resolveDingtalkConfig(api: OpenClawPluginApi): DingtalkConfig | undefined {
  const config = api.config as Record<string, unknown> | undefined;
  const channels = config?.channels as Record<string, unknown> | undefined;
  return channels?.dingtalk as DingtalkConfig | undefined;
}

/**
 * Resolve the effective user ID for tool operations.
 * Priority: explicit param > config.operatorUserId.
 * Returns null when neither is available so callers can return an error.
 */
function resolveUserId(
  paramUserId: string | undefined,
  dingtalkCfg: DingtalkConfig,
): string | null {
  return paramUserId || dingtalkCfg.operatorUserId || null;
}

// ============ Tool Registration ============

/**
 * 注册钉钉待办 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来创建、查询、完成待办任务。
 * 用户只需自然语言描述，如"帮我创建一个明天的待办：提交周报"。
 */
function registerTodoTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_todo",
      label: "DingTalk Todo",
      description:
        "Manage DingTalk todo tasks. Actions: create (new task), list (all tasks), get (task details), complete (mark done), update, delete. " +
        "IMPORTANT: due_time must be an ISO 8601 string. When the user says relative dates like 'tomorrow', calculate based on the server_time returned in the response. " +
        "user_id (DingTalk unionId) is optional if operatorUserId is configured.",
      parameters: DingtalkTodoSchema,
      async execute(_toolCallId, params) {
        const todoParams = params as DingtalkTodoParams;
        const userId = resolveUserId(todoParams.user_id, dingtalkCfg);
        const totalTimer = createPerfTimer(`dingtalk_todo total`);

        if (!userId) {
          totalTimer.end(api.logger);
          return json({
            error:
              "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
          });
        }
        try {
          switch (todoParams.action) {
            case "create": {
              const actionTimer = createPerfTimer(`dingtalk_todo create`);
              if (!todoParams.subject) {
                totalTimer.end(api.logger);
                return json({ error: "subject is required for creating a todo task" });
              }
              const serverNow = new Date();
              const serverTimeCST = serverNow.toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
              const dueTimeMs = todoParams.due_time
                ? new Date(todoParams.due_time).getTime()
                : undefined;
              const dueTimeResolved = dueTimeMs
                ? new Date(dueTimeMs).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    weekday: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })
                : undefined;
              const task = await createTodoTask(dingtalkCfg, userId, {
                subject: todoParams.subject,
                description: todoParams.description,
                dueTime: dueTimeMs,
                priority: todoParams.priority
                  ? (Number(todoParams.priority) as 10 | 20 | 30 | 40)
                  : undefined,
                executorIds: todoParams.executor_ids,
              });
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json({
                success: true,
                task,
                server_time: serverTimeCST,
                due_time_resolved: dueTimeResolved,
              });
            }
            case "list": {
              const actionTimer = createPerfTimer(`dingtalk_todo list`);
              const result = await listTodoTasks(dingtalkCfg, userId);
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json(result);
            }
            case "get": {
              const actionTimer = createPerfTimer(`dingtalk_todo get`);
              if (!todoParams.task_id) {
                totalTimer.end(api.logger);
                return json({ error: "task_id is required for getting a todo task" });
              }
              const task = await getTodoTask(dingtalkCfg, userId, todoParams.task_id);
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json(task);
            }
            case "complete": {
              const actionTimer = createPerfTimer(`dingtalk_todo complete`);
              if (!todoParams.task_id) {
                totalTimer.end(api.logger);
                return json({ error: "task_id is required for completing a todo task" });
              }
              await updateTodoExecutorStatus(dingtalkCfg, userId, todoParams.task_id, [
                { id: userId, isDone: true },
              ]);
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json({ success: true, message: "Task marked as complete" });
            }
            case "update": {
              const actionTimer = createPerfTimer(`dingtalk_todo update`);
              if (!todoParams.task_id) {
                totalTimer.end(api.logger);
                return json({ error: "task_id is required for updating a todo task" });
              }
              const updated = await updateTodoTask(dingtalkCfg, userId, todoParams.task_id, {
                subject: todoParams.subject,
                description: todoParams.description,
                dueTime: todoParams.due_time ? new Date(todoParams.due_time).getTime() : undefined,
                priority: todoParams.priority
                  ? (Number(todoParams.priority) as 10 | 20 | 30 | 40)
                  : undefined,
                executorIds: todoParams.executor_ids,
                done: todoParams.done,
              });
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json({ success: true, task: updated });
            }
            case "delete": {
              const actionTimer = createPerfTimer(`dingtalk_todo delete`);
              if (!todoParams.task_id) {
                totalTimer.end(api.logger);
                return json({ error: "task_id is required for deleting a todo task" });
              }
              await deleteTodoTask(dingtalkCfg, userId, todoParams.task_id);
              actionTimer.end(api.logger);
              totalTimer.end(api.logger);
              return json({ success: true, message: "Task deleted" });
            }
            default:
              totalTimer.end(api.logger);
              return json({ error: `Unknown action: ${todoParams.action}` });
          }
        } catch (err) {
          totalTimer.end(api.logger);
          api.logger.info?.(
            `[PERF] dingtalk_todo error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_todo" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_todo tool");
}

/**
 * 注册钉钉日程 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来创建、查询日程。
 * 用户只需自然语言描述，如"下周三下午2点安排一个项目评审会，1小时"。
 */
function registerCalendarTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_calendar",
      label: "DingTalk Calendar",
      description:
        "Manage DingTalk calendar events. Actions: create (new event), list (upcoming events), get (event details), update, delete. " +
        "IMPORTANT: Times must be ISO 8601 with timezone, e.g. 2024-12-31T14:00:00+08:00. When the user says relative dates like 'tomorrow', calculate based on the server_time returned in the response. " +
        "user_id (DingTalk unionId) is optional if operatorUserId is configured.",
      parameters: DingtalkCalendarSchema,
      async execute(_toolCallId, params) {
        const calParams = params as DingtalkCalendarParams;
        const userId = resolveUserId(calParams.user_id, dingtalkCfg);
        if (!userId) {
          return json({
            error:
              "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
          });
        }
        try {
          switch (calParams.action) {
            case "create": {
              if (!calParams.summary || !calParams.start_time || !calParams.end_time) {
                return json({
                  error: "summary, start_time, and end_time are required for creating an event",
                });
              }
              const calendarTimezone = "Asia/Shanghai";
              const event = await createCalendarEvent(dingtalkCfg, userId, {
                summary: calParams.summary,
                description: calParams.description,
                start: {
                  dateTime: calParams.start_time,
                  timeZone: calendarTimezone,
                },
                end: {
                  dateTime: calParams.end_time,
                  timeZone: calendarTimezone,
                },
                location: calParams.location,
                isAllDay: calParams.is_all_day,
                attendees: calParams.attendee_ids?.map((id) => ({ id })),
                reminders: calParams.reminder_minutes
                  ? [{ method: "dingtalk", minutes: calParams.reminder_minutes }]
                  : undefined,
              });
              const calServerNow = new Date();
              const calServerTimeCST = calServerNow.toLocaleString("zh-CN", {
                timeZone: calendarTimezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                weekday: "long",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
              return json({
                success: true,
                event,
                server_time: calServerTimeCST,
                card: renderEventCreatedCard(event),
              });
            }
            case "list": {
              const result = await listCalendarEvents(dingtalkCfg, userId);
              return json({
                ...result,
                card: renderEventListCard(result),
              });
            }
            case "get": {
              if (!calParams.event_id) {
                return json({ error: "event_id is required for getting an event" });
              }
              const event = await getCalendarEvent(dingtalkCfg, userId, calParams.event_id);
              return json({
                ...event,
                card: renderEventCard(event),
              });
            }
            case "update": {
              if (!calParams.event_id) {
                return json({ error: "event_id is required for updating an event" });
              }
              const updated = await updateCalendarEvent(dingtalkCfg, userId, calParams.event_id, {
                summary: calParams.summary,
                description: calParams.description,
                start: calParams.start_time
                  ? {
                      dateTime: calParams.start_time,
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    }
                  : undefined,
                end: calParams.end_time
                  ? {
                      dateTime: calParams.end_time,
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    }
                  : undefined,
                location: calParams.location,
                isAllDay: calParams.is_all_day,
                attendees: calParams.attendee_ids?.map((id) => ({ id })),
                reminders: calParams.reminder_minutes
                  ? [{ method: "dingtalk", minutes: calParams.reminder_minutes }]
                  : undefined,
              });
              return json({
                success: true,
                event: updated,
                card: renderEventUpdatedCard(updated),
              });
            }
            case "delete": {
              if (!calParams.event_id) {
                return json({ error: "event_id is required for deleting an event" });
              }
              await deleteCalendarEvent(dingtalkCfg, userId, calParams.event_id);
              return json({
                success: true,
                message: "Event deleted",
                card: renderEventDeletedCard(),
              });
            }
            default:
              return json({ error: `Unknown action: ${calParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_calendar" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_calendar tool");
}

/**
 * 注册钉钉文档 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来管理知识库和文档。
 * 用户只需自然语言描述，如"在知识库里新建一个文档叫项目周报"。
 */
function registerDocTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_doc",
      label: "DingTalk Doc",
      description:
        "Manage DingTalk knowledge base documents. Actions: spaces (list knowledge bases), create (new document), " +
        "list_nodes (list documents in a space), get (document info), delete. " +
        "user_id (DingTalk unionId) is optional if operatorUserId is configured.",
      parameters: DingtalkDocSchema,
      async execute(_toolCallId, params) {
        const docParams = params as DingtalkDocParams;
        const userId = resolveUserId(docParams.user_id, dingtalkCfg);
        if (!userId) {
          return json({
            error:
              "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
          });
        }
        try {
          switch (docParams.action) {
            case "spaces": {
              const result = await listDocSpaces(dingtalkCfg, userId);
              return json(result);
            }
            case "create": {
              if (!docParams.space_id || !docParams.name) {
                return json({
                  error: "space_id and name are required for creating a document",
                });
              }
              const doc = await createDocument(dingtalkCfg, userId, docParams.space_id, {
                name: docParams.name,
                docType: docParams.doc_type ?? "alidoc",
                parentNodeId: docParams.parent_node_id,
              });
              return json({ success: true, document: doc });
            }
            case "list_nodes": {
              if (!docParams.space_id) {
                return json({ error: "space_id is required for listing nodes" });
              }
              const result = await listDocNodes(dingtalkCfg, userId, docParams.space_id, {
                parentNodeId: docParams.parent_node_id,
              });
              return json(result);
            }
            case "get": {
              if (!docParams.space_id || !docParams.node_id) {
                return json({
                  error: "space_id and node_id are required for getting document info",
                });
              }
              const info = await getDocumentInfo(
                dingtalkCfg,
                userId,
                docParams.space_id,
                docParams.node_id,
              );
              return json(info);
            }
            case "delete": {
              if (!docParams.space_id || !docParams.node_id) {
                return json({ error: "space_id and node_id are required for deleting a document" });
              }
              await deleteDocNode(dingtalkCfg, userId, docParams.space_id, docParams.node_id);
              return json({ success: true, message: "Document deleted" });
            }
            default:
              return json({ error: `Unknown action: ${docParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_doc" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_doc tool");
}

// ============ Contact Tool ============

/**
 * 注册钉钉通讯录 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来查询企业通讯录信息。
 * 用户只需自然语言描述，如"查一下研发部有哪些人"。
 */
function registerContactTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_contact",
      label: "DingTalk Contact",
      description:
        "Query DingTalk enterprise contacts. Actions: list_departments (sub-departments), get_department (details), list_users (users in department), get_user (user details by unionId), get_user_by_staff_id (user details by staffId/userid via legacy API, returns full profile including unionid, name, department, job number), get_user_by_auth_code (get user info via JSAPI auth code). " +
        "Use department_id='1' for root department.",
      parameters: DingtalkContactSchema,
      async execute(_toolCallId, params) {
        const contactParams = params as DingtalkContactParams;
        try {
          switch (contactParams.action) {
            case "list_departments": {
              const departmentId = contactParams.department_id ?? "1";
              const result = await listDepartments(dingtalkCfg, departmentId);
              return json(result);
            }
            case "get_department": {
              if (!contactParams.department_id) {
                return json({ error: "department_id is required for get_department" });
              }
              const dept = await getDepartment(dingtalkCfg, contactParams.department_id);
              return json(dept);
            }
            case "list_users": {
              if (!contactParams.department_id) {
                return json({ error: "department_id is required for list_users" });
              }
              const result = await listDepartmentUsers(
                dingtalkCfg,
                contactParams.department_id,
                contactParams.cursor,
                contactParams.size,
              );
              return json(result);
            }
            case "get_user": {
              if (!contactParams.user_id) {
                return json({ error: "user_id is required for get_user" });
              }
              const user = await getUserInfo(dingtalkCfg, contactParams.user_id);
              return json(user);
            }
            case "get_user_by_staff_id": {
              if (!contactParams.staff_id) {
                return json({ error: "staff_id is required for get_user_by_staff_id" });
              }
              const staffUser = await getUserInfoByStaffId(dingtalkCfg, contactParams.staff_id);
              return json(staffUser);
            }
            case "get_user_by_auth_code": {
              if (!contactParams.auth_code) {
                return json({ error: "auth_code is required for get_user_by_auth_code" });
              }
              const authCodeUser = await getUserByAuthCode(dingtalkCfg, contactParams.auth_code);
              return json(authCodeUser);
            }
            default:
              return json({ error: `Unknown action: ${contactParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_contact" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_contact tool");
}

// ============ Attendance Tool ============

/**
 * 注册钉钉考勤 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来查询考勤数据。
 * 用户只需自然语言描述，如"查一下我昨天的打卡记录"。
 */
function registerAttendanceTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_attendance",
      label: "DingTalk Attendance",
      description:
        "Query DingTalk attendance data. Actions: get_records (punch/clock-in records), get_status (attendance results/status), get_leave_records (leave/time-off records). " +
        "Dates must be in YYYY-MM-DD format.",
      parameters: DingtalkAttendanceSchema,
      async execute(_toolCallId, params) {
        const attParams = params as DingtalkAttendanceParams;
        try {
          switch (attParams.action) {
            case "get_records": {
              if (!attParams.user_ids?.length || !attParams.start_date || !attParams.end_date) {
                return json({
                  error: "user_ids, start_date, and end_date are required for get_records",
                });
              }
              const result = await getAttendanceRecords(
                dingtalkCfg,
                attParams.user_ids,
                attParams.start_date,
                attParams.end_date,
              );
              return json(result);
            }
            case "get_status": {
              if (!attParams.user_ids?.length || !attParams.start_date || !attParams.end_date) {
                return json({
                  error: "user_ids, start_date, and end_date are required for get_status",
                });
              }
              const result = await getAttendanceStatus(
                dingtalkCfg,
                attParams.user_ids,
                attParams.start_date,
                attParams.end_date,
              );
              return json(result);
            }
            case "get_leave_records": {
              if (!attParams.start_date || !attParams.end_date) {
                return json({
                  error: "start_date and end_date are required for get_leave_records",
                });
              }
              const result = await getLeaveRecords(
                dingtalkCfg,
                attParams.start_date,
                attParams.end_date,
                attParams.offset,
                attParams.size,
              );
              return json(result);
            }
            default:
              return json({ error: `Unknown action: ${attParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_attendance" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_attendance tool");
}

// ============ Approval Tool ============

/**
 * 注册钉钉 OA 审批 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来管理审批流程。
 * 用户只需自然语言描述，如"帮我发起一个请假审批"。
 */
function registerApprovalTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_approval",
      label: "DingTalk Approval",
      description:
        "Manage DingTalk OA approval workflows. Actions: list_templates (available templates), create (start new approval), get (instance details), list (query instances by template). " +
        "user_id (DingTalk userId) is optional if operatorUserId is configured.",
      parameters: DingtalkApprovalSchema,
      async execute(_toolCallId, params) {
        const approvalParams = params as DingtalkApprovalParams;
        const userId = resolveUserId(approvalParams.user_id, dingtalkCfg);
        try {
          switch (approvalParams.action) {
            case "list_templates": {
              if (!userId) {
                return json({
                  error:
                    "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
                });
              }
              const result = await listApprovalTemplates(
                dingtalkCfg,
                userId,
                approvalParams.cursor,
                approvalParams.size,
              );
              return json(result);
            }
            case "create": {
              if (!userId) {
                return json({
                  error:
                    "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
                });
              }
              if (
                !approvalParams.process_code ||
                !approvalParams.department_id ||
                !approvalParams.form_values?.length
              ) {
                return json({
                  error:
                    "process_code, department_id, and form_values are required for creating an approval",
                });
              }
              const result = await createApprovalInstance(
                dingtalkCfg,
                userId,
                approvalParams.process_code,
                approvalParams.department_id,
                approvalParams.form_values,
                approvalParams.approvers,
              );
              return json({ success: true, ...result });
            }
            case "get": {
              if (!approvalParams.instance_id) {
                return json({ error: "instance_id is required for getting an approval instance" });
              }
              const result = await getApprovalInstance(dingtalkCfg, approvalParams.instance_id);
              return json(result);
            }
            case "list": {
              if (
                !approvalParams.process_code ||
                !approvalParams.start_time ||
                !approvalParams.end_time
              ) {
                return json({
                  error:
                    "process_code, start_time, and end_time are required for listing approval instances",
                });
              }
              const result = await listApprovalInstances(
                dingtalkCfg,
                approvalParams.process_code,
                approvalParams.start_time,
                approvalParams.end_time,
                approvalParams.cursor,
                approvalParams.size,
              );
              return json(result);
            }
            default:
              return json({ error: `Unknown action: ${approvalParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_approval" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_approval tool");
}

// ============ Project Tool ============

/**
 * 注册钉钉项目管理 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来管理项目任务。
 * 用户只需自然语言描述，如"在产品迭代项目里创建一个任务：完成登录页面设计"。
 */
function registerProjectTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_project",
      label: "DingTalk Project",
      description:
        "Manage DingTalk project tasks (Teambition). Actions: list_spaces (project spaces), list_tasks (tasks in project), get_task (task details), create_task (new task), update_task (modify task). " +
        "user_id (DingTalk userId) is optional if operatorUserId is configured.",
      parameters: DingtalkProjectSchema,
      async execute(_toolCallId, params) {
        const projParams = params as DingtalkProjectParams;
        const userId = resolveUserId(projParams.user_id, dingtalkCfg);
        if (!userId) {
          return json({
            error:
              "user_id is required. Either pass it explicitly or set operatorUserId in dingtalk config.",
          });
        }
        try {
          switch (projParams.action) {
            case "list_spaces": {
              const result = await listProjectSpaces(
                dingtalkCfg,
                userId,
                projParams.cursor,
                projParams.size,
              );
              return json(result);
            }
            case "list_tasks": {
              if (!projParams.space_id) {
                return json({ error: "space_id is required for list_tasks" });
              }
              const result = await listProjectTasks(
                dingtalkCfg,
                userId,
                projParams.space_id,
                projParams.cursor,
                projParams.size,
              );
              return json(result);
            }
            case "get_task": {
              if (!projParams.task_id) {
                return json({ error: "task_id is required for get_task" });
              }
              const task = await getProjectTask(dingtalkCfg, userId, projParams.task_id);
              return json(task);
            }
            case "create_task": {
              if (!projParams.space_id || !projParams.subject) {
                return json({
                  error: "space_id and subject are required for create_task",
                });
              }
              const task = await createProjectTask(dingtalkCfg, userId, projParams.space_id, {
                subject: projParams.subject,
                description: projParams.description,
                executorId: projParams.executor_id,
                dueDate: projParams.due_date,
                priority: projParams.priority ? Number(projParams.priority) : undefined,
              });
              return json({ success: true, task });
            }
            case "update_task": {
              if (!projParams.task_id) {
                return json({ error: "task_id is required for update_task" });
              }
              const task = await updateProjectTask(dingtalkCfg, userId, projParams.task_id, {
                subject: projParams.subject,
                description: projParams.description,
                executorId: projParams.executor_id,
                dueDate: projParams.due_date,
                priority: projParams.priority ? Number(projParams.priority) : undefined,
                isDone: projParams.done,
              });
              return json({ success: true, task });
            }
            default:
              return json({ error: `Unknown action: ${projParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_project" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_project tool");
}

// ============ CoolApp Tool ============

/**
 * 注册钉钉酷应用 Agent Tool
 *
 * AI 可以在对话中自动调用此 tool 来管理酷应用吊顶卡片。
 * 用户只需自然语言描述，如"在群里置顶一个项目进度卡片"。
 */
function registerCoolAppTool(api: OpenClawPluginApi, dingtalkCfg: DingtalkConfig) {
  api.registerTool(
    {
      name: "dingtalk_coolapp",
      label: "DingTalk CoolApp",
      description:
        "Manage DingTalk CoolApp features. Actions: create_topbox (create and pin an interactive card at the top of a group chat), close_topbox (remove a pinned TopBox card). " +
        "Requires coolAppCode from DingTalk developer console and a card template ID.",
      parameters: DingtalkCoolAppSchema,
      async execute(_toolCallId, params) {
        const coolAppParams = params as DingtalkCoolAppParams;
        try {
          switch (coolAppParams.action) {
            case "create_topbox": {
              if (!coolAppParams.card_template_id) {
                return json({ error: "card_template_id is required for create_topbox" });
              }
              const outTrackId = (() => {
                if (coolAppParams.out_track_id) return coolAppParams.out_track_id;
                const ts = Date.now();
                const rnd = Math.random().toString(36).slice(2, 10);
                return `topbox_${ts}_${rnd}`;
              })();

              let cardData: { cardParamMap: Record<string, string> } | undefined;
              if (coolAppParams.card_data) {
                try {
                  const parsed = JSON.parse(coolAppParams.card_data) as Record<string, string>;
                  cardData = { cardParamMap: parsed };
                } catch {
                  return json({ error: "card_data must be valid JSON" });
                }
              }

              const result = await createTopBox(dingtalkCfg, {
                cardTemplateId: coolAppParams.card_template_id,
                outTrackId,
                coolAppCode: coolAppParams.cool_app_code,
                openConversationId: coolAppParams.open_conversation_id,
                cardData,
                platforms: coolAppParams.platforms,
                callbackRouteKey: coolAppParams.callback_route_key,
              });
              return json({ success: true, outTrackId, ...result });
            }
            case "close_topbox": {
              if (!coolAppParams.out_track_id) {
                return json({ error: "out_track_id is required for close_topbox" });
              }
              await closeTopBox(dingtalkCfg, {
                openConversationId: coolAppParams.open_conversation_id,
                coolAppCode: coolAppParams.cool_app_code,
                outTrackId: coolAppParams.out_track_id,
              });
              return json({ success: true, message: "TopBox closed" });
            }
            default:
              return json({ error: `Unknown action: ${coolAppParams.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "dingtalk_coolapp" },
  );

  api.logger.info?.("dingtalk: Registered dingtalk_coolapp tool");
}

// ============ Public API ============

/**
 * 注册所有钉钉 Agent Tools
 *
 * 在插件 register() 中调用，将待办/日程/文档/通讯录/考勤/审批/项目/酷应用能力暴露给 AI Agent。
 * 仅在钉钉凭证已配置时注册。
 */
export function registerDingtalkTools(api: OpenClawPluginApi): void {
  const dingtalkCfg = resolveDingtalkConfig(api);
  if (!dingtalkCfg?.clientId || !dingtalkCfg?.clientSecret) {
    api.logger.debug?.("dingtalk: Credentials not configured, skipping tool registration");
    return;
  }

  registerTodoTool(api, dingtalkCfg);
  registerCalendarTool(api, dingtalkCfg);
  registerDocTool(api, dingtalkCfg);
  registerContactTool(api, dingtalkCfg);
  registerAttendanceTool(api, dingtalkCfg);
  registerApprovalTool(api, dingtalkCfg);
  registerProjectTool(api, dingtalkCfg);
  registerCoolAppTool(api, dingtalkCfg);
}
