# Capital 1000-run Simulation Sweep

- generatedAt: 2026-05-21T04:06:20.302Z
- status: pass_with_findings
- runs: 1000
- symbol: TX00AM
- intents: 8
- quoteFreshAllowed: true
- liveTradingEnabled: false
- writeBrokerOrders: false
- stressRiskEnforced: true
- maxAllowedSimulationP95DrawdownPts: 500
- requireWalkForwardBeforeLivePromotion: true
- recommendation: paper_only_risk_gates_enforced

## Summary

- positiveRunRate: 0.805
- losingRunRate: 0.195
- pnl p05/p50/p95: -438.2383 / 540.1433 / 1633.2562
- maxDrawdown p95/max: 598.1083 / 818.0378
- fillRate mean/p05: 0.8516 / 0.625
- winRate mean/p05: 0.4817 / 0.1429

## Fix Now

|   # | Priority | Item                                  | Reason                |
| --: | -------- | ------------------------------------- | --------------------- |
|   1 | none     | no immediate code fix from simulation | keep paper-only gates |

## Add Features

|   # | Priority | Item                                       | Reason                                                                                              |
| --: | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
|   1 | high     | walk-forward / QMD replay sample expansion | current signal sample is only 8; 1000-run perturbation is useful but not enough for live promotion. |

## Verification Notes

|   # | Priority | Item                                        | Reason                                                                                       |
| --: | -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
|   1 | medium   | stale symbols stay blocked                  | stale=TX05AM; this is correct runtime blocking, not a price fallback target.                 |
|   2 | high     | risk throttle live blocker enforced         | p05 pnl is -438.2383 pts; live promotion is blocked by capital-paper-hft-risk-controls.json. |
|   3 | high     | max drawdown live blocker enforced          | p95 max drawdown is 598.1083 pts > limit 500; live promotion is blocked.                     |
|   4 | high     | walk-forward required before live promotion | QMD/walk-forward replay is explicitly required before any live promotion.                    |

## Safety

- No live order was sent.
- Broker write path remains disabled.
- This report is paper/simulation only.
