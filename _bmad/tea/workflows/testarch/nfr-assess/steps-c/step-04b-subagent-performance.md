---
name: "step-04b-subagent-performance"
description: "Subagent: Performance NFR assessment"
subagent: true
outputFile: "/tmp/tea-nfr-performance-{{timestamp}}.json"
---

# Subagent 4B: Performance NFR Assessment

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with other NFR domain assessments.

**Your task:** Assess PERFORMANCE NFR domain only.

---

## SUBAGENT TASK

### 1. Performance Assessment Categories

**A) Response Times:**

- API response times (<200ms target)
- Page load times (<2s target)
- Time to interactive (<3s target)

**B) Throughput:**

- Requests per second capacity
- Concurrent user support
- Database query performance

**C) Resource Usage:**

- Memory consumption
- CPU utilization
- Database connection pooling

**D) Optimization:**

- Caching strategies
- CDN usage
- Code splitting/lazy loading
- Database indexing

---

## OUTPUT FORMAT

```json
{
  "domain": "performance",
  "risk_level": "LOW",
  "findings": [
    {
      "category": "Response Times",
      "status": "PASS",
      "description": "API endpoints respond in <150ms (P95)",
      "evidence": ["Load testing results show 140ms P95"],
      "recommendations": []
    },
    {
      "category": "Caching",
      "status": "CONCERN",
      "description": "No CDN for static assets",
      "evidence": ["Static files served from origin"],
      "recommendations": ["Implement CDN (CloudFront/Cloudflare)", "Cache static assets for 1 year"]
    }
  ],
  "compliance": {
    "SLA_99.9": "PASS",
    "SLA_99.99": "CONCERN"
  },
  "priority_actions": [
    "Implement CDN for static assets",
    "Add database query caching for frequent reads"
  ],
  "summary": "Performance is acceptable with minor optimization opportunities"
}
```

---

## EXIT CONDITION

Subagent completes when JSON output written to temp file.
