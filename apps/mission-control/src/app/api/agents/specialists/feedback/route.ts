import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  addSpecialistFeedback,
  getTask,
  listSpecialistFeedback,
  logActivity,
} from "@/lib/db";
import {
  getSpecializedAgent,
} from "@/lib/agent-registry";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import {
  parseOrThrow,
  specialistFeedbackQuerySchema,
  specialistFeedbackSchema,
} from "@/lib/schemas";
import { buildSpecialistIntelligence } from "@/lib/specialist-intelligence";

// GET /api/agents/specialists/feedback
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(specialistFeedbackQuerySchema, {
      agentId: searchParams.get("agentId") ?? undefined,
      taskId: searchParams.get("taskId") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const feedback = listSpecialistFeedback({
      specialist_id: query.agentId,
      task_id: query.taskId,
      limit: query.limit ?? 100,
    });

    return NextResponse.json({
      feedback,
      total: feedback.length,
    });
  } catch (error) {
    return handleApiError(error, "Failed to fetch specialist feedback");
  }
}, ApiGuardPresets.read);

// POST /api/agents/specialists/feedback
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(
      specialistFeedbackSchema,
      await request.json()
    );

    const specialist = getSpecializedAgent(payload.agentId);
    if (!specialist) {
      throw new UserError("Specialist not found", 404);
    }

    if (payload.taskId) {
      const task = getTask(payload.taskId);
      if (!task) {
        throw new UserError("Task not found", 404);
      }
    }

    const feedback = addSpecialistFeedback({
      id: uuidv4(),
      specialist_id: specialist.id,
      task_id: payload.taskId ?? null,
      rating: payload.rating,
      dimension: payload.dimension ?? "overall",
      note: sanitizeInput(payload.note ?? ""),
      created_by: "user",
    });

    logActivity({
      id: uuidv4(),
      type: "specialist_feedback",
      agent_id: specialist.id,
      task_id: payload.taskId,
      message: `Specialist feedback recorded for "${specialist.name}"`,
      metadata: {
        rating: payload.rating,
        dimension: payload.dimension ?? "overall",
      },
    });

    return NextResponse.json({
      feedback,
      intelligence: buildSpecialistIntelligence(specialist),
    });
  } catch (error) {
    return handleApiError(error, "Failed to save specialist feedback");
  }
}, ApiGuardPresets.write);
