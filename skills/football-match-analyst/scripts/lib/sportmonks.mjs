/**
 * Sportmonks Football API v3 provider.
 * @see https://docs.sportmonks.com/v3/
 */

import {
  FINISHED,
  buildLlmPack,
  h2hAggregate,
  parseStatNumber,
  summarizeSportmonksOdds,
} from "./shared.mjs";

const BASE = "https://api.sportmonks.com/v3/football";

const SM_FINISHED = new Set([5, 7, 8]);

function smUrl(path, token, extra = {}) {
  const u = new URL(`${BASE}${path.startsWith("/") ? path : `/${path}`}`);
  u.searchParams.set("api_token", token);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export async function smGet(path, token, extra = {}) {
  const url = smUrl(path, token, extra);
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      json.message || `HTTP ${res.status}: check SPORTMONKS_TOKEN and plan entitlements`,
    );
  }
  if (!res.ok) {
    throw new Error(json.message || `HTTP ${res.status}: ${text.slice(0, 200)}`);
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

function extractParticipants(f) {
  const parts = f.participants ?? [];
  let home = null;
  let away = null;
  for (const p of parts) {
    const loc = p.meta?.location;
    if (loc === "home") home = p;
    else if (loc === "away") away = p;
  }
  return { home, away };
}

function extractGoals(f) {
  const ri = f.result_info;
  if (typeof ri === "string" && ri.trim()) {
    const m = ri.trim().match(/(\d+)\s*[-:]\s*(\d+)/);
    if (m) return { home: Number(m[1]), away: Number(m[2]) };
  }
  let homeG = null;
  let awayG = null;
  for (const s of f.scores ?? []) {
    const d = String(s.description ?? "").toUpperCase();
    if (!d.includes("CURRENT") && !d.includes("2ND") && !d.includes("FULL") && !d.includes("FT"))
      continue;
    const part = s.score?.participant;
    const g = s.score?.goals;
    if (g == null || part == null) continue;
    if (part === "home") homeG = g;
    if (part === "away") awayG = g;
  }
  if (homeG != null && awayG != null) return { home: homeG, away: awayG };
  return { home: null, away: null };
}

function statusShort(stateId) {
  return SM_FINISHED.has(stateId) ? "FT" : "NS";
}

/** Map Sportmonks fixture -> API-Football-shaped row for shared aggregators. */
export function smFixtureToRow(f) {
  const { home, away } = extractParticipants(f);
  const goals = extractGoals(f);
  return {
    fixture: {
      id: f.id,
      date: f.starting_at,
      timezone: null,
      status: { short: statusShort(f.state_id) },
      venue: typeof f.venue === "object" && f.venue?.name ? f.venue.name : (f.venue ?? null),
    },
    teams: {
      home: { id: home?.id, name: home?.name },
      away: { id: away?.id, name: away?.name },
    },
    goals: { home: goals.home, away: goals.away },
    league: f.league
      ? { name: f.league.name, round: f.round?.name ?? f.stage?.name ?? null }
      : null,
    _sm: { rawStateId: f.state_id },
  };
}

function mapRows(fixtures) {
  return (fixtures ?? []).map(smFixtureToRow);
}

async function searchTeams(token, q) {
  const enc = encodeURIComponent(q);
  const data = await smGet(`/teams/search/${enc}`, token);
  return data.data ?? [];
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

async function findFixtureOnDate(token, date, homeId, awayId, homeQ, awayQ) {
  const data = await smGet(`/fixtures/date/${date}`, token, {
    include: "participants;state;league;venue",
  });
  const fixtures = data.data ?? [];
  const warnings = [];

  for (const f of fixtures) {
    const row = smFixtureToRow(f);
    const hId = row.teams?.home?.id;
    const aId = row.teams?.away?.id;
    if (!hId || !aId) continue;
    const byId = (hId === homeId && aId === awayId) || (hId === awayId && aId === homeId);
    if (byId) {
      if (!(hId === homeId && aId === awayId)) {
        warnings.push("Fixture found with home/away reversed vs your --home/--away order.");
      }
      return { fixture: smFixtureToRow(f), raw: f, warnings };
    }
  }

  for (const f of fixtures) {
    const row = smFixtureToRow(f);
    const h = row.teams?.home?.name;
    const aw = row.teams?.away?.name;
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
      return { fixture: smFixtureToRow(f), raw: f, warnings };
    }
  }
  return {
    fixture: null,
    raw: null,
    warnings: [`No fixture on ${date} matched "${homeQ}" vs "${awayQ}".`],
  };
}

function dateRangeForTeamHistory(last) {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

async function recentFixturesForTeam(token, teamId, last) {
  const { start, end } = dateRangeForTeamHistory(last);
  const data = await smGet(`/fixtures/between/${start}/${end}/${teamId}`, token, {
    include: "participants;scores;state",
    per_page: 100,
    order: "desc",
  });
  let rows = data.data ?? [];
  rows = rows.filter((f) => SM_FINISHED.has(f.state_id));
  rows = rows.slice(0, last);
  return mapRows(rows);
}

async function headToHeadRows(token, id1, id2, last) {
  const data = await smGet(`/fixtures/head-to-head/${id1}/${id2}`, token, {
    include: "participants;scores;state",
    per_page: Math.min(100, last + 20),
  });
  let rows = data.data ?? [];
  rows = rows.filter((f) => SM_FINISHED.has(f.state_id));
  rows = rows.slice(0, last);
  return mapRows(rows);
}

/** xG + possession from fixture statistics (requires plan / league coverage). */
function xgPossessionFromSmFixture(f, teamId) {
  let xg = null;
  let possession = null;
  for (const st of f.statistics ?? []) {
    const pid = st.participant_id ?? st.team_id;
    if (pid != null && pid !== teamId) continue;
    const name = String(st.type?.name ?? st.type?.developer_name ?? "").toLowerCase();
    const val = st.data?.value ?? st.value;
    if (name.includes("expected") || name.includes("xg")) {
      const n = parseStatNumber(val);
      if (n != null) xg = n;
    }
    if (name.includes("possession")) {
      const n = parseStatNumber(String(val).replace("%", ""));
      if (n != null) possession = n;
    }
  }
  if (xg == null && Array.isArray(f.xgfixture)) {
    for (const x of f.xgfixture) {
      if (x.participant_id === teamId || x.team_id === teamId) {
        const v = x.value ?? x.xg ?? x.data?.value;
        const n = parseStatNumber(v);
        if (n != null) xg = n;
      }
    }
  }
  return { xg, possession };
}

async function fetchFixtureDetailTech(token, fixtureId) {
  const includes = ["statistics.type", "xGfixture", "participants", "scores", "state"].join(";");
  try {
    const data = await smGet(`/fixtures/${fixtureId}`, token, { include: includes });
    return data.data ?? null;
  } catch {
    return null;
  }
}

async function last5TechSeriesSm(token, teamId, rows) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  const take = finished.slice(0, 5);
  const points = [];
  for (const row of take) {
    const fid = row.fixture?.id;
    if (!fid) continue;
    try {
      const raw = await fetchFixtureDetailTech(token, fid);
      if (!raw) {
        points.push({
          fixtureId: fid,
          date: row.fixture?.date ?? null,
          xgFor: null,
          possession: null,
        });
        continue;
      }
      const t = xgPossessionFromSmFixture(raw, teamId);
      points.push({
        fixtureId: fid,
        date: row.fixture?.date ?? null,
        xgFor: t.xg,
        possession: t.possession,
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

function sidelinedToInjuries(rawFixture) {
  const out = [];
  const sid = rawFixture?.sidelined ?? [];
  for (const s of sid) {
    const pl = s.player ?? s.sideline?.player;
    const tid = s.participant_id ?? pl?.team_id;
    out.push({
      player: { name: pl?.name ?? pl?.fullname ?? "unknown", firstname: pl?.firstname },
      team: tid ? { id: tid } : null,
      type: "sidelined",
      reason: s.sideline?.type?.name ?? s.type?.name ?? null,
    });
  }
  return out;
}

async function fetchFixtureFull(token, id) {
  const data = await smGet(`/fixtures/${id}`, token, {
    include: [
      "participants",
      "scores",
      "state",
      "league",
      "venue",
      "odds",
      "sidelined",
      "sideline.player",
      "lineups",
      "formations",
    ].join(";"),
  });
  return data.data;
}

export async function runSportmonks(args, token) {
  const last = args.last;
  const warnings = [];

  let fixtureRow = null;
  let rawTarget = null;
  let homePick;
  let awayPick;

  if (args.fixture) {
    rawTarget = await fetchFixtureFull(token, args.fixture);
    if (!rawTarget?.id) {
      return {
        ok: false,
        llmPack: null,
        meta: { source: "sportmonks v3", last, warnings: [`Fixture ${args.fixture} not found.`] },
        raw: null,
      };
    }
    fixtureRow = smFixtureToRow(rawTarget);
    const { home, away } = extractParticipants(rawTarget);
    homePick = { team: { id: home?.id, name: home?.name }, warning: null };
    awayPick = { team: { id: away?.id, name: away?.name }, warning: null };
  } else {
    if (!args.date || !args.home || !args.away) {
      return {
        ok: false,
        llmPack: null,
        meta: { source: "sportmonks v3", last, warnings: [], error: "Missing date/home/away" },
        raw: null,
      };
    }

    const homeSearch = await searchTeams(token, args.home);
    const awaySearch = await searchTeams(token, args.away);
    homePick = pickTeam(homeSearch, args.home);
    awayPick = pickTeam(awaySearch, args.away);
    if (homePick.warning) warnings.push(homePick.warning);
    if (awayPick.warning) warnings.push(awayPick.warning);

    if (!homePick.team || !awayPick.team) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "sportmonks v3",
          last,
          warnings,
          error: "Could not resolve both teams. Try official English names.",
        },
        raw: null,
      };
    }

    const hid = homePick.team.id;
    const aid = awayPick.team.id;

    const {
      fixture: found,
      raw,
      warnings: w2,
    } = await findFixtureOnDate(token, args.date, hid, aid, args.home, args.away);
    warnings.push(...w2);
    fixtureRow = found;
    rawTarget = raw;
    if (!fixtureRow) {
      warnings.push(
        "No fixture on that date; aggregates still use recent fixtures — verify date/league.",
      );
    }
  }

  const hid = homePick.team.id;
  const aid = awayPick.team.id;

  const [homeRecent, awayRecent, h2h] = await Promise.all([
    recentFixturesForTeam(token, hid, last),
    recentFixturesForTeam(token, aid, last),
    headToHeadRows(token, hid, aid, 10),
  ]);

  let injuries = [];
  const fixtureId = fixtureRow?.fixture?.id;
  if (rawTarget?.sidelined) {
    injuries = sidelinedToInjuries(rawTarget);
  } else if (fixtureId) {
    try {
      const full = await fetchFixtureFull(token, fixtureId);
      injuries = sidelinedToInjuries(full ?? {});
    } catch (e) {
      warnings.push(`Sidelined fetch failed: ${e.message}`);
    }
  }

  const anchorDate =
    fixtureRow?.fixture?.date ??
    (args.date ? `${args.date}T12:00:00+00:00` : new Date().toISOString());

  const [homeTech, awayTech] = await Promise.all([
    last5TechSeriesSm(token, hid, homeRecent),
    last5TechSeriesSm(token, aid, awayRecent),
  ]);

  let oddsSummary = null;
  if (rawTarget?.odds?.length) {
    oddsSummary = summarizeSportmonksOdds(rawTarget.odds);
  } else if (fixtureId) {
    try {
      const full = await fetchFixtureFull(token, fixtureId);
      if (full?.odds?.length) oddsSummary = summarizeSportmonksOdds(full.odds);
    } catch {
      /* ignore */
    }
  }

  const h2hSum = h2hAggregate(h2h, hid, aid);

  const lineupNote =
    rawTarget?.lineups?.length || rawTarget?.formations?.length
      ? {
          lineupOrFormation:
            "Lineups/formations present in raw response when verbose; predicted XI may require premium feeds.",
        }
      : undefined;

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
    dataSource: "sportmonks",
    extras: lineupNote ? { providerExtras: lineupNote } : undefined,
  });

  const out = {
    ok: true,
    query: args.fixture
      ? { fixture: args.fixture, provider: "sportmonks" }
      : { date: args.date, home: args.home, away: args.away, provider: "sportmonks" },
    llmPack,
    meta: {
      source: "sportmonks v3",
      last,
      apiCallsNote:
        "Uses /fixtures/between for team history, /fixtures/head-to-head for H2H, extra /fixtures/{id} calls for last-5 tech + sidelined + odds. xG add-on may be required for full xG coverage.",
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
      sportmonksFixture: rawTarget ?? null,
    };
  }

  return out;
}
