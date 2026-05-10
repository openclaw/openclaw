# Codex auth profile mixed profiles

```yaml qa-scenario
id: auth-profile-codex-mixed-profiles
title: Codex auth profile mixed profiles
surface: runtime
coverage:
  primary:
    - runtime.codex-plugin.auth
  secondary:
    - auth-profiles.provider-selection
objective: Verify mixed openai-codex OAuth and openai API-key profile stores select the Codex OAuth profile for Codex app-server turns.
successCriteria:
  - The selected auth profile id is openai-codex:qa-oauth.
  - The openai:media-api API-key profile is present but not selected.
  - The fixture rejects the residual provider mismatch covered by issue #78499.
docsRefs:
  - docs/cli/doctor.md
codeRefs:
  - extensions/qa-lab/src/auth-profile-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for mixed-profile Codex auth selection.
  config:
    selectedProfileId: openai-codex:qa-oauth
    rejectedProfileId: openai:media-api
```

```yaml qa-flow
steps:
  - name: records mixed-profile fixture contract
    actions:
      - assert:
          expr: "config.selectedProfileId !== config.rejectedProfileId"
          message: "codex profile must not equal openai api-key profile"
    detailsExpr: "`selected=${config.selectedProfileId} rejected=${config.rejectedProfileId}`"
```
