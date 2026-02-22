import { NextResponse } from "next/server";
import { getCachedPluginCatalog } from "@/lib/plugin-scanner";

export async function GET() {
  try {
    const catalog = getCachedPluginCatalog();
    return NextResponse.json(catalog);
  } catch (error) {
    return NextResponse.json(
      {
        error: String(error),
        plugins: [],
        totalSkills: 0,
        totalAgents: 0,
        totalMcpServers: 0,
        categories: [],
        scannedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
