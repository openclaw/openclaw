#!/usr/bin/env python3
"""
Example analysis script using openclaw_loader.

Demonstrates common analysis patterns for cron run logs.
Run: python example_analysis.py [--dir ~/.openclaw]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Ensure loader is importable from same directory
sys.path.insert(0, str(Path(__file__).parent))

from openclaw_loader import (
    load_cron_runs,
    load_sessions,
    cron_daily_summary,
    cron_job_summary,
    cron_model_summary,
    export_to_csv,
)


def print_section(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")


def analyze_cron(openclaw_dir: str | None) -> None:
    df = load_cron_runs(openclaw_dir=openclaw_dir)

    if df.empty:
        print("No cron run logs found. Jobs will appear after scheduled tasks run.")
        return

    # --- Overview ---
    print_section("Cron Runs Overview")
    print(f"Total executions: {len(df)}")
    print(f"Unique jobs: {df['job_id'].nunique()}")
    print(f"Date range: {df['timestamp'].min():%Y-%m-%d} to {df['timestamp'].max():%Y-%m-%d}")
    print(f"\nStatus distribution:")
    for status, count in df["status"].value_counts().items():
        pct = count / len(df) * 100
        print(f"  {status}: {count} ({pct:.1f}%)")

    # --- Daily trends ---
    print_section("Daily Summary (last 7 days)")
    daily = cron_daily_summary(df)
    if not daily.empty:
        recent = daily.tail(7)
        for _, row in recent.iterrows():
            bar = "█" * int(row["success_rate"] * 20)
            print(
                f"  {row['date']}  "
                f"runs={row['total_runs']:3d}  "
                f"ok={row['ok_count']:3d}  "
                f"err={row['error_count']:2d}  "
                f"rate={row['success_rate']:.0%} {bar}"
            )

    # --- Model comparison ---
    print_section("Model Performance")
    models = cron_model_summary(df)
    if not models.empty:
        print(f"{'Provider':<12} {'Model':<30} {'Runs':>5} {'Avg ms':>8} {'Err%':>6} {'Tokens':>10}")
        print("-" * 75)
        for _, row in models.iterrows():
            print(
                f"{row['provider']:<12} "
                f"{row['model']:<30} "
                f"{row['run_count']:>5} "
                f"{row['avg_duration_ms']:>8.0f} "
                f"{row['error_rate']:>5.1%} "
                f"{row['total_tokens']:>10.0f}"
            )

    # --- Job health ---
    print_section("Job Health")
    jobs = cron_job_summary(df)
    if not jobs.empty:
        for _, row in jobs.iterrows():
            status_icon = "✓" if row["success_rate"] >= 0.95 else ("⚠" if row["success_rate"] >= 0.8 else "✗")
            print(
                f"  {status_icon} {row['job_id']:<25} "
                f"runs={row['run_count']:4d}  "
                f"rate={row['success_rate']:.0%}  "
                f"last={row['last_run']:%Y-%m-%d %H:%M}"
            )

    # --- Errors ---
    errors = df[df["status"] == "error"]
    if not errors.empty:
        print_section(f"Recent Errors ({len(errors)} total)")
        for _, row in errors.tail(5).iterrows():
            print(f"  [{row['timestamp']:%Y-%m-%d %H:%M}] job={row['job_id']}")
            if row.get("error"):
                print(f"    error: {row['error'][:100]}")


def analyze_sessions(openclaw_dir: str | None) -> None:
    sessions = load_sessions(openclaw_dir=openclaw_dir, limit=10)

    if sessions.empty:
        print("No sessions found.")
        return

    print_section("Recent Sessions")
    print(f"Total discovered: {len(sessions)}")
    print(f"\n{'Session ID':<40} {'Size':>10} {'Lines':>7} {'Modified':<20}")
    print("-" * 80)
    for _, row in sessions.head(10).iterrows():
        size_kb = row["size_bytes"] / 1024
        print(
            f"{row['session_id']:<40} "
            f"{size_kb:>8.1f}KB "
            f"{row['line_count']:>7} "
            f"{row['modified_at']:%Y-%m-%d %H:%M}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Example OpenClaw data analysis.")
    parser.add_argument("--dir", help="Override ~/.openclaw base directory.")
    parser.add_argument("--export", help="Export cron runs to CSV.")
    args = parser.parse_args()

    analyze_cron(args.dir)
    analyze_sessions(args.dir)

    if args.export:
        df = load_cron_runs(openclaw_dir=args.dir)
        if not df.empty:
            export_to_csv(df, args.export)


if __name__ == "__main__":
    main()
