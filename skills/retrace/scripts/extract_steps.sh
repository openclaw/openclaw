#!/usr/bin/env bash
# extract_steps.sh — Extract a structured step-by-step summary from an OpenClaw session JSONL.
# Usage: extract_steps.sh <session.jsonl> [--format md|json] [--verbose]
#
# Outputs a markdown summary of what was done: user requests, assistant actions,
# tool calls (files read/edited, commands run), and outcomes.
# Requires: jq

set -euo pipefail

usage() {
  echo "Usage: $0 <session.jsonl> [--format md|json] [--verbose]"
  echo ""
  echo "  --format md    Markdown output (default)"
  echo "  --format json  Structured JSON output"
  echo "  --verbose      Include tool call details and results"
  exit 1
}

SESSION_FILE=""
FORMAT="md"
VERBOSE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format) FORMAT="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help) usage ;;
    *)
      if [[ -z "$SESSION_FILE" ]]; then
        SESSION_FILE="$1"; shift
      else
        echo "Error: unexpected argument '$1'" >&2; usage
      fi
      ;;
  esac
done

if [[ -z "$SESSION_FILE" ]]; then
  echo "Error: session JSONL file required" >&2
  usage
fi

if [[ ! -f "$SESSION_FILE" ]]; then
  echo "Error: file not found: $SESSION_FILE" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed" >&2
  exit 1
fi

# --- Extract session metadata ---
SESSION_START=$(head -1 "$SESSION_FILE" | jq -r '.timestamp // empty')
SESSION_END=$(tail -1 "$SESSION_FILE" | jq -r '.timestamp // empty')

# --- Extract structured steps ---
if [[ "$FORMAT" == "json" ]]; then
  # JSON output: array of step objects
  jq -s '
    [
      foreach .[] as $entry (
        {step: 0, steps: [], current_request: null};

        # Track user messages as new "steps"
        if ($entry.message.role == "user") then
          .step += 1
          | .current_request = (
              [$entry.message.content[]? | select(.type == "text") | .text]
              | join("\n")
            )
          | .steps += [{
              step: .step,
              type: "request",
              timestamp: $entry.timestamp,
              content: .current_request
            }]
        elif ($entry.message.role == "assistant") then
          # Collect text responses
          .steps += [
            ($entry.message.content[]?
              | if .type == "text" and (.text | length) > 0 then
                  {step: .step, type: "response", timestamp: $entry.timestamp, content: .text}
                elif .type == "toolCall" then
                  {step: .step, type: "tool_call", timestamp: $entry.timestamp, tool: .name, input_preview: (.input | tostring | .[0:200])}
                else empty
                end
            )
          ]
        else . end;

        .
      )
      | .steps
    ] | last
  ' "$SESSION_FILE"
else
  # Markdown output
  echo "# Session Retrace"
  echo ""
  if [[ -n "$SESSION_START" ]]; then
    echo "**Started:** $SESSION_START"
  fi
  if [[ -n "$SESSION_END" ]]; then
    echo "**Ended:** $SESSION_END"
  fi
  echo ""

  # Extract interleaved user/assistant/tool actions
  jq -r '
    if .message.role == "user" then
      .message.content[]?
      | select(.type == "text")
      | "## User Request\n\n" + .text + "\n"
    elif .message.role == "assistant" then
      .message.content[]?
      | if .type == "text" and (.text | length) > 0 then
          "### Assistant\n\n" + .text + "\n"
        elif .type == "toolCall" then
          if .name == "Edit" or .name == "Write" then
            "- **" + .name + "**: `" + (.input.file_path // "unknown") + "`"
          elif .name == "Read" then
            "- **Read**: `" + (.input.file_path // "unknown") + "`"
          elif .name == "Bash" then
            "- **Command**: `" + ((.input.command // "") | .[0:120]) + "`"
          elif .name == "Glob" then
            "- **Search files**: `" + (.input.pattern // "") + "`"
          elif .name == "Grep" then
            "- **Search content**: `" + (.input.pattern // "") + "`"
          else
            "- **" + .name + "**"
          end
        else empty
        end
    else empty
    end
  ' "$SESSION_FILE"

  # Summary stats
  echo ""
  echo "---"
  echo "## Summary"
  echo ""
  jq -rs '
    {
      total_messages: length,
      user_messages: [.[] | select(.message.role == "user")] | length,
      assistant_messages: [.[] | select(.message.role == "assistant")] | length,
      tool_calls: [.[] | .message.content[]? | select(.type == "toolCall")] | length,
      files_edited: [.[] | .message.content[]? | select(.type == "toolCall" and (.name == "Edit" or .name == "Write")) | .input.file_path] | unique | length,
      commands_run: [.[] | .message.content[]? | select(.type == "toolCall" and .name == "Bash")] | length
    }
    | "- **Messages:** \(.user_messages) user, \(.assistant_messages) assistant\n- **Tool calls:** \(.tool_calls)\n- **Files edited:** \(.files_edited)\n- **Commands run:** \(.commands_run)"
  ' "$SESSION_FILE"
fi
