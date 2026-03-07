# Ads Testing Framework

## Principles
1. **Staged batches** — never launch everything at once
2. **Read-only first** — pull metrics before making changes
3. **Human approval required** — all spend changes need explicit approval
4. **Dry-run by default** — the engine proposes, you approve

## Testing Workflow

### Step 1: Generate Creative Variants
- Agent proposes hook_type + format combinations
- Worker generates scripts/specs
- Human reviews and approves for rendering

### Step 2: Render & Package
- Worker renders video/image assets
- Worker packages into delivery-ready formats
- QA review before upload

### Step 3: Controlled Launch
- Upload creatives as drafts (not active)
- Human approves and activates
- Start with small daily budget ($5-10 per creative)

### Step 4: Evaluate (Daily)
- Pull metrics at EOD
- Compute: CTR, CPC, CPL, cost per booked call, CPA
- Engine produces promote/kill/iterate decisions

### Step 5: Act on Decisions
- **Promote**: Increase budget (requires human approval above $25)
- **Kill**: Pause underperforming creatives
- **Iterate**: Generate new variants from winners

## Evaluation Rules

### Promote Criteria
- CTR > 2.0% AND CPC < $2.00
- Confidence threshold: 0.8

### Kill Criteria
- Impressions > 500 AND CTR < 0.5%
- Confidence threshold: 0.7

### Iterate Criteria
- Everything else (moderate performance)
- Confidence threshold: 0.5

## Spend Safety Rules
| Rule | Value |
|------|-------|
| Max daily budget (total) | $100 |
| Max per experiment | $50 |
| Max active experiments | 5 |
| Human approval threshold | $25 |
| Dry run by default | Yes |

## KPI Review Cadence
- **Daily**: Automated metrics pull + AI evaluation
- **Weekly**: Human review of all active experiments
- **Monthly**: Full funnel performance review
