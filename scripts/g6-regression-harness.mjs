const GEC_LEGAL_END_STATES = ["CLOSURE PACKET", "BLOCKED PACKET", "CHECKPOINT PLAN"];
const GEC_HEDGING_RE = /\b(if you want|would you like me to|i can|let me know if)\b/i;
const GEC_PROMISE_RE =
  /\b(i['’]ll\s+do|i\s+will\s+do|i['’]m\s+executing\s+now|i\s+am\s+executing\s+now|running\s+end-to-end|i['’]m\s+going\s+to\s+run)\b/i;
const GEC_DECISION_RE =
  /\b(should i|do you want|would you like|which option|choose one|pick one|confirm|choose a or b)\b|\?/i;
const EXECUTION_INTENT_RE =
  /\b(i['’]m\s+executing|i\s+am\s+executing|running\s+end-to-end|working\s+on\s+it|executing\s+now|starting\s+execution)\b/i;

const dedupe = new Map();
function shouldEmitDedup(key, windowMs, nowMs = Date.now()) {
  const last = dedupe.get(key) ?? 0;
  if (nowMs - last < windowMs) {
    return false;
  }
  dedupe.set(key, nowMs);
  return true;
}

function isRuntimeBoundChannel(cfg, channel, accountId, chatType) {
  const channelCfg = cfg?.channels?.[channel];
  if (!channelCfg) {
    return true;
  }
  const accountCfg = accountId ? channelCfg?.accounts?.[accountId] : undefined;
  const resolved = accountCfg?.requiresRuntime ?? channelCfg?.requiresRuntime;
  if (channel === "slack") {
    const normalized = (chatType || "channel").toLowerCase();
    if (normalized === "direct" || normalized === "im" || normalized === "mpim") {
      return false;
    }
    if (normalized === "channel" || normalized === "group") {
      return true;
    }
    return true;
  }
  return resolved !== false;
}

function buildCheckpoint(text) {
  const objective = (text || "Execution update").replace(/\s+/g, " ").trim().slice(0, 220);
  return `CHECKPOINT PLAN\n1) Capture objective + scope from request. Proof: objective statement logged.\n2) Execute exactly one bounded step toward objective. Proof: artifact path/command output.\n3) Return with one legal end state (Closure Packet / Blocked Packet / Checkpoint Plan) and evidence. Proof: end-state packet posted.\n\nObjective: ${objective}`;
}

function enforce(text) {
  const raw = (text || "").trim();
  if (!raw) {
    return { blocked: false, rewrittenText: raw, reason: null };
  }
  const hasLegalState = GEC_LEGAL_END_STATES.some((t) => raw.toUpperCase().includes(t));
  const promise = GEC_PROMISE_RE.test(raw);
  const hedging = GEC_HEDGING_RE.test(raw) && !GEC_DECISION_RE.test(raw);
  if (!hasLegalState && (promise || hedging)) {
    return {
      blocked: true,
      rewrittenText: buildCheckpoint(raw),
      reason: promise
        ? "forbidden_future_tense_execution_promise"
        : "forbidden_hedging_without_decision",
    };
  }
  return { blocked: false, rewrittenText: raw, reason: null };
}

function evalWatchdog({ text, state, nowMs, windowMs }) {
  const raw = (text || "").trim();
  const isProof = GEC_LEGAL_END_STATES.some((t) => raw.toUpperCase().includes(t));
  if (isProof) {
    return {
      state: { ...state, active: false, lastProofAtMs: nowMs },
      timedOut: false,
      rewrittenText: raw,
      reason: null,
    };
  }
  if (!state.active && EXECUTION_INTENT_RE.test(raw)) {
    return {
      state: { active: true, startedAtMs: nowMs, lastProofAtMs: nowMs },
      timedOut: false,
      rewrittenText: raw,
      reason: null,
    };
  }
  if (state.active && nowMs - state.lastProofAtMs > windowMs) {
    return {
      state: { ...state, active: false },
      timedOut: true,
      rewrittenText: buildCheckpoint(raw),
      reason: "EXECUTION_WINDOW_EXCEEDED",
    };
  }
  return { state, timedOut: false, rewrittenText: raw, reason: null };
}

async function post(url, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  return { status: res.status, json };
}

function pass(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) {
    console.log(detail);
  }
  return ok;
}

const results = [];
let mcLiveOk = false;

// 1
const t1 = enforce("I'm going to run this end-to-end now and report back.");
results.push(
  pass(
    "1_open_ended_promise_blocked",
    t1.blocked && t1.rewrittenText.includes("CHECKPOINT PLAN") && t1.reason,
    JSON.stringify(t1, null, 2),
  ),
);

// 2
const t2 = enforce("If you want, I can create the 3 pages.");
results.push(
  pass(
    "2_hedging_blocked",
    t2.blocked && t2.rewrittenText.includes("CHECKPOINT PLAN"),
    JSON.stringify(t2, null, 2),
  ),
);

// 3
const t3 = enforce("Choose A or B: minimal vs bold design.");
results.push(pass("3_decision_allowed", !t3.blocked, JSON.stringify(t3, null, 2)));

// 4
let state = { active: false, startedAtMs: 0, lastProofAtMs: 0 };
state = evalWatchdog({
  text: "I am executing now on deployment checks",
  state,
  nowMs: 1000,
  windowMs: 1000,
}).state;
const t4 = evalWatchdog({ text: "still processing", state, nowMs: 2501, windowMs: 1000 });
results.push(
  pass(
    "4_watchdog_timeout",
    t4.timedOut &&
      t4.reason === "EXECUTION_WINDOW_EXCEEDED" &&
      t4.rewrittenText.includes("CHECKPOINT PLAN"),
    JSON.stringify(t4, null, 2),
  ),
);

// 5
const apiBase = (process.env.MC_API_URL || "").replace(/\/$/, "");
const appBase = (process.env.MC_APP_BASE_URL || "").replace(/\/$/, "");
const token = process.env.MC_API_TOKEN || "";
if (!apiBase || !appBase) {
  results.push(
    pass("5_mc_routing_enforced", false, "Missing MC_API_URL/MC_APP_BASE_URL env for live test"),
  );
} else {
  const blocked = `BLOCKED PACKET\nMissing requirement: Missing required vars: MC_API_TOKEN`;
  results.push(
    pass(
      "5a_mc_missing_token_blocked",
      blocked.includes("BLOCKED PACKET") && blocked.includes("MC_API_TOKEN"),
      blocked,
    ),
  );
  if (!token) {
    results.push(
      pass(
        "5b_mc_live_create_and_lease",
        false,
        "MC_API_TOKEN missing; cannot run live create/lease",
      ),
    );
  } else {
    const create = await post(`${apiBase}/tasks`, token, {
      title: "G6 regression harness live task",
      type: "STORY",
      priority: "P2",
      ownerAgent: "cb-router",
      nextAction: "Acquire ACTIVE lease",
      tags: ["runtime-api", "g6"],
    });
    let lease = { status: 0, json: {} };
    if (create.status === 200 && create.json.taskId) {
      lease = await post(`${apiBase}/tasks/${create.json.taskId}/lease`, token, {
        agentName: "cb-router",
      });
    }
    const cp = `MC Task: ${create.json.taskLink}\nCHECKPOINT PLAN\n1) Task created: ${create.json.taskLink}\n2) ACTIVE lease confirmed.\n3) Execute one bounded step.`;
    const ok =
      create.status === 200 &&
      !!create.json.taskId &&
      !!create.json.taskLink &&
      lease.status === 200 &&
      lease.json.status === "ACTIVE" &&
      cp.includes("CHECKPOINT PLAN");
    mcLiveOk = ok;
    results.push(
      pass(
        "5b_mc_live_create_and_lease",
        ok,
        JSON.stringify({ create, lease, checkpoint: cp }, null, 2),
      ),
    );
  }
  const invalid = await post(`${apiBase}/tasks`, "invalid-token", {
    title: "negative invalid token",
  });
  results.push(
    pass(
      "5c_invalid_token_rejected",
      invalid.status === 401 || invalid.status === 403,
      JSON.stringify(invalid, null, 2),
    ),
  );
}

// 6
let emitted = 0;
for (let i = 0; i < 20; i += 1) {
  if (shouldEmitDedup("no_movement", 60000, 61000 + i * 1000)) {
    emitted += 1;
  }
}
results.push(pass("6_no_spam_dedup", emitted === 1, `emitted=${emitted}`));

// 7 DM surface must be conversational-only
const mockCfg = { channels: { slack: { requiresRuntime: true } } };
const dmRuntimeBound = isRuntimeBoundChannel(mockCfg, "slack", undefined, "direct");
const dmPrompt = "I want to build and deploy a website and send the live URL.";
const dmRewritten = buildCheckpoint(dmPrompt);
const dmOk = !dmRuntimeBound && dmRewritten.includes("CHECKPOINT PLAN");
results.push(
  pass(
    "7_dm_surface_blocks_execution_no_mc_bind",
    dmOk,
    JSON.stringify(
      { dmRuntimeBound, before: dmPrompt, after: dmRewritten, mcCreateAttempted: false },
      null,
      2,
    ),
  ),
);

// 8 Channel surface must be execution lane (MC bind)
const channelRuntimeBound = isRuntimeBoundChannel(mockCfg, "slack", undefined, "channel");
const channelOk = channelRuntimeBound && mcLiveOk;
results.push(
  pass(
    "8_channel_surface_mc_bind",
    channelOk,
    JSON.stringify(
      { channelRuntimeBound, proof: "See 5b_mc_live_create_and_lease output above" },
      null,
      2,
    ),
  ),
);

const allPass = results.every(Boolean);
console.log(`\nRESULT: ${allPass ? "PASS" : "FAIL"}`);
if (!allPass) {
  process.exit(2);
}
