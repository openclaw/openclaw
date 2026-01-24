#!/bin/bash
# Manus API helper script
# Usage: manus.sh <action> [args]

API_BASE="https://api.manus.ai/v1"

if [ -z "$MANUS_API_KEY" ]; then
  echo "Error: MANUS_API_KEY not set" >&2
  exit 1
fi

action="$1"
shift

case "$action" in
  create)
    # Create a task: manus.sh create "your prompt here" [profile]
    prompt="$1"
    profile="${2:-manus-1.6}"
    curl -s -X POST "$API_BASE/tasks" \
      -H "API_KEY: $MANUS_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"prompt\": $(echo "$prompt" | jq -Rs .), \"agentProfile\": \"$profile\", \"taskMode\": \"agent\", \"createShareableLink\": true}"
    ;;
  
  get)
    # Get task: manus.sh get <task_id>
    task_id="$1"
    curl -s "$API_BASE/tasks/$task_id" \
      -H "API_KEY: $MANUS_API_KEY"
    ;;
  
  status)
    # Get task status only: manus.sh status <task_id>
    task_id="$1"
    curl -s "$API_BASE/tasks/$task_id" \
      -H "API_KEY: $MANUS_API_KEY" | jq -r '.status // "unknown"'
    ;;
  
  wait)
    # Wait for task completion: manus.sh wait <task_id> [timeout_seconds]
    task_id="$1"
    timeout="${2:-600}"
    elapsed=0
    interval=10
    
    while [ $elapsed -lt $timeout ]; do
      status=$(curl -s "$API_BASE/tasks/$task_id" -H "API_KEY: $MANUS_API_KEY" | jq -r '.status // "unknown"')
      
      if [ "$status" = "completed" ]; then
        echo "completed"
        exit 0
      elif [ "$status" = "failed" ]; then
        echo "failed"
        exit 1
      fi
      
      sleep $interval
      elapsed=$((elapsed + interval))
      echo "waiting... ($elapsed/$timeout sec, status: $status)" >&2
    done
    
    echo "timeout"
    exit 1
    ;;
  
  files)
    # List output files: manus.sh files <task_id>
    task_id="$1"
    curl -s "$API_BASE/tasks/$task_id" \
      -H "API_KEY: $MANUS_API_KEY" | jq -r '.output[]?.content[]? | select(.type == "output_file") | "\(.fileName)\t\(.fileUrl)"'
    ;;
  
  download)
    # Download output files: manus.sh download <task_id> [output_dir]
    task_id="$1"
    output_dir="${2:-.}"
    mkdir -p "$output_dir"
    
    curl -s "$API_BASE/tasks/$task_id" \
      -H "API_KEY: $MANUS_API_KEY" | jq -r '.output[]?.content[]? | select(.type == "output_file") | "\(.fileName)\t\(.fileUrl)"' | \
    while IFS=$'\t' read -r filename url; do
      if [ -n "$filename" ] && [ -n "$url" ]; then
        # Sanitize filename
        safe_name=$(echo "$filename" | tr -cd '[:alnum:]._-' | head -c 100)
        [ -z "$safe_name" ] && safe_name="output_file"
        echo "Downloading: $safe_name" >&2
        curl -sL "$url" -o "$output_dir/$safe_name"
        echo "$output_dir/$safe_name"
      fi
    done
    ;;
  
  list)
    # List tasks: manus.sh list
    curl -s "$API_BASE/tasks" \
      -H "API_KEY: $MANUS_API_KEY"
    ;;
  
  *)
    echo "Usage: manus.sh <command> [args]"
    echo ""
    echo "Commands:"
    echo "  create \"prompt\" [profile]  - Create a new task (default: manus-1.6)"
    echo "  get <task_id>              - Get full task details"
    echo "  status <task_id>           - Get task status (pending/running/completed/failed)"
    echo "  wait <task_id> [timeout]   - Wait for task completion (default: 600s)"
    echo "  files <task_id>            - List output files"
    echo "  download <task_id> [dir]   - Download all output files"
    echo "  list                       - List all tasks"
    echo ""
    echo "Profiles: manus-1.6 (default), manus-1.6-lite, manus-1.6-max"
    exit 1
    ;;
esac
