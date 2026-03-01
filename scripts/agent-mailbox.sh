#!/usr/bin/env bash
# agent-mailbox.sh -- File-based mailbox fallback for local/offline agent messaging.
# Messages are stored as JSONL in ~/.openclaw/mailbox/{inbox,outbox}/.
set -euo pipefail

MAILBOX_ROOT="${OPENCLAW_MAILBOX_ROOT:-$HOME/.openclaw/mailbox}"
INBOX_DIR="$MAILBOX_ROOT/inbox"
OUTBOX_DIR="$MAILBOX_ROOT/outbox"
TASKS_DIR="$MAILBOX_ROOT/tasks"

usage() {
  cat <<EOF
Usage: agent-mailbox.sh <command> [args]

Commands:
  init                              Create mailbox directories
  send <target> <message> [--correlation-id ID]
                                    Write a message to outbox/<target>.jsonl
  recv <agent-id>                   Read and drain inbox/<agent-id>.jsonl
  list [agent-id]                   List pending messages
  task add <description>            Add a task
  task list                         Show pending tasks
  task done <id>                    Mark a task completed
EOF
}

cmd_init() {
  mkdir -p "$INBOX_DIR" "$OUTBOX_DIR" "$TASKS_DIR"
  echo "Mailbox initialized at $MAILBOX_ROOT"
}

gen_id() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%s' "$(date +%s)-$$-$RANDOM"
  fi
}

cmd_send() {
  local target="${1:-}"
  local message="${2:-}"
  local correlation_id=""
  shift 2 || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --correlation-id)
        correlation_id="${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -z "$target" || -z "$message" ]]; then
    echo "Error: send requires <target> and <message>" >&2
    exit 1
  fi

  mkdir -p "$OUTBOX_DIR"
  local id
  id=$(gen_id)
  local ts
  ts=$(date +%s)
  local from="${OPENCLAW_AGENT_ID:-local}"

  local json
  json=$(printf '{"id":"%s","from":"%s","to":"%s","message":"%s","correlationId":"%s","ts":%s}\n' \
    "$id" "$from" "$target" "$message" "$correlation_id" "$ts")

  echo "$json" >> "$OUTBOX_DIR/$target.jsonl"
  echo "Sent message $id to $target"
}

cmd_recv() {
  local agent_id="${1:-}"
  if [[ -z "$agent_id" ]]; then
    echo "Error: recv requires <agent-id>" >&2
    exit 1
  fi

  local inbox_file="$INBOX_DIR/$agent_id.jsonl"
  if [[ ! -f "$inbox_file" ]]; then
    echo "No messages for $agent_id"
    return
  fi

  cat "$inbox_file"
  rm "$inbox_file"
}

cmd_list() {
  local agent_id="${1:-}"

  if [[ -n "$agent_id" ]]; then
    local inbox_file="$INBOX_DIR/$agent_id.jsonl"
    if [[ -f "$inbox_file" ]]; then
      echo "=== Inbox: $agent_id ==="
      wc -l < "$inbox_file" | xargs printf "%s message(s)\n"
    else
      echo "No messages for $agent_id"
    fi
    return
  fi

  echo "=== Inbox ==="
  if [[ -d "$INBOX_DIR" ]]; then
    for f in "$INBOX_DIR"/*.jsonl; do
      [[ -f "$f" ]] || continue
      local name
      name=$(basename "$f" .jsonl)
      local count
      count=$(wc -l < "$f" | xargs)
      echo "  $name: $count message(s)"
    done
  fi

  echo "=== Outbox ==="
  if [[ -d "$OUTBOX_DIR" ]]; then
    for f in "$OUTBOX_DIR"/*.jsonl; do
      [[ -f "$f" ]] || continue
      local name
      name=$(basename "$f" .jsonl)
      local count
      count=$(wc -l < "$f" | xargs)
      echo "  $name: $count message(s)"
    done
  fi
}

cmd_task() {
  local subcmd="${1:-}"
  shift || true

  case "$subcmd" in
    add)
      local desc="${1:-}"
      if [[ -z "$desc" ]]; then
        echo "Error: task add requires <description>" >&2
        exit 1
      fi
      mkdir -p "$TASKS_DIR"
      local id
      id=$(gen_id)
      local ts
      ts=$(date +%s)
      local json
      json=$(printf '{"id":"%s","description":"%s","status":"pending","ts":%s}\n' \
        "$id" "$desc" "$ts")
      echo "$json" >> "$TASKS_DIR/tasks.jsonl"
      echo "Task $id added"
      ;;
    list)
      local tasks_file="$TASKS_DIR/tasks.jsonl"
      if [[ ! -f "$tasks_file" ]]; then
        echo "No tasks"
        return
      fi
      cat "$tasks_file"
      ;;
    done)
      local task_id="${1:-}"
      if [[ -z "$task_id" ]]; then
        echo "Error: task done requires <id>" >&2
        exit 1
      fi
      local tasks_file="$TASKS_DIR/tasks.jsonl"
      if [[ ! -f "$tasks_file" ]]; then
        echo "No tasks file found" >&2
        exit 1
      fi
      local tmp
      tmp=$(mktemp)
      local found=0
      while IFS= read -r line; do
        if echo "$line" | grep -q "\"id\":\"$task_id\""; then
          echo "$line" | sed 's/"status":"pending"/"status":"completed"/' >> "$tmp"
          found=1
        else
          echo "$line" >> "$tmp"
        fi
      done < "$tasks_file"
      mv "$tmp" "$tasks_file"
      if [[ $found -eq 1 ]]; then
        echo "Task $task_id marked completed"
      else
        echo "Task $task_id not found" >&2
        exit 1
      fi
      ;;
    *)
      echo "Unknown task subcommand: $subcmd" >&2
      usage
      exit 1
      ;;
  esac
}

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    init)   cmd_init ;;
    send)   cmd_send "$@" ;;
    recv)   cmd_recv "$@" ;;
    list)   cmd_list "$@" ;;
    task)   cmd_task "$@" ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
