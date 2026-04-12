# [VERTICAL_EXTENSIONS] — Generic business

Use this template when the tenant's vertical isn't covered by a specific template yet. The generic template is deliberately light — it asks the interviewer to pull out just the universally-useful constraints without trying to cover industry specifics.

## Business category
- **Industry:** {self-describe in the tenant's own words}
- **Business model:** {B2B subscription, B2C product, marketplace, services-as-a-product, etc.}
- **Revenue stage:** {pre-revenue | early / sub-$1M ARR | growth / $1–10M ARR | scale / $10M+}

## Audience
- **Who buys the product:** {persona or role}
- **Who uses the product:** {same as buyer? different?}
- **Geographic scope:** {local, regional, national, global}

## Operating rhythms
- **Customer-facing cadence:** {how often does the team communicate with customers — daily, weekly, monthly, on-demand?}
- **Internal standup / review cadence:** {weekly standups, monthly retros, quarterly planning}
- **Peak seasons / quiet seasons:** {if any}

## Risk posture
- **Customer-facing content risk:** {low | medium | high}
- **Financial action risk:** {can the agent initiate payments, generate invoices, send quotes? If yes, what's the approval threshold?}
- **Data sensitivity:** {PII? PHI? financial? intellectual property? none?}

## Common off-limits zones (customize as needed)
Agents in this tenant generally SHOULD NOT:
- Make binding commitments on pricing, delivery dates, or scope without human approval.
- Share confidential business metrics externally without explicit approval.
- Produce content that disparages competitors by name.
- Predict future financial outcomes with false confidence.
- Use the company name in a way that could mislead about the nature of the business.

## Suggested next step
If you're running this template, your next move is to add a vertical-specific template for your industry. Copy `generic.md`, rename it to `your-vertical.md`, and fill in the sections that matter most for your operational context. Then set `vertical: your-vertical` on the next `/foundation` run.
