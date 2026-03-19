---
name: skill-publish
description: "Skill Publishing Agent. Use when the user wants to publish a strategy to the server, check publish/backtest status, or view backtest report. Flow: validate → zip → publish → poll verify → get report. Supports FEP v2.0 protocol."
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
| `skill_validate`       | Validate strategy package directory locally (FEP v2.0) before zipping        |
| `skill_publish`        | POST ZIP to server; returns submissionId, backtestTaskId, and initial status |
| `skill_publish_verify` | GET publish/backtest status by submissionId or backtestTaskId                |

## API Configuration

The plugin requires configuration:

- `skillApiUrl`: Server URL (default: `https://hub.openfinclaw.ai`)
- `skillApiKey`: API key with `fch_` prefix (68 chars)

Configure via:

- Plugin config: `skillApiUrl`, `skillApiKey`
- Environment: `SKILL_API_URL`, `SKILL_API_KEY`

### ⚠️ API Key Security

**IMPORTANT: Never expose your Hub API Key!**

- The API Key (`fch_` prefix) is **only** for hub.openfinclaw.ai API authentication
- **DO NOT** commit API Keys to Git repositories or share publicly
- **DO NOT** expose real API Keys in public chats, screenshots, or code examples
- If you suspect a Key has been leaked, regenerate it immediately in Hub settings

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

## Backtest report structure (FEP v2.0)

When `backtestStatus === "completed"`:

```json
{
  "alpha": null,
  "taskId": "bt-2be0c156bfe2",
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
    "version": "1.0.0"
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
    "totalReturn": 0.22,
    "sharpe": 0.12,
    "maxDrawdown": -0.15,
    "totalTrades": 189,
    "winRate": 68.25,
    "profitFactor": 1.32,
    "sortino": 0.13,
    "annualizedReturn": 0.18,
    "calmar": 0.37,
    "returnsVolatility": 0.25,
    "riskReturnRatio": 0.88,
    "expectancy": 120.5,
    "avgWinner": 350.2,
    "avgLoser": -180.3,
    "maxWinner": 1200.0,
    "maxLoser": -450.0,
    "longRatio": 0.65,
    "pnlTotal": 22000.0,
    "startingBalance": 100000.0,
    "endingBalance": 122000.0,
    "backtestStart": "2024-01-01",
    "backtestEnd": "2024-12-31",
    "totalOrders": 378,
    "hints": ["Strategy performed well in trending markets."]
  },
  "equityCurve": [
    { "date": "2024-01-02", "equity": 100500.0 },
    { "date": "2024-01-03", "equity": 101200.0 }
  ],
  "drawdownCurve": [
    { "date": "2024-01-02", "drawdown": 0.0 },
    { "date": "2024-01-15", "drawdown": -0.05 }
  ],
  "monthlyReturns": [
    { "month": "2024-01", "return": 0.05 },
    { "month": "2024-02", "return": -0.02 }
  ],
  "trades": [
    {
      "open_date": "2024-01-15",
      "close_date": "2024-01-20",
      "side": "BUY",
      "quantity": 100.0,
      "avg_open": 250.0,
      "avg_close": 260.0,
      "realized_pnl": "+$1,000.00",
      "return_pct": 0.04
    }
  ]
}
```

### Top-level fields

| Field            | Type             | Description                               |
| ---------------- | ---------------- | ----------------------------------------- |
| `alpha`          | `number \| null` | Alpha coefficient, strategy excess return |
| `taskId`         | `string`         | Backtest task unique identifier           |
| `metadata`       | `object`         | Strategy metadata                         |
| `integrity`      | `object`         | Integrity verification info               |
| `performance`    | `object`         | Backtest performance metrics              |
| `equityCurve`    | `array`          | Equity curve data points                  |
| `drawdownCurve`  | `array`          | Drawdown curve data points                |
| `monthlyReturns` | `array`          | Monthly returns data                      |
| `trades`         | `array`          | Complete trade records                    |

### Performance fields (FEP v2.0)

#### Core Metrics

| Field          | Type     | Description                    |
| -------------- | -------- | ------------------------------ |
| `totalReturn`  | `number` | Total return (decimal)         |
| `sharpe`       | `number` | Sharpe ratio (252-day annual)  |
| `maxDrawdown`  | `number` | Maximum drawdown (negative)    |
| `totalTrades`  | `int`    | Number of complete trade round |
| `winRate`      | `number` | Win rate (percentage)          |
| `profitFactor` | `number` | Profit factor                  |

#### Return Analysis

| Field               | Type     | Description                 |
| ------------------- | -------- | --------------------------- |
| `sortino`           | `number` | Sortino ratio               |
| `annualizedReturn`  | `number` | CAGR annualized return      |
| `calmar`            | `number` | Calmar ratio (CAGR / MaxDD) |
| `returnsVolatility` | `number` | Returns volatility          |
| `riskReturnRatio`   | `number` | Risk-return ratio           |

#### Trade Analysis

| Field        | Type     | Description               |
| ------------ | -------- | ------------------------- |
| `expectancy` | `number` | Expected profit per trade |
| `avgWinner`  | `number` | Average winning trade     |
| `avgLoser`   | `number` | Average losing trade      |
| `maxWinner`  | `number` | Largest winning trade     |
| `maxLoser`   | `number` | Largest losing trade      |
| `longRatio`  | `number` | Long position ratio       |

#### Extended Metrics

| Field             | Type     | Description              |
| ----------------- | -------- | ------------------------ |
| `pnlTotal`        | `number` | Total profit/loss amount |
| `startingBalance` | `number` | Initial capital          |
| `endingBalance`   | `number` | Final capital            |
| `backtestStart`   | `string` | Backtest start date      |
| `backtestEnd`     | `string` | Backtest end date        |
| `totalOrders`     | `int`    | Total number of orders   |

### Time Series Data

#### equityCurve format

```json
[
  { "date": "2024-01-02", "equity": 100500.0 },
  { "date": "2024-01-03", "equity": 101200.0 }
]
```

#### drawdownCurve format

```json
[
  { "date": "2024-01-02", "drawdown": 0.0 },
  { "date": "2024-01-15", "drawdown": -0.05 }
]
```

#### monthlyReturns format

```json
[
  { "month": "2024-01", "return": 0.05 },
  { "month": "2024-02", "return": -0.02 }
]
```

#### trades format

| Field          | Type     | Description                |
| -------------- | -------- | -------------------------- |
| `open_date`    | `string` | Position open date         |
| `close_date`   | `string` | Position close date        |
| `side`         | `string` | Trade direction (BUY)      |
| `quantity`     | `number` | Position size              |
| `avg_open`     | `number` | Average open price         |
| `avg_close`    | `number` | Average close price        |
| `realized_pnl` | `string` | Realized P&L with currency |
| `return_pct`   | `number` | Return percentage          |

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
