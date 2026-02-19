# Critical Infrastructure Protection

OpenClaw provides tools for protecting operational technology (OT) and critical infrastructure.

## Overview

Critical infrastructure protection tools help:
- Assess OT security posture
- Detect pre-positioning activity (Volt Typhoon-style)
- Generate resilience and recovery plans

## Tools

### `infra_assess_ot`

Assess operational technology (OT) security posture. Checks exposed OT connections and validates zero trust principles.

**Example:**
```
infra_assess_ot({
  networkCidrs: ["10.0.0.0/8"]
})
```

### `infra_detect_prepositioning`

Detect pre-positioning activity similar to Volt Typhoon. Identifies suspicious access patterns and flags potential sleeper agent activity.

**Example:**
```
infra_detect_prepositioning({
  timeRange: {
    start: "2024-01-01T00:00:00Z",
    end: "2024-01-31T23:59:59Z"
  }
})
```

### `infra_resilience_plan`

Generate resilience and recovery plans. Documents analog backup procedures and plans for rapid recovery (<24 hours target).

**Example:**
```
infra_resilience_plan({
  systemName: "SCADA System"
})
```

## Key Concepts

### Pre-positioning

Pre-positioning refers to adversary activity that places capabilities in critical infrastructure systems in advance of potential conflict. As discussed in the FBI podcast, actors like Volt Typhoon pre-position for potential wartime disruption.

### Resilience Planning

Resilience planning focuses on:
- Analog backup procedures (like Navy sextants, pilot backup navigation)
- Rapid recovery capabilities (<24 hours)
- Operating without digital systems when necessary

## Configuration

Enable critical infrastructure protection in your config:

```json5
{
  cybersecurity: {
    criticalInfrastructure: {
      enabled: true,
      otNetworks: ["10.0.0.0/8", "192.168.1.0/24"]
    }
  }
}
```

## Resources

- CISA Secure Connectivity Principles for OT
- Adapting Zero Trust Principles to Operational Technology (joint guide)
