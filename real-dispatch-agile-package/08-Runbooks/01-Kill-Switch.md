# Kill switch runbook

## Purpose

Immediately stop autonomous actions at one of these scopes:

- global
- tenant
- ticket/case
- incident category

## Two-layer enforcement

1. **Stop Temporal worker**
   - fastest, immediate stop to new auto actions
2. **Data-plane command denial**
   - dispatch-api rejects specific tool names/scopes even if a rogue worker exists

## Procedure

1. Toggle global pause (ops endpoint / config)
2. Stop Temporal worker deployment
3. Verify:
   - new command attempts are denied and logged
   - workflows move into safe wait states
4. Post-incident:
   - export timeline + policy decision logs + workflow histories for replay analysis
