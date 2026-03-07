---
name: "step-04c-subagent-reliability"
description: "Subagent: Reliability NFR assessment"
subagent: true
outputFile: "/tmp/tea-nfr-reliability-{{timestamp}}.json"
---

# Subagent 4C: Reliability NFR Assessment

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with other NFR domain assessments.

**Your task:** Assess RELIABILITY NFR domain only.

---

## SUBAGENT TASK

### 1. Reliability Assessment Categories

**A) Error Handling:**

- Try-catch blocks for critical operations
- Graceful degradation
- Circuit breakers
- Retry mechanisms

**B) Monitoring & Observability:**

- Logging implementation
- Error tracking (Sentry/Datadog)
- Health check endpoints
- Alerting systems

**C) Fault Tolerance:**

- Database failover
- Service redundancy
- Backup strategies
- Disaster recovery plan

**D) Uptime & Availability:**

- SLA targets
- Historical uptime
- Incident response

---

## OUTPUT FORMAT

```json
{
  "domain": "reliability",
  "risk_level": "LOW",
  "findings": [
    {
      "category": "Error Handling",
      "status": "PASS",
      "description": "Comprehensive error handling with circuit breakers",
      "evidence": ["Circuit breaker pattern in src/services/", "Retry logic implemented"],
      "recommendations": []
    },
    {
      "category": "Monitoring",
      "status": "CONCERN",
      "description": "No APM (Application Performance Monitoring) tool",
      "evidence": ["Logging present but no distributed tracing"],
      "recommendations": ["Implement APM (Datadog/New Relic)", "Add distributed tracing"]
    }
  ],
  "compliance": {
    "SLA_99.9": "PASS"
  },
  "priority_actions": ["Implement APM for better observability"],
  "summary": "Reliability is good with minor monitoring gaps"
}
```

---

## EXIT CONDITION

Subagent completes when JSON output written to temp file.
