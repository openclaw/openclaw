#!/bin/bash
# Mythos-Class Cron Registration Script
# Registers all production cron jobs for Mythos workflows

set -e

echo "🦞 Registering Mythos-Class Cron Jobs"
echo "======================================"
echo ""

# Daily Intelligence Briefing - 7:00 AM UTC
echo "📊 Registering: Daily Intelligence Briefing (7:00 AM UTC)"
openclaw cron add \
  --name "Mythos Daily Brief" \
  --schedule "0 7 * * *" \
  --timezone UTC \
  --session isolated \
  --model google/gemini-3-flash-preview \
  --workflow mythos-workspace/workflows/daily-brief.lobster \
  --deliver telegram:prime,slack:general,discord:briefings

echo ""

# Weekly Retrospective - Friday 6:00 PM UTC
echo "📅 Registering: Weekly Retrospective (Friday 6:00 PM UTC)"
openclaw cron add \
  --name "Mythos Weekly Retro" \
  --schedule "0 18 * * 5" \
  --timezone UTC \
  --session isolated \
  --model anthropic/claude-opus-4-7 \
  --workflow mythos-workspace/workflows/weekly-retro.lobster \
  --deliver telegram:prime,slack:team,discord:retrospectives

echo ""

# GitHub PR Sweep - Every 15 minutes during work hours
echo "🔧 Registering: GitHub PR Sweep (Every 15 min, 9 AM - 6 PM UTC)"
openclaw cron add \
  --name "Mythos PR Sweep" \
  --schedule "*/15 9-18 * * 1-5" \
  --timezone UTC \
  --session "session:github-triage" \
  --model google/gemini-3-flash-preview \
  --system-event "Check GitHub for open PRs needing review"

echo ""

# Security Audit - Sunday 3:00 AM UTC
echo "🔒 Registering: Security Audit (Sunday 3:00 AM UTC)"
openclaw cron add \
  --name "Mythos Security Audit" \
  --schedule "0 3 * * 0" \
  --timezone UTC \
  --session isolated \
  --model anthropic/claude-opus-4-7 \
  --system-event "Run comprehensive security audit"

echo ""

# Memory Wiki Compilation - 2:00 AM UTC
echo "🧠 Registering: Memory Wiki Compilation (2:00 AM UTC)"
openclaw cron add \
  --name "Mythos Wiki Compile" \
  --schedule "0 2 * * *" \
  --timezone UTC \
  --session isolated \
  --model anthropic/claude-haiku-3-5 \
  --system-event "Compile memory into wiki pages"

echo ""

# Context Window Warm-up - Every 25 minutes
echo "🔥 Registering: Context Window Warm-up (Every 25 min)"
openclaw cron add \
  --name "Mythos Cache Warm" \
  --schedule "*/25 * * * *" \
  --session main \
  --system-event "Heartbeat cache warm" \
  --wake next-heartbeat

echo ""

echo "✅ All cron jobs registered successfully!"
echo ""
echo "To view registered jobs:"
echo "  openclaw cron list"
echo ""
echo "To remove a job:"
echo "  openclaw cron remove <job-id>"
echo ""
