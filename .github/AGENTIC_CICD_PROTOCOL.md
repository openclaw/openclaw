# Agentic CI/CD Protocol

> Designed by Kelsey Hightower x Vitalik Buterin mental models
> For Cruz's One Soul agentic system

## Architecture

```
Cruz (L2/L3 supervisor — on top of loop, not inside)
  |
  v
Reputation-Weighted Consensus (agent voting)
  |
  v
GitHub Actions CI (verification layer)
  |
  v
Sentinel (continuous health monitor)
  |
  v
Auto-merge / Auto-revert
```

## Levels

### L0 — Full Auto (zero human)

| Attribute | Value |
|-----------|-------|
| Trigger | lint fix, dep bump, data JSON update, doc update |
| Flow | Agent PR -> CI green -> Sentinel health OK -> auto-merge |
| Time limit | < 5 min |
| Rollback | Auto-revert if post-merge Sentinel red |
| Examples | BioCorpus data refresh, cafe dialogue pool expansion, dependency patch |

**Safe path criteria:**
- Only modifies: `*.json`, `*.md`, `*.css`, lint/format fixes
- No changes to: workflows, secrets, env, auth, payment, API routes
- PR author is a known agent (bot label or allow-listed username)
- CI passes all checks
- Diff < 500 lines

### L1 — Consensus Auto (multi-agent vote + observation period)

| Attribute | Value |
|-----------|-------|
| Trigger | Feature changes, new agent skills, config changes |
| Flow | Agent A proposes -> Agent B reviews + votes -> Agent C signs -> 4hr observation -> merge |
| Time limit | < 8 hr |
| Rollback | Auto-revert if Sentinel reports anomaly during observation |
| Examples | Andrew adds new risk rule, new TG bridge skill |

**Consensus rules:**
- Minimum 2/3 agent approval
- Agent vote weight = historical accuracy (reputation-weighted)
- 4hr observation window (Cruz can veto anytime)
- Sentinel must stay green throughout

### L2 — Human Confirm (high risk)

| Attribute | Value |
|-----------|-------|
| Trigger | API changes, payment/billing, third-party integrations |
| Flow | Multi-agent review -> Cruz explicit approve -> 24hr cooldown -> deploy |
| Time limit | 24 hr |
| Rollback | Manual or Cruz-triggered |
| Examples | Stripe integration, Supabase RLS policy change |

### L3 — Irreversible (multi-sig)

| Attribute | Value |
|-----------|-------|
| Trigger | Data deletion, permission changes, contract modifications, prod destructive ops |
| Flow | 3 agent signatures + Cruz signature + 72hr cooling period -> execute |
| Time limit | 72 hr |
| Rollback | Not possible (by definition) |
| Examples | TG bot admin upgrade, database migration, secret rotation |

## Safety Mechanisms

1. **Sentinel health gate** — Every auto-merge checks Sentinel status first
2. **Blast radius scoring** — Each PR gets a risk score based on files changed
3. **Reputation decay** — Agent vote weight decays if unused for 30 days
4. **Emergency brake** — Cruz can freeze all L0/L1 with one command
5. **Audit trail** — Every agent action logged to `.github/agent-audit.jsonl`

## Implementation Roadmap

- [x] L0 workflow: `.github/workflows/agent-automerge.yml`
- [ ] Sentinel health API endpoint (for CI to query)
- [ ] Agent identity system (bot labels, allow-listed authors)
- [ ] L1 consensus mechanism (multi-agent review bot)
- [ ] Reputation scoring system
- [ ] Emergency freeze command

---

*"Make L0 boringly stable for 30 days before adding L1." — Kelsey*
*"Leave a meta-layer so the system can modify its own rules." — Vitalik*
