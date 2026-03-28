/**
 * Opta / Stats Perform–style HTTP provider (contract-configurable).
 *
 * Opta 数据多经 Stats Perform 等合同交付，REST 路径与鉴权因客户而异。
 * 通过 OPTA_API_BASE、OPTA_API_KEY 与 OPTA_PATH_* / OPTA_PARAM_* 对齐你的接口文档。
 *
 * 认证常见模式（OPTA_AUTH_MODE）:
 *   subscription — Ocp-Apim-Subscription-Key: <key>
 *   bearer       — Authorization: Bearer <key>
 *   apikey       — 自定义头 OPTA_AUTH_HEADER（默认 X-API-Key）
 *
 * 球队解析：优先 OPTA_HOME_TEAM_ID / OPTA_AWAY_TEAM_ID；若配置 OPTA_PATH_TEAM_SEARCH 则尝试按名称搜索。
 */

import { FINISHED, buildLlmPack, h2hAggregate, parseStatNumber } from "./shared.mjs";

function envTrim(key) {
  return process.env[key]?.trim() ?? "";
}

function optaBase() {
  const b = envTrim("OPTA_API_BASE");
  return b.replace(/\/$/, "");
}

function authHeaders() {
  const key = envTrim("OPTA_API_KEY");
  if (!key) throw new Error("Missing OPTA_API_KEY");
  const mode = (envTrim("OPTA_AUTH_MODE") || "subscription").toLowerCase();
  if (mode === "bearer") {
    return { Authorization: `Bearer ${key}`, Accept: "application/json" };
  }
  if (mode === "apikey") {
    const h = envTrim("OPTA_AUTH_HEADER") || "X-API-Key";
    return { [h]: key, Accept: "application/json" };
  }
  return { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" };
}

/** Expand `{matchId}`, `{teamId}`, `{date}`, `{id1}`, `{id2}`, `{limit}` in path */
function expandPath(template, vars) {
  let p = template;
  for (const [k, v] of Object.entries(vars)) {
    p = p.split(`{${k}}`).join(encodeURIComponent(String(v ?? "")));
  }
  if (/\{[a-zA-Z]+\}/.test(p)) {
    throw new Error(`Path still has placeholders: ${p}`);
  }
  return p.startsWith("/") ? p : `/${p}`;
}

async function optaGet(path, query = {}) {
  const base = optaBase();
  if (!base) throw new Error("Set OPTA_API_BASE to your Stats Perform / Opta REST gateway");
  const u = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  const res = await fetch(u.toString(), { headers: authHeaders() });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(json?.message || json?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

function finishedStatusSet() {
  const raw = envTrim("OPTA_FINISHED_STATUS") || "FT,AET,PEN,FINISHED,COMPLETE,Played,FullTime";
  return new Set(
    raw
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameId(a, b) {
  return String(a) === String(b);
}

function teamMatchesQuery(teamName, query) {
  const a = norm(teamName);
  const b = norm(query);
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}

/** Pull array of match-like objects from arbitrary JSON */
function extractMatchList(json) {
  const key = envTrim("OPTA_JSON_MATCHES_KEY");
  if (key) {
    const parts = key.split(".");
    let cur = json;
    for (const p of parts) {
      cur = cur?.[p];
    }
    if (Array.isArray(cur)) return cur;
  }
  for (const k of ["data", "matches", "results", "items", "content", "fixtures", "events"]) {
    const v = json?.[k];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(json)) return json;
  return [];
}

function firstScore(obj) {
  if (!obj || typeof obj !== "object") return { home: null, away: null };
  const h =
    obj.home ??
    obj.homeScore ??
    obj.home_goals ??
    obj.scoreHome ??
    obj.totalHome ??
    obj.homeTeamScore;
  const a =
    obj.away ??
    obj.awayScore ??
    obj.away_goals ??
    obj.scoreAway ??
    obj.totalAway ??
    obj.awayTeamScore;
  const hn = h != null ? Number(h) : null;
  const an = a != null ? Number(a) : null;
  return {
    home: Number.isFinite(hn) ? hn : null,
    away: Number.isFinite(an) ? an : null,
  };
}

/**
 * Map one vendor match object → API-Football-shaped row.
 * Tries several common Opta/Perform JSON shapes.
 */
export function optaMatchToRow(raw) {
  const fin = finishedStatusSet();

  let id = raw.id ?? raw.matchId ?? raw.fixtureId ?? raw.eventId ?? raw.uuid ?? raw.gameId;
  const date =
    raw.matchDate ?? raw.date ?? raw.startTime ?? raw.utcDate ?? raw.scheduled ?? raw.kickoff;

  let homeTeam = raw.homeTeam ?? raw.home;
  let awayTeam = raw.awayTeam ?? raw.away;
  let goals = firstScore(raw.score ?? raw.fullTime ?? raw.result ?? raw);

  if (!homeTeam?.id && Array.isArray(raw.contestants)) {
    let h;
    let a;
    for (const c of raw.contestants) {
      const pos = String(c.position ?? c.side ?? c.homeAway ?? "").toLowerCase();
      if (pos === "home" || pos === "1") h = c;
      if (pos === "away" || pos === "2") a = c;
    }
    if (h && a) {
      homeTeam = { id: h.id ?? h.teamId, name: h.name ?? h.teamName };
      awayTeam = { id: a.id ?? a.teamId, name: a.name ?? a.teamName };
    }
  }

  if (!homeTeam?.id && raw.teams && typeof raw.teams === "object") {
    const th = raw.teams.home ?? raw.teams[0];
    const ta = raw.teams.away ?? raw.teams[1];
    if (th && ta) {
      homeTeam = { id: th.id, name: th.name };
      awayTeam = { id: ta.id, name: ta.name };
    }
  }

  if (goals.home == null && raw.scores && Array.isArray(raw.scores)) {
    for (const s of raw.scores) {
      const d = String(s.description ?? s.period ?? "").toUpperCase();
      if (!d.includes("FULL") && !d.includes("FT") && !d.includes("CURRENT")) continue;
      const part = s.team ?? s.side ?? s.participant;
      const g = s.goals ?? s.value ?? s.score;
      if (part === "home" || part === 1 || part === "HOME") goals.home = Number(g);
      if (part === "away" || part === 2 || part === "AWAY") goals.away = Number(g);
    }
  }

  const st =
    raw.status?.short ?? raw.status ?? raw.state ?? raw.matchStatus ?? raw.period ?? raw.phase;
  const short = String(st ?? "NS");
  const finishedLike = fin.has(short.toLowerCase()) || FINISHED.has(short);

  return {
    fixture: {
      id,
      date: date ? String(date) : null,
      timezone: raw.timezone ?? null,
      status: { short: finishedLike ? "FT" : short.length <= 4 ? short : "NS" },
      venue:
        typeof raw.venue === "string" ? raw.venue : (raw.venue?.name ?? raw.stadium?.name ?? null),
    },
    teams: {
      home: { id: homeTeam?.id ?? null, name: homeTeam?.name ?? "unknown" },
      away: { id: awayTeam?.id ?? null, name: awayTeam?.name ?? "unknown" },
    },
    goals: { home: goals.home, away: goals.away },
    league: raw.competition
      ? { name: raw.competition.name ?? raw.competition, round: raw.round ?? raw.matchday ?? null }
      : raw.tournament
        ? { name: raw.tournament.name ?? raw.tournament, round: null }
        : null,
    _opta: { rawId: id },
  };
}

function mapRows(list) {
  return (list ?? []).map(optaMatchToRow).filter((r) => r.fixture?.id != null);
}

function pathCfg() {
  return {
    matchById: envTrim("OPTA_PATH_MATCH_BY_ID") || "/matches/{matchId}",
    teamFixtures: envTrim("OPTA_PATH_TEAM_FIXTURES") || "/teams/{teamId}/fixtures",
    fixturesByDate: envTrim("OPTA_PATH_FIXTURES_BY_DATE") || "/fixtures",
    h2h: envTrim("OPTA_PATH_H2H") || "/fixtures/headtohead",
    teamSearch: envTrim("OPTA_PATH_TEAM_SEARCH"),
    matchStats: envTrim("OPTA_PATH_MATCH_STATS"),
  };
}

function paramCfg() {
  return {
    date: envTrim("OPTA_PARAM_DATE") || "date",
    limit: envTrim("OPTA_PARAM_LIMIT") || "limit",
    id1: envTrim("OPTA_PARAM_H2H_HOME") || "homeTeamId",
    id2: envTrim("OPTA_PARAM_H2H_AWAY") || "awayTeamId",
    search: envTrim("OPTA_PARAM_SEARCH") || "q",
  };
}

async function fetchMatchById(matchId) {
  const paths = pathCfg();
  const path = expandPath(paths.matchById, { matchId });
  const json = await optaGet(path);
  let one = json.data ?? json.match ?? json.fixture ?? json.results ?? json;
  if (Array.isArray(one)) one = one[0];
  const row = optaMatchToRow(one?.id != null || one?.matchId != null ? one : json);
  return row.fixture?.id != null ? row : null;
}

async function fixturesForDate(dateYmd) {
  const paths = pathCfg();
  const p = paramCfg();
  const path = paths.fixturesByDate.includes("{")
    ? expandPath(paths.fixturesByDate, { date: dateYmd })
    : paths.fixturesByDate;
  const q =
    path === paths.fixturesByDate && !paths.fixturesByDate.includes("{")
      ? { [p.date]: dateYmd }
      : {};
  const json = await optaGet(path, q);
  return mapRows(extractMatchList(json));
}

async function teamFixtures(teamId, last) {
  const paths = pathCfg();
  const p = paramCfg();
  const path = expandPath(paths.teamFixtures, { teamId });
  const json = await optaGet(path, { [p.limit]: String(last) });
  return mapRows(extractMatchList(json));
}

async function headToHeadRows(id1, id2, cap) {
  const paths = pathCfg();
  const p = paramCfg();
  try {
    const path = expandPath(paths.h2h, { id1, id2 });
    const json = await optaGet(path, {
      [p.id1]: String(id1),
      [p.id2]: String(id2),
      limit: String(cap),
    });
    return mapRows(extractMatchList(json)).slice(0, cap);
  } catch {
    const [a, b] = await Promise.all([teamFixtures(id1, 80), teamFixtures(id2, 80)]);
    const merged = [...a, ...b];
    const seen = new Map();
    for (const r of merged) {
      const fid = r.fixture?.id;
      const hs = r.teams?.home?.id;
      const as = r.teams?.away?.id;
      if (!fid || hs == null || as == null) continue;
      const ok = (sameId(hs, id1) && sameId(as, id2)) || (sameId(hs, id2) && sameId(as, id1));
      if (ok && FINISHED.has(r.fixture?.status?.short)) seen.set(fid, r);
    }
    return [...seen.values()]
      .sort((x, y) => {
        const ta = new Date(x.fixture?.date ?? 0).getTime();
        const tb = new Date(y.fixture?.date ?? 0).getTime();
        return tb - ta;
      })
      .slice(0, cap);
  }
}

function resolveTeamsFromEnv() {
  const h = envTrim("OPTA_HOME_TEAM_ID");
  const a = envTrim("OPTA_AWAY_TEAM_ID");
  if (!h || !a) return null;
  const hn = envTrim("OPTA_HOME_TEAM_NAME");
  const an = envTrim("OPTA_AWAY_TEAM_NAME");
  return {
    home: { id: Number.parseInt(h, 10) || h, name: hn || "home" },
    away: { id: Number.parseInt(a, 10) || a, name: an || "away" },
  };
}

async function searchTeamsOptional(q) {
  const path = envTrim("OPTA_PATH_TEAM_SEARCH");
  if (!path) return [];
  const p = paramCfg();
  const expanded = path.includes("{q}") ? expandPath(path, { q }) : path;
  const json = await optaGet(expanded, path.includes("{q}") ? {} : { [p.search]: q });
  const list = extractMatchList(json);
  return list
    .map((t) => ({
      id: t.id ?? t.teamId,
      name: t.name ?? t.teamName ?? t.shortName,
    }))
    .filter((x) => x.id != null && x.name);
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

function findFixtureOnDate(rows, dateYmd, homeId, awayId, homeQ, awayQ) {
  const warnings = [];
  const day = dateYmd;

  for (const row of rows) {
    const d = String(row.fixture?.date ?? "");
    if (!d.startsWith(day)) continue;
    const hId = row.teams?.home?.id;
    const aId = row.teams?.away?.id;
    if (hId == null || aId == null) continue;
    const byId =
      (sameId(hId, homeId) && sameId(aId, awayId)) || (sameId(hId, awayId) && sameId(aId, homeId));
    if (byId) {
      if (!(sameId(hId, homeId) && sameId(aId, awayId))) {
        warnings.push("Fixture found with home/away reversed vs your --home/--away order.");
      }
      return { fixture: row, warnings };
    }
  }

  for (const row of rows) {
    const d = String(row.fixture?.date ?? "");
    if (!d.startsWith(day)) continue;
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
  return {
    fixture: null,
    warnings: [`No fixture on ${dateYmd} matched "${homeQ}" vs "${awayQ}".`],
  };
}

async function matchStatsOptional(matchId, teamId) {
  const tpl = envTrim("OPTA_PATH_MATCH_STATS");
  if (!tpl) return { xg: null, possession: null };
  try {
    const path = expandPath(tpl, { matchId });
    const json = await optaGet(path);
    const block = json.data ?? json.statistics ?? json;
    let xg = null;
    let possession = null;
    const arr = Array.isArray(block) ? block : Object.values(block ?? {});
    for (const st of arr) {
      const tid = st.teamId ?? st.team_id ?? st.participantId;
      if (tid != null && String(tid) !== String(teamId)) continue;
      const name = String(st.name ?? st.type ?? st.metric ?? "").toLowerCase();
      const v = st.value ?? st.val ?? st.statValue;
      if (name.includes("xg") || name.includes("expected")) xg = parseStatNumber(v);
      if (name.includes("possession")) possession = parseStatNumber(String(v).replace("%", ""));
    }
    return { xg, possession };
  } catch {
    return { xg: null, possession: null };
  }
}

async function last5TechOpta(teamId, rows) {
  const finished = (rows ?? []).filter((r) => FINISHED.has(r?.fixture?.status?.short));
  const take = finished.slice(0, 5);
  const points = [];
  for (const row of take) {
    const fid = row.fixture?.id;
    if (!fid) continue;
    const t = await matchStatsOptional(fid, teamId);
    points.push({
      fixtureId: fid,
      date: row.fixture?.date ?? null,
      xgFor: t.xg,
      possession: t.possession,
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

function injuriesFromOptaDetail(detail) {
  if (!detail || typeof detail !== "object") return [];
  const raw = detail.injuries ?? detail.injury ?? detail.sidelined ?? detail.absences ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list.map((x) => ({
    player: { name: x.player_name ?? x.name ?? x.player?.name ?? "unknown" },
    team: x.team_id ? { id: x.team_id } : { id: x.team?.id },
    type: x.type ?? null,
    reason: x.reason ?? x.detail ?? null,
  }));
}

async function fetchMatchDetailInjuries(matchId) {
  const tpl = envTrim("OPTA_PATH_MATCH_INJURIES");
  if (!tpl) return [];
  try {
    const path = expandPath(tpl, { matchId });
    const json = await optaGet(path);
    return injuriesFromOptaDetail(json.data ?? json);
  } catch {
    return [];
  }
}

async function fetchOddsSummary(matchId) {
  const tpl = envTrim("OPTA_PATH_MATCH_ODDS");
  if (!tpl) return null;
  try {
    const path = expandPath(tpl, { matchId });
    const json = await optaGet(path);
    const o = json.data ?? json;
    if (!o || typeof o !== "object") return { bookmaker: "opta", note: "Odds payload empty" };
    return {
      bookmaker: "opta",
      market: "snapshot",
      line: JSON.stringify(o).slice(0, 200),
      rawValueCount: 1,
    };
  } catch {
    return null;
  }
}

export async function runOpta(args) {
  const last = args.last;
  const warnings = [];

  if (!optaBase()) {
    return {
      ok: false,
      llmPack: null,
      meta: {
        source: "opta-configurable",
        last,
        warnings: [],
        error: "Set OPTA_API_BASE (and OPTA_API_KEY) to your Opta/Stats Perform REST gateway.",
      },
      raw: null,
    };
  }

  let fixtureRow = null;
  let detailForInjuries = null;
  let homePick;
  let awayPick;

  if (args.fixture) {
    fixtureRow = await fetchMatchById(args.fixture);
    if (!fixtureRow?.teams?.home?.id) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "opta-configurable",
          last,
          warnings: [
            `Fixture ${args.fixture} not mapped. Tune OPTA_PATH_MATCH_BY_ID / OPTA_JSON_MATCHES_KEY or response shape.`,
          ],
        },
        raw: null,
      };
    }
    homePick = { team: fixtureRow.teams.home, warning: null };
    awayPick = { team: fixtureRow.teams.away, warning: null };
    detailForInjuries = fixtureRow;
  } else {
    if (!args.date || !args.home || !args.away) {
      return {
        ok: false,
        llmPack: null,
        meta: { source: "opta-configurable", last, warnings: [], error: "Missing date/home/away" },
        raw: null,
      };
    }

    const fromEnv = resolveTeamsFromEnv();
    if (fromEnv) {
      homePick = { team: fromEnv.home, warning: null };
      awayPick = { team: fromEnv.away, warning: null };
      warnings.push(
        "Using OPTA_HOME_TEAM_ID / OPTA_AWAY_TEAM_ID; set OPTA_HOME_TEAM_NAME / OPTA_AWAY_TEAM_NAME for display if needed.",
      );
    } else {
      const homeSearch = await searchTeamsOptional(args.home);
      const awaySearch = await searchTeamsOptional(args.away);
      homePick = pickTeam(homeSearch, args.home);
      awayPick = pickTeam(awaySearch, args.away);
      if (homePick.warning) warnings.push(homePick.warning);
      if (awayPick.warning) warnings.push(awayPick.warning);

      if (!homePick.team || !awayPick.team) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "opta-configurable",
            last,
            warnings,
            error:
              "Could not resolve teams. Set OPTA_HOME_TEAM_ID and OPTA_AWAY_TEAM_ID, or configure OPTA_PATH_TEAM_SEARCH for your contract.",
          },
          raw: null,
        };
      }
    }

    const hid = homePick.team.id;
    const aid = awayPick.team.id;

    let rawRows = [];
    try {
      rawRows = await fixturesForDate(args.date);
    } catch (e) {
      warnings.push(
        `Fixtures-by-date failed: ${e.message}. Check OPTA_PATH_FIXTURES_BY_DATE and OPTA_PARAM_DATE.`,
      );
    }

    const { fixture: found, warnings: w2 } = findFixtureOnDate(
      rawRows,
      args.date,
      hid,
      aid,
      args.home,
      args.away,
    );
    warnings.push(...w2);
    fixtureRow = found;
    if (fixtureRow) detailForInjuries = fixtureRow;
    if (!fixtureRow) {
      warnings.push(
        "No fixture on that date in the date feed; aggregates still use team fixture lists — verify date and paths.",
      );
    }
  }

  const hid = homePick.team.id;
  const aid = awayPick.team.id;

  let homeRaw = [];
  let awayRaw = [];
  try {
    homeRaw = await teamFixtures(hid, last);
  } catch (e) {
    warnings.push(`Home team fixtures failed: ${e.message}`);
  }
  try {
    awayRaw = await teamFixtures(aid, last);
  } catch (e) {
    warnings.push(`Away team fixtures failed: ${e.message}`);
  }

  const homeRecent = homeRaw.filter((r) => FINISHED.has(r.fixture?.status?.short));
  const awayRecent = awayRaw.filter((r) => FINISHED.has(r.fixture?.status?.short));

  let h2h = [];
  try {
    h2h = await headToHeadRows(hid, aid, 10);
  } catch (e) {
    warnings.push(`H2H failed: ${e.message}`);
  }

  let injuries = [];
  const fixtureId = fixtureRow?.fixture?.id;
  if (fixtureId) {
    injuries = await fetchMatchDetailInjuries(fixtureId);
    if (!injuries.length && detailForInjuries) {
      injuries = injuriesFromOptaDetail(detailForInjuries);
    }
  }

  const anchorDate =
    fixtureRow?.fixture?.date ??
    (args.date ? `${args.date}T12:00:00+00:00` : new Date().toISOString());

  const [homeTech, awayTech, oddsSummary] = await Promise.all([
    last5TechOpta(hid, homeRecent),
    last5TechOpta(aid, awayRecent),
    fixtureId ? fetchOddsSummary(fixtureId) : Promise.resolve(null),
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
    dataSource: "opta",
    extras: {
      providerExtras: {
        optaNote:
          "Opta/Stats Perform REST layouts vary by contract. Tune OPTA_PATH_* and OPTA_JSON_MATCHES_KEY; optional OPTA_PATH_MATCH_STATS for last-5 xG.",
      },
    },
  });

  const out = {
    ok: true,
    query: args.fixture
      ? { fixture: args.fixture, provider: "opta" }
      : { date: args.date, home: args.home, away: args.away, provider: "opta" },
    llmPack,
    meta: {
      source: "opta-configurable",
      last,
      apiCallsNote:
        "Paths are contract-specific; see SKILL.md Opta section. Team history uses OPTA_PATH_TEAM_FIXTURES; H2H uses OPTA_PATH_H2H or client-side filter fallback.",
      warnings,
    },
  };

  if (args.verbose) {
    out.raw = {
      teams: { home: homePick.team, away: awayPick.team },
      fixture: fixtureRow,
      recent: { home: homeRaw, away: awayRaw },
      headToHead: h2h,
      injuries,
    };
  }

  return out;
}
