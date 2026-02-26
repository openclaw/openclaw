#!/usr/bin/env bash
# chrome-cleanup.sh — Browser Process Lifecycle Manager for OpenClaw
#
# Monitors and reaps orphaned Chrome/Chromium main processes to prevent RAM exhaustion.
# Only targets main browser processes (not child zygote/renderer/GPU processes).
# Killing the main process automatically cleans up all its children.
#
# Modes:
#   daemon   — Run continuously with CHECK_INTERVAL_SECS between scans
#   once     — Run a single scan and exit
#   status   — Show current Chrome process state
#   kill-all — Kill all openclaw Chrome processes immediately
#
# Platform support: Linux (systemd), macOS (launchd - TODO)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="${SCRIPT_DIR}/chrome-cleanup.conf"

# ── Platform detection ──────────────────────────────────────────────────────
detect_platform() {
    case "$(uname -s)" in
        Linux*)     PLATFORM="linux";;
        Darwin*)    PLATFORM="macos";;
        *)          PLATFORM="unknown";;
    esac
    echo "$PLATFORM"
}

PLATFORM="$(detect_platform)"

# ── Load config ─────────────────────────────────────────────────────────────
if [[ -f "$CONF_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONF_FILE"
fi

MAX_CHROME_INSTANCES="${MAX_CHROME_INSTANCES:-2}"
IDLE_TIMEOUT_SECS="${IDLE_TIMEOUT_SECS:-120}"
CHECK_INTERVAL_SECS="${CHECK_INTERVAL_SECS:-30}"
LOG_FILE="${LOG_FILE:-$HOME/.openclaw/logs/chrome-cleanup.log}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-1048576}"
DRY_RUN="${DRY_RUN:-false}"

# OpenClaw-specific filtering - only target OpenClaw browser processes
OPENCLAW_USERDATA_DIR="${OPENCLAW_USERDATA_DIR:-$HOME/.openclaw/browser}"

# ── Setup ───────────────────────────────────────────────────────────────────
# Create log directory on first run
setup_logging() {
    local log_dir
    log_dir="$(dirname "$LOG_FILE")"
    if [[ ! -d "$log_dir" ]]; then
        mkdir -p "$log_dir" || {
            echo "ERROR: Cannot create log directory: $log_dir" >&2
            exit 1
        }
    fi
}

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
    local level="$1"; shift
    local ts
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[$ts] [$level] $*" >> "$LOG_FILE"
}

# Platform-aware log rotation
rotate_log() {
    if [[ -f "$LOG_FILE" ]]; then
        local log_size
        if [[ "$PLATFORM" == "macos" ]]; then
            # macOS stat syntax
            log_size="$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)"
        else
            # Linux stat syntax
            log_size="$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)"
        fi
        
        if [[ "$log_size" -gt "$LOG_MAX_BYTES" ]]; then
            mv "$LOG_FILE" "${LOG_FILE}.1"
            log "INFO" "Log rotated"
        fi
    fi
}

# ── Chrome main-process discovery ────────────────────────────────────────────
# Returns ONLY main Chrome browser process PIDs launched by OpenClaw.
# A main Chrome process:
#   - Executable is chrome/chromium (not crashpad_handler)
#   - Does NOT have --type= flag (children always have --type=zygote, --type=gpu-process, etc.)
#   - Has --user-data-dir pointing to OpenClaw's browser directory (CRITICAL)
#
# Regular user Chrome (no OpenClaw user-data-dir) is NEVER touched.
# Killing a main process automatically terminates all its children.
find_main_chrome_pids() {
    local pids=()
    local ps_output
    
    # Get process list
    if [[ "$PLATFORM" == "macos" ]]; then
        # macOS ps syntax
        ps_output="$(ps -u "$(whoami)" -o pid=,comm=,args= 2>/dev/null)" || true
    else
        # Linux ps syntax
        ps_output="$(ps -u "$(whoami)" -o pid=,args= 2>/dev/null)" || true
    fi
    
    [[ -z "$ps_output" ]] && echo "" && return 0

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        local pid
        pid="$(echo "$line" | awk '{print $1}')"
        [[ -n "$pid" ]] && pids+=("$pid")
    done < <(
        echo "$ps_output" \
        | grep -E '/chrome|/Chromium|/Google Chrome' \
        | grep -v 'crashpad_handler' \
        | grep -v '\-\-type=' \
        | grep -v 'grep' \
        | grep -v 'chrome-cleanup' \
        | grep -F "--user-data-dir=$OPENCLAW_USERDATA_DIR" \
        || true
    )
    
    echo "${pids[*]}"
}

# ── Process info helpers ─────────────────────────────────────────────────────
get_elapsed_secs() {
    ps -p "$1" -o etimes= 2>/dev/null | tr -d ' '
}

get_rss_kb() {
    ps -p "$1" -o rss= 2>/dev/null | tr -d ' '
}

# Platform-aware command line reading
read_proc_cmdline() {
    local pid="$1"
    if [[ "$PLATFORM" == "macos" ]]; then
        # macOS: use ps
        ps -p "$pid" -o args= 2>/dev/null || true
    else
        # Linux: use /proc
        tr '\0' '\n' < /proc/"$pid"/cmdline 2>/dev/null || true
    fi
}

# Check if a Chrome process has an active CDP connection
has_active_cdp() {
    local pid="$1"
    local port
    
    port="$(read_proc_cmdline "$pid" | grep -oE 'remote-debugging-port=[0-9]+' | cut -d= -f2)" || true
    [[ -z "$port" ]] && return 1
    
    if [[ "$PLATFORM" == "macos" ]]; then
        # macOS: use lsof
        lsof -nP -iTCP:"$port" -sTCP:ESTABLISHED 2>/dev/null | grep -q "ESTABLISHED" && return 0
    else
        # Linux: use ss
        ss -tnp 2>/dev/null | grep -q ":${port}.*ESTAB" && return 0
    fi
    return 1
}

# Get total RSS of a process tree (main + all children) in MB
get_tree_rss_mb() {
    local pid="$1"
    local total_kb=0
    
    # Get children PIDs
    local children
    if [[ "$PLATFORM" == "macos" ]]; then
        # macOS: use pgrep
        children="$(pgrep -P "$pid" 2>/dev/null || true)"
    else
        # Linux: use ps
        children="$(ps --ppid "$pid" -o pid= 2>/dev/null || true)"
    fi
    
    # Sum RSS
    while IFS= read -r rss; do
        rss="$(echo "$rss" | tr -d ' ')"
        [[ -n "$rss" ]] && total_kb=$(( total_kb + rss ))
    done < <(echo "$children" | xargs -I{} ps -p {} -o rss= 2>/dev/null; ps -p "$pid" -o rss= 2>/dev/null)
    
    echo $(( total_kb / 1024 ))
}

# ── Cleanup logic ────────────────────────────────────────────────────────────
do_scan() {
    local pids_str
    pids_str="$(find_main_chrome_pids)"
    [[ -z "$pids_str" ]] && return 0

    # FIX: Properly initialize array from space-separated PIDs
    read -ra pids <<< "$pids_str"
    local killed=0

    # Build sorted list: pid:elapsed:rss_tree_mb:has_cdp
    local -a entries=()
    for pid in "${pids[@]}"; do
        local elapsed rss_mb cdp=0
        elapsed="$(get_elapsed_secs "$pid")" || continue
        [[ -z "$elapsed" ]] && continue
        rss_mb="$(get_tree_rss_mb "$pid")"
        has_active_cdp "$pid" && cdp=1
        entries+=("${pid}:${elapsed}:${rss_mb}:${cdp}")
    done

    local count="${#entries[@]}"
    [[ "$count" -eq 0 ]] && return 0

    log "INFO" "Found $count OpenClaw Chrome process(es)"

    # Phase 1: Kill idle processes past IDLE_TIMEOUT_SECS (no CDP connection)
    local -a surviving=()
    for entry in "${entries[@]}"; do
        IFS=':' read -r pid elapsed rss_mb cdp <<< "$entry"
        if [[ "$cdp" -eq 0 ]] && [[ "$elapsed" -gt "$IDLE_TIMEOUT_SECS" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log "INFO" "[DRY-RUN] Would kill idle Chrome PID=$pid age=${elapsed}s tree_rss=${rss_mb}MB"
            else
                log "INFO" "Killing idle Chrome PID=$pid age=${elapsed}s tree_rss=${rss_mb}MB (no CDP, exceeded ${IDLE_TIMEOUT_SECS}s)"
                kill -TERM "$pid" 2>/dev/null || true
                sleep 1
                kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
                ((killed++)) || true
            fi
        else
            surviving+=("$entry")
        fi
    done

    # Phase 2: If more than MAX_CHROME_INSTANCES remain, kill oldest non-CDP
    local remaining="${#surviving[@]}"
    if [[ "$remaining" -gt "$MAX_CHROME_INSTANCES" ]]; then
        # Sort by elapsed time (oldest first), prefer non-CDP
        IFS=$'\n' read -r -d '' -a sorted < <(printf '%s\n' "${surviving[@]}" | sort -t: -k2 -n -r)
        
        local to_kill=$(( remaining - MAX_CHROME_INSTANCES ))
        for entry in "${sorted[@]:$MAX_CHROME_INSTANCES}"; do
            [[ -z "$entry" ]] && continue
            IFS=':' read -r pid elapsed rss_mb cdp <<< "$entry"
            
            # Skip if has active CDP (protected)
            [[ "$cdp" -eq 1 ]] && continue
            
            if [[ "$DRY_RUN" == "true" ]]; then
                log "INFO" "[DRY-RUN] Would kill excess Chrome PID=$pid (max=$MAX_CHROME_INSTANCES, remaining=$remaining)"
            else
                log "INFO" "Killing excess Chrome PID=$pid age=${elapsed}s (max=$MAX_CHROME_INSTANCES exceeded)"
                kill -TERM "$pid" 2>/dev/null || true
                sleep 1
                kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
                ((killed++)) || true
            fi
            
            ((to_kill--)) || true
            [[ "$to_kill" -le 0 ]] && break
        done
    fi

    log "INFO" "Scan complete: killed=$killed, remaining=$(( count - killed ))"
}

# ── Status display ───────────────────────────────────────────────────────────
show_status() {
    local pids_str
    pids_str="$(find_main_chrome_pids)"
    
    echo "=== OpenClaw Chrome Process Status ==="
    echo "Platform: $PLATFORM"
    echo "User-data-dir: $OPENCLAW_USERDATA_DIR"
    echo ""
    
    if [[ -z "$pids_str" ]]; then
        echo "No OpenClaw Chrome processes found."
        return 0
    fi
    
    # FIX: Properly initialize array from space-separated PIDs
    read -ra pids <<< "$pids_str"
    echo "Found ${#pids[@]} process(es):"
    echo ""
    
    for pid in "${pids[@]}"; do
        local elapsed rss_mb cdp="no"
        elapsed="$(get_elapsed_secs "$pid")" || continue
        rss_mb="$(get_tree_rss_mb "$pid")"
        has_active_cdp "$pid" && cdp="yes"
        
        printf "  PID %-6s | Age: %-5ss | RSS: %-5sMB | CDP: %-3s\n" "$pid" "$elapsed" "$rss_mb" "$cdp"
    done
    
    echo ""
    echo "Config: max=$MAX_CHROME_INSTANCES, idle_timeout=${IDLE_TIMEOUT_SECS}s"
}

# ── Kill all ─────────────────────────────────────────────────────────────────
kill_all_chrome() {
    local pids_str
    pids_str="$(find_main_chrome_pids)"
    
    if [[ -z "$pids_str" ]]; then
        echo "No OpenClaw Chrome processes to kill."
        return 0
    fi
    
    # FIX: Properly initialize array from space-separated PIDs
    read -ra pids <<< "$pids_str"
    echo "Killing ${#pids[@]} OpenClaw Chrome process(es)..."
    
    for pid in "${pids[@]}"; do
        echo "  Killing PID $pid..."
        kill -TERM "$pid" 2>/dev/null || true
    done
    
    sleep 2
    
    # Check if any survived
    local remaining
    remaining="$(find_main_chrome_pids)"
    if [[ -n "$remaining" ]]; then
        echo "  Some processes survived, using SIGKILL..."
        for pid in "${remaining[@]}"; do
            kill -KILL "$pid" 2>/dev/null || true
        done
    fi
    
    echo "Done."
}

# ── Daemon mode ──────────────────────────────────────────────────────────────
run_daemon() {
    log "INFO" "Chrome cleanup daemon starting (platform=$PLATFORM, max=$MAX_CHROME_INSTANCES, idle=${IDLE_TIMEOUT_SECS}s)"
    
    # FIX: Add signal handling for graceful shutdown
    trap 'log "INFO" "Received SIGTERM/SIGINT, shutting down gracefully"; exit 0' SIGTERM SIGINT
    
    while true; do
        rotate_log
        do_scan
        sleep "$CHECK_INTERVAL_SECS"
    done
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
    local mode="${1:-once}"
    
    # Setup logging
    setup_logging
    rotate_log
    
    case "$mode" in
        daemon)
            run_daemon
            ;;
        once)
            do_scan
            ;;
        status)
            show_status
            ;;
        kill-all)
            kill_all_chrome
            ;;
        *)
            echo "Usage: $0 {daemon|once|status|kill-all}"
            echo ""
            echo "Modes:"
            echo "  daemon   - Run continuously (for systemd/launchd)"
            echo "  once     - Run single scan and exit (default)"
            echo "  status   - Show current Chrome processes"
            echo "  kill-all - Kill all OpenClaw Chrome processes immediately"
            exit 1
            ;;
    esac
}

main "$@"
