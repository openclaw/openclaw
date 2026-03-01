"""Layer 4: Weekly Review — runs every Sunday at 10:00, uses Sonnet (~$0.05/week).

Collects weekly digests, experience stats, audit results, anomaly history,
then generates a weekly report via Claude Sonnet and sends summary to Cruz.
"""
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

from lib.logging_util import setup_logger, log_event
from lib.telegram import TelegramBridge
from lib.claude import ClaudeClient

logger = setup_logger("sentinel.weekly_review")

BASE = Path(__file__).resolve().parent.parent          # sentinel/
WORKSPACE = BASE.parent / "workspace"                  # clawd/workspace/
EXPERIENCE_SEARCH = Path.home() / "Clawd" / "workspace" / "experience-memory" / "search_experience"
BOOTSTRAP_AUDIT = WORKSPACE / "scripts" / "bootstrap-audit.py"
WEEKLY_DIR = WORKSPACE / "memory" / "weekly"


def _collect_digests(days=7):
    """Scan workspace for bita-digest and daily-dashboard files from the past N days."""
    cutoff = datetime.now() - timedelta(days=days)
    patterns = ["bita-digest-*.md", "daily-dashboard-*.md"]
    files_found = []

    for pattern in patterns:
        for path in sorted(WORKSPACE.glob(pattern)):
            # Extract date from filename: bita-digest-2026-02-25.md
            stem = path.stem
            try:
                # Take last 10 chars as date (YYYY-MM-DD)
                date_str = stem[-10:]
                file_date = datetime.strptime(date_str, "%Y-%m-%d")
                if file_date >= cutoff:
                    files_found.append(path)
            except ValueError:
                continue

    digests = []
    for path in files_found:
        try:
            content = path.read_text(encoding="utf-8")
            if len(content) > 500:
                content = content[:500] + "\n...(truncated)"
            digests.append(f"### {path.name}\n{content}")
        except Exception as e:
            logger.warning(f"Failed to read {path}: {e}")

    return digests


def _get_experience_stats():
    """Run experience-memory search --stats and capture output."""
    try:
        result = subprocess.run(
            [str(EXPERIENCE_SEARCH), "--stats"],
            capture_output=True, text=True, timeout=120,
        )
        return result.stdout.strip() or result.stderr.strip() or "stats empty"
    except Exception as e:
        logger.warning(f"Experience stats failed: {e}")
        return "stats unavailable"


def _get_audit_result():
    """Run bootstrap-audit.py and capture output."""
    try:
        result = subprocess.run(
            ["python3", str(BOOTSTRAP_AUDIT)],
            capture_output=True, text=True, timeout=120,
            cwd=str(BASE.parent),
        )
        return result.stdout.strip() or result.stderr.strip() or "audit empty"
    except Exception as e:
        logger.warning(f"Bootstrap audit failed: {e}")
        return "audit unavailable"


def _summarize_anomalies(state):
    """Summarize anomaly scan history from state."""
    history = state.get("sentinel", {}).get("anomaly_history", [])
    if not history:
        return "No anomaly scan history recorded."

    total_scans = len(history)
    total_ai_calls = sum(h.get("ai_calls", 0) for h in history)
    p0_count = sum(h.get("p0", 0) for h in history)
    p1_count = sum(h.get("p1", 0) for h in history)
    scores = [h.get("score", 0) for h in history if "score" in h]
    avg_score = sum(scores) / len(scores) if scores else 0

    return (
        f"Total scans: {total_scans}\n"
        f"Total AI calls: {total_ai_calls}\n"
        f"P0 alerts: {p0_count}\n"
        f"P1 alerts: {p1_count}\n"
        f"Average anomaly score: {avg_score:.2f}"
    )


def run(config, state):
    """Main entry. Returns dict with report path and status."""
    log_event(logger, "weekly_review_start", "weekly_review")

    # Step 1: Collect weekly digests
    try:
        digests = _collect_digests(days=7)
        digests_text = "\n\n".join(digests) if digests else "No digests found for the past week."
    except Exception as e:
        logger.error(f"Digest collection failed: {e}")
        digests = []
        digests_text = f"Digest collection error: {e}"

    # Step 2: Experience DB stats
    exp_stats = _get_experience_stats()

    # Step 3: Bootstrap audit
    audit_result = _get_audit_result()

    # Step 4: Anomaly scan history
    anomaly_summary = _summarize_anomalies(state)

    # Step 5: Generate weekly report via Claude Sonnet
    try:
        ai_model = config.get("tasks", {}).get("weekly_review", {}).get(
            "ai_model", "claude-sonnet-4-5-20250514"
        )
        claude = ClaudeClient(max_daily_calls=config.get("claude", {}).get("max_daily_calls", 20))
        ai_content = claude.weekly_summary(
            digests=digests_text,
            audit=audit_result,
            exp_stats=exp_stats,
            anomaly_history=anomaly_summary,
            model=ai_model,
        )
    except Exception as e:
        logger.error(f"Claude weekly summary failed: {e}")
        ai_content = f"AI summary generation failed: {e}"

    # Step 6: Save report
    now = datetime.now()
    iso_year, iso_week, _ = now.isocalendar()
    report_filename = f"{iso_year}-W{iso_week:02d}.md"

    try:
        WEEKLY_DIR.mkdir(parents=True, exist_ok=True)
        report_path = WEEKLY_DIR / report_filename
        report_content = (
            f"# \u9031\u5831 {iso_year}-W{iso_week:02d}\n\n"
            f"_Generated by Sentinel at {now.strftime('%Y-%m-%d %H:%M')}_\n\n"
            f"{ai_content}\n\n"
            f"---\n\n"
            f"## \u539f\u59cb\u6578\u64da\n\n"
            f"### \u5be9\u8a08\u7d50\u679c\n{audit_result}\n\n"
            f"### \u7d93\u9a57\u5eab\u7d71\u8a08\n{exp_stats}\n"
        )
        report_path.write_text(report_content, encoding="utf-8")
        log_event(logger, "weekly_report_saved", "weekly_review", str(report_path))
    except Exception as e:
        logger.error(f"Failed to save weekly report: {e}")
        report_path = None

    # Step 7: Send summary to Cruz
    sent = False
    try:
        condensed = ai_content[:500] if len(ai_content) > 500 else ai_content
        message = f"[Sentinel \u9031\u5831] {iso_year}-W{iso_week:02d}\n\n{condensed}"
        bridge = TelegramBridge(
            config.get("notifications", {}).get("telegram_bridge", "http://localhost:18790")
        )
        chat_id = config.get("notifications", {}).get("cruz_chat_id", "448345880")
        result = bridge.send(message, chat_id)
        sent = result.get("ok", False) if isinstance(result, dict) else False
        if sent:
            log_event(logger, "weekly_summary_sent", "weekly_review")
        else:
            logger.warning(f"Telegram send returned: {result}")
    except Exception as e:
        logger.error(f"Failed to send weekly summary: {e}")

    log_event(logger, "weekly_review_complete", "weekly_review",
              f"digests={len(digests)}, sent={sent}")

    return {
        "status": "ok",
        "report_path": str(report_path) if report_path else None,
        "digests_found": len(digests),
        "sent": sent,
    }


if __name__ == "__main__":
    import argparse
    import json
    import sys
    import yaml

    parser = argparse.ArgumentParser(description="Layer 4: Weekly Review")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen without AI call")
    args = parser.parse_args()

    # Load config
    config_path = BASE / "sentinel.yaml"
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f)
    else:
        print(f"Config not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    # Load state
    state_path = BASE / "state.json"
    if state_path.exists():
        with open(state_path) as f:
            state = json.load(f)
    else:
        state = {}

    if args.dry_run:
        print("=== DRY RUN: Weekly Review ===")
        digests = _collect_digests(days=7)
        print(f"Digests found: {len(digests)}")
        for d in digests:
            print(f"  - {d.splitlines()[0]}")
        print(f"\nExperience stats:\n{_get_experience_stats()}")
        print(f"\nAudit result:\n{_get_audit_result()}")
        print(f"\nAnomaly summary:\n{_summarize_anomalies(state)}")
        print("\n(Skipping AI call and Telegram send in dry-run mode)")
    else:
        result = run(config, state)
        print(json.dumps(result, indent=2, ensure_ascii=False))
