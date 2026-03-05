import { apiResponse } from "@/lib/workspace";
import os from "os";

export async function GET() {
  const uptime = process.uptime();
  const mem = process.memoryUsage();

  return apiResponse({
    status: "ok",
    uptime: Math.floor(uptime),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    system: {
      platform: os.platform(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024),
      loadAvg: os.loadavg(),
    },
    convex: !!process.env.NEXT_PUBLIC_CONVEX_URL,
  });
}
