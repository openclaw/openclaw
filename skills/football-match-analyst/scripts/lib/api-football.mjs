/**
 * API-Sports Football v3 provider.
 */

import { FINISHED, buildLlmPack, h2hAggregate, parsePercent, parseStatNumber } from "./shared.mjs";

const BASE = "https://v3.football.api-sports.io";

export async function apiFootballGet(path, key) {
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": key },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${json?.message ?? text.slice(0, 200)}`);
  }
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message || String(e)).join("; ");
    throw new Error(msg || "API returned errors");
  }
  return json;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamMatchesQuery(teamName, query) {
  const a = norm(teamName);
  const b = norm(query);
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}

async function searchTeam(key, q) {
  const data = await apiFootballGet(`/teams?search=${encodeURIComponent(q)}`, key);
  const rows = data.response ?? [];
  return rows.map((r) => r.team).filter(Boolean);
}

function pickTeam(candidates, label) {
  if (!candidates.length) return { team: null, warning: `No team found for "${label}"` };
  if (candidates.length === 1) return { team: candidates[0], warning: null };
  const names = candidates.slice(0, 8).map((t) => t.name);
  return {
    team: candidates[0],
    warning: `Multiple matches for "${label}"; using first: ${candidates[0].name}. Others: ${names.join(", ")}`,
  };
}

async function findFixtureOnDate(key, date, homeId, awayId, homeQ, awayQ) {
  const data = await apiFootballGet(`/fixtures?date=${encodeURIComponent(date)}&timezone=UTC`, key);
  const fixtures = data.response ?? [];
  const warnings = [];

  for (const row of fixtures) {
    const hId = row?.teams?.home?.id;
    const aId = row?.teams?.away?.id;
    if (!hId || !aId) continue;
    const byId = (hId === homeId && aId === awayId) || (hId === awayId && aId === homeId);
    if (byId) {
      if (!(hId === homeId && aId === awayId)) {
        warnings.push("Fixture found with home/away reversed vs your --home/--away order.");
      }
      return { fixture: row, warnings };
    }
  }

  for (const row of fixtures) {
    const h = row?.teams?.home?.name;
    const aw = row?.teams?.away?.name;
    if (!h || !aw) continue;
    const homeOk = teamMatchesQuery(h, homeQ) || teamMatchesQuery(homeQ, h);
    const awayOk = teamMatchesQuery(aw, awayQ) || teamMatchesQuery(awayQ, aw);
    const swapped =
      (teamMatchesQuery(h, awayQ) || teamMatchesQuery(awayQ, h)) &&
      (teamMatchesQuery(aw, homeQ) || teamMatchesQuery(homeQ, aw));
    if ((homeOk && awayOk) || swapped) {
      if (swapped && !(homeOk && awayOk)) {
        warnings.push("Teams appear swapped vs input; matched fixture with home/away reversed.");
      }
      return { fixture: row, warnings };
    }
  }
  return { fixture: null, warnings: [`No fixture on ${date} matched "${homeQ}" vs "${awayQ}".`] };
}

async function fetchFixtureById(key, id) {
  const data = await apiFootballGet(`/fixtures?id=${id}`, key);
  return data.response?.[0] ?? null;
}

async function recentFixtures(key, teamId, last) {
  const data = await apiFootballGet(`/fixtures?team=${teamId}&last=${last}`, key);
  return data.response ?? [];
}

async function headToHead(key, id1, id2, last) {
  const data = await apiFootballGet(`/fixtures/headtohead?h2h=${id1}-${id2}&last=${last}`, key);
  return data.response ?? [];
}

async function injuriesForFixture(key, fixtureId) {
  const data = await apiFootballGet(`/injuries?fixture=${fixtureId}`, key);
  return data.response ?? [];
}

async function coachesForTeam(key, teamId) {
  const data = await apiFootballGet(`/coachs?team=${teamId}`, key);
  return data.response ?? [];
}

async function oddsForFixture(key, fixtureId) {
  try {
    const data = await apiFootballGet(`/odds?fixture=${fixtureId}`, key);
    return data.response ?? [];
  } catch {
    return [];
  }
}

function parseFixtureStatisticsByTeam(data) {
  const byId = {};
  for (const block of data.response ?? []) {
    const tid = block.team?.id;
    if (!tid) continue;
    const row = { xg: null, possession: null };
    for (const s of block.statistics ?? []) {
      const type = String(s.type || "").toLowerCase();
      const v = s.value;
      if (type.includes("expected") || type === "xg" || type.includes("expected goals")) {
        row.xg = parseStatNumber(v);
      }
      if (type.includes("possession")) {
        row.possession = parsePercent(v);
      }
    }
    byId[tid] = row;
  }
  return byId;
}

async function fixtureStatisticsByTeam(key, fixtureId) {
  const data = await apiFootballGet(`/fixtures/statistics?fixture=${fixtureId}`, key);
  return parseFixtureStatisticsByTeam(data);
}

async function last5TechSeries(key, teamId, rows) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  const take = finished.slice(0, 5);
  const points = [];
  for (const row of take) {
    const fid = row.fixture?.id;
    if (!fid) continue;
    try {
      const byTeam = await fixtureStatisticsByTeam(key, fid);
      const t = byTeam[teamId] ?? {};
      points.push({
        fixtureId: fid,
        date: row.fixture?.date ?? null,
        xgFor: t.xg ?? null,
        possession: t.possession ?? null,
      });
    } catch {
      points.push({
        fixtureId: fid,
        date: row.fixture?.date ?? null,
        xgFor: null,
        possession: null,
      });
    }
  }

  const xgs = points.map((p) => p.xgFor).filter((x) => x != null);
  const poss = points.map((p) => p.possession).filter((x) => x != null);
  const avg = (arr) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;

  return {
    games: points,
    last5AvgXgFor: avg(xgs),
    last5AvgPossession: avg(poss),
    xgCoverage: `${xgs.length}/5`,
  };
}

function summarizeOdds(oddsResponse) {
  const rows = oddsResponse ?? [];
  if (!rows.length) return null;

  const entry = rows[0];
  const bookmakers = entry.bookmakers ?? [];
  const first = bookmakers[0];
  if (!first) {
    return { note: "Odds payload had no bookmakers (fixture may lack odds yet)" };
  }

  const bookmaker = first.name ?? "unknown";
  const bets = first.bets ?? [];
  const matchWinner = bets.find(
    (b) => b.name === "Match Winner" || b.name === "Home/Away" || b.name === "3-Way Result",
  );
  if (!matchWinner?.values?.length) {
    return { bookmaker, note: "No Match Winner market in first bookmaker row" };
  }

  const vals = matchWinner.values;
  const line = vals.map((v) => `${v.value}: ${v.odd}`).join(" | ");
  return {
    bookmaker,
    market: matchWinner.name,
    line,
    rawValueCount: vals.length,
  };
}

export async function runApiFootball(args, key) {
  const last = args.last;
  const warnings = [];

  let fixtureRow = null;
  let homePick;
  let awayPick;

  if (args.fixture) {
    fixtureRow = await fetchFixtureById(key, args.fixture);
    if (!fixtureRow?.teams?.home?.id || !fixtureRow?.teams?.away?.id) {
      return {
        ok: false,
        llmPack: null,
        meta: { source: "api-football v3", last, warnings: [`Fixture ${args.fixture} not found.`] },
        raw: null,
      };
    }
    homePick = { team: fixtureRow.teams.home, warning: null };
    awayPick = { team: fixtureRow.teams.away, warning: null };
  } else {
    const homeSearch = await searchTeam(key, args.home);
    const awaySearch = await searchTeam(key, args.away);
    homePick = pickTeam(homeSearch, args.home);
    awayPick = pickTeam(awaySearch, args.away);
    if (homePick.warning) warnings.push(homePick.warning);
    if (awayPick.warning) warnings.push(awayPick.warning);

    if (!homePick.team || !awayPick.team) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "api-football v3",
          last,
          warnings,
          error: "Could not resolve both teams. Try official English names.",
        },
        raw: null,
      };
    }

    const hid = homePick.team.id;
    const aid = awayPick.team.id;

    const { fixture: found, warnings: w2 } = await findFixtureOnDate(
      key,
      args.date,
      hid,
      aid,
      args.home,
      args.away,
    );
    warnings.push(...w2);
    fixtureRow = found;
    if (!fixtureRow) {
      warnings.push(
        "No fixture on that date; aggregates still use recent fixtures — verify date/league.",
      );
    }
  }

  const hid = homePick.team.id;
  const aid = awayPick.team.id;

  const [homeRecent, awayRecent, h2h, homeCoaches, awayCoaches] = await Promise.all([
    recentFixtures(key, hid, last),
    recentFixtures(key, aid, last),
    headToHead(key, hid, aid, 10),
    coachesForTeam(key, hid),
    coachesForTeam(key, aid),
  ]);

  let injuries = [];
  const fixtureId = fixtureRow?.fixture?.id;
  if (fixtureId) {
    try {
      injuries = await injuriesForFixture(key, fixtureId);
    } catch (e) {
      warnings.push(`Injuries fetch failed: ${e.message}`);
    }
  }

  const anchorDate =
    fixtureRow?.fixture?.date ??
    (args.date ? `${args.date}T12:00:00+00:00` : new Date().toISOString());

  const [homeTech, awayTech, oddsSummary] = await Promise.all([
    last5TechSeries(key, hid, homeRecent),
    last5TechSeries(key, aid, awayRecent),
    fixtureId ? oddsForFixture(key, fixtureId).then(summarizeOdds) : Promise.resolve(null),
  ]);

  const h2hSum = h2hAggregate(h2h, hid, aid);

  const llmPack = buildLlmPack({
    homeTeam: homePick.team,
    awayTeam: awayPick.team,
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
    dataSource: "api-football",
  });

  const out = {
    ok: true,
    query: args.fixture
      ? { fixture: args.fixture, provider: "api-football" }
      : { date: args.date, home: args.home, away: args.away, provider: "api-football" },
    llmPack,
    meta: {
      source: "api-football v3",
      last,
      apiCallsNote:
        "Last-5 xG/possession issues up to 10 extra /fixtures/statistics calls; odds uses /odds when fixture id known.",
      warnings,
    },
  };

  if (args.verbose) {
    out.raw = {
      teams: { home: homePick.team, away: awayPick.team },
      fixture: fixtureRow,
      recent: { home: homeRecent, away: awayRecent },
      headToHead: h2h,
      injuries,
      coaches: { home: homeCoaches, away: awayCoaches },
    };
  }

  return out;
}
