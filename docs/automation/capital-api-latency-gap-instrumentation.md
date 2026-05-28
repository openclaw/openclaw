# Capital latency / gap instrumentation

- generatedAt: 2026-05-21T07:22:55.109Z
- status: passed
- capitalRoot: D:\群益及元大API\CapitalHftService
- liveTradingEnabled: false
- writeBrokerOrders: false
- sentOrder: false

## Static wiring

| check                           | status |
| ------------------------------- | ------ |
| latencyMonitorClassPresent      | OK     |
| latencyHelpersPresent           | OK     |
| strategyRunnerLatencyLinked     | OK     |
| latencyApiStages                | OK     |
| tickToSignalRecordedOnBothFeeds | OK     |
| signalToOrderRecorded           | OK     |
| orderRoundTripRecorded          | OK     |
| gapDetectorClassPresent         | OK     |
| lastPriceFeedsGapDetector       | OK     |
| preTradeRiskBlocksGapPause      | OK     |

## Runtime evidence

- latestSignalAt: 2026-05-21T14:49:12.3297917+08:00
- signalTailCount: 1331
- paperOrderTailCount: 1331
- serviceStatus: running

## Result

Latency/GAP instrumentation is wired and broker write remains disabled.
