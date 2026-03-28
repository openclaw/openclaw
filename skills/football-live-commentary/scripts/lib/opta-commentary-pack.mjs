/**
 * Build token-efficient commentaryPack from Opta-like atomic events.
 */

import {
  classifyPriority,
  eventTypeString,
  isGoalEvent,
  isPassEvent,
} from "./opta-event-classifier.mjs";

const PERSONAS = {
  neutral: {
    id: "neutral",
    label: "Neutral / 中性",
    guide:
      "Factual, balanced tone; name players when present; avoid hype unless event is high priority.",
  },
  data: {
    id: "data",
    label: "Data-forward (数据流)",
    guide:
      "詹俊式：简洁交代事实与数据感（射门次数、传球方向可略提），少形容词堆砌；关键事件点名球员与时间点。",
  },
  passion: {
    id: "passion",
    label: "High-energy (激情流)",
    guide:
      "黄健翔式：高优先级事件短句有力、可重复关键词；控制篇幅，避免全场喊叫；低优先级不要强行煽情。",
  },
  poetic: {
    id: "poetic",
    label: "Poetic / 诗人流",
    guide: "贺炜式：高优先级可一两句意象化收束；其余保持克制；避免滥用排比与套话。",
  },
};

function minuteFromEvent(e) {
  const m = e.minute ?? e.time?.minute ?? e.clock?.minute ?? e.matchTime?.min;
  const n = Number(m);
  if (Number.isFinite(n)) return n;
  const t = e.time ?? e.matchTime;
  if (t && typeof t === "string" && /^\d+:\d+/.test(t)) {
    const [mm] = t.split(":");
    const v = Number.parseInt(mm, 10);
    if (Number.isFinite(v)) return v;
  }
  return 0;
}

function secondFromEvent(e) {
  const s = e.second ?? e.time?.second ?? e.clock?.second ?? 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function sortKey(e) {
  return minuteFromEvent(e) * 60 + secondFromEvent(e);
}

function teamKey(e, opt) {
  const id = e.teamId ?? e.contestantId ?? e.team?.id ?? e.side;
  if (id != null && opt?.homeId != null && String(id) === String(opt.homeId)) return "home";
  if (id != null && opt?.awayId != null && String(id) === String(opt.awayId)) return "away";
  const h = e.isHome ?? e.home;
  if (h === true) return "home";
  if (h === false) return "away";
  const q = eventTypeString(e);
  if (/home/i.test(String(e.team))) return "home";
  if (/away/i.test(String(e.team))) return "away";
  return "unknown";
}

function derivePhase(minute) {
  if (minute <= 5) return "opening";
  if (minute >= 40 && minute <= 45) return "first_half_closing";
  if (minute >= 46 && minute <= 55) return "second_half_opening";
  if (minute >= 85 && minute <= 90) return "late_game";
  if (minute > 90) return "stoppage_or_extra";
  return "mid_match";
}

function scoreNarrative(score, lastGoalSide) {
  const { home, away } = score;
  if (home === away) return "level";
  if (home > away)
    return lastGoalSide === "away" ? "home_leading_after_away_reply" : "home_leading";
  return lastGoalSide === "home" ? "away_leading_after_home_reply" : "away_leading";
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {{ persona?: string, homeName?: string, awayName?: string, homeId?: string|number, awayId?: string|number, passChainThreshold?: number, lowBurstWindowMinutes?: number, lowBurstMinEvents?: number, dataSource?: string }} opt
 */
export function buildCommentaryPack(events, opt = {}) {
  const personaId = PERSONAS[opt.persona] ? opt.persona : "neutral";
  const persona = PERSONAS[personaId];
  const homeName = opt.homeName ?? "Home";
  const awayName = opt.awayName ?? "Away";
  const passThreshold = opt.passChainThreshold ?? 15;
  const burstWin = opt.lowBurstWindowMinutes ?? 1.5;
  const burstMin = opt.lowBurstMinEvents ?? 12;

  const arr = [...(events ?? [])].sort((a, b) => sortKey(a) - sortKey(b));

  const score = { home: 0, away: 0 };
  let lastGoalSide = null;

  /** @type {Array<{ priority: string, minute: number, second: number, label: string, teamKey: string, raw: Record<string, unknown> }>} */
  const normalized = [];

  for (const raw of arr) {
    const typeStr = eventTypeString(raw);
    if (!typeStr && !raw.type && !raw.eventType) continue;
    const pri = classifyPriority(typeStr, raw);
    const minute = minuteFromEvent(raw);
    const second = secondFromEvent(raw);
    const tk = teamKey(raw, opt);

    if (isGoalEvent(typeStr)) {
      if (tk === "home") {
        score.home += 1;
        lastGoalSide = "home";
      } else if (tk === "away") {
        score.away += 1;
        lastGoalSide = "away";
      }
    }

    normalized.push({
      priority: pri,
      minute,
      second,
      label: typeStr.slice(0, 200) || "(event)",
      teamKey: tk,
      raw,
    });
  }

  /** @type {typeof normalized} */
  const immediate = [];
  /** @type {typeof normalized} */
  const mediumBuffer = [];
  let suppressedLow = 0;

  let passTeam = null;
  let passCount = 0;

  /** low-priority events in sliding window by match-time */
  let lowWindow = [];

  /** @type {Array<{ fromMin: number, toMin: number, items: typeof normalized, summaryKind: string }>} */
  const deferredSummaries = [];

  function flushPassChain(atMinute) {
    if (passTeam && passCount >= passThreshold) {
      const name = passTeam === "home" ? homeName : passTeam === "away" ? awayName : "一方";
      mediumBuffer.push({
        priority: "medium",
        minute: atMinute,
        second: 0,
        label: `pass chain ${passCount}+ (${name})`,
        teamKey: passTeam,
        raw: { synthetic: true, kind: "pass_chain" },
      });
    }
    passTeam = null;
    passCount = 0;
  }

  function flushMediumWindow(endMinute) {
    if (!mediumBuffer.length) return;
    const slice = mediumBuffer.splice(0, mediumBuffer.length);
    const mins = slice.map((x) => x.minute);
    deferredSummaries.push({
      fromMin: Math.min(...mins),
      toMin: Math.max(...mins, endMinute),
      items: slice,
      summaryKind: "medium_batch",
    });
  }

  for (const ev of normalized) {
    const typeStr = eventTypeString(ev.raw);
    const m = ev.minute + ev.second / 60;

    lowWindow = lowWindow.filter((x) => m - (x.minute + x.second / 60) <= burstWin);

    if (ev.priority === "high") {
      flushPassChain(ev.minute);
      flushMediumWindow(ev.minute);
      immediate.push(ev);
      continue;
    }

    if (ev.priority === "medium") {
      flushPassChain(ev.minute);
      mediumBuffer.push(ev);
      if (mediumBuffer.length >= 8) flushMediumWindow(ev.minute);
      continue;
    }

    suppressedLow += 1;
    lowWindow.push(ev);

    if (isPassEvent(typeStr)) {
      const tk = ev.teamKey;
      if (tk !== "unknown" && tk === passTeam) passCount += 1;
      else {
        flushPassChain(ev.minute);
        passTeam = tk !== "unknown" ? tk : null;
        passCount = tk !== "unknown" ? 1 : 0;
      }
    } else {
      flushPassChain(ev.minute);
    }

    if (lowWindow.length >= burstMin) {
      deferredSummaries.push({
        fromMin: lowWindow[0].minute,
        toMin: ev.minute,
        items: [...lowWindow],
        summaryKind: "low_priority_burst",
      });
      lowWindow = [];
    }
  }

  flushPassChain(minuteFromEvent(arr[arr.length - 1] ?? {}) || 90);
  if (mediumBuffer.length) {
    const last = normalized[normalized.length - 1];
    flushMediumWindow(last ? last.minute : 90);
  }

  const lastEv = normalized[normalized.length - 1];
  const clock = lastEv ? lastEv.minute + lastEv.second / 60 : 0;
  const phase = derivePhase(lastEv?.minute ?? 0);

  const matchContext = {
    score,
    scoreLine: `${homeName} ${score.home}–${score.away} ${awayName}`,
    phase,
    clockMinuteApprox: Math.floor(clock),
    narrativeToneHint: scoreNarrative(score, lastGoalSide),
    timeSensitivityNote:
      phase === "opening"
        ? "开场阶段：同样犯规可写「试探尺度」；避免过度定性。"
        : phase === "stoppage_or_extra" || phase === "late_game"
          ? "尾声/补时：同样犯规可加重语气（时间所剩无几）。"
          : "常规时段：保持与比分形势一致的叙述力度。",
    leadingSide: score.home > score.away ? "home" : score.away > score.home ? "away" : "none",
  };

  const immediateBriefs = immediate.map((x) => ({
    priority: "high",
    at: `${x.minute}:${String(x.second).padStart(2, "0")}`,
    team: x.teamKey,
    cue: x.label,
    requiresInstantNarration: true,
  }));

  const deferredBriefs = deferredSummaries.map((d) => ({
    kind: d.summaryKind,
    window: `${d.fromMin}–${d.toMin}′`,
    eventCount: d.items.length,
    cue:
      d.summaryKind === "low_priority_burst"
        ? `短时间内大量琐碎事件（${d.items.length}）→ 合并为一句「场面节奏」描述即可，勿逐条复读。`
        : `延时汇总：${d.items.length} 条中优先级线索，合并成一小段，不要照念标签。`,
  }));

  return {
    schemaVersion: 1,
    source: opt.dataSource ?? "opta-like-events",
    persona: persona.id,
    personaLabel: persona.label,
    personaGuide: persona.guide,
    matchContext,
    immediate: immediateBriefs,
    deferredWindows: deferredBriefs,
    suppressedLowPriorityCount: suppressedLow,
    tokenBudgetNote:
      "Do NOT stream raw event arrays to the user. Use `immediate` for line-by-line (or sentence) commentary; fold `deferredWindows` into occasional summaries; ignore individual low-priority events unless summarized.",
    modelInstructions: [
      `解说人格：${persona.label}。${persona.guide}`,
      `当前比分：${matchContext.scoreLine}。形势：${matchContext.narrativeToneHint}。`,
      matchContext.timeSensitivityNote,
      "高优先级事件必须优先开口；中优先级合并后再播；低优先级默认省略，仅在 burst 窗口用一句话概括场面。",
    ].join("\n"),
  };
}

export { PERSONAS };
