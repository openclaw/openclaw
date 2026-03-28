/**
 * 纳米「足球实时数据」事件 → 与 Opta 风格统一的事件对象（供 commentaryPack 管线）。
 * 字段名因合同/版本而异：此处做宽松映射；不详处保留在 raw 供调试。
 *
 * 产品文档页: https://www.nami.com/zh/details/j3ry6iztqltnwe0
 */

function pickMinute(e) {
  const cands = [
    e.minute,
    e.time_min,
    e.match_minute,
    e.period_time?.minute,
    e.match_time?.minute,
    e.clock?.minute,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickSecond(e) {
  const cands = [e.second, e.time_sec, e.match_second, e.match_time?.second, e.clock?.second];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * @param {Record<string, unknown>} e
 * @returns {Record<string, unknown>}
 */
export function normalizeNamiLiveEvent(e) {
  if (!e || typeof e !== "object") return e;

  const minute = pickMinute(e);
  const second = pickSecond(e);

  const typeStr =
    (typeof e.event_name === "string" && e.event_name) ||
    (typeof e.type_name === "string" && e.type_name) ||
    (typeof e.event_type_name === "string" && e.event_type_name) ||
    (typeof e.name === "string" && e.name) ||
    (e.type && typeof e.type === "object" && String(e.type.name ?? e.type.type ?? "")) ||
    (typeof e.type === "string" && e.type) ||
    (e.type_id != null ? `type_${e.type_id}` : "") ||
    (e.event_type != null ? `event_${e.event_type}` : "") ||
    "unknown";

  const t =
    e.type && typeof e.type === "object" && !Array.isArray(e.type)
      ? { ...e.type, name: String(e.type.name ?? typeStr) }
      : { name: String(typeStr) };

  let isHome = undefined;
  if (e.isHome === true || e.is_home === 1 || e.home_away === 1 || e.side === "home") isHome = true;
  if (e.isHome === false || e.is_home === 0 || e.home_away === 2 || e.side === "away")
    isHome = false;

  const teamId = e.team_id ?? e.teamId ?? e.contestant_id ?? e.team?.id ?? null;

  return {
    minute,
    second,
    type: t,
    isHome,
    teamId,
    team: e.team_name ?? e.team?.name,
    outcome: e.outcome ?? e.result,
    qualifiers: e.qualifiers ?? e.extra,
    raw: e,
  };
}

/**
 * @param {unknown[]} records
 */
export function normalizeNamiLiveBatch(records) {
  if (!Array.isArray(records)) return [];
  return records.map((x) => normalizeNamiLiveEvent(x));
}
