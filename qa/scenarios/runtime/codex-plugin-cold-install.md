# Codex plugin cold install

```yaml qa-scenario
id: codex-plugin-cold-install
title: Codex plugin cold install
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.lifecycle
  secondary:
    - runtime.doctor-repair
objective: Verify a clean home that needs the Codex runtime reports a clear missing-plugin remediation, installs through doctor repair, and retries through Codex OAuth instead of OpenAI API-key auth.
successCriteria:
  - Missing Codex plugin emits the exact remediation string asserted by the fixture test.
  - Doctor repair seeds the Codex plugin before retrying the agent turn.
  - The retry uses the openai-codex OAuth profile and never routes through the openai API-key profile.
docsRefs:
  - docs/cli/doctor.md
  - docs/cli/plugins.md
  - docs/plugins/install-overrides.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin-fixture.ts
  - extensions/qa-lab/src/auth-profile-fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Phase 3 fixture contract for the cold-install lifecycle cell; parent wiring will attach this to the runtime suite.
  config:
    fixture: cold-install
    remediation: Codex plugin is required for Codex runtime. Run "openclaw doctor --fix" to install @openclaw/codex, then retry.
```

```yaml qa-flow
steps:
  - name: records cold-install fixture contract
    actions:
      - assert:
          expr: "config.fixture === 'cold-install'"
          message: "expected cold-install fixture"
    detailsExpr: "config.remediation"
```
