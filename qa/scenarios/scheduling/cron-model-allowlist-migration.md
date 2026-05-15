# Cron model allowlist migration

```yaml qa-scenario
id: cron-model-allowlist-migration
title: Cron model allowlist migration
surface: scheduling
runtimeParityTier: live-only
coverage:
  primary:
    - runtime.gateway-log-sentinel.cron-model-allowlist
  secondary:
    - cron.model-migration
    - doctor.model-validation
objective: Fail live proof when stale cron payload models hit runtime model allowlist failures instead of being migrated, repaired, or rejected by validation.
successCriteria:
  - Cron inventory can be listed.
  - No cron job payload still references the stale beta model used in the May 13 failure.
  - Gateway logs contain no cron model allowlist sentinel.
docsRefs:
  - extensions/qa-lab/transport-parity-gate.md
  - docs/cron.md
codeRefs:
  - extensions/qa-lab/src/gateway-log-sentinel.ts
  - src/cron
execution:
  kind: flow
  summary: Inspect cron state and logs for stale model allowlist failures.
  config:
    staleModel: openai/gpt-5.4
```

```yaml qa-flow
steps:
  - name: catches stale cron model allowlist failures
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - set: cronJobs
        value:
          expr: await listCronJobs(env)
      - set: staleJobs
        value:
          expr: "cronJobs.filter((job) => JSON.stringify(job).includes(config.staleModel))"
      - assert:
          expr: staleJobs.length === 0
          message:
            expr: "`cron payloads still reference stale model ${config.staleModel}: ${JSON.stringify(staleJobs)}`"
      - call: assertNoGatewayLogSentinels
        args:
          - since: 0
            kinds:
              - cron-model-allowlist
    detailsExpr: "`checked ${cronJobs.length} cron jobs for stale model ${config.staleModel}`"
```
