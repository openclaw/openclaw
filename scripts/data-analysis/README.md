# OpenClaw Data Analysis Toolkit

JSONL log parser and Pandas DataFrame utilities for analyzing OpenClaw agent telemetry.

## Setup

```bash
pip install -r requirements.txt
```

## Quick Start

```python
from openclaw_loader import load_cron_runs, load_sessions, load_session_transcript

# Load all cron job run logs into a DataFrame
df = load_cron_runs()

# Aggregate by day / model / job
from openclaw_loader import cron_daily_summary, cron_model_summary, cron_job_summary
daily = cron_daily_summary(df)
models = cron_model_summary(df)
jobs = cron_job_summary(df)

# Discover available sessions
sessions = load_sessions()

# Load a specific session transcript
transcript = load_session_transcript("session-id-here")

# Export to CSV or Parquet
from openclaw_loader import export_to_csv, export_to_parquet
export_to_csv(df, "cron_runs.csv")
export_to_parquet(df, "cron_runs.parquet")
```

## CLI Usage

```bash
# Summary of all available data
python openclaw_loader.py

# Export cron logs to CSV
python openclaw_loader.py --source cron --export-csv cron_runs.csv

# Use a custom data directory
python openclaw_loader.py --dir /path/to/.openclaw
```

## Data Sources

| Source | Path | Description |
|--------|------|-------------|
| Cron run logs | `~/.openclaw/cron/runs/*.jsonl` | Job execution telemetry |
| Session transcripts | `~/.openclaw/sessions/*.jsonl` | Agent conversation logs |

## DataFrame Schemas

### `load_cron_runs()` columns

| Column | Type | Description |
|--------|------|-------------|
| `timestamp` | datetime | UTC execution time |
| `job_id` | str | Cron job identifier |
| `status` | category | ok / error / skipped |
| `duration_ms` | float | Execution time in ms |
| `model` | str | AI model used |
| `provider` | str | API provider |
| `input_tokens` | float | Input token count |
| `output_tokens` | float | Output token count |
| `delivery_status` | category | delivered / not-delivered / not-requested |

### `load_session_transcript()` columns

| Column | Type | Description |
|--------|------|-------------|
| `timestamp` | datetime | Message time |
| `role` | str | user / assistant |
| `tokens_input` | float | Input tokens for this turn |
| `tokens_output` | float | Output tokens for this turn |
| `model` | str | Model used |
| `tool_names` | list | Tools called in this turn |
| `duration_ms` | float | Response latency |
