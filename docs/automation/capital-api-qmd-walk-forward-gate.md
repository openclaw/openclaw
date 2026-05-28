# Capital QMD Walk-Forward Gate

- generatedAt: 2026-05-24T10:28:55.169Z
- status: passed
- recommendation: walk_forward_clear_paper_only
- barsPath: D:\OpenClaw\.openclaw\bars\TXF-1m.jsonl
- usedDays: 260
- rowsScanned: 1890224
- totalTestTrades: 610
- positiveFoldRate: 1
- totalTestPnlPts: 795.8644
- maxTestDrawdownPts: 108.176
- liveTradingEnabled: false
- writeBrokerOrders: false

## Folds

| Fold | Train                  | Test                   | Trades | WinRate | TestPnlPts | MaxDDPts |
| ---: | ---------------------- | ---------------------- | -----: | ------: | ---------: | -------: |
|    1 | 2020-10-26..2021-01-10 | 2021-01-11..2021-05-31 |    125 |   0.432 |    269.445 |  108.176 |
|    2 | 2020-10-26..2021-05-31 | 2021-06-04..2021-08-08 |    123 |  0.3902 |    95.4839 |  58.9222 |
|    3 | 2020-10-26..2021-08-08 | 2021-09-03..2022-01-02 |    117 |  0.4188 |    90.4836 |   49.237 |
|    4 | 2020-10-26..2022-01-02 | 2022-01-03..2022-03-05 |    120 |  0.4167 |   224.6194 |  44.3787 |
|    5 | 2020-10-26..2022-03-05 | 2022-03-06..2023-10-31 |    125 |   0.432 |   115.8325 |  38.6737 |

## Next task

walk-forward gate 已通過；下一步處理 PreTradeRiskGate / SEMI approval / latency-gap 主流程接線。
