import { z } from "zod";
import { UserError } from "@/lib/errors";

export const WORKSPACES = ["golden", "ras", "mustadem", "anteja"] as const;

export const taskStatusSchema = z.enum([
  "inbox",
  "assigned",
  "in_progress",
  "review",
  "done",
]);

export const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const missionStatusSchema = z.enum([
  "active",
  "paused",
  "completed",
  "archived",
]);

export const workspaceSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9_-]+$/i, "workspace_id must be alphanumeric");

const safeString = (max: number, min = 1) =>
  z.string().trim().min(min).max(max);

const optionalDateSchema = z
  .union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD"),
    z.string().datetime(),
  ])
  .optional()
  .nullable();

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  mission_id: safeString(100).optional(),
  agent_id: safeString(100).optional(),
  workspace_id: workspaceSchema,
});

export const activityListQuerySchema = z.object({
  workspace_id: workspaceSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.string().trim().min(1).max(100).optional(),
});

export const createTaskSchema = z.object({
  title: safeString(500),
  description: z.string().max(50000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  mission_id: safeString(100).optional(),
  assigned_agent_id: safeString(100).optional(),
  employee_id: safeString(100).optional().nullable(),
  tags: z.array(safeString(64)).max(30).optional(),
  due_date: optionalDateSchema,
  cost_estimate: z.number().finite().nonnegative().optional().nullable(),
  workspace_id: workspaceSchema,
});

export const updateTaskSchema = z
  .object({
    id: safeString(100),
    title: safeString(500).optional(),
    description: z.string().max(50000).optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    mission_id: safeString(100).optional().nullable(),
    assigned_agent_id: safeString(100).optional().nullable(),
    employee_id: safeString(100).optional().nullable(),
    tags: z.array(safeString(64)).max(30).optional(),
    due_date: optionalDateSchema,
    cost_estimate: z.number().finite().nonnegative().optional().nullable(),
    workspace_id: workspaceSchema,
  })
  .refine(
    (payload) =>
      Object.keys(payload).some(
        (k) =>
          k !== "id" &&
          k !== "workspace_id" &&
          payload[k as keyof typeof payload] !== undefined
      ),
    "No fields to update"
  );

export const deleteTaskQuerySchema = z.object({
  id: safeString(100),
  workspace_id: workspaceSchema,
});

export const missionListQuerySchema = z.object({
  workspace_id: workspaceSchema,
});

export const createMissionSchema = z.object({
  name: safeString(200),
  description: z.string().max(50000).optional(),
  workspace_id: workspaceSchema,
});

export const updateMissionSchema = z.object({
  id: safeString(100),
  name: safeString(200).optional(),
  description: z.string().max(50000).optional(),
  status: missionStatusSchema.optional(),
  workspace_id: workspaceSchema,
});

export const deleteMissionQuerySchema = z.object({
  id: safeString(100),
  workspace_id: workspaceSchema,
});

export const dispatchTaskSchema = z.object({
  taskId: safeString(100),
  agentId: safeString(100),
  feedback: z.string().trim().min(1).max(100000).optional(),
  model: safeString(120).optional(),
  provider: safeString(120).optional(),
});

export const reworkTaskSchema = z.object({
  taskId: safeString(100),
  feedback: z.string().trim().min(1).max(100000),
});

export const commentsQuerySchema = z.object({
  taskId: safeString(100),
  workspace_id: workspaceSchema,
});

export const addCommentSchema = z.object({
  taskId: safeString(100),
  content: z.string().trim().min(1).max(100000),
  workspace_id: workspaceSchema,
});

export const approvalsResolveSchema = z.object({
  id: safeString(100),
  decision: z.enum(["approve", "reject"]),
});

export const approvalsAllowPatternSchema = z.object({
  action: z.literal("allow-pattern"),
  pattern: safeString(2000),
  agentId: safeString(100).optional(),
  approvalId: safeString(100).optional(),
  approveCurrent: z.boolean().optional(),
});

export const createAgentSchema = z.object({
  agentId: safeString(100),
});

export const specialistFeedbackSchema = z.object({
  agentId: safeString(120),
  taskId: safeString(120).optional(),
  rating: z.coerce.number().int().min(1).max(5),
  dimension: z
    .enum(["overall", "accuracy", "actionability", "depth", "communication"])
    .optional(),
  note: z.string().trim().max(4000).optional(),
});

export const specialistFeedbackQuerySchema = z.object({
  agentId: safeString(120).optional(),
  taskId: safeString(120).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const specialistRecommendationSchema = z.object({
  title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(50000).optional(),
  limit: z.coerce.number().int().positive().max(5).optional(),
  workspace_id: workspaceSchema,
});

export const specialistWorkspaceQuerySchema = z.object({
  workspace_id: workspaceSchema.optional(),
});

export const specialistSuggestionQuerySchema = z.object({
  workspace_id: workspaceSchema.optional(),
});

export const toolsCallSchema = z.object({
  tool: safeString(120),
  args: z.unknown().optional(),
});

const cronBase = z.object({
  action: z.enum(["add", "run", "update", "remove"]),
});

export const cronActionSchema = z.discriminatedUnion("action", [
  cronBase.extend({
    action: z.literal("add"),
    prompt: safeString(100000),
    schedule: safeString(120),
    agentId: safeString(100).optional(),
    sessionKey: safeString(200).optional(),
    enabled: z.boolean().optional(),
  }),
  cronBase.extend({
    action: z.literal("run"),
    id: safeString(100),
    mode: z.enum(["due", "force"]).optional(),
  }),
  cronBase.extend({
    action: z.literal("update"),
    id: safeString(100),
    prompt: z.string().trim().max(100000).optional(),
    schedule: z.string().trim().max(120).optional(),
    enabled: z.boolean().optional(),
  }),
  cronBase.extend({
    action: z.literal("remove"),
    id: safeString(100),
  }),
]);

export const chatHistoryQuerySchema = z.object({
  sessionKey: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const chatSendSchema = z.object({
  message: z.string().trim().min(1).max(500000),
  sessionKey: z.string().trim().max(200).optional(),
  model: z.string().trim().max(160).optional(),
});

export const chatSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const chatSessionDeleteSchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
});

export const chatSessionPatchSchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
  model: z.string().trim().max(160).nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(24).optional(),
}).refine(
  (payload) => ["model", "label", "tags"].some((field) => payload[field as keyof typeof payload] !== undefined),
  "No fields to update",
);

export const chatAbortSchema = z.object({
  sessionKey: z.string().trim().max(200).optional(),
  runId: z.string().trim().max(160).optional(),
});

export const chatCouncilSchema = z.object({
  message: z.string().trim().min(1).max(500000),
  sessionKey: z.string().trim().max(200).optional(),
  models: z
    .array(z.string().trim().min(1).max(160))
    .min(2)
    .max(4),
});

export const chatSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  sessionKey: z.string().trim().max(200).optional(),
  channel: z.string().trim().max(120).optional(),
  model: z.string().trim().max(160).optional(),
  agentId: z.string().trim().max(120).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(24).optional(),
});

export const chatSessionsSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  channel: z.string().trim().max(120).optional(),
  agentId: z.string().trim().max(120).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(24).optional(),
});

export const chatAnalyticsSchema = z.object({
  sessionKey: z.string().trim().max(200).optional(),
  channel: z.string().trim().max(120).optional(),
  model: z.string().trim().max(160).optional(),
  agentId: z.string().trim().max(120).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});

export const chatTagsQuerySchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
});

export const chatTagsPatchSchema = z.object({
  sessionKey: z.string().trim().min(1).max(200),
  tags: z.array(z.string().trim().min(1).max(64)).max(24),
});

export const searchPostSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  count: z.coerce.number().int().min(1).max(25).optional(),
});

export const integrationServiceSchema = z.enum([
  // Dev tools
  "github",
  "vercel",
  "neon",
  "render",
  // Messaging channels
  "telegram",
  "whatsapp",
  "slack",
  "discord",
  "signal",
  "imessage",
  // Email
  "gmail",
  "outlook",
  // System
  "telegram_master",
]);

export const integrationUpsertSchema = z.object({
  service: integrationServiceSchema,
  token: safeString(4096, 6),
  username: safeString(120).optional(),
  teamId: safeString(120).optional(),
});

export const integrationDeleteQuerySchema = z.object({
  service: integrationServiceSchema,
});

// --- Employees schemas ---

export const employeeDepartmentSchema = z.enum([
  "operations",
  "sales",
  "marketing",
  "finance",
  "compliance",
  "engineering",
  "other",
]);

export const employeeStatusSchema = z.enum(["active", "paused", "archived"]);

export const employeesListQuerySchema = z.object({
  workspace_id: workspaceSchema,
});

export const createEmployeeSchema = z.object({
  name: safeString(120),
  role_key: safeString(120).optional(),
  department: employeeDepartmentSchema.optional(),
  status: employeeStatusSchema.optional(),
  description: z.string().max(20000).optional(),
  manager_id: safeString(100).optional().nullable(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
  workspace_id: workspaceSchema,
});

const EMPLOYEE_UPDATE_FIELDS = [
  "name",
  "role_key",
  "department",
  "status",
  "description",
  "manager_id",
  "sort_order",
] as const;

export const updateEmployeeSchema = z
  .object({
    id: safeString(100),
    name: safeString(120).optional(),
    role_key: safeString(120).optional(),
    department: employeeDepartmentSchema.optional(),
    status: employeeStatusSchema.optional(),
    description: z.string().max(20000).optional(),
    manager_id: safeString(100).optional().nullable(),
    sort_order: z.coerce.number().int().min(0).max(100000).optional(),
    workspace_id: workspaceSchema,
  })
  .refine(
    (payload) => EMPLOYEE_UPDATE_FIELDS.some((field) => payload[field] !== undefined),
    "No fields to update"
  );

export const deleteEmployeeQuerySchema = z.object({
  id: safeString(100),
  workspace_id: workspaceSchema,
});

export const usageQuerySchema = z.object({
  period: z
    .enum(["today", "7d", "30d", "week", "month", "quarter", "year"])
    .optional(),
});

export const orchestratorTaskSchema = z.object({
  title: safeString(500),
  description: z.string().max(50000).optional(),
  priority: taskPrioritySchema.optional(),
  agentId: safeString(100),
  model: safeString(120).optional(),
  provider: safeString(120).optional(),
});

export const orchestratorPostSchema = z.object({
  tasks: z.array(orchestratorTaskSchema).min(1).max(50),
  missionName: z.string().trim().max(200).optional(),
  workspace_id: workspaceSchema.optional(),
});

// --- Workspace CRUD schemas ---

export const WORKSPACE_COLORS = [
  "amber",
  "emerald",
  "sky",
  "rose",
  "slate",
  "violet",
  "cyan",
  "orange",
] as const;

export const workspaceColorSchema = z.enum(WORKSPACE_COLORS);

export const workspaceAccessModeSchema = z.enum([
  "read-only",
  "read-write",
  "full",
]);

/** Workspace id: lowercase alphanumeric, hyphens, underscores. 1-50 chars, must start with alphanumeric. */
export const workspaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,49}$/,
    "workspace id must start with a lowercase letter or digit and contain only lowercase alphanumeric, hyphens, or underscores"
  );

/**
 * folder_path must be an absolute path, must NOT contain '..' traversal,
 * and must NOT contain null bytes.
 */
export const folderPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith("/"), "folder_path must be an absolute path (start with /)")
  .refine((p) => !p.includes(".."), "folder_path must not contain '..' traversal")
  .refine((p) => !p.includes("\0"), "folder_path must not contain null bytes");

export const createWorkspaceSchema = z.object({
  id: workspaceIdSchema,
  label: safeString(100),
  color: workspaceColorSchema.optional(),
  folder_path: folderPathSchema.optional().nullable(),
  access_mode: workspaceAccessModeSchema.optional(),
});

export const updateWorkspaceSchema = z
  .object({
    id: workspaceIdSchema,
    label: safeString(100).optional(),
    color: workspaceColorSchema.optional(),
    folder_path: folderPathSchema.optional().nullable(),
    access_mode: workspaceAccessModeSchema.optional(),
  })
  .refine(
    (payload) =>
      Object.keys(payload).some(
        (k) => k !== "id" && payload[k as keyof typeof payload] !== undefined
      ),
    "No fields to update"
  );

export const deleteWorkspaceQuerySchema = z.object({
  id: workspaceIdSchema,
});

// ── Profile Schemas ────────────────────────────────

export const PROFILE_COLORS = [
  "blue", "emerald", "amber", "rose", "violet", "cyan", "orange", "slate",
] as const;

export const profileColorSchema = z.enum(PROFILE_COLORS);

export const profileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(60);

export const createProfileSchema = z.object({
  name: safeString(50),
  avatar_color: profileColorSchema.optional(),
  avatar_emoji: z.string().min(1).max(4).optional(),
});

export const updateProfileSchema = z
  .object({
    id: profileIdSchema,
    name: safeString(50).optional(),
    avatar_color: profileColorSchema.optional(),
    avatar_emoji: z.string().min(1).max(4).optional(),
  })
  .refine(
    (p) => Object.keys(p).some((k) => k !== "id" && p[k as keyof typeof p] !== undefined),
    "No fields to update"
  );

export const deleteProfileQuerySchema = z.object({
  id: profileIdSchema,
});

export const profileWorkspaceLinkSchema = z.object({
  profile_id: profileIdSchema,
  workspace_id: workspaceIdSchema,
  role: z.enum(["owner", "shared"]).optional(),
});

export const profileWorkspaceUnlinkSchema = z.object({
  profile_id: profileIdSchema,
  workspace_id: workspaceIdSchema,
});

export const profileIntegrationSchema = z.object({
  profile_id: profileIdSchema,
  service: z.string().trim().min(1).max(50),
  account_id: z.string().max(200).optional().nullable(),
  config: z.string().max(5000).optional(),
});

// --- Employee Schedule schemas ---

export const scheduleCategorySchema = z.enum([
  "social_media",
  "finance",
  "sales",
  "operations",
  "other",
]);

export const scheduleListQuerySchema = z.object({
  workspace_id: workspaceSchema,
  employee_id: z.string().min(1).optional(),
});

export const createScheduleSchema = z.object({
  employee_id: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50000).optional(),
  cron_expression: z.string().trim().min(1).max(100),
  timezone: z.string().trim().max(50).optional(),
  agent_id: z.string().trim().min(1).max(100).optional(),
  priority: taskPrioritySchema.optional(),
  category: scheduleCategorySchema.optional(),
  workspace_id: workspaceSchema,
});

export const updateScheduleSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(50000).optional(),
  cron_expression: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().max(50).optional(),
  agent_id: z.string().trim().min(1).max(100).optional(),
  priority: taskPrioritySchema.optional(),
  category: scheduleCategorySchema.optional(),
  enabled: z.boolean().optional(),
  workspace_id: workspaceSchema,
});

export const deleteScheduleQuerySchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceSchema,
});

export const runScheduleSchema = z.object({
  id: z.string().min(1),
  workspace_id: workspaceSchema,
});

export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    throw new UserError(message || "Invalid request payload", 400, "VALIDATION_ERROR");
  }
  return parsed.data;
}
