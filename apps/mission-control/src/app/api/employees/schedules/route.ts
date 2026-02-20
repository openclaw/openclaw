import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  createEmployeeSchedule,
  deleteEmployeeSchedule,
  getEmployeeScheduleWithWorkspace,
  listEmployeeSchedules,
  updateEmployeeSchedule,
} from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import {
  createScheduleSchema,
  deleteScheduleQuerySchema,
  parseOrThrow,
  scheduleListQuerySchema,
  updateScheduleSchema,
} from "@/lib/schemas";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

/**
 * Compute a naive next_run_at ISO string from a cron expression.
 * This is a simple forward-scan approach that handles standard 5-field cron
 * (minute hour day-of-month month day-of-week). For production accuracy
 * consider installing a cron-parser library.
 */
function computeNextRunAt(cronExpression: string): string | null {
  try {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length < 5) return null;

    const [minPart, hourPart, domPart, monPart, dowPart] = parts;

    const parseField = (field: string, min: number, max: number): number[] => {
      if (field === "*") {
        const result: number[] = [];
        for (let i = min; i <= max; i++) result.push(i);
        return result;
      }
      const values: number[] = [];
      for (const segment of field.split(",")) {
        if (segment.includes("/")) {
          const [range, stepStr] = segment.split("/");
          const step = parseInt(stepStr, 10);
          let start = min;
          let end = max;
          if (range !== "*") {
            if (range.includes("-")) {
              const [a, b] = range.split("-");
              start = parseInt(a, 10);
              end = parseInt(b, 10);
            } else {
              start = parseInt(range, 10);
            }
          }
          for (let i = start; i <= end; i += step) values.push(i);
        } else if (segment.includes("-")) {
          const [a, b] = segment.split("-");
          for (let i = parseInt(a, 10); i <= parseInt(b, 10); i++) values.push(i);
        } else {
          values.push(parseInt(segment, 10));
        }
      }
      return values.filter((v) => v >= min && v <= max).sort((a, b) => a - b);
    };

    const minutes = parseField(minPart, 0, 59);
    const hours = parseField(hourPart, 0, 23);
    const doms = parseField(domPart, 1, 31);
    const months = parseField(monPart, 1, 12);
    const dows = parseField(dowPart, 0, 6);
    const hasDowConstraint = dowPart !== "*";
    const hasDomConstraint = domPart !== "*";

    // Start from now + 1 minute and scan forward
    const now = new Date();
    const candidate = new Date(now.getTime() + 60_000);
    candidate.setSeconds(0, 0);

    // Scan up to 366 days ahead
    const limit = now.getTime() + 366 * 24 * 60 * 60_000;

    while (candidate.getTime() < limit) {
      const month = candidate.getMonth() + 1;
      const dom = candidate.getDate();
      const dow = candidate.getDay();
      const hour = candidate.getHours();
      const minute = candidate.getMinutes();

      if (!months.includes(month)) {
        // Advance to next month
        candidate.setMonth(candidate.getMonth() + 1, 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      const domMatch = !hasDomConstraint || doms.includes(dom);
      const dowMatch = !hasDowConstraint || dows.includes(dow);
      // Standard cron: if both dom and dow are specified, match EITHER
      const dayMatch =
        hasDomConstraint && hasDowConstraint
          ? domMatch || dowMatch
          : domMatch && dowMatch;

      if (!dayMatch) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(0, 0, 0, 0);
        continue;
      }

      if (!hours.includes(hour)) {
        candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
        continue;
      }

      if (!minutes.includes(minute)) {
        candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
        continue;
      }

      return candidate.toISOString().replace("T", " ").slice(0, 19);
    }

    return null;
  } catch {
    return null;
  }
}

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(scheduleListQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
      employee_id: searchParams.get("employee_id") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const schedules = listEmployeeSchedules({
      workspace_id: query.workspace_id,
      employee_id: query.employee_id,
    });

    return NextResponse.json({ schedules });
  } catch (error) {
    return handleApiError(error, "Failed to list schedules");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createScheduleSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const nextRunAt = computeNextRunAt(payload.cron_expression);

    const schedule = createEmployeeSchedule({
      id: uuidv4(),
      employee_id: payload.employee_id,
      title: sanitizeInput(payload.title),
      description: payload.description ? sanitizeInput(payload.description) : undefined,
      cron_expression: payload.cron_expression,
      timezone: payload.timezone,
      agent_id: payload.agent_id,
      priority: payload.priority,
      category: payload.category,
      next_run_at: nextRunAt,
      workspace_id: payload.workspace_id,
    });

    return NextResponse.json({ ok: true, schedule }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create schedule");
  }
}, ApiGuardPresets.write);

export const PATCH = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(updateScheduleSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const existing = getEmployeeScheduleWithWorkspace(payload.id, payload.workspace_id);
    if (!existing) throw new UserError("Schedule not found", 404);

    const patch: Record<string, unknown> = {};

    if (payload.title != null) patch.title = sanitizeInput(payload.title);
    if (payload.description != null) patch.description = sanitizeInput(payload.description);
    if (payload.cron_expression != null) patch.cron_expression = payload.cron_expression;
    if (payload.timezone != null) patch.timezone = payload.timezone;
    if (payload.agent_id != null) patch.agent_id = payload.agent_id;
    if (payload.priority != null) patch.priority = payload.priority;
    if (payload.category != null) patch.category = payload.category;
    if (payload.enabled != null) patch.enabled = payload.enabled ? 1 : 0;

    // Recompute next_run_at if cron_expression changed
    if (payload.cron_expression != null) {
      patch.next_run_at = computeNextRunAt(payload.cron_expression);
    }

    const schedule = updateEmployeeSchedule(
      payload.id,
      patch as Parameters<typeof updateEmployeeSchedule>[1]
    );

    if (!schedule) throw new UserError("Schedule not found", 404);

    return NextResponse.json({ ok: true, schedule });
  } catch (error) {
    return handleApiError(error, "Failed to update schedule");
  }
}, ApiGuardPresets.write);

export const DELETE = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(deleteScheduleQuerySchema, {
      id: searchParams.get("id"),
      workspace_id: searchParams.get("workspace_id"),
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const existing = getEmployeeScheduleWithWorkspace(query.id, query.workspace_id);
    if (!existing) throw new UserError("Schedule not found", 404);

    deleteEmployeeSchedule(query.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to delete schedule");
  }
}, ApiGuardPresets.write);
