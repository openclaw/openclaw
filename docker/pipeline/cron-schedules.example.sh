#!/usr/bin/env bash
# Example cron jobs for the multi-agent pipeline.
# Run these against a running OpenClaw gateway to set up scheduled workflows.
# Adjust times and messages to your preference.

set -euo pipefail

OPENCLAW="openclaw"

echo "==> Adding Market Analyzer daily run (08:00 UTC)"
$OPENCLAW cron add \
  --name "Market Analyzer: daily summary" \
  --cron "0 8 * * *" \
  --session isolated \
  --agent market_analyzer \
  --message "Produce a daily market summary. Check watchlist, flag notable movements, and save any trend-worthy signals."

echo "==> Adding Trend Finder daily run (09:00 UTC)"
$OPENCLAW cron add \
  --name "Trend Finder: daily scan" \
  --cron "0 9 * * *" \
  --session isolated \
  --agent trend_finder \
  --message "Read new trend signals, investigate and score each one, then promote or archive."

echo "==> Adding Brainstormer weekday run (10:00 UTC, Mon-Fri)"
$OPENCLAW cron add \
  --name "Brainstormer: ideation pass" \
  --cron "0 10 * * 1-5" \
  --session isolated \
  --agent brainstormer \
  --message "Read reviewed trends and generate structured product ideas for each."

echo "==> Adding Product Architect weekday run (14:00 UTC, Mon-Fri)"
$OPENCLAW cron add \
  --name "Product Architect: evaluation pass" \
  --cron "0 14 * * 1-5" \
  --session isolated \
  --agent product_architect \
  --message "Evaluate generated ideas. Shortlist or reject. Write product specs for promising candidates."

echo "==> Adding Software Engineer weekly run (10:00 UTC, Monday)"
$OPENCLAW cron add \
  --name "Software Engineer: planning pass" \
  --cron "0 10 * * 1" \
  --session isolated \
  --agent software_engineer \
  --message "Read approved product specs and generate engineering task breakdowns."

echo "==> Done. Verify with: $OPENCLAW cron list"
