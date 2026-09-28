#!/bin/bash

# VibeTunnel Logging Utility
# Simplifies access to VibeTunnel logs using macOS unified logging system

set -euo pipefail

SUBSYSTEM="ai.openclaw"
DEFAULT_LEVEL="info"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

handle_sudo_error() {
    echo -e "\n${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}⚠️  Password Required for Log Access${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    echo -e "clawlog needs to use sudo to show complete log data (Apple hides sensitive info by default)."
    echo -e "\nTo avoid password prompts, configure passwordless sudo for the log command:"
    echo -e "See: ${BLUE}apple/docs/logging-private-fix.md${NC}\n"
    echo -e "Quick fix:"
    echo -e "  1. Run: ${GREEN}sudo visudo${NC}"
    echo -e "  2. Add: ${GREEN}$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/log${NC}"
    echo -e "  3. Save and exit (:wq)\n"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    exit 1
}

STREAM_MODE=false
TIME_RANGE="5m"
CATEGORY=""
LOG_LEVEL="$DEFAULT_LEVEL"
SEARCH_TEXT=""
OUTPUT_FILE=""
ERRORS_ONLY=false
TAIL_LINES=50
SHOW_TAIL=true
STYLE_JSON=false
LIST_CATEGORIES=false

show_usage() {
    cat << EOF
clawlog - OpenClaw Logging Utility

USAGE:
    clawlog [OPTIONS]

DESCRIPTION:
    View OpenClaw logs with full details (bypasses Apple's privacy redaction).
    Requires sudo access configured for /usr/bin/log command.

LOG FLOW ARCHITECTURE:
    OpenClaw logs flow through the macOS unified log (subsystem: ai.openclaw).

LOG CATEGORIES (examples):
    • voicewake           - Voice wake detection/test harness
    • gateway             - Gateway process manager
    • xpc                 - XPC service calls
    • notifications       - Notification helper
    • screenshot          - Screenshotter
    • shell               - ShellExecutor

QUICK START:
    clawlog -n 100             Show last 100 lines from all components
    clawlog -f                 Follow logs in real-time
    clawlog -e                 Show only errors
    clawlog -c ServerManager   Show logs from ServerManager only

OPTIONS:
    -h, --help              Show this help message
    -f, --follow            Stream logs continuously (like tail -f)
    -n, --lines NUM         Number of lines (or JSON records) to show (default: 50)
    -l, --last TIME         Time range to search (default: 5m)
                           Examples: 5m, 1h, 2d, 1w
    -c, --category CAT      Filter by category (e.g., ServerManager, SessionService)
    -e, --errors            Show only error messages
    -d, --debug             Show debug level logs (more verbose)
    -s, --search TEXT       Search for specific text in log messages
    -o, --output FILE       Export logs to file
    --server                Show only server output logs
    --all                   Show all logs without tail limit
    --list-categories       List all available log categories (not with --json)
    --json                  Output one JSON array (not with --follow or --list-categories)

EXAMPLES:
    clawlog                   Show last 50 lines from past 5 minutes (default)
    clawlog -f                Stream logs continuously
    clawlog -n 100            Show last 100 lines
    clawlog -e                Show only recent errors
    clawlog -l 30m -n 200     Show last 200 lines from past 30 minutes
    clawlog -c ServerManager  Show recent ServerManager logs
    clawlog -s "fail"         Search for "fail" in recent logs
    clawlog --server -e       Show recent server errors
    clawlog -f -d             Stream debug logs continuously

CATEGORIES:
    Common categories include:
    - ServerManager         - Server lifecycle and configuration
    - SessionService        - Terminal session management
    - TerminalManager       - Terminal spawning and control
    - GitRepository         - Git integration features
    - ScreencapService      - Screen capture functionality
    - WebRTCManager         - WebRTC connections
    - UnixSocket           - Unix socket communication
    - WindowTracker        - Window tracking and focus
    - NgrokService         - Ngrok tunnel management
    - ServerOutput         - Node.js server output

TIME FORMATS:
    - 5m  = 5 minutes       - 1h  = 1 hour
    - 2d  = 2 days         - 1w  = 1 week

EOF
}

list_categories() {
    echo -e "${BLUE}Fetching VibeTunnel log categories from the last hour...${NC}\n"

    log show --predicate "subsystem == \"$SUBSYSTEM\"" --last 1h 2>/dev/null | \
        grep -E "category: \"[^\"]+\"" | \
        sed -E 's/.*category: "([^"]+)".*/\1/' | \
        sort | uniq | \
        while read -r cat; do
            echo "  • $cat"
        done

    echo -e "\n${YELLOW}Note: Only categories with recent activity are shown${NC}"
}

# Escape user input embedded in macOS log predicate string literals.
escape_predicate_literal() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -f|--follow)
            STREAM_MODE=true
            SHOW_TAIL=false
            shift
            ;;
        -n|--lines|-l|--last|-c|--category|-s|--search|-o|--output)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}Error: $1 requires a value${NC}" >&2
                exit 1
            fi
            case $1 in
                -n|--lines) TAIL_LINES="$2" ;;
                -l|--last) TIME_RANGE="$2" ;;
                -c|--category) CATEGORY="$2" ;;
                -s|--search) SEARCH_TEXT="$2" ;;
                -o|--output) OUTPUT_FILE="$2" ;;
            esac
            shift 2
            ;;
        -e|--errors)
            ERRORS_ONLY=true
            shift
            ;;
        -d|--debug)
            LOG_LEVEL="debug"
            shift
            ;;
        --server)
            CATEGORY="ServerOutput"
            shift
            ;;
        --list-categories)
            LIST_CATEGORIES=true
            shift
            ;;
        --json)
            STYLE_JSON=true
            shift
            ;;
        --all)
            SHOW_TAIL=false
            shift
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

if [[ "$STYLE_JSON" == true ]] && [[ "$STREAM_MODE" == true || "$LIST_CATEGORIES" == true ]]; then
    echo "Error: --json cannot be combined with --follow or --list-categories" >&2
    exit 1
fi

if [[ "$LIST_CATEGORIES" == true ]]; then
    list_categories
    exit 0
fi

PREDICATE="subsystem == \"$SUBSYSTEM\""

if [[ -n "$CATEGORY" ]]; then
    ESCAPED_CATEGORY=$(escape_predicate_literal "$CATEGORY")
    PREDICATE="$PREDICATE AND category == \"$ESCAPED_CATEGORY\""
fi

if [[ "$ERRORS_ONLY" == true ]]; then
    PREDICATE="$PREDICATE AND (eventType == \"error\" OR messageType == \"error\" OR eventMessage CONTAINS \"ERROR\" OR eventMessage CONTAINS \"[31m\")"
fi

if [[ -n "$SEARCH_TEXT" ]]; then
    ESCAPED_SEARCH_TEXT=$(escape_predicate_literal "$SEARCH_TEXT")
    PREDICATE="$PREDICATE AND eventMessage CONTAINS[c] \"$ESCAPED_SEARCH_TEXT\""
fi

# Build the command as argv array to avoid shell eval injection
LOG_CMD=(sudo log)
if [[ "$STREAM_MODE" == true ]]; then
    LOG_CMD+=(stream --predicate "$PREDICATE" --level "$LOG_LEVEL" --info)

    echo -e "${GREEN}Streaming VibeTunnel logs continuously...${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"
else
    LOG_CMD+=(show --predicate "$PREDICATE")

    if [[ "$LOG_LEVEL" == "debug" ]]; then
        LOG_CMD+=(--debug)
    else
        LOG_CMD+=(--info)
    fi

    LOG_CMD+=(--last "$TIME_RANGE")

    if [[ "$STYLE_JSON" == false ]]; then
        if [[ "$SHOW_TAIL" == true ]]; then
            echo -e "${GREEN}Showing last $TAIL_LINES log lines from the past $TIME_RANGE${NC}"
        else
            echo -e "${GREEN}Showing all logs from the past $TIME_RANGE${NC}"
        fi

        if [[ "$ERRORS_ONLY" == true ]]; then
            echo -e "${RED}Filter: Errors only${NC}"
        fi
        if [[ -n "$CATEGORY" ]]; then
            echo -e "${BLUE}Category: $CATEGORY${NC}"
        fi
        if [[ -n "$SEARCH_TEXT" ]]; then
            echo -e "${YELLOW}Search: \"$SEARCH_TEXT\"${NC}"
        fi
        echo ""
    fi
fi

if [[ "$STYLE_JSON" == true ]]; then
    LOG_CMD+=(--style ndjson)
    sudo -n /usr/bin/log show --last 1s >/dev/null || exit $?

    if [[ -n "$OUTPUT_FILE" ]]; then
        if [[ -d "$OUTPUT_FILE" ]]; then
            echo "Error: output path is a directory: $OUTPUT_FILE" >&2
            exit 1
        fi
        STAGED_OUTPUT=$(mktemp -- "${OUTPUT_FILE}.tmp.XXXXXX")
    else
        STAGED_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/clawlog.XXXXXX")
    fi
    trap 'rm -f -- "$STAGED_OUTPUT"' EXIT

    TAIL_ARGS=(-n "$TAIL_LINES")
    if [[ "$SHOW_TAIL" == false ]]; then
        TAIL_ARGS=(-n +1)
    fi

    # macOS appends a documented "finished" metadata record after NDJSON events.
    if "${LOG_CMD[@]}" | sed '$d' | tail "${TAIL_ARGS[@]}" | \
        awk 'BEGIN { printf "[" } NR > 1 { printf "," } { printf "%s", $0 } END { print "]" }' > "$STAGED_OUTPUT"; then
        if [[ -n "$OUTPUT_FILE" ]]; then
            mv -f -- "$STAGED_OUTPUT" "$OUTPUT_FILE"
        else
            cat "$STAGED_OUTPUT"
        fi
    else
        exit $?
    fi
    exit 0
fi

# First check if sudo works without password for the log command.
if sudo -n /usr/bin/log show --last 1s 2>&1 | grep -q "password"; then
    handle_sudo_error
fi

if [[ -n "$OUTPUT_FILE" ]]; then
    echo -e "${BLUE}Exporting logs to: $OUTPUT_FILE${NC}\n"
    if [[ "$SHOW_TAIL" == true ]] && [[ "$STREAM_MODE" == false ]]; then
        "${LOG_CMD[@]}" 2>&1 | tail -n "$TAIL_LINES" > "$OUTPUT_FILE"
    else
        "${LOG_CMD[@]}" > "$OUTPUT_FILE" 2>&1
    fi

    if [[ -s "$OUTPUT_FILE" ]]; then
        LINE_COUNT=$(wc -l < "$OUTPUT_FILE" | tr -d ' ')
        echo -e "${GREEN}✓ Exported $LINE_COUNT lines to $OUTPUT_FILE${NC}"
    else
        echo -e "${YELLOW}⚠ No logs found matching the criteria${NC}"
    fi
else
    if [[ "$SHOW_TAIL" == true ]] && [[ "$STREAM_MODE" == false ]]; then
        "${LOG_CMD[@]}" 2>&1 | tail -n "$TAIL_LINES"
        echo -e "\n${YELLOW}Showing last $TAIL_LINES lines. Use --all or -n to see more.${NC}"
    else
        "${LOG_CMD[@]}"
    fi
fi
