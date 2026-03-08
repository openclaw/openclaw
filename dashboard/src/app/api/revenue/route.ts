import path from "path";
import { getWorkspacePath, readJsonFile, apiResponse } from "@/lib/workspace";
import type { RevenueData } from "@/lib/types";

export async function GET() {
  const wsPath = getWorkspacePath();
  const revenue = await readJsonFile<RevenueData>(path.join(wsPath, "state", "revenue.json"));

  return apiResponse(revenue || {
    current: 0,
    monthlyBurn: 0,
    net: 0,
    currency: "USD",
  });
}
