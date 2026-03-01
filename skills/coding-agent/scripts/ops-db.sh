#!/usr/bin/env bash
# ops-db.sh — Query/mutate the OpenClaw operational database
# Provides structured history of health, config changes, incidents, and tasks.
# All output is JSON.
#
# Usage:
#   ops-db.sh health snapshot                        # Record current provider health
#   ops-db.sh health latest                          # Latest status per provider
#   ops-db.sh health history [provider] [--limit N]  # Recent snapshots
#
#   ops-db.sh incident open <title> [--provider X] [--severity X] [--desc "..."]
#   ops-db.sh incident close <id> [--resolution "..."]
#   ops-db.sh incident list [--open|--all]
#
#   ops-db.sh task create <agent> <summary> [--urgency X] [--context "..."]
#   ops-db.sh task update <id> <status> [--result '{"..."}']
#   ops-db.sh task list [--status X] [--agent X]
#   ops-db.sh task get <id>
#
#   ops-db.sh notify <type> <provider> <message> [--reason X]
#   ops-db.sh notify list [--undelivered|--all] [--limit N]
#   ops-db.sh notify deliver <id>
#
#   ops-db.sh config log <json_line>                 # Log a config change
#   ops-db.sh config recent [--limit N]
#
#   ops-db.sh kv get <key>
#   ops-db.sh kv set <key> <value>
#
#   ops-db.sh query "<SQL>"                          # Raw query (SELECT only)
#   ops-db.sh stats                                  # Table row counts
#   ops-db.sh init                                   # Initialize/upgrade schema

set -eo pipefail

# Resolve state directory
if [ -n "$OPENCLAW_STATE_DIR" ]; then
  BASE="$OPENCLAW_STATE_DIR"
elif [ -d "$HOME/.openclaw" ]; then
  BASE="$HOME/.openclaw"
else
  echo '{"error":"Cannot find OpenClaw state directory"}' >&2
  exit 1
fi

DB="${BASE}/ops.db"
INIT_SQL="${BASE}/scripts/ops-db-init.sql"

# Auto-init if DB doesn't exist
if [ ! -f "$DB" ] && [ -f "$INIT_SQL" ]; then
  sqlite3 "$DB" < "$INIT_SQL"
fi

if [ ! -f "$DB" ]; then
  echo '{"error":"ops.db not found","path":"'"$DB"'"}' >&2
  exit 1
fi

sq() { sqlite3 -json "$DB" "$1"; }
sq_exec() { sqlite3 "$DB" "$1"; }
sq_insert_return() { sqlite3 -json "$DB" "$2; SELECT * FROM $1 WHERE rowid = last_insert_rowid();"; }

escape() { echo "$1" | sed "s/'/''/g"; }

CMD="${1:?Usage: ops-db.sh <health|incident|task|notify|config|kv|query|stats|init>}"
SUB="${2:-}"

case "$CMD" in

  health)
    case "$SUB" in
      snapshot)
        MH="${BASE}/model-health.json"
        [ ! -f "$MH" ] && echo '{"error":"model-health.json not found"}' && exit 1
        NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ); COUNT=0
        for P in $(jq -r '.providers | keys[]' "$MH"); do
          ST=$(jq -r ".providers[\"$P\"].status" "$MH")
          RE=$(jq -r ".providers[\"$P\"].reason // \"none\"" "$MH")
          FC=$(jq -r ".providers[\"$P\"].failureCount // 0" "$MH")
          EC=$(jq -r "[.providers[\"$P\"].profiles[]] | first | .errorCount // 0" "$MH")
          LU=$(jq -r "[.providers[\"$P\"].profiles[]] | first | .lastUsed // \"\"" "$MH")
          sq_exec "INSERT INTO health_snapshots (ts,provider,status,reason,failure_count,error_count,last_used) VALUES ('$NOW','$P','$ST','$RE',$FC,$EC,'$LU');"
          COUNT=$((COUNT + 1))
        done
        echo "{\"status\":\"ok\",\"inserted\":$COUNT,\"timestamp\":\"$NOW\"}"
        ;;
      latest) sq "SELECT * FROM v_latest_health;" ;;
      history)
        PROVIDER="" LIMIT=20; shift 2 2>/dev/null || true
        while [ $# -gt 0 ]; do
          case "$1" in --limit) LIMIT="$2"; shift 2 ;; *) PROVIDER="$1"; shift ;; esac
        done
        [ -n "$PROVIDER" ] && sq "SELECT * FROM health_snapshots WHERE provider='$PROVIDER' ORDER BY ts DESC LIMIT $LIMIT;" \
                           || sq "SELECT * FROM health_snapshots ORDER BY ts DESC LIMIT $LIMIT;"
        ;;
      *) echo '{"error":"Usage: ops-db.sh health <snapshot|latest|history>"}'; exit 1 ;;
    esac ;;

  incident)
    case "$SUB" in
      open)
        TITLE="${3:?Usage: ops-db.sh incident open <title>}"
        PROVIDER="" SEVERITY="medium" DESC=""; shift 3
        while [ $# -gt 0 ]; do
          case "$1" in --provider) PROVIDER="$2"; shift 2 ;; --severity) SEVERITY="$2"; shift 2 ;; --desc) DESC="$2"; shift 2 ;; *) shift ;; esac
        done
        sq_insert_return incidents "INSERT INTO incidents (provider,severity,title,description) VALUES ('$PROVIDER','$SEVERITY','$(escape "$TITLE")','$(escape "$DESC")')"
        ;;
      close)
        ID="${3:?Usage: ops-db.sh incident close <id>}"; RES=""
        [ "${4:-}" = "--resolution" ] && RES="$5"
        sq "UPDATE incidents SET closed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), resolution='$(escape "$RES")' WHERE id=$ID; SELECT * FROM incidents WHERE id=$ID;"
        ;;
      list)
        FLAG="${3:---open}"
        [ "$FLAG" = "--all" ] && sq "SELECT * FROM incidents ORDER BY opened_at DESC LIMIT 50;" \
                              || sq "SELECT * FROM v_open_incidents;"
        ;;
      *) echo '{"error":"Usage: ops-db.sh incident <open|close|list>"}'; exit 1 ;;
    esac ;;

  task)
    case "$SUB" in
      create)
        AGENT="${3:?Usage: ops-db.sh task create <agent> <summary>}"
        TASK="${4:?Usage: ops-db.sh task create <agent> <summary>}"
        URGENCY="routine" CONTEXT="" FILES="" ERRORS="" OUTCOME=""; shift 4
        while [ $# -gt 0 ]; do
          case "$1" in --urgency) URGENCY="$2"; shift 2 ;; --context) CONTEXT="$2"; shift 2 ;; --files) FILES="$2"; shift 2 ;; --errors) ERRORS="$2"; shift 2 ;; --outcome) OUTCOME="$2"; shift 2 ;; *) shift ;; esac
        done
        sq_insert_return tasks "INSERT INTO tasks (agent,urgency,task,context,files,errors,outcome) VALUES ('$AGENT','$URGENCY','$(escape "$TASK")','$(escape "$CONTEXT")','$(escape "$FILES")','$(escape "$ERRORS")','$(escape "$OUTCOME")')"
        ;;
      update)
        ID="${3:?Usage: ops-db.sh task update <id> <status>}"; STATUS="${4:?}"
        RESULT=""; [ "${5:-}" = "--result" ] && RESULT="$6"
        sq "UPDATE tasks SET status='$STATUS', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), result='$(escape "$RESULT")' WHERE id=$ID; SELECT * FROM tasks WHERE id=$ID;"
        ;;
      list)
        FILTER_STATUS="" FILTER_AGENT=""; shift 2 2>/dev/null || true
        while [ $# -gt 0 ]; do
          case "$1" in --status) FILTER_STATUS="$2"; shift 2 ;; --agent) FILTER_AGENT="$2"; shift 2 ;; *) shift ;; esac
        done
        WHERE=""
        [ -n "$FILTER_STATUS" ] && WHERE="WHERE status='$FILTER_STATUS'"
        if [ -n "$FILTER_AGENT" ]; then
          [ -n "$WHERE" ] && WHERE="$WHERE AND agent='$FILTER_AGENT'" || WHERE="WHERE agent='$FILTER_AGENT'"
        fi
        [ -z "$WHERE" ] && sq "SELECT * FROM v_pending_tasks;" || sq "SELECT * FROM tasks $WHERE ORDER BY created_at DESC LIMIT 50;"
        ;;
      get) sq "SELECT * FROM tasks WHERE id=${3:?Usage: ops-db.sh task get <id>};" ;;
      *) echo '{"error":"Usage: ops-db.sh task <create|update|list|get>"}'; exit 1 ;;
    esac ;;

  notify)
    if [ "$SUB" = "list" ]; then
      FLAG="--undelivered" LIMIT=20; shift 2 2>/dev/null || true
      while [ $# -gt 0 ]; do
        case "$1" in --undelivered) FLAG="--undelivered"; shift ;; --all) FLAG="--all"; shift ;; --limit) LIMIT="$2"; shift 2 ;; *) shift ;; esac
      done
      [ "$FLAG" = "--all" ] && sq "SELECT * FROM notifications ORDER BY ts DESC LIMIT $LIMIT;" \
                            || sq "SELECT * FROM v_undelivered_notifications LIMIT $LIMIT;"
    elif [ "$SUB" = "deliver" ]; then
      ID="${3:?Usage: ops-db.sh notify deliver <id>}"
      sq_exec "UPDATE notifications SET delivered=1 WHERE id=$ID;"
      echo "{\"status\":\"ok\",\"id\":$ID}"
    else
      TYPE="${SUB:?Usage: ops-db.sh notify <type> <provider> <message>}"
      PROVIDER="${3:?}" MESSAGE="${4:?}" REASON=""
      [ "${5:-}" = "--reason" ] && REASON="$6"
      sq_insert_return notifications "INSERT INTO notifications (type,provider,reason,message) VALUES ('$TYPE','$PROVIDER','$REASON','$(escape "$MESSAGE")')"
    fi ;;

  config)
    case "$SUB" in
      log)
        LINE="${3:?Usage: ops-db.sh config log '<json>'}"
        TS=$(echo "$LINE" | jq -r '.ts')
        SRC=$(echo "$LINE" | jq -r '.source // ""')
        EVT=$(echo "$LINE" | jq -r '.event // ""')
        PH=$(echo "$LINE" | jq -r '.previousHash // ""')
        NH=$(echo "$LINE" | jq -r '.nextHash // ""')
        PB=$(echo "$LINE" | jq -r '.previousBytes // "null"')
        NB=$(echo "$LINE" | jq -r '.nextBytes // "null"')
        GM=$(echo "$LINE" | jq -r '.gatewayModeAfter // ""')
        SU=$(echo "$LINE" | jq -c '.suspicious // []')
        RE=$(echo "$LINE" | jq -r '.result // ""')
        sq_exec "INSERT INTO config_changes (ts,source,event,previous_hash,next_hash,previous_bytes,next_bytes,gateway_mode,suspicious,result) VALUES ('$TS','$SRC','$EVT','$PH','$NH',$PB,$NB,'$GM','$SU','$RE');"
        echo "{\"status\":\"ok\",\"ts\":\"$TS\"}"
        ;;
      recent) LIMIT=20; [ "${3:-}" = "--limit" ] && LIMIT="$4"; sq "SELECT * FROM config_changes ORDER BY ts DESC LIMIT $LIMIT;" ;;
      *) echo '{"error":"Usage: ops-db.sh config <log|recent>"}'; exit 1 ;;
    esac ;;

  kv)
    case "$SUB" in
      get)
        KEY="${3:?Usage: ops-db.sh kv get <key>}"
        RESULT=$(sq_exec "SELECT value FROM kv WHERE key='$KEY';")
        [ -n "$RESULT" ] && echo "{\"key\":\"$KEY\",\"value\":\"$RESULT\"}" || echo "{\"key\":\"$KEY\",\"value\":null}"
        ;;
      set)
        KEY="${3:?}" VALUE="${4:?}"
        sq_exec "INSERT OR REPLACE INTO kv (key,value,updated_at) VALUES ('$KEY','$(escape "$VALUE")',strftime('%Y-%m-%dT%H:%M:%SZ','now'));"
        echo "{\"status\":\"ok\",\"key\":\"$KEY\"}"
        ;;
      *) echo '{"error":"Usage: ops-db.sh kv <get|set>"}'; exit 1 ;;
    esac ;;

  query)
    SQL="${SUB:?Usage: ops-db.sh query '<SELECT ...>'}"
    echo "$SQL" | grep -iqE '^\s*(insert|update|delete|drop|alter|create)' && echo '{"error":"Only SELECT queries allowed"}' >&2 && exit 1
    sq "$SQL" ;;

  stats)
    echo "{"
    for T in health_snapshots config_changes incidents tasks notifications kv; do
      echo "  \"$T\": $(sq_exec "SELECT COUNT(*) FROM $T;"),"
    done
    echo "  \"db_size_kb\": $(du -k "$DB" 2>/dev/null | awk '{print $1}')"
    echo "}" ;;

  init)
    [ -f "$INIT_SQL" ] && sqlite3 "$DB" < "$INIT_SQL" && echo '{"status":"ok","message":"schema initialized"}' \
                       || (echo '{"error":"init SQL not found"}' && exit 1) ;;

  *) echo '{"error":"Unknown command: '"$CMD"'"}' >&2; exit 1 ;;
esac
