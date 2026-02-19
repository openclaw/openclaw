# AI Threat Defense

OpenClaw provides tools for detecting and responding to AI-accelerated attacks.

## Overview

AI threat defense tools help:

- Detect AI-driven attack patterns (machine-speed operations)
- Automatically respond to AI-accelerated attacks
- Proactively hunt for AI-driven campaigns

## Key Threats

As discussed in the FBI podcast, AI-accelerated attacks present new challenges:

- **Speed**: AI can execute attacks 100x faster than human-driven attacks
- **Volume**: Thousands of requests per second, multiple operations per second
- **Autonomy**: 80-90% of operations executed autonomously
- **Scale**: Single zero-day can be leveraged across many targets

## Tools

### `ai_threat_detect_anomaly`

Detect AI-driven attack patterns. Identifies machine-speed operations (100x faster than human) and flags physically impossible request rates.

**Example:**

```json5

ai_threat_detect_anomaly({
  timeRange: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-01-01T23:59:59Z"
  }
})
```

### `ai_threat_respond`

Automated response to AI-accelerated attacks. Quarantines affected systems and implements rate limiting and circuit breakers.

**Example:**

```
ai_threat_respond({
  anomalyId: "anomaly-123",
  actions: ["quarantine", "rate_limit", "circuit_breaker"]
})
```

### `ai_threat_hunt`

Proactive hunting for AI-driven campaigns. Searches telemetry for AI attack signatures and correlates with known AI threat actor patterns.

**Example:**

```
ai_threat_hunt({
  actorIds: ["prc-ai-group"],
  patterns: ["high_request_rate", "autonomous_lateral_movement"]
})
```

## Defense Strategies

### Automation at Speed

To defend against AI-accelerated attacks, defenders must also automate:

- Vulnerability cycle: Fixes must be deployed nearly instantaneously
- Anomaly detection: AI-powered detection of AI attacks
- Response automation: Quarantine and rate limiting

### Focus on Critical Systems

Apply defensive AI to:

- Internet-facing devices
- User logins and credentials
- Systems with cascading impact potential

## Configuration

Enable AI threat defense in your config:

```json5
{
  cybersecurity: {
    aiThreatDefense: {
      enabled: true,
      anomalyThreshold: 100,
      autoRespond: false
    }
  }
}
```

## Resources

- Anthropic Report on PRC AI Campaign (November 2024)
- Google Threat Intelligence Forecast 2026
