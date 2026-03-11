import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_project",
    description: "Create a new project",
    params: {},
    handler: async (params, ctx) => {
      const project = await q.createProject(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "project",
        entityId: project.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "projects",
        entityType: "project",
        trigger: "create",
        record: project,
      });
      return { success: true, data: project };
    },
  },
  {
    name: "get_project",
    description: "Retrieve a project by ID",
    params: {},
    handler: async (params, ctx) => {
      const project = await q.getProject(ctx.pg, (params as any).id);
      return project ? { success: true, data: project } : { error: "Project not found" };
    },
  },
  {
    name: "list_projects",
    description: "List projects with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listProjects(ctx.pg, params as any) };
    },
  },
  {
    name: "update_project",
    description: "Update project fields",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const project = await q.updateProject(ctx.pg, id, rest);
      if (!project) return { error: "Project not found or no fields to update" };
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "project",
        entityId: project.id,
        action: "update",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "projects",
        entityType: "project",
        trigger: "update",
        record: project,
      });
      return { success: true, data: project };
    },
  },
  {
    name: "create_task",
    description: "Create a task within a project",
    params: {},
    handler: async (params, ctx) => {
      const task = await q.createTask(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "task",
        entityId: task.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: task };
    },
  },
  {
    name: "get_task",
    description: "Retrieve a task by ID",
    params: {},
    handler: async (params, ctx) => {
      const task = await q.getTask(ctx.pg, (params as any).id);
      return task ? { success: true, data: task } : { error: "Task not found" };
    },
  },
  {
    name: "list_tasks",
    description: "List tasks with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listTasks(ctx.pg, params as any) };
    },
  },
  {
    name: "update_task",
    description: "Update task fields",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const task = await q.updateTask(ctx.pg, id, rest);
      if (!task) return { error: "Task not found or no fields to update" };
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "task",
        entityId: task.id,
        action: "update",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: task };
    },
  },
  {
    name: "create_milestone",
    description: "Create a milestone for a project",
    params: {},
    handler: async (params, ctx) => {
      const milestone = await q.createMilestone(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "milestone",
        entityId: milestone.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: milestone };
    },
  },
  {
    name: "list_milestones",
    description: "List milestones for a project",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.listMilestones(ctx.pg, (params as any).project_id),
      };
    },
  },
  {
    name: "complete_milestone",
    description: "Mark a milestone as completed",
    params: {},
    handler: async (params, ctx) => {
      const milestone = await q.completeMilestone(ctx.pg, (params as any).id);
      if (!milestone) return { error: "Milestone not found" };
      await writeAuditLog(ctx.pg, {
        domain: "projects",
        entityType: "milestone",
        entityId: milestone.id,
        action: "complete",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: milestone };
    },
  },
];

export const projectsTool = createErpDomainTool({
  domain: "projects",
  description:
    "Project management - projects, tasks, milestones, assignments, and progress tracking",
  actions,
});
