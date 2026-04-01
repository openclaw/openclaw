# Base Plan Templates

## PT-001: Market Research

**Applicable Goals:** Understand market, competitive analysis, market sizing
**Success Rate:** 78%

### Steps

1. Define research questions and scope (primitive)
2. Gather secondary research — web search, industry reports (primitive)
3. Identify competitors and substitutes (primitive)
4. Analyze pricing, positioning, differentiation (primitive)
5. Synthesize findings into report (primitive)
6. Present recommendations to CEO agent (primitive)

---

## PT-002: Financial Health Check

**Applicable Goals:** Cash flow assessment, runway calculation, budget review
**Success Rate:** 92%

### Steps

1. Gather current financial data (primitive)
2. Calculate cash runway (primitive)
3. Analyze burn rate trends (primitive)
4. Review budget vs actuals (compound → per-department)
5. Identify cost reduction opportunities (primitive)
6. Generate financial health report (primitive)
7. Escalate if runway < 6 months (decision point)

---

## PT-003: New Hire Onboarding (Freelancer)

**Applicable Goals:** Engage freelancer, onboard contractor
**Success Rate:** 85%

### Steps

1. Define work package scope and deliverables (primitive)
2. Set budget and timeline (primitive)
3. Source candidates — network, platforms (compound)
4. Evaluate candidates — portfolio, references (primitive)
5. Draft contract with legal agent (primitive)
6. Execute contract and NDA (primitive → decision_request if > threshold)
7. Create workspace access and documentation (primitive)
8. Kickoff meeting and expectations alignment (primitive)

---

## PT-004: Monthly Operations Review

**Applicable Goals:** Performance review, KPI tracking, process improvement
**Success Rate:** 88%

### Steps

1. Collect KPIs from all agents (primitive → agent_message QUERY to each)
2. Aggregate metrics (primitive)
3. Compare vs targets and previous period (primitive)
4. Identify anomalies and trends (primitive)
5. Draft improvement recommendations (primitive)
6. Present to CEO for strategic decisions (primitive → decision_request if needed)

---

## PT-005: Strategic Decision Framework

**Applicable Goals:** Major strategic decisions, pivots, expansions
**Success Rate:** 71%

### Steps

1. Frame the decision — criteria, constraints, timeline (primitive)
2. Gather data from relevant agents (compound)
3. Apply reasoning methods — causal, bayesian, game theory (primitive)
4. Generate options with impact analysis (primitive)
5. Check for analogous cases in CBR (primitive → cbr_retrieve)
6. Stakeholder escalation with recommendation (primitive → decision_request)
