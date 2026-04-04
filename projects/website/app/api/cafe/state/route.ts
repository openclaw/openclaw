import { NextResponse } from "next/server";
import { getState, CORS_HEADERS, isForceClosed } from "../_storage";

export const runtime = "nodejs";

function calcAbsentDays(state: any, visitorId: string): number {
  const dates = state.visitors[visitorId];
  if (!dates || !dates.length) return 0;
  const sorted = [...dates].sort();
  const lastVisit = new Date(sorted[sorted.length - 1]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  lastVisit.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - lastVisit.getTime()) / 86400000);
  return Math.max(diff, 0);
}

export async function GET(req: Request) {
  const state = await getState();
  const todayCount = Object.keys(state.visitorsToday).length;

  // Check force close status for visitor
  const url = new URL(req.url);
  const vid = url.searchParams.get("visitorId") || "";
  const forceClose = vid ? await isForceClosed(vid) : false;
  const absentDays = vid ? calcAbsentDays(state, vid) : 0;

  return NextResponse.json(
    {
      coffees: state.coffees,
      notes: state.notes.slice(-50),
      visitors_today: todayCount,
      ghosts: state.ghosts.slice(-20),
      waitingList: (state.waitingList || []).map((w) => ({
        star: w.star,
        seat: w.seat,
        at: w.at,
      })),
      forceClose,
      absentDays,
    },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
