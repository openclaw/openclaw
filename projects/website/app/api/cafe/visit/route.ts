import { NextResponse } from "next/server";
import {
  getState, setState, checkRate, checkBudget,
  isForceClosed, setForceClose, CORS_HEADERS
} from "../_storage";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { visitorId, path } = await req.json();
  if (!visitorId || !Array.isArray(path)) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  if (await isForceClosed(visitorId)) {
    return NextResponse.json(
      { error: "cafe closed", forceClose: true,
        farewell: "今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。" },
      { status: 200, headers: CORS_HEADERS }
    );
  }
  if (!checkRate(visitorId)) {
    return NextResponse.json({ error: "rate limit" }, { status: 429 });
  }

  const state = await getState();

  const budget = checkBudget(visitorId, state);
  if (budget.forceClose) {
    await setForceClose(visitorId);
    await setState(state);
    return NextResponse.json(
      { forceClose: true,
        farewell: "今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。" },
      { headers: CORS_HEADERS }
    );
  }
  const today = new Date().toISOString().slice(0, 10);

  // Record ghost path (keep last 20)
  state.ghosts.push({ path: path.slice(0, 50), at: new Date().toISOString() });
  if (state.ghosts.length > 20) state.ghosts = state.ghosts.slice(-20);

  // Track visitor dates
  const dates = state.visitors[visitorId] ?? [];
  if (!dates.includes(today)) dates.push(today);
  state.visitors[visitorId] = dates;
  state.visitorsToday[visitorId] = true;

  // Calculate streak (consecutive days ending today)
  const sorted = [...dates].sort().reverse();
  let streak = 0;
  const d = new Date(today);
  for (const dateStr of sorted) {
    const expected = new Date(d);
    expected.setDate(expected.getDate() - streak);
    if (dateStr === expected.toISOString().slice(0, 10)) {
      streak++;
    } else break;
  }

  const recognized = dates.length > 1;
  await setState(state);

  return NextResponse.json(
    { streak, recognized },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
