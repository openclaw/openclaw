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

## Visibility Warning (IMPORTANT)

Before publishing, **always check** `identity.visibility` in the strategy's `fep.yaml`:

| Visibility | Behavior                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`   | Strategy will be uploaded to **https://hub.openfinclaw.ai** and made **publicly visible**. Community members can view, fork, and evolve the strategy. |
| `private`  | Strategy is stored privately; only the owner can access it.                                                                                           |
| `unlisted` | Strategy is accessible via direct link but not listed in public galleries.                                                                            |

**If `visibility: public` is detected:**

1. **Warn the user** before proceeding:

   > ⚠️ 该策略将上传到 **https://hub.openfinclaw.ai** 并设为**公开**。社区成员可以查看、fork 和进化您的策略。如果您希望保持私有，请将 `fep.yaml` 中的 `identity.visibility` 改为 `private`。

2. **Wait for user confirmation** before zipping/publishing.

3. If user wants private: instruct them to update `fep.yaml`:
   ```yaml
   identity:
     visibility: private # change from public to private
   ```

## Recommended flow

1. **Validate first**: For a **directory** (not yet zipped), use `skill_validate` with `dirPath` first. Only proceed when `valid: true`.
2. **Check visibility**: Before zipping, read the `fep.yaml` and check `identity.visibility`:
   - If `visibility: public`: **MUST warn user** that the strategy will be uploaded to **https://hub.openfinclaw.ai** and made **publicly visible** for community evolution/forking. Ask if they want to change to `visibility: private` instead.
   - If `visibility: private` or `unlisted`: Proceed without warning.
3. **Create ZIP**: Zip the directory (e.g. `zip -r ../skill.zip fep.yaml scripts/`). The ZIP must contain `fep.yaml` at root.
4. **Publish**: Use `skill_publish` with the ZIP `filePath`. The server will:
   - Parse `fep.yaml`
   - Auto-increment version if exists
   - Run automatic backtest
   - Return `submissionId` and `backtestTaskId`
5. **Poll verify**: Use `skill_publish_verify` with `submissionId` or `backtestTaskId`. Repeat until `backtestStatus` is:
   - `completed` — Success, `backtestReport` contains full results
   - `failed` — Backtest failed
   - `rejected` — Strategy rejected
6. **Get report**: When `backtestStatus === "completed"`, the response includes full `backtestReport` with performance, equity_curve, trade_journal.

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
  "alpha": null,
  "task_id": "bt-2be0c156bfe2",
  "metadata": {
    "id": "tsla-simple-test",
    "name": "TSLA Simple Test Strategy",
    "tags": ["tsla", "simple", "test"],
    "type": "strategy",
    "style": "trend",
    "author": { "name": "OpenFinClaw" },
    "market": "US",
    "license": "MIT",
    "summary": "Simple TSLA strategy for testing",
    "version": "1.0.0",
    "archetype": "systematic",
    "frequency": "daily",
    "riskLevel": "moderate",
    "visibility": "private",
    "description": "A simple trend following strategy for TSLA",
    "assetClasses": ["equity"],
    "parameters": [
      {
        "name": "sma_period",
        "type": "integer",
        "label": "SMA周期",
        "default": 20,
        "range": { "min": 10, "max": 50 }
      }
    ]
  },
  "integrity": {
    "fepHash": "sha256:...",
    "codeHash": "sha256:...",
    "contentCID": "Qm...",
    "contentHash": "sha256:...",
    "publishedAt": "2026-03-12T10:18:28.782727+00:00",
    "timestampProof": "..."
  },
  "performance": {
    "hints": ["Insufficient data: 1/435 periods (0%) had no market data."],
    "calmar": 0.37,
    "sharpe": 0.12,
    "sortino": 0.13,
    "winRate": 68.25,
    "finalEquity": 100216.37,
    "maxDrawdown": 0.49,
    "totalReturn": 0.22,
    "totalTrades": 189,
    "profitFactor": 1.32,
    "maxDrawdownStart": "349",
    "maxDrawdownEnd": "426",
    "monthlyReturns": { "2025-01": 0, "2025-02": 0 },
    "annualizedReturn": 0.18,
    "recentValidation": {
      "decay": {
        "sharpeDecay30d": 15.17,
        "sharpeDecay90d": 6.25,
        "warning": "30d Sharpe decay 1517% exceeds 50% threshold"
      },
      "recent": [{ "period": "2026-02-10 ~ 2026-03-12", "window": "30d", "sharpe": -1.76 }],
      "historical": { "period": "2025-01-01 ~ 2026-03-11", "sharpe": 0.12 }
    }
  },
  "equity_curve": null,
  "trade_journal": null
}
```

### Report fields

#### Top-level fields

| Field           | Type             | Description                               |
| --------------- | ---------------- | ----------------------------------------- |
| `alpha`         | `number \| null` | Alpha coefficient, strategy excess return |
| `task_id`       | `string`         | Backtest task unique identifier           |
| `metadata`      | `object`         | Strategy metadata (see below)             |
| `integrity`     | `object`         | Integrity verification info (see below)   |
| `performance`   | `object`         | Backtest performance metrics (see below)  |
| `equity_curve`  | `array \| null`  | Equity curve data points                  |
| `trade_journal` | `array \| null`  | Trade journal records                     |

#### metadata fields

| Field          | Type       | Description                          |
| -------------- | ---------- | ------------------------------------ |
| `id`           | `string`   | Strategy unique identifier           |
| `name`         | `string`   | Strategy name                        |
| `tags`         | `string[]` | Strategy tags                        |
| `type`         | `string`   | Strategy type (strategy/indicator)   |
| `style`        | `string`   | Strategy style                       |
| `author`       | `object`   | Author info `{ name: string }`       |
| `market`       | `string`   | Target market (US/CN/HK etc.)        |
| `license`      | `string`   | License type                         |
| `summary`      | `string`   | Strategy summary                     |
| `version`      | `string`   | Version number                       |
| `archetype`    | `string`   | Architecture type                    |
| `frequency`    | `string`   | Trading frequency                    |
| `riskLevel`    | `string`   | Risk level                           |
| `visibility`   | `string`   | Visibility (public/private/unlisted) |
| `description`  | `string`   | Detailed description                 |
| `assetClasses` | `string[]` | Asset classes                        |
| `parameters`   | `object[]` | Strategy parameter definitions       |

#### integrity fields

| Field            | Type     | Description                           |
| ---------------- | -------- | ------------------------------------- |
| `fepHash`        | `string` | FEP file SHA256 hash                  |
| `codeHash`       | `string` | Code file SHA256 hash                 |
| `contentCID`     | `string` | IPFS content CID                      |
| `contentHash`    | `string` | Full content SHA256 hash              |
| `publishedAt`    | `string` | Publish timestamp (ISO 8601)          |
| `timestampProof` | `string` | Timestamp proof (blockchain anchored) |

#### performance fields

| Field              | Type       | Description                                     |
| ------------------ | ---------- | ----------------------------------------------- |
| `hints`            | `string[]` | Backtest hints/warnings                         |
| `calmar`           | `number`   | Calmar ratio (annualized return / max drawdown) |
| `sharpe`           | `number`   | Sharpe ratio                                    |
| `sortino`          | `number`   | Sortino ratio                                   |
| `winRate`          | `number`   | Win rate (percentage)                           |
| `finalEquity`      | `number`   | Final equity                                    |
| `maxDrawdown`      | `number`   | Maximum drawdown (decimal)                      |
| `totalReturn`      | `number`   | Total return (decimal)                          |
| `totalTrades`      | `number`   | Total number of trades                          |
| `profitFactor`     | `number`   | Profit factor                                   |
| `maxDrawdownStart` | `string`   | Max drawdown start position (bar index)         |
| `maxDrawdownEnd`   | `string`   | Max drawdown end position (bar index)           |
| `monthlyReturns`   | `object`   | Monthly returns `{ "YYYY-MM": number }`         |
| `annualizedReturn` | `number`   | Annualized return                               |
| `recentValidation` | `object`   | Recent validation analysis (see below)          |

#### recentValidation fields

| Field                  | Type       | Description                              |
| ---------------------- | ---------- | ---------------------------------------- |
| `decay`                | `object`   | Strategy decay analysis                  |
| `decay.sharpeDecay30d` | `number`   | 30-day Sharpe decay percentage           |
| `decay.sharpeDecay90d` | `number`   | 90-day Sharpe decay percentage           |
| `decay.warning`        | `string`   | Decay warning message                    |
| `recent`               | `object[]` | Recent window backtest results (30d/90d) |
| `historical`           | `object`   | Historical full backtest results         |

## Post-publish guidance

After the strategy is successfully published and backtest completed, inform the user:

> ✅ 策略发布成功！请访问 **https://hub.openfinclaw.ai/en/dashboard/entries** 查看策略详情和回测报告。

**Do NOT** provide strategy-specific URLs like `https://hub.openfinclaw.ai/en/strategy/{entryId}`. Always direct users to the dashboard entries page.

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
