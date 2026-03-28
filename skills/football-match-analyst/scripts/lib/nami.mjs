/**
 * 纳米数据 — 足球资料库 API（与官网产品文档路径对齐）
 * 文档页: https://www.nami.com/zh/details/7j8gxi0to7inrql#interface
 *
 * 网关: NAMI_API_BASE（默认 https://open.sportnanoapi.com）
 * 认证: 查询参数 user + secret（非 header）；商务侧常配合 IP 白名单。
 *
 * 本产品包含的接口（默认路径）:
 *   GET /api/v5/football/match/list                    — 获取比赛列表
 *   GET /api/v5/football/match/schedule/season        — 获取赛程赛果列表（赛季）
 *   GET /api/v5/football/season/table/detail          — 赛季积分榜
 *   GET /api/v5/football/season/stats/detail          — 赛季统计详情
 *   GET /api/v5/football/archive                      — 打包数据地址
 *
 * 具体查询参数名以你合同/后台说明为准，可通过 NAMI_PARAM_* 与 NAMI_MATCH_LIST_EXTRA 调整。
 */

import { FINISHED, buildLlmPack, h2hAggregate, parseStatNumber } from "./shared.mjs";

/** Default paths from Nami「足球资料库」product API list */
const PATHS = {
  matchList: "/api/v5/football/match/list",
  scheduleSeason: "/api/v5/football/match/schedule/season",
  seasonTable: "/api/v5/football/season/table/detail",
  seasonStats: "/api/v5/football/season/stats/detail",
  archive: "/api/v5/football/archive",
};

function envPath(key, fallback) {
  const v = process.env[key]?.trim();
  return v || fallback;
}

function parseFinishedStatusIds() {
  const raw = process.env.NAMI_STATUS_FINISHED_IDS?.trim() || "8,9,10,11,12";
  return new Set(
    raw
      .split(/[,;]/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}

function namiBase() {
  return (process.env.NAMI_API_BASE?.trim() || "https://open.sportnanoapi.com").replace(/\/$/, "");
}

async function namiFetch(user, secret, path, extraParams = {}) {
  const u = new URL(`${namiBase()}${path.startsWith("/") ? path : `/${path}`}`);
  u.searchParams.set("user", user);
  u.searchParams.set("secret", secret);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return { httpStatus: res.status, json };
}

function ensureNamiOk(json) {
  if (json == null || typeof json !== "object") throw new Error("Invalid JSON body");
  if (json.err != null && json.err !== "") throw new Error(String(json.err));
  if (json.error != null && json.error !== "") throw new Error(String(json.error));
}

/**
 * Success: code 0/200 or omitted with results; errors: ensureNamiOk already threw on `err`.
 */
function unwrapList(json) {
  ensureNamiOk(json);
  const code = json.code ?? json.errCode;
  if (code != null && code !== 0 && code !== 200 && code !== "0") {
    const msg = json.msg ?? json.message ?? json.errMsg ?? `code=${code}`;
    throw new Error(String(msg));
  }
  const list =
    json.results ??
    json.data?.results ??
    (Array.isArray(json.data) ? json.data : null) ??
    json.list ??
    json.rows ??
    [];
  return Array.isArray(list) ? list : [];
}

function unwrapObject(json) {
  ensureNamiOk(json);
  const code = json.code ?? json.errCode;
  if (code != null && code !== 0 && code !== 200 && code !== "0") {
    const msg = json.msg ?? json.message ?? `code=${code}`;
    throw new Error(String(msg));
  }
  return json.results ?? json.data ?? json;
}

/** Calendar day → Unix seconds (UTC) inclusive range for match/list filters */
function utcDayRangeUnix(dateYmd) {
  const start = Math.floor(new Date(`${dateYmd}T00:00:00.000Z`).getTime() / 1000);
  const end = Math.floor(new Date(`${dateYmd}T23:59:59.999Z`).getTime() / 1000);
  return { start, end };
}

function mergeExtraParams() {
  const raw = process.env.NAMI_MATCH_LIST_EXTRA?.trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return typeof o === "object" && o != null ? o : {};
  } catch {
    return {};
  }
}

function formatMatchTime(t) {
  if (t == null) return null;
  if (typeof t === "number" && Number.isFinite(t)) {
    return new Date(t * 1000).toISOString();
  }
  if (typeof t === "string" && /^\d{10,13}$/.test(t.trim())) {
    const n = Number(t.trim());
    const sec = n > 1e12 ? n / 1000 : n;
    return new Date(sec * 1000).toISOString();
  }
  return String(t);
}

function extractScoreField(scores) {
  if (scores == null) return null;
  if (typeof scores === "number") return scores;
  if (Array.isArray(scores) && scores.length > 0) {
    const x = scores[0];
    if (typeof x === "number") return x;
    if (typeof x === "object" && x != null && x.score != null) return Number(x.score);
    return Number(x);
  }
  if (typeof scores === "object" && scores != null) {
    if (scores.score != null) return Number(scores.score);
    if (scores.fulltime != null) return Number(scores.fulltime);
  }
  return null;
}

function isNamiFinished(m, finishedIds) {
  const sid = m.status_id ?? m.status?.id ?? m.match_status;
  if (sid != null && finishedIds.has(Number(sid))) return true;
  const hg = extractScoreField(m.home_scores ?? m.home_score);
  const ag = extractScoreField(m.away_scores ?? m.away_score);
  return hg != null && ag != null && Number.isFinite(hg) && Number.isFinite(ag);
}

export function namiMatchToRow(m, finishedIds) {
  const hid = m.home_team_id ?? m.home_team?.id ?? m.home_id;
  const aid = m.away_team_id ?? m.away_team?.id ?? m.away_id;
  const hname = m.home_team_name ?? m.home_team?.name ?? m.home?.name;
  const aname = m.away_team_name ?? m.away_team?.name ?? m.away?.name;
  const hg = extractScoreField(m.home_scores ?? m.home_score);
  const ag = extractScoreField(m.away_scores ?? m.away_score);
  const finished = isNamiFinished(m, finishedIds);
  const t = formatMatchTime(m.match_time ?? m.start_time ?? m.match_date ?? m.time);
  return {
    fixture: {
      id: m.id ?? m.match_id,
      date: t,
      timezone: "UTC",
      status: { short: finished ? "FT" : "NS" },
      venue: m.venue_name ?? m.venue?.name ?? null,
    },
    teams: {
      home: { id: hid, name: hname },
      away: { id: aid, name: aname },
    },
    goals: { home: hg, away: ag },
    league: m.competition_name
      ? {
          name: m.competition_name,
          round: m.round?.round_num != null ? String(m.round.round_num) : null,
        }
      : null,
    _nami: { raw: m },
  };
}

function mapMatches(rows, finishedIds) {
  return (rows ?? []).map((m) => namiMatchToRow(m, finishedIds));
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

async function searchTeamsOptional(user, secret, q) {
  const path = process.env.NAMI_PATH_TEAM_SEARCH?.trim();
  if (!path) return [];
  const kwKey = process.env.NAMI_PARAM_KEYWORD?.trim() || "keyword";
  const { json } = await namiFetch(user, secret, path, { [kwKey]: q });
  const list = unwrapList(json);
  return list.map((t) => ({ id: t.id ?? t.team_id, name: t.name ?? t.team_name ?? t.short_name }));
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

function resolveTeamsFromEnv() {
  const h = process.env.NAMI_HOME_TEAM_ID?.trim();
  const a = process.env.NAMI_AWAY_TEAM_ID?.trim();
  const hn = process.env.NAMI_HOME_TEAM_NAME?.trim();
  const an = process.env.NAMI_AWAY_TEAM_NAME?.trim();
  if (!h || !a) return null;
  const hid = Number.parseInt(h, 10);
  const aid = Number.parseInt(a, 10);
  if (!Number.isFinite(hid) || !Number.isFinite(aid)) return null;
  return {
    home: { id: hid, name: hn || `team_id=${hid}` },
    away: { id: aid, name: an || `team_id=${aid}` },
  };
}

/** GET match/list — 资料库核心；按日筛选优先使用 start_time/end_time（可改名） */
async function fetchMatchList(user, secret, params) {
  const path = envPath("NAMI_PATH_MATCH_LIST", PATHS.matchList);
  const merged = { ...mergeExtraParams(), ...params };
  const { json } = await namiFetch(user, secret, path, merged);
  return unwrapList(json);
}

async function matchesForDate(user, secret, dateYmd) {
  const { start, end } = utcDayRangeUnix(dateYmd);
  const sk = process.env.NAMI_PARAM_START_TIME?.trim() || "start_time";
  const ek = process.env.NAMI_PARAM_END_TIME?.trim() || "end_time";
  return fetchMatchList(user, secret, { [sk]: start, [ek]: end });
}

/** Team history: same match/list + team_id（若你合同使用其它路径，改 NAMI_PATH_TEAM_MATCHES） */
async function teamMatchHistory(user, secret, teamId, limit) {
  const path = envPath("NAMI_PATH_TEAM_MATCHES", envPath("NAMI_PATH_MATCH_LIST", PATHS.matchList));
  const tidKey = process.env.NAMI_PARAM_TEAM_ID?.trim() || "team_id";
  const limitKey = process.env.NAMI_PARAM_LIMIT?.trim() || "limit";
  const { json } = await namiFetch(user, secret, path, {
    [tidKey]: teamId,
    [limitKey]: String(limit),
    ...mergeExtraParams(),
  });
  return unwrapList(json);
}

async function fetchMatchById(user, secret, matchId) {
  const idKey = process.env.NAMI_PARAM_MATCH_ID?.trim() || "id";
  const rows = await fetchMatchList(user, secret, { [idKey]: matchId });
  if (rows.length) return rows[0];
  return null;
}

async function matchDetailOptional(user, secret, matchId) {
  const path = process.env.NAMI_PATH_MATCH_DETAIL?.trim();
  if (!path) return null;
  try {
    const idKey = process.env.NAMI_PARAM_MATCH_ID?.trim() || "match_id";
    const { json } = await namiFetch(user, secret, path, { [idKey]: matchId });
    ensureNamiOk(json);
    return json.results ?? json.data ?? json;
  } catch {
    return null;
  }
}

async function fetchSeasonTableOptional(user, secret) {
  const sid = process.env.NAMI_SEASON_ID?.trim();
  if (!sid) return null;
  const path = envPath("NAMI_PATH_SEASON_TABLE", PATHS.seasonTable);
  const key = process.env.NAMI_PARAM_SEASON_ID?.trim() || "season_id";
  try {
    const { json } = await namiFetch(user, secret, path, { [key]: sid });
    return unwrapObject(json);
  } catch {
    return null;
  }
}

async function fetchSeasonStatsOptional(user, secret) {
  const sid = process.env.NAMI_SEASON_ID?.trim();
  if (!sid) return null;
  const path = envPath("NAMI_PATH_SEASON_STATS", PATHS.seasonStats);
  const key = process.env.NAMI_PARAM_SEASON_ID?.trim() || "season_id";
  try {
    const { json } = await namiFetch(user, secret, path, { [key]: sid });
    return unwrapObject(json);
  } catch {
    return null;
  }
}

async function fetchArchiveOptional(user, secret) {
  const path = envPath("NAMI_PATH_ARCHIVE", PATHS.archive);
  try {
    const { json } = await namiFetch(user, secret, path, {});
    return unwrapObject(json);
  } catch {
    return null;
  }
}

function findFixtureOnDate(rows, finishedIds, date, homeId, awayId, homeQ, awayQ) {
  const warnings = [];
  const mapped = mapMatches(rows, finishedIds);

  for (const row of mapped) {
    const hId = row.teams?.home?.id;
    const aId = row.teams?.away?.id;
    if (!hId || !aId) continue;
    const byId = (hId === homeId && aId === awayId) || (hId === awayId && aId === homeId);
    if (byId) {
      if (!(hId === homeId && aId === awayId)) {
        warnings.push("Fixture found with home/away reversed vs your --home/--away order.");
      }
      return { fixture: row, warnings };
    }
  }

  for (const row of mapped) {
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
      return { fixture: row, warnings };
    }
  }
  return { fixture: null, warnings: [`No fixture on ${date} matched "${homeQ}" vs "${awayQ}".`] };
}

function opponentId(row, teamId) {
  const hs = row.teams?.home?.id;
  const as = row.teams?.away?.id;
  if (hs === teamId) return as;
  if (as === teamId) return hs;
  return null;
}

function h2hFromRecent(homeRecent, awayRecent, id1, id2, cap) {
  const seen = new Map();
  for (const r of homeRecent) {
    if (opponentId(r, id1) === id2 && r.fixture?.id != null) seen.set(r.fixture.id, r);
  }
  for (const r of awayRecent) {
    if (opponentId(r, id2) === id1 && r.fixture?.id != null) seen.set(r.fixture.id, r);
  }
  const arr = [...seen.values()].sort((a, b) => {
    const ta = new Date(a.fixture?.date ?? 0).getTime();
    const tb = new Date(b.fixture?.date ?? 0).getTime();
    return tb - ta;
  });
  return arr.slice(0, cap);
}

function injuriesFromDetail(detail) {
  if (!detail || typeof detail !== "object") return [];
  const raw =
    detail.injuries ?? detail.injury ?? detail.missing_players ?? detail.lineup_injury ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list.map((x) => ({
    player: { name: x.player_name ?? x.name ?? x.player?.name ?? "unknown" },
    team: x.team_id ? { id: x.team_id } : { id: x.team?.id },
    type: x.type ?? x.reason_type ?? null,
    reason: x.reason ?? x.detail ?? null,
  }));
}

function oddsFromDetail(detail) {
  if (!detail?.odds && !detail?.europe_odds && !detail?.asian_odds) return null;
  const eo = detail.europe_odds ?? detail.odds?.europe;
  if (eo && (Array.isArray(eo) || typeof eo === "object")) {
    const parts = Array.isArray(eo) ? eo : [eo];
    const line = parts
      .slice(0, 3)
      .map((o) => `${o.label ?? o.name ?? "?"}: ${o.value ?? o.odd ?? o}`)
      .join(" | ");
    return { bookmaker: "nami", market: "europe_odds", line, rawValueCount: parts.length };
  }
  return { bookmaker: "nami", note: "Odds present but format not summarized; use verbose raw." };
}

async function last5TechNami(user, secret, rows) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  const take = finished.slice(0, 5);
  const points = [];
  for (const row of take) {
    const fid = row.fixture?.id;
    if (!fid) continue;
    const d = await matchDetailOptional(user, secret, fid);
    let xg = null;
    let possession = null;
    if (d) {
      const stats = d.statistics ?? d.tech_stats ?? d.match_stats ?? [];
      const arr = Array.isArray(stats) ? stats : Object.values(stats);
      for (const st of arr) {
        const name = String(st.name ?? st.type ?? st.key ?? "").toLowerCase();
        const v = st.value ?? st.val;
        if (name.includes("xg") || name.includes("expected")) xg = parseStatNumber(v);
        if (name.includes("possession")) possession = parseStatNumber(String(v).replace("%", ""));
      }
      if (xg == null && d.xg) xg = parseStatNumber(d.xg.home ?? d.xg);
    }
    points.push({
      fixtureId: fid,
      date: row.fixture?.date ?? null,
      xgFor: xg,
      possession,
    });
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

export async function runNami(args, user, secret) {
  const last = args.last;
  const warnings = [];
  const finishedIds = parseFinishedStatusIds();

  let fixtureRow = null;
  let detailTarget = null;
  let homePick;
  let awayPick;

  if (args.fixture) {
    const raw = await fetchMatchById(user, secret, args.fixture);
    if (!raw) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "nami-v5-archive",
          last,
          warnings: [
            `Fixture id ${args.fixture} not returned by ${PATHS.matchList} (check NAMI_PATH_MATCH_DETAIL / id param name or purchase scope).`,
          ],
        },
        raw: null,
      };
    }
    fixtureRow = namiMatchToRow(raw, finishedIds);
    detailTarget = await matchDetailOptional(user, secret, args.fixture);
    homePick = { team: fixtureRow.teams.home, warning: null };
    awayPick = { team: fixtureRow.teams.away, warning: null };
  } else {
    if (!args.date || !args.home || !args.away) {
      return {
        ok: false,
        llmPack: null,
        meta: { source: "nami-v5-archive", last, warnings: [], error: "Missing date/home/away" },
        raw: null,
      };
    }

    const fromEnv = resolveTeamsFromEnv();
    if (fromEnv) {
      homePick = { team: fromEnv.home, warning: null };
      awayPick = { team: fromEnv.away, warning: null };
      warnings.push(
        "Using NAMI_HOME_TEAM_ID / NAMI_AWAY_TEAM_ID; display names from NAMI_HOME_TEAM_NAME / NAMI_AWAY_TEAM_NAME if set.",
      );
    } else {
      const homeSearch = await searchTeamsOptional(user, secret, args.home);
      const awaySearch = await searchTeamsOptional(user, secret, args.away);
      homePick = pickTeam(homeSearch, args.home);
      awayPick = pickTeam(awaySearch, args.away);
      if (homePick.warning) warnings.push(homePick.warning);
      if (awayPick.warning) warnings.push(awayPick.warning);

      if (!homePick.team || !awayPick.team) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "nami-v5-archive",
            last,
            warnings,
            error:
              "Could not resolve teams. Set NAMI_HOME_TEAM_ID and NAMI_AWAY_TEAM_ID (see skill doc), or set NAMI_PATH_TEAM_SEARCH if your package includes team search.",
          },
          raw: null,
        };
      }
    }

    const hid = homePick.team.id;
    const aid = awayPick.team.id;

    let rawRows = [];
    try {
      rawRows = await matchesForDate(user, secret, args.date);
    } catch (e) {
      warnings.push(
        `Match list for date failed: ${e.message}. Adjust NAMI_PARAM_START_TIME/END_TIME or NAMI_MATCH_LIST_EXTRA per your contract.`,
      );
    }

    const { fixture: found, warnings: w2 } = findFixtureOnDate(
      rawRows,
      finishedIds,
      args.date,
      hid,
      aid,
      args.home,
      args.away,
    );
    warnings.push(...w2);
    fixtureRow = found;
    if (fixtureRow?.fixture?.id) {
      detailTarget = await matchDetailOptional(user, secret, fixtureRow.fixture.id);
    }
    if (!fixtureRow) {
      warnings.push(
        "No fixture on that date in match/list window; aggregates still use team-scoped lists — verify date and team ids.",
      );
    }
  }

  const hid = homePick.team.id;
  const aid = awayPick.team.id;

  let homeRaw = [];
  let awayRaw = [];
  try {
    homeRaw = await teamMatchHistory(user, secret, hid, last);
  } catch (e) {
    warnings.push(`Home team history failed: ${e.message}`);
  }
  try {
    awayRaw = await teamMatchHistory(user, secret, aid, last);
  } catch (e) {
    warnings.push(`Away team history failed: ${e.message}`);
  }

  const homeRecent = mapMatches(homeRaw, finishedIds).filter((r) =>
    FINISHED.has(r.fixture?.status?.short),
  );
  const awayRecent = mapMatches(awayRaw, finishedIds).filter((r) =>
    FINISHED.has(r.fixture?.status?.short),
  );

  const h2h = h2hFromRecent(homeRecent, awayRecent, hid, aid, 10);

  let injuries = [];
  if (detailTarget) {
    injuries = injuriesFromDetail(detailTarget);
  } else if (fixtureRow?.fixture?.id) {
    const d = await matchDetailOptional(user, secret, fixtureRow.fixture.id);
    injuries = injuriesFromDetail(d);
  }

  const anchorDate =
    fixtureRow?.fixture?.date ??
    (args.date ? `${args.date}T12:00:00+00:00` : new Date().toISOString());

  const [homeTech, awayTech, seasonTable, seasonStats, archiveInfo] = await Promise.all([
    last5TechNami(user, secret, homeRecent),
    last5TechNami(user, secret, awayRecent),
    fetchSeasonTableOptional(user, secret),
    fetchSeasonStatsOptional(user, secret),
    fetchArchiveOptional(user, secret),
  ]);

  let oddsSummary = null;
  if (detailTarget) {
    oddsSummary = oddsFromDetail(detailTarget);
  } else if (fixtureRow?.fixture?.id) {
    const d = await matchDetailOptional(user, secret, fixtureRow.fixture.id);
    oddsSummary = oddsFromDetail(d);
  }

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
    dataSource: "nami",
    extras: {
      providerExtras: {
        docRef: "https://www.nami.com/zh/details/7j8gxi0to7inrql#interface",
        endpoints: PATHS,
        seasonContext:
          seasonTable || seasonStats
            ? "NAMI_SEASON_ID set: partial season table/stats fetched (see verbose for size)."
            : "Set NAMI_SEASON_ID to also pull season/table and season/stats from the same product.",
        archiveBundle: archiveInfo
          ? "Nami archive endpoint returned bundle URL fields (see meta or verbose)."
          : null,
      },
    },
  });

  const out = {
    ok: true,
    query: args.fixture
      ? { fixture: args.fixture, provider: "nami" }
      : { date: args.date, home: args.home, away: args.away, provider: "nami" },
    llmPack,
    meta: {
      source: "nami-v5-football-archive",
      last,
      apiCallsNote:
        "Paths follow 足球资料库: /api/v5/football/match/list, schedule/season, season/table|stats/detail, archive. Responses use `err` for errors; success typically `code:0` + `results`.",
      namiSeasonSnippet:
        seasonTable || seasonStats ? { hasTable: !!seasonTable, hasStats: !!seasonStats } : null,
      namiArchiveKeys:
        archiveInfo && typeof archiveInfo === "object" ? Object.keys(archiveInfo) : null,
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
      namiDetail: detailTarget ?? null,
      namiSeasonTable: seasonTable ?? null,
      namiSeasonStats: seasonStats ?? null,
      namiArchive: archiveInfo ?? null,
    };
  }

  return out;
}
