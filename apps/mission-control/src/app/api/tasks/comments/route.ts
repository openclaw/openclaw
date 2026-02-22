import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { listComments, addComment, logActivity, getTaskWithWorkspace } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import { addCommentSchema, commentsQuerySchema, parseOrThrow } from "@/lib/schemas";
import { isValidWorkspaceId } from "@/lib/workspaces-server";

// GET /api/tasks/comments?taskId=xxx&workspace_id=xxx - Get comments for a task
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const { taskId, workspace_id } = parseOrThrow(commentsQuerySchema, {
      taskId: searchParams.get("taskId"),
      workspace_id: searchParams.get("workspace_id"),
    });

    if (!isValidWorkspaceId(workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    // Verify the parent task belongs to the given workspace
    const task = getTaskWithWorkspace(taskId, workspace_id);
    if (!task) {throw new UserError("Task not found", 404);}

    const comments = listComments(taskId);
    return NextResponse.json({ comments });
  } catch (error) {
    return handleApiError(error, "Failed to fetch comments");
  }
}, ApiGuardPresets.read);

// POST /api/tasks/comments - Add a user comment to a task
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(addCommentSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    // Verify the parent task belongs to the given workspace
    const task = getTaskWithWorkspace(payload.taskId, payload.workspace_id);
    if (!task) {throw new UserError("Task not found", 404);}

    const comment = addComment({
      id: uuidv4(),
      task_id: payload.taskId,
      author_type: "user",
      content: sanitizeInput(payload.content),
    });

    logActivity({
      id: uuidv4(),
      type: "comment_added",
      task_id: payload.taskId,
      message: "User added a comment on task",
      workspace_id: payload.workspace_id,
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to add comment");
  }
}, ApiGuardPresets.write);
