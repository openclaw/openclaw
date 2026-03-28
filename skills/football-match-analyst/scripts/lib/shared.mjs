/**
 * Shared aggregators and llmPack builder for API-Football and Sportmonks providers.
 * Rows follow API-Football-shaped objects: { fixture, teams, goals, league? }.
 */

export const FINISHED = new Set(["FT", "AET", "PEN"]);

export function parsePercent(val) {
  if (val == null) return null;
  const s = String(val).replace("%", "").trim();
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function parseStatNumber(val) {
  if (val == null) return null;
  const n = Number.parseFloat(String(val).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function emptySplit() {
  return { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
}

export function aggregateForm(rows, teamId) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  const overall = { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  const venue = { home: emptySplit(), away: emptySplit() };

  for (const row of finished) {
    const fid = row.fixture?.id;
    const hs = row.teams?.home?.id;
    const as = row.teams?.away?.id;
    const gh = row.goals?.home;
    const ga = row.goals?.away;
    if (!fid || hs == null || as == null || gh == null || ga == null) continue;

    const isHome = hs === teamId;
    const mine = isHome ? gh : ga;
    const theirs = isHome ? ga : gh;
    const bucket = isHome ? venue.home : venue.away;

    overall.played += 1;
    overall.gf += mine;
    overall.ga += theirs;
    bucket.played += 1;
    bucket.gf += mine;
    bucket.ga += theirs;

    if (mine > theirs) {
      overall.w += 1;
      bucket.w += 1;
    } else if (mine === theirs) {
      overall.d += 1;
      bucket.d += 1;
    } else {
      overall.l += 1;
      bucket.l += 1;
    }
  }

  const rate = (o) => ({
    ...o,
    gfPerGame: o.played ? Math.round((o.gf / o.played) * 100) / 100 : null,
    gaPerGame: o.played ? Math.round((o.ga / o.played) * 100) / 100 : null,
    winPct: o.played ? Math.round((o.w / o.played) * 1000) / 1000 : null,
  });

  return {
    sampleSize: overall.played,
    overall: rate(overall),
    venue: { home: rate(venue.home), away: rate(venue.away) },
  };
}

export function h2hAggregate(rows, teamAId, teamBId) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  let aW = 0,
    bW = 0,
    dr = 0,
    goals = 0;
  for (const row of finished) {
    const hs = row.teams?.home?.id;
    const as = row.teams?.away?.id;
    const gh = row.goals?.home;
    const ga = row.goals?.away;
    if (hs == null || as == null || gh == null || ga == null) continue;
    goals += gh + ga;
    if (gh === ga) dr += 1;
    else if (hs === teamAId && gh > ga) aW += 1;
    else if (as === teamAId && ga > gh) aW += 1;
    else if (hs === teamBId && gh > ga) bW += 1;
    else if (as === teamBId && ga > gh) bW += 1;
  }
  const n = finished.length;
  return {
    sampleSize: n,
    teamFirstIdWins: aW,
    teamSecondIdWins: bW,
    draws: dr,
    avgTotalGoals: n ? Math.round((goals / n) * 100) / 100 : null,
  };
}

export function matchesInLast7Days(rows, teamId, anchorIso) {
  const anchor = new Date(anchorIso).getTime();
  if (!Number.isFinite(anchor)) return null;
  const windowStart = anchor - 7 * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const row of rows ?? []) {
    const t = new Date(row.fixture?.date ?? "").getTime();
    if (!Number.isFinite(t) || t >= anchor || t < windowStart) continue;
    if (!FINISHED.has(row.fixture?.status?.short)) continue;
    const hs = row.teams?.home?.id;
    const as = row.teams?.away?.id;
    if (hs === teamId || as === teamId) n += 1;
  }
  return n;
}

export function injuriesShortList(rows) {
  return (rows ?? []).map((r) => ({
    player: r.player?.name ?? r.player?.firstname ?? "unknown",
    type: r.type ?? null,
    reason: r.reason ?? null,
  }));
}

export function splitInjuriesByTeam(rows, hid, aid) {
  const home = [];
  const away = [];
  for (const x of rows ?? []) {
    const tid = x.team?.id ?? x.player?.team?.id;
    if (tid === hid) home.push(x);
    else if (tid === aid) away.push(x);
  }
  return { home, away };
}

/** Accepts Sportmonks `odds` include: either `[{ bookmakers: [...] }]` or a flat bookmakers list. */
export function summarizeSportmonksOdds(oddsPayload) {
  if (!oddsPayload?.length) return { note: "No odds in response" };
  let bookmakers = oddsPayload;
  const top = oddsPayload[0];
  if (top?.bookmakers?.length) {
    bookmakers = top.bookmakers;
  }
  const first = bookmakers[0];
  if (!first) return { note: "No bookmakers in odds include" };
  const bookmaker = first.name ?? "unknown";
  const bets = first.bets ?? [];
  const matchWinner = bets.find(
    (b) =>
      /match winner|fulltime|3-way|1x2|result/i.test(String(b.name ?? "")) ||
      b.name === "Match Winner" ||
      b.name === "Fulltime Result" ||
      b.name === "3-Way Result",
  );
  if (!matchWinner?.values?.length) {
    return { bookmaker, note: "No Match Winner / fulltime market in first bookmaker" };
  }
  const vals = matchWinner.values;
  const line = vals.map((v) => `${v.label ?? v.name ?? v.value}: ${v.odd ?? v.value}`).join(" | ");
  return { bookmaker, market: matchWinner.name, line, rawValueCount: vals.length };
}

export function buildLlmPack({
  homeTeam,
  awayTeam,
  fixtureRow,
  homeRecent,
  awayRecent,
  h2h,
  injuries,
  homeTech,
  awayTech,
  h2hSum,
  oddsSummary,
  anchorDate,
  dataSource,
  extras,
}) {
  const hid = homeTeam.id;
  const aid = awayTeam.id;
  const homeForm = aggregateForm(homeRecent, hid);
  const awayForm = aggregateForm(awayRecent, aid);

  const matchBlock = fixtureRow?.fixture
    ? {
        id: fixtureRow.fixture.id,
        date: fixtureRow.fixture.date,
        timezone: fixtureRow.fixture.timezone ?? null,
        status: fixtureRow.fixture.status,
        league: fixtureRow.league?.name ?? null,
        round: fixtureRow.league?.round ?? null,
        venue: fixtureRow.fixture.venue?.name ?? fixtureRow.fixture.venue ?? null,
      }
    : null;

  return {
    schemaVersion: 2,
    dataSource: dataSource ?? "api-football",
    roleHint:
      "Use as quantitative prior only; combine with news for motivation, travel, and suspensions. Never claim certainty.",
    match: matchBlock,
    teams: {
      home: { id: hid, name: homeTeam.name },
      away: { id: aid, name: awayTeam.name },
    },
    fundamentals: {
      home: {
        record: homeForm.overall,
        homeAwaySplit: { homeVenue: homeForm.venue.home, awayVenue: homeForm.venue.away },
      },
      away: {
        record: awayForm.overall,
        homeAwaySplit: { homeVenue: awayForm.venue.home, awayVenue: awayForm.venue.away },
      },
    },
    technicalLast5: {
      home: homeTech,
      away: awayTech,
      note: "xG/possession depend on league coverage and plan add-ons; nulls mean missing stat rows — do not invent numbers.",
    },
    headToHead: {
      sampleSize: h2hSum.sampleSize,
      homeTeamWins: h2hSum.teamFirstIdWins,
      awayTeamWins: h2hSum.teamSecondIdWins,
      draws: h2hSum.draws,
      avgTotalGoals: h2hSum.avgTotalGoals,
    },
    injuries: (() => {
      const sp = splitInjuriesByTeam(injuries, hid, aid);
      return {
        home: injuriesShortList(sp.home),
        away: injuriesShortList(sp.away),
        combined: injuriesShortList(injuries),
      };
    })(),
    scheduleLoad: {
      anchor: anchorDate,
      homeMatchesLast7Days: matchesInLast7Days(homeRecent, hid, anchorDate),
      awayMatchesLast7Days: matchesInLast7Days(awayRecent, aid, anchorDate),
      note: "Does not include travel distance; research cups and international breaks via web.",
    },
    market: oddsSummary,
    analystHeuristics: {
      strikerOrTopScorerOut:
        "If confirmed key scorer is out, consider lowering goal expectation ~0.5 vs baseline (qualitative).",
      dataPriority:
        "Prefer comparing last-5 xG in llmPack when present; else use goals GF/GA trends.",
    },
    ...(extras && typeof extras === "object" ? extras : {}),
  };
}
