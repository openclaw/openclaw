# Incident Response Workflow
# Structured incident detection, analysis, and resolution

name: incident-response
version: "1.0.0"
description: Structured incident response workflow

trigger:
  type: webhook
  path: /plugins/webhooks/incident
  secret:
    source: env
    id: INCIDENT_WEBHOOK_SECRET

steps:
  - id: assess_severity
    agent: mythos-prime
    prompt: |
      Assess the incident severity and scope:

      Report: {{payload.incident_description}}
      Time: {{payload.timestamp}}
      Reporter: {{payload.reporter}}
      Affected System: {{payload.system}}

      Determine:
      - Severity: P1 (critical) / P2 (high) / P3 (medium) / P4 (low)
      - Scope: single user / multiple users / system-wide
      - Impact: data loss / service outage / degraded performance / security breach
      - Urgency: immediate / within 1 hour / within 24 hours

      Respond with JSON assessment.
    depends_on: []
    model: anthropic/claude-opus-4-7

  - id: gather_diagnostics
    agent: mythos-ops
    prompt: |
      Gather diagnostic information for the incident:

      Severity: {{steps.assess_severity.output.severity}}
      System: {{payload.system}}

      Run:
      1. `openclaw doctor --deep` for gateway health
      2. Check recent logs: `openclaw logs --since 1h --level error`
      3. Check system resources (CPU, memory, disk)
      4. Check network connectivity
      5. Check recent deployments or config changes

      Return structured diagnostic report.
    depends_on: [assess_severity]
    tools: [exec, read]
    model: anthropic/claude-sonnet-4-6

  - id: identify_root_cause
    agent: mythos-research
    prompt: |
      Analyze diagnostics to identify root cause:

      Incident: {{payload.incident_description}}
      Diagnostics: {{steps.gather_diagnostics.output}}

      1. Correlate symptoms with diagnostic data
      2. Check memory for similar past incidents
      3. Search web for known issues with affected components
      4. Identify most likely root cause(s)

      Return root cause analysis with confidence levels.
    depends_on: [gather_diagnostics]
    tools: [memory_search, web_search]
    model: anthropic/claude-sonnet-4-6

  - id: develop_fix
    agent: mythos-code
    prompt: |
      Develop a fix or workaround for the incident:

      Root Cause: {{steps.identify_root_cause.output}}
      Severity: {{steps.assess_severity.output.severity}}

      If P1/P2 (critical/high):
        - Develop immediate workaround to restore service
        - Plan proper fix for later

      If P3/P4 (medium/low):
        - Develop proper fix
        - Include tests to prevent regression

      Return fix implementation plan with rollback strategy.
    depends_on: [identify_root_cause]
    tools: [exec, read, write, edit]
    model: anthropic/claude-opus-4-7

  - id: review_fix
    agent: mythos-critic
    prompt: |
      Review the proposed fix for safety and correctness:

      Fix Plan: {{steps.develop_fix.output}}
      Root Cause: {{steps.identify_root_cause.output}}

      Check:
      1. Does the fix address the root cause?
      2. Are there any side effects or regressions?
      3. Is the rollback plan adequate?
      4. Are tests included?
      5. Is it safe to deploy now?

      Approve, request changes, or reject with reasons.
    depends_on: [develop_fix]
    model: anthropic/claude-opus-4-7

  - id: deploy_fix
    agent: mythos-ops
    prompt: |
      Deploy the approved fix:

      Fix: {{steps.develop_fix.output}}
      Severity: {{steps.assess_severity.output.severity}}

      Steps:
      1. Create backup of current state
      2. Apply fix incrementally
      3. Verify system health after each change
      4. Run smoke tests
      5. Monitor for 15 minutes
      6. Report deployment status

      Include rollback instructions if issues arise.
    depends_on: [review_fix]
    tools: [exec]
    model: anthropic/claude-sonnet-4-6

  - id: notify_stakeholders
    agent: mythos-ops
    prompt: |
      Notify stakeholders about incident resolution:

      Incident: {{payload.incident_description}}
      Severity: {{steps.assess_severity.output.severity}}
      Root Cause: {{steps.identify_root_cause.output}}
      Resolution: {{steps.deploy_fix.output}}

      Compose incident report:
      - What happened
      - Impact
      - Root cause
      - Resolution
      - Prevention measures

      Deliver to:
      - Slack #incidents (all severities)
      - Email to management (P1/P2 only)
      - Status page update (P1/P2 only)
      - Log to memory for future reference
    depends_on: [deploy_fix]
    deliver:
      - slack:incidents
      - email:management  # P1/P2 only
    model: anthropic/claude-sonnet-4-6
