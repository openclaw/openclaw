import path from "path";
import { getWorkspacePath, readJsonFile, writeJsonFile, apiResponse, apiError } from "@/lib/workspace";
import type { SuggestedTask } from "@/lib/types";
import { type NextRequest } from "next/server";

export async function GET() {
  const wsPath = getWorkspacePath();
  const tasks = await readJsonFile<SuggestedTask[]>(path.join(wsPath, "state", "suggested-tasks.json"));
  return apiResponse(tasks || []);
}

export async function POST(request: NextRequest) {
  const wsPath = getWorkspacePath();
  const filePath = path.join(wsPath, "state", "suggested-tasks.json");

  const body = await request.json();
  const { id, action } = body as { id: string; action: "approve" | "reject" };

  if (!id || !action) {
    return apiError("Missing id or action", 400);
  }

  const tasks = (await readJsonFile<SuggestedTask[]>(filePath)) || [];
  const task = tasks.find((t) => t.id === id);

  if (!task) {
    return apiError(`Task '${id}' not found`, 404);
  }

  task.status = action === "approve" ? "approved" : "rejected";
  await writeJsonFile(filePath, tasks);

  return apiResponse(task);
}
