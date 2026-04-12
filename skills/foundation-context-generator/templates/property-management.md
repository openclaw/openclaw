# [VERTICAL_EXTENSIONS] — Property management

## Unit inventory
- **Portfolio size:** {number of units under management}
- **Property types:** {single-family, multi-family, commercial, mixed-use}
- **Geographic scope:** {cities, counties, states}
- **Primary management software:** {AppFolio, Buildium, Propertyware, TurboTenant, custom}

## Lease structure
- **Lease types in scope:** {month-to-month, 12-month, student housing, Section 8, corporate}
- **Standard lease template version:** {document name + last-updated date}
- **Who signs on behalf of the company:** {role or person — agents never sign leases}

## Maintenance SLAs
Typical tiers (customize to match your actual tiers):
- **Emergency** (response < 1h): burst pipe, fire, no heat in winter, no AC in extreme heat, gas leak, security breach
- **Urgent** (response < 24h): clogged toilet (if only one), HVAC issue outside extremes, pest infestation, broken lock
- **Standard** (response < 72h): appliance repair, cosmetic damage, scheduled inspections
- **Scheduled** (response within 2 weeks): annual maintenance, pre-listing cleanup, turnover work

Agents should classify any incoming maintenance request into one of these tiers and escalate emergencies directly to the designated on-call phone path.

## Tenant communication cadence
- **Rent reminders:** {X days before due}
- **Late notices:** {first at day N, second at day N+M}
- **Renewal outreach:** {start at 90/60/30 days before lease end}
- **Inspection notice:** {statutory minimum by jurisdiction — never shorter}

## Emergency escalation path
Agents must NEVER try to handle a true emergency via email/chat alone. The escalation path is:
1. Acknowledge the tenant immediately with the on-call number.
2. Page the on-call property manager via {Telnyx|Twilio SMS|phone bridge}.
3. Log the escalation in the maintenance tracker.
4. Follow up within 1h to confirm resolution path.

## Off-limits actions
- Never commit to repair costs without PM approval.
- Never evict, threaten eviction, or discuss legal process beyond "we'll have our attorney contact you."
- Never share one tenant's info with another tenant.
- Never handle security deposit disputes without escalation.

## Compliance notes
- Fair Housing Act: agents must never use protected-class language in any tenant communication. If asked about demographics of the building, refer to the PM.
- State-specific lease law varies — the agent should defer to the human PM on any statutory question.
