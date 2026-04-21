---
summary: "CLI reference for `openclaw diagnose` (AI-powered gateway diagnostic analysis)"
read_when:
  - The gateway is misbehaving and you want a structured diagnostic report
  - You want an AI analysis of gateway logs, config, and health data
  - You need to generate a diagnostic report for sharing or archival
title: "diagnose"
---

# `openclaw diagnose`

AI-powered diagnostic analysis of gateway logs and configuration.

Assembles diagnostic context from the gateway log, configuration, health data,
version info, auth events, and system memory, then sends it to an AI model for
structured analysis. The resulting report identifies issues, likely root causes,
and recommended fixes.

Related:

- Health checks: [doctor](/cli/doctor)
- Gateway status: [gateway](/cli/gateway)
- Logs: [logs](/cli/logs)

## Examples

```bash
openclaw diagnose                           # stream report to stdout
openclaw diagnose --canvas                  # also save HTML to canvas for browser viewing
openclaw diagnose --output diagnostics.md   # save report to file
openclaw diagnose --json                    # structured JSON output
openclaw diagnose --model claude-haiku-4-5  # use a specific model
openclaw diagnose --max-log-entries 50      # limit log entries (faster, cheaper)
```

## Options

- `--output <path>`: Save the Markdown report to a file
- `--canvas`: Save an HTML report to `~/.openclaw/canvas/diagnostics.html` for browser viewing
- `--json`: Output result as structured JSON (includes raw context and report)
- `--model <id>`: Override the model used for analysis (default: user's configured primary model)
- `--max-log-entries <n>`: Maximum WARN/ERROR/FATAL log entries to include (default: 200)

## What gets analyzed

The diagnostic context includes six sections, assembled automatically:

1. **Gateway log** — today's WARN/ERROR/FATAL entries, capped to fit the model's token limit
2. **Configuration** — `openclaw.json` with secrets redacted
3. **Health data** — `health.json` from the workspace watchdog
4. **Version** — installed OpenClaw version
5. **Auth events** — count and IP summary of authentication rejections
6. **System memory** — RAM and platform info at time of analysis

## Report structure

The AI model produces a structured Markdown report with:

- **Executive Summary** — one-paragraph health assessment plus an alphabetically enumerated list of every issue found
- **Findings** — one subsection per issue with: what it means, relevant log entries with timestamps, likely root cause, and recommended fix

## Canvas output

When `--canvas` is used, the report is also saved as a self-contained HTML page at
`~/.openclaw/canvas/diagnostics.html`. This page includes a dark-theme stylesheet
and can be viewed in any browser. If the gateway is running, it is also accessible
via the Control UI's canvas serving mechanism.

## Notes

- The gateway must be running for the AI analysis (the command uses the gateway's
  model routing). If the gateway is down, use `--json` to get the raw diagnostic
  context and feed it to your own LLM.
- The command reads log files directly from disk, so log data is available even
  when the gateway is unresponsive.
- Secrets in `openclaw.json` (API keys, tokens, passwords) are replaced with
  `[REDACTED]` before being sent to the model.
- Use `--max-log-entries` to reduce token usage and cost when a full log scan
  is not needed.
