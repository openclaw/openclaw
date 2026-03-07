# ADS_TESTING_SYSTEM.md — Controlled Experiment Engine

## 0) Principle

Ads are experiments, not autonomous spend systems.

---

## 1) Initial Mode

```
READ_ONLY = true
```

System only ingests:

```
CTR
CPC
Cost Per Lead
Cost Per Booked Call
```

---

## 2) Ranking Logic

Daily:

Rank creatives by:

```
cost_per_booked_call
```

Store:

```
creative_id
hook_type
visual_type
cta_type
```

---

## 3) Proposal Generation

System may propose:

- increase budget 20%
- duplicate creative
- pause underperformers

---

## 4) Execution Rules

No budget changes executed automatically.

Require approval token.
