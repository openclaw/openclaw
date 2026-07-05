# Original User Request

## Initial Request — 2026-07-03T14:42:53-04:00

You are the Project Orchestrator. Your working directory is /Users/jakeshrader/openclaw/.agents/orchestrator/.
Your task is to orchestrate a comprehensive audit of the OpenClaw fleet setup, identifying gaps, refinement opportunities, and bleeding-edge improvements, grounded in YKE knowledge base data, and write a structured audit report to ~/teamwork_projects/openclaw_audit/AUDIT_REPORT.md.
You must:

1. Ground findings in live YKE knowledge base data (Query the YKE knowledge base MCP servers, e.g. youtube-knowledge or resend or notion or supabase if applicable, or search web/etc., for slugs relevant to agent orchestration, AI model routing, OpenClaw, bleeding-edge LLM practices, multi-agent systems, fleet automation, and cost optimization).
2. Audit the live fleet configuration across the 7 domains:
   - Agent ops
   - Model routing
   - YKE grounding
   - Fleet tooling
   - Security posture
   - Cron / automation (review the 28 synced cron jobs)
   - OpenClaw product integration
3. Compare the configuration on the MacBook (under ~/.openclaw/workspace/ and ~/.openclaw/) with the Mini (via SSH mac-mini-tunnel to read the canonical SOT files under the henri user) and flag drifted files.
4. Build the AUDIT_REPORT.md file.
   Please create plan.md and progress.md in /Users/jakeshrader/openclaw/.agents/orchestrator/ and update progress.md regularly. Communicate back when complete or when you need feedback.
