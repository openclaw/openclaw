---
name: skill-publish
description: "Skill Publishing Agent. Use when the user wants to publish a strategy to the server, check publish/backtest status, or view backtest report. Flow: validate → zip → publish → poll verify → get report."
metadata: { "openclaw": { "requires": { "extensions": ["openfinclaw"] } } }
---

# Skill Publishing

When the user talks about **publishing a strategy**, **submitting a skill**, **checking backtest status**, or **viewing backtest report**, use the skill publishing tools. The server automatically runs backtest after publishing.

## When to trigger

- User says: 发布策略、发布 Skill、上传策略、提交策略
- User asks: 回测状态、发布状态、回测结果、回测报告
- User wants: 发布到服务器、查看发布结果

## Recommended flow

1. **Validate first**: For a **directory** (not yet zipped), use `skill_validate` with `dirPath` first. Only proceed when `valid: true`.
2. **Create ZIP**: Zip the directory (e.g. `zip -r ../skill.zip fep.yaml scripts/`). The ZIP must contain `fep.yaml` at root.
3. **Publish**: Use `skill_publish` with the ZIP `filePath`. The server will:
   - Parse `fep.yaml`
   - Auto-increment version if exists
   - Run automatic backtest
   - Return `submissionId` and `backtestTaskId`
4. **Poll verify**: Use `skill_publish_verify` with `submissionId` or `backtestTaskId`. Repeat until `backtestStatus` is:
   - `completed` — Success, `backtestReport` contains full results
   - `failed` — Backtest failed
   - `rejected` — Strategy rejected
5. **Get report**: When `backtestStatus === "completed"`, the response includes full `backtestReport` with performance, equity_curve, trade_journal.

## Tools

| Tool                   | Purpose                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `skill_validate`       | Validate strategy package directory locally (fep v1.2) before zipping        |
| `skill_publish`        | POST ZIP to server; returns submissionId, backtestTaskId, and initial status |
| `skill_publish_verify` | GET publish/backtest status by submissionId or backtestTaskId                |

## API Configuration

The plugin requires configuration:

- `skillApiUrl`: Server URL (default: `https://hub.openfinclaw.ai`)
- `skillApiKey`: API key with `fch_` prefix (68 chars)

Configure via:

- Plugin config: `skillApiUrl`, `skillApiKey`
- Environment: `SKILL_API_URL`, `SKILL_API_KEY`

## Response fields

### skill_publish response

| Field            | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| `slug`           | Strategy unique identifier (from fep identity.id)                      |
| `entryId`        | Strategy entry UUID                                                    |
| `version`        | Published version (may be auto-incremented)                            |
| `status`         | Combined publish+backtest status                                       |
| `submissionId`   | Submission ID for verify endpoint                                      |
| `backtestTaskId` | Backtest task ID for verify endpoint                                   |
| `backtestStatus` | Backtest status: submitted/queued/processing/completed/failed/rejected |
| `backtestReport` | Full report when backtest completed                                    |

### skill_publish_verify response

| Field                | Description                     |
| -------------------- | ------------------------------- |
| `strategyUploaded`   | Strategy saved to database      |
| `backtestCompleted`  | Backtest reached terminal state |
| `backtestReportInDb` | Full report saved to database   |
| `backtestReport`     | Complete report when completed  |

## Backtest report structure

When `backtestStatus === "completed"`:

```json
{
  "task_id": "bt-xxx",
  "performance": {
    "totalReturn": -0.2391,
    "sharpe": -1.63,
    "maxDrawdown": 0.45,
    "winRate": 0.42,
    "profitFactor": 0.85,
    "totalTrades": 156,
    "finalEquity": 7609.00,
    "monthlyReturns": { "2024-01": -0.05, ... }
  },
  "integrity": { ... },
  "equity_curve": [ ... ],
  "trade_journal": [ ... ]
}
```

## Example workflow

```
User: 发布我的策略到服务器
Agent:
1. skill_validate(dirPath: "/path/to/strategy")
   → valid: true
2. [zip directory]
3. skill_publish(filePath: "/path/to/skill.zip")
   → submissionId: "abc-123", backtestTaskId: "bt-xyz", status: "pending"
4. skill_publish_verify(submissionId: "abc-123")
   → backtestStatus: "processing" (poll again)
5. skill_publish_verify(submissionId: "abc-123")
   → backtestStatus: "completed", backtestReport: { ... }
```
