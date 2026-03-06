import { NextResponse } from "next/server";
import { taskStore } from "../../../../lib/task-store";

interface RouteContext {
  params: Promise<{ taskId: string }>;
}

export async function GET(_req: Request, context: RouteContext): Promise<NextResponse> {
  const { taskId } = await context.params;
  const task = await taskStore.getById(taskId);

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(task);
}
