#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/lib-db-target.sh"

MODE="summary"
NAMESPACE="${DB_EVIDENCE_NAMESPACE:-morpho-prd}"
TARGET="${DB_EVIDENCE_TARGET:-}"
SERVICE="${DB_EVIDENCE_SERVICE:-}"
SQL="${DB_EVIDENCE_SQL:-}"
SECRET_NAME="${DB_EVIDENCE_SECRET:-}"
LIMIT="${DB_EVIDENCE_LIMIT:-20}"
PRINT_PLAN=0
DB_EVIDENCE_LAST_ERROR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="${2:?namespace required}"
      shift 2
      ;;
    --target)
      TARGET="${2:?target required}"
      shift 2
      ;;
    --service)
      SERVICE="${2:?service required}"
      shift 2
      ;;
    --secret)
      SECRET_NAME="${2:?secret required}"
      shift 2
      ;;
    --mode)
      MODE="${2:?mode required}"
      shift 2
      ;;
    --sql)
      SQL="${2:?sql required}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:?limit required}"
      shift 2
      ;;
    --print-plan)
      PRINT_PLAN=1
      shift
      ;;
    *)
      printf 'unknown arg: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] || {
  printf 'limit must be a positive integer\n' >&2
  exit 2
}

TARGET_ALIAS="${TARGET:-$(db_target_infer_from_service "$SERVICE")}"
if [[ -z "$TARGET_ALIAS" || "$TARGET_ALIAS" == "unknown" ]]; then
  TARGET_ALIAS="unknown"
fi

resolve_connection_env() {
  local resolved=""
  if [[ -n "$SECRET_NAME" ]]; then
    resolved="$(db_target_decode_secret "$NAMESPACE" "$SECRET_NAME" 2>&1)" || {
      DB_EVIDENCE_LAST_ERROR="$resolved"
      return 1
    }
  else
    resolved="$(db_target_resolve_env "$NAMESPACE" "$TARGET_ALIAS" 2>&1)" || {
      DB_EVIDENCE_LAST_ERROR="$resolved"
      return 1
    }
  fi
  [[ -n "$resolved" ]] || return 1
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    export "$key=$value"
  done <<<"$resolved"
}

run_sql() {
  local sql="${1:?sql required}"
  if [[ "${DB_EVIDENCE_ALLOW_MOCK:-0}" == "1" && -n "${DB_EVIDENCE_MOCK_OUTPUT:-}" ]]; then
    printf '%s\n' "${DB_EVIDENCE_MOCK_OUTPUT}"
    return 0
  fi

  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="${PGPASSWORD:-}" psql \
      -X -qAt \
      -h "${PGHOST:?}" \
      -p "${PGPORT:-5432}" \
      -U "${PGUSER:?}" \
      -d "${PGDATABASE:?}" \
      -c "$sql"
    return 0
  fi

  node - "$sql" <<'NODE'
const { Client } = require("/tmp/pgclient/node_modules/pg");

async function main() {
  const sql = process.argv[2];
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: false,
  });
  await client.connect();
  const result = await client.query(sql);
  for (const row of result.rows) {
    console.log(Object.values(row).join("\t"));
  }
  await client.end();
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

quote_ident() {
  local ident="${1:?identifier required}"
  printf '"%s"' "${ident//\"/\"\"}"
}

count_nonempty_lines() {
  local raw="${1:-}"
  if [[ -z "$raw" ]]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$raw" | awk 'NF > 0 { c++ } END { print c + 0 }'
}

emit_mode_json() {
  local mode="${1:?mode required}"
  local schema_state="${2:-failed}"
  local query_state="${3:-failed}"
  local note="${4:-none}"
  local rows="${5:-0}"
  local output="${6-}"
  local db_ref
  db_ref="${PGHOST:-unknown}:${PGPORT:-5432}/${PGDATABASE:-unknown}"

  jq -nc \
    --arg status "ok" \
    --arg mode "$mode" \
    --arg target "$TARGET_ALIAS" \
    --arg namespace "$NAMESPACE" \
    --arg db "$db_ref" \
    --arg schema_check "$schema_state" \
    --arg query_check "$query_state" \
    --arg note "$note" \
    --arg output "$output" \
    --argjson rows "$rows" \
    '{
      status: $status,
      mode: $mode,
      target: $target,
      namespace: $namespace,
      db: $db,
      schema_check: $schema_check,
      query_check: $query_check,
      note: $note,
      rows: $rows,
      evidence_line: ("db=" + $db + " schema_check=" + $schema_check + " query_check=" + $query_check + " rows=" + ($rows|tostring)),
      output: (if $output == "" then [] else ($output | split("\n") | map(select(length > 0))) end)
    }'
}

run_mode_query() {
  local mode="${1:?mode required}"
  local sql="${2:?sql required}"
  local output rows query_state note
  output="$(run_sql "$sql" 2>/dev/null || true)"
  rows="$(count_nonempty_lines "$output")"
  query_state="$( [[ -n "$output" ]] && printf ok || printf failed )"
  note="$( [[ -n "$output" ]] && printf none || printf empty_output )"
  emit_mode_json "$mode" "ok" "$query_state" "$note" "$rows" "$output"
}

pick_data_probe_table() {
  local alias_regex
  case "$TARGET_ALIAS" in
    indexer)
      alias_regex='(block|vault|market)'
      ;;
    realtime)
      alias_regex='(realtime|vault|market|state)'
      ;;
    historical)
      alias_regex='(historical|snapshot|vault|market|state)'
      ;;
    blue_api | processor)
      alias_regex='(vault|market|position|state)'
      ;;
    *)
      alias_regex='(vault|market|block|state|position)'
      ;;
  esac

  run_sql "
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_name ~* '${alias_regex}'
    ORDER BY table_schema, table_name
    LIMIT 1;
  " | head -n1
}

build_summary_json() {
  local schema_rows data_rows replica_rows activity_rows statement_rows conflict_rows settings_rows
  local schema_check data_check pg_internal_check rows_count replica lag_s activity_count statement_count conflict_snapshot
  local selected_table db_ref

  db_ref="${PGHOST:-unknown}:${PGPORT:-5432}/${PGDATABASE:-unknown}"
  schema_rows="$(run_sql "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT ${LIMIT};" 2>/dev/null || true)"
  schema_check="failed"
  [[ -n "$schema_rows" ]] && schema_check="ok"

  selected_table="$(pick_data_probe_table 2>/dev/null || true)"
  data_rows=""
  data_check="failed"
  rows_count=0
  if [[ -n "$SQL" ]]; then
    data_rows="$(run_sql "$SQL" 2>/dev/null || true)"
    [[ -n "$data_rows" ]] && data_check="ok"
    rows_count="$(printf '%s\n' "$data_rows" | awk 'NF > 0 { c++ } END { print c + 0 }')"
  elif [[ -n "$selected_table" ]]; then
    local schema_name table_name
    schema_name="$(printf '%s\n' "$selected_table" | awk -F'\t' '{print $1}')"
    table_name="$(printf '%s\n' "$selected_table" | awk -F'\t' '{print $2}')"
    data_rows="$(run_sql "SELECT 1 FROM $(quote_ident "$schema_name").$(quote_ident "$table_name") LIMIT ${LIMIT};" 2>/dev/null || true)"
    [[ -n "$data_rows" ]] && data_check="ok"
    rows_count="$(printf '%s\n' "$data_rows" | awk 'NF > 0 { c++ } END { print c + 0 }')"
  fi

  replica_rows="$(run_sql "SELECT pg_is_in_recovery(), EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint;" 2>/dev/null || true)"
  activity_rows="$(run_sql "SELECT count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle in transaction') FROM pg_stat_activity;" 2>/dev/null || true)"
  statement_rows="$(run_sql "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements';" 2>/dev/null || true)"
  conflict_rows="$(run_sql "SELECT COALESCE(sum(confl_snapshot),0) FROM pg_stat_database_conflicts;" 2>/dev/null || true)"
  settings_rows="$(run_sql "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','hot_standby_feedback','max_standby_streaming_delay') ORDER BY 1;" 2>/dev/null || true)"

  pg_internal_check="failed"
  if [[ -n "$replica_rows" || -n "$activity_rows" || -n "$conflict_rows" || -n "$settings_rows" ]]; then
    pg_internal_check="ok"
  fi

  replica="$(printf '%s\n' "$replica_rows" | awk -F'\t' 'NF > 0 {print $1; exit}')"
  lag_s="$(printf '%s\n' "$replica_rows" | awk -F'\t' 'NF > 1 {print $2; exit}')"
  activity_count="$(printf '%s\n' "$activity_rows" | awk -F'\t' 'NF > 0 {print $1; exit}')"
  statement_count="$(printf '%s\n' "$statement_rows" | awk 'NF > 0 {print $1; exit}')"
  conflict_snapshot="$(printf '%s\n' "$conflict_rows" | awk 'NF > 0 {print $1; exit}')"

  jq -nc \
    --arg status "ok" \
    --arg target "$TARGET_ALIAS" \
    --arg namespace "$NAMESPACE" \
    --arg db "$db_ref" \
    --arg schema_check "$schema_check" \
    --arg query_check "$data_check" \
    --arg pg_internal_check "$pg_internal_check" \
    --arg selected_table "$selected_table" \
    --arg replica "${replica:-unknown}" \
    --arg replay_lag_s "${lag_s:-unknown}" \
    --arg active_queries "${activity_count:-0}" \
    --arg statement_count "${statement_count:-0}" \
    --arg conflict_snapshot "${conflict_snapshot:-0}" \
    --argjson rows "${rows_count:-0}" \
    '{
      status: $status,
      target: $target,
      namespace: $namespace,
      db: $db,
      schema_check: $schema_check,
      query_check: $query_check,
      pg_internal_check: $pg_internal_check,
      rows: $rows,
      selected_table: (if $selected_table == "" then null else $selected_table end),
      replica: $replica,
      replay_lag_s: $replay_lag_s,
      active_queries: $active_queries,
      statement_count: $statement_count,
      conflict_snapshot: $conflict_snapshot,
      evidence_line: ("db=" + $db + " schema_check=" + $schema_check + " query_check=" + $query_check + " rows=" + ($rows|tostring))
    }'
}

if [[ "$PRINT_PLAN" -eq 1 ]]; then
  jq -nc \
    --arg mode "$MODE" \
    --arg namespace "$NAMESPACE" \
    --arg target "$TARGET_ALIAS" \
    --arg service "$SERVICE" \
    --arg has_sql "$( [[ -n "$SQL" ]] && printf yes || printf no )" \
    '{mode:$mode, namespace:$namespace, target:$target, service:$service, has_sql:$has_sql}'
  exit 0
fi

if ! resolve_connection_env; then
  jq -nc \
    --arg status "blocked" \
    --arg target "$TARGET_ALIAS" \
    --arg namespace "$NAMESPACE" \
    --arg error "${DB_EVIDENCE_LAST_ERROR:-unable to resolve db target credentials}" \
    '{status:$status,target:$target,namespace:$namespace,error:$error}'
  exit 1
fi

case "$MODE" in
  summary)
    build_summary_json
    ;;
  schema)
    run_mode_query "schema" "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT ${LIMIT};"
    ;;
  data)
    output=""
    if [[ -n "$SQL" ]]; then
      output="$(run_sql "$SQL" 2>/dev/null || true)"
    else
      selected_table="$(pick_data_probe_table 2>/dev/null || true)"
      if [[ -z "$selected_table" ]]; then
        emit_mode_json "data" "ok" "failed" "no_probe_table" 0 ""
        exit 0
      fi
      schema_name="$(printf '%s\n' "$selected_table" | awk -F'\t' '{print $1}')"
      table_name="$(printf '%s\n' "$selected_table" | awk -F'\t' '{print $2}')"
      output="$(run_sql "SELECT 1 FROM $(quote_ident "$schema_name").$(quote_ident "$table_name") LIMIT ${LIMIT};" 2>/dev/null || true)"
    fi
    rows="$(count_nonempty_lines "$output")"
    emit_mode_json "data" "ok" "$( [[ -n "$output" ]] && printf ok || printf failed )" "$( [[ -n "$output" ]] && printf none || printf empty_output )" "$rows" "$output"
    ;;
  replica)
    run_mode_query "replica" "SELECT pg_is_in_recovery(), EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint;"
    ;;
  activity)
    run_mode_query "activity" "SELECT pid, application_name, state, now() - query_start AS age, wait_event_type, wait_event FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start ASC LIMIT ${LIMIT};"
    ;;
  statements)
    run_mode_query "statements" "SELECT calls, round(total_exec_time::numeric,1), round(mean_exec_time::numeric,1), rows FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT ${LIMIT};"
    ;;
  conflicts)
    run_mode_query "conflicts" "SELECT datname, confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock FROM pg_stat_database_conflicts ORDER BY confl_snapshot DESC LIMIT ${LIMIT};"
    ;;
  settings)
    run_mode_query "settings" "SELECT name, setting FROM pg_settings WHERE name IN ('max_connections','hot_standby_feedback','max_standby_streaming_delay','statement_timeout') ORDER BY 1;"
    ;;
  locks)
    run_mode_query "locks" "SELECT pid, locktype, mode, granted FROM pg_locks ORDER BY granted, pid LIMIT ${LIMIT};"
    ;;
  *)
    printf 'unsupported mode: %s\n' "$MODE" >&2
    exit 2
    ;;
esac
