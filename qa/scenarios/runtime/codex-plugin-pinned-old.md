# Codex plugin pinned old

```yaml qa-scenario
id: codex-plugin-pinned-old
title: Codex plugin pinned old
surface: runtime
coverage:
  primary:
    - runtime.codex-plugin.version
objective: Verify a Codex plugin pinned behind the OpenClaw host version fails closed with a precise update remediation.
successCriteria:
  - The lifecycle fixture detects the plugin version is older than the host version.
  - The failure remediation points to openclaw plugins update codex or unpinning the plugin, then rerunning doctor.
  - The remediation string is asserted literally by the Phase 3 test.
docsRefs:
  - docs/cli/plugins.md
  - docs/cli/update.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for pinned-old Codex plugin mismatch.
  config:
    pluginVersion: 2026.5.9-beta.1
    hostVersion: 2026.5.10-beta.1
    pluginRelation: older
```

```yaml qa-flow
steps:
  - name: records pinned-old fixture contract
    actions:
      - assert:
          expr: "config.pluginRelation === 'older'"
          message: "expected plugin version to be older than host"
    detailsExpr: "`plugin=${config.pluginVersion} host=${config.hostVersion}`"
```
