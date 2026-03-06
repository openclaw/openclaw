import { NextResponse } from "next/server";
import { taskStore } from "../../../lib/task-store";

export async function GET(): Promise<NextResponse> {
  const items = await taskStore.list();
  return NextResponse.json({ items });
}
