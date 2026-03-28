/**
 * Football-Data.co.uk CSV → API-Football-shaped rows + llmPack.
 * @see https://www.football-data.co.uk/notes.txt
 */

import fs from "node:fs";
import { FINISHED, buildLlmPack, h2hAggregate, parseStatNumber } from "./shared.mjs";

function normTeam(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamMatch(a, b) {
  const x = normTeam(a);
  const y = normTeam(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** Parse dd/mm/yy or dd/mm/yyyy */
function parseFdDate(str) {
  const m = String(str ?? "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let d = Number.parseInt(m[1], 10);
  let mo = Number.parseInt(m[2], 10);
  let y = Number.parseInt(m[3], 10);
  if (y < 100) y += y >= 50 ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function toYmd(dt) {
  if (!dt) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** One CSV line with quoted fields (Football-Data exports comma-separated). */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return lines.map(parseCsvLine).filter((r) => r.some((x) => String(x).trim() !== ""));
}

function rowToObject(headers, cells) {
  const o = {};
  for (let i = 0; i < headers.length; i++) {
    const k = String(headers[i] ?? "").trim();
    if (k) o[k] = cells[i] ?? "";
  }
  return o;
}

function teamId(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `fd-${Math.abs(h)}`;
}

function rowToApiShape(o, idx) {
  const dt = parseFdDate(o.Date);
  const iso = dt ? dt.toISOString() : null;
  const fthg = parseStatNumber(o.FTHG ?? o.HG);
  const ftag = parseStatNumber(o.FTAG ?? o.AG);
  const hid = teamId(o.HomeTeam);
  const aid = teamId(o.AwayTeam);
  return {
    fixture: {
      id: `csv-${idx}`,
      date: iso,
      timezone: "UTC",
      status: { short: fthg != null && ftag != null ? "FT" : "NS" },
      venue: null,
    },
    teams: {
      home: { id: hid, name: String(o.HomeTeam ?? "").trim() || "Home" },
      away: { id: aid, name: String(o.AwayTeam ?? "").trim() || "Away" },
    },
    goals: { home: fthg, away: ftag },
    league: { name: o.Div ? String(o.Div) : null, round: null },
    _fd: { raw: o },
  };
}

function shotsOnTargetForTeam(rowObj, teamIdTarget, hid, aid) {
  const hst = parseStatNumber(rowObj.HST);
  const ast = parseStatNumber(rowObj.AST);
  if (teamIdTarget === hid) return hst;
  if (teamIdTarget === aid) return ast;
  return null;
}

function summarizeOddsFromRow(o) {
  const b365h = parseStatNumber(o.B365H);
  const b365d = parseStatNumber(o.B365D);
  const b365a = parseStatNumber(o.B365A);
  if (b365h != null && b365d != null && b365a != null) {
    return {
      bookmaker: "Bet365 (CSV)",
      market: "1X2",
      line: `H ${b365h} | D ${b365d} | A ${b365a}`,
      rawValueCount: 3,
    };
  }
  const avh = parseStatNumber(o.AvgH);
  const avd = parseStatNumber(o.AvgD);
  const ava = parseStatNumber(o.AvgA);
  if (avh != null && avd != null && ava != null) {
    return {
      bookmaker: "Market avg (CSV)",
      market: "1X2",
      line: `H ${avh} | D ${avd} | A ${ava}`,
      rawValueCount: 3,
    };
  }
  return null;
}

function last5ShotsSeries(rows, teamIdTarget, teamName) {
  const finished = rows.filter((r) => FINISHED.has(r.fixture?.status?.short));
  const take = finished.slice(0, 5);
  const points = [];
  for (const r of take) {
    const hid = r.teams.home.id;
    const aid = r.teams.away.id;
    const raw = r._fd?.raw ?? {};
    const sot = shotsOnTargetForTeam(raw, teamIdTarget, hid, aid);
    points.push({
      fixtureId: r.fixture.id,
      date: r.fixture.date,
      xgFor: null,
      possession: null,
      shotsOnTarget: sot,
    });
  }
  const sots = points.map((p) => p.shotsOnTarget).filter((x) => x != null);
  const avg = (arr) =>
    arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
  return {
    games: points,
    last5AvgXgFor: null,
    last5AvgPossession: null,
    xgCoverage: "0/5",
    last5AvgShotsOnTarget: avg(sots),
    note: "xG/possession not in Football-Data CSV; shots on target (HST/AST) when present.",
  };
}

export async function runFootballDataCsv(args, csvPath) {
  const last = args.last;
  const warnings = [];

  if (!csvPath || !fs.existsSync(csvPath)) {
    return {
      ok: false,
      llmPack: null,
      meta: {
        source: "football-data.co.uk csv",
        last,
        warnings: [],
        error: `CSV not found: ${csvPath ?? "(empty)"}. Set FOOTBALL_DATA_CSV or pass --csv.`,
      },
      raw: null,
    };
  }

  const text = fs.readFileSync(csvPath, "utf8");
  const table = parseCsv(text);
  if (table.length < 2) {
    return {
      ok: false,
      llmPack: null,
      meta: {
        source: "football-data.co.uk csv",
        last,
        warnings: ["Empty CSV"],
        error: "No data rows",
      },
      raw: null,
    };
  }

  const headers = table[0].map((h) => String(h).trim());
  const objects = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (!cells || cells.every((c) => String(c).trim() === "")) continue;
    const o = rowToObject(headers, cells);
    if (!o.HomeTeam || !o.AwayTeam || !o.Date) continue;
    objects.push(rowToApiShape(o, i - 1));
  }

  if (!objects.length) {
    return {
      ok: false,
      llmPack: null,
      meta: {
        source: "football-data.co.uk csv",
        last,
        warnings,
        error: "No valid rows (need Date, HomeTeam, AwayTeam)",
      },
      raw: null,
    };
  }

  objects.sort((a, b) => {
    const ta = new Date(a.fixture?.date ?? 0).getTime();
    const tb = new Date(b.fixture?.date ?? 0).getTime();
    return tb - ta;
  });

  let fixtureRow = null;
  let homePick;
  let awayPick;

  if (args.fixture != null && Number.isFinite(args.fixture)) {
    const idx = Math.floor(args.fixture);
    const row = objects.find((r) => String(r.fixture.id) === `csv-${idx}`) ?? objects[idx];
    if (!row?.teams?.home?.id) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "football-data.co.uk csv",
          last,
          warnings: [],
          error: `No row for fixture index ${args.fixture}. Use --date + --home + --away, or row index matching internal csv-N id.`,
        },
        raw: null,
      };
    }
    fixtureRow = row;
    homePick = { team: row.teams.home, warning: null };
    awayPick = { team: row.teams.away, warning: null };
  } else {
    if (!args.date || !args.home || !args.away) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "football-data.co.uk csv",
          last,
          warnings: [],
          error: "Missing date/home/away (or use --fixture)",
        },
        raw: null,
      };
    }

    const target = objects.find((r) => {
      const ymd = toYmd(parseFdDate(r._fd?.raw?.Date));
      if (ymd !== args.date) return false;
      return teamMatch(r.teams.home.name, args.home) && teamMatch(r.teams.away.name, args.away);
    });

    const swapped = target
      ? null
      : objects.find((r) => {
          const ymd = toYmd(parseFdDate(r._fd?.raw?.Date));
          if (ymd !== args.date) return false;
          return teamMatch(r.teams.home.name, args.away) && teamMatch(r.teams.away.name, args.home);
        });

    fixtureRow = target ?? swapped;
    if (swapped && !target) {
      warnings.push("Matched fixture with home/away names swapped vs --home/--away order.");
    }

    if (!fixtureRow) {
      return {
        ok: false,
        llmPack: null,
        meta: {
          source: "football-data.co.uk csv",
          last,
          warnings,
          error: `No row on ${args.date} for "${args.home}" vs "${args.away}". Check spelling vs CSV team names.`,
        },
        raw: null,
      };
    }

    homePick = { team: fixtureRow.teams.home, warning: null };
    awayPick = { team: fixtureRow.teams.away, warning: null };
  }

  const hid = homePick.team.id;
  const aid = awayPick.team.id;
  const homeName = homePick.team.name;
  const awayName = awayPick.team.name;

  const homeRecent = objects
    .filter(
      (r) =>
        FINISHED.has(r.fixture?.status?.short) &&
        (teamMatch(r.teams.home.name, homeName) || teamMatch(r.teams.away.name, homeName)),
    )
    .slice(0, last);

  const awayRecent = objects
    .filter(
      (r) =>
        FINISHED.has(r.fixture?.status?.short) &&
        (teamMatch(r.teams.home.name, awayName) || teamMatch(r.teams.away.name, awayName)),
    )
    .slice(0, last);

  const h2h = objects
    .filter(
      (r) =>
        FINISHED.has(r.fixture?.status?.short) &&
        ((teamMatch(r.teams.home.name, homeName) && teamMatch(r.teams.away.name, awayName)) ||
          (teamMatch(r.teams.home.name, awayName) && teamMatch(r.teams.away.name, homeName))),
    )
    .slice(0, 20);

  const h2hSum = h2hAggregate(h2h, hid, aid);

  const homeTech = last5ShotsSeries(homeRecent, hid, homeName);
  const awayTech = last5ShotsSeries(awayRecent, aid, awayName);

  const anchorRaw = fixtureRow._fd?.raw ?? {};
  const oddsSummary = summarizeOddsFromRow(anchorRaw);

  const anchorDate =
    fixtureRow?.fixture?.date ??
    (args.date ? `${args.date}T12:00:00.000Z` : new Date().toISOString());

  const llmPack = buildLlmPack({
    homeTeam: homePick.team,
    awayTeam: awayPick.team,
    fixtureRow,
    homeRecent,
    awayRecent,
    h2h,
    injuries: [],
    homeTech,
    awayTech,
    h2hSum,
    oddsSummary,
    anchorDate,
    dataSource: "football-data.co.uk",
    extras: {
      providerExtras: {
        csvPath: csvPath,
        footballDataNote:
          "Historical CSV from Football-Data.co.uk; no live injuries; xG not in standard columns — use HST/AST proxies in technicalLast5 when present.",
      },
    },
  });

  const out = {
    ok: true,
    query: Number.isFinite(args.fixture)
      ? { fixture: args.fixture, provider: "football-data", csv: csvPath }
      : {
          date: args.date,
          home: args.home,
          away: args.away,
          provider: "football-data",
          csv: csvPath,
        },
    llmPack,
    meta: {
      source: "football-data.co.uk csv",
      last,
      rowCount: objects.length,
      warnings,
    },
  };

  if (args.verbose) {
    out.raw = { sampleHeaders: headers, rowCount: objects.length };
  }

  return out;
}
