import { NextResponse } from "next/server";
import {
  getState, setState, checkRate, checkBudget,
  isForceClosed, setForceClose, CORS_HEADERS
} from "../_storage";

export const runtime = "nodejs";

const URL_RE = /https?:\/\/|www\./i;
const HTML_RE = /<[^>]+>/;

export async function POST(req: Request) {
  const { npcId, text, visitorId } = await req.json();
  if (!npcId || !text || !visitorId) {
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

  const clean = String(text).trim().slice(0, 50);
  if (clean.length < 1 || URL_RE.test(clean) || HTML_RE.test(clean)) {
    return NextResponse.json({ error: "invalid text" }, { status: 400 });
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

  state.notes.push({
    npcId,
    text: clean,
    from: visitorId,
    at: new Date().toISOString().slice(0, 10),
  });

  // FIFO: keep max 20 notes per NPC
  const perNpc = state.notes.filter((n) => n.npcId === npcId);
  if (perNpc.length > 20) {
    const oldest = perNpc[0];
    state.notes = state.notes.filter((n) => n !== oldest);
  }

  await setState(state);
  const count = state.notes.filter((n) => n.npcId === npcId).length;
  return NextResponse.json(
    { ok: true, noteCount: count },
    { headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
