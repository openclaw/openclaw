# Codex plugin pinned new

```yaml qa-scenario
id: codex-plugin-pinned-new
title: Codex plugin pinned new
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.version
objective: Verify a Codex plugin pinned ahead of the OpenClaw host version fails closed with a precise host-upgrade remediation.
successCriteria:
  - The lifecycle fixture detects the plugin version is newer than the host version.
  - The failure remediation points to upgrading OpenClaw or installing a Codex plugin pinned to the host version.
  - The remediation string is asserted literally by the Phase 3 test.
docsRefs:
  - docs/cli/plugins.md
  - docs/cli/update.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for pinned-new Codex plugin mismatch.
  config:
    pluginVersion: 2026.5.11-beta.1
    hostVersion: 2026.5.10-beta.1
    pluginRelation: newer
```

```yaml qa-flow
steps:
  - name: records pinned-new fixture contract
    actions:
      - assert:
          expr: "config.pluginRelation === 'newer'"
          message: "expected plugin version to be newer than host"
    detailsExpr: "`plugin=${config.pluginVersion} host=${config.hostVersion}`"
```
