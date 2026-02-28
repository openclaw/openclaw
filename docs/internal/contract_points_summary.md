# Contract Points Distribution Summary

This document contains aggregate statistics about contract/decision inflection points
across all OpenClaw agentic runs in the test suite.

## Overview

- **Total runs analyzed**: 28
- **Min contract points**: 0
- **Max contract points**: 0

## Percentiles

- **p50 (median)**: 0
- **p90**: 0
- **p95**: 0
- **p99**: 0

## Threshold Analysis (127 points)

- **Runs exceeding 127 points**: 0
- **Percentage exceeding 127**: 0%

## Distribution by Bucket

- **0-25**: 28 runs (100%)
- **26-50**: 0 runs (0%)
- **51-75**: 0 runs (0%)
- **76-100**: 0 runs (0%)
- **101-127**: 0 runs (0%)
- **128-150**: 0 runs (0%)
- **151-200**: 0 runs (0%)
- **201-300**: 0 runs (0%)
- **301-500**: 0 runs (0%)
- **501+**: 0 runs (0%)

## Field Reference

Contract points are calculated as the sum of all decision outcomes per run:

```
contractPointsTotal = outcomes.proceeds + outcomes.abstains + outcomes.confirms + outcomes.modifies
```

- **PROCEED**: Decision point where the router cleared the request
- **ABSTAIN_CLARIFY**: Decision point requiring clarification or routing failure
- **ABSTAIN_CONFIRM**: Decision point requiring user confirmation
- **MODIFY**: Decision point where the router modified the request
