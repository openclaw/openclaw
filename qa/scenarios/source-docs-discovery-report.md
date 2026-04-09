# Source and docs discovery report

```yaml qa-scenario
id: source-docs-discovery-report
title: Source and docs discovery report
surface: discovery
objective: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
successCriteria:
  - Agent reads docs and source before proposing more tests.
  - Agent identifies extra candidate scenarios beyond the seed list.
  - Agent ends with a worked or failed QA report.
docsRefs:
  - docs/help/testing.md
  - docs/web/dashboard.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/report.ts
  - extensions/qa-lab/src/self-check.ts
  - src/agents/system-prompt.ts
execution:
  kind: flow
  summary: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
  config:
    requiredFiles:
      - repo/qa/scenarios/index.md
      - repo/extensions/qa-lab/src/suite.ts
      - repo/docs/help/testing.md
    prompt: Read the seeded docs and source plan. The full repo is mounted under ./repo/. Explicitly inspect repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md, then report grouped into Worked, Failed, Blocked, and Follow-up. Mention at least two extra QA scenarios beyond the seed list.
```

```yaml qa-flow
steps:
  - name: reads seeded material and emits a protocol report
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:discovery
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && hasDiscoveryLabels(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "!reportsMissingDiscoveryFiles(outbound.text)"
          message:
            expr: "`discovery report still missed repo files: ${outbound.text}`"
      - assert:
          expr: "!reportsDiscoveryScopeLeak(outbound.text)"
          message:
            expr: "`discovery report drifted beyond scope: ${outbound.text}`"
    detailsExpr: outbound.text
```
