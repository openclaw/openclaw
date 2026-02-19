# Threat Intelligence Tools

OpenClaw provides comprehensive threat intelligence capabilities for tracking threat actors, indicators of compromise (IOCs), and campaigns.

## Overview

The threat intelligence system allows you to:
- Track threat actor profiles (Volt Typhoon, Scattered Spider, APT29, etc.)
- Store and search indicators of compromise (IPs, domains, hashes, file paths)
- Manage campaigns and analyze correlations
- Export/import threat data in standard formats (STIX/TAXII)

## Tools

### `threat_track_actor`

Track threat actor profiles with metadata including aliases, attribution, TTPs, and campaigns.

**Example:**
```
threat_track_actor({
  id: "volt-typhoon",
  name: "Volt Typhoon",
  attribution: "PRC",
  description: "Pre-positioning campaign targeting critical infrastructure",
  severity: "critical"
})
```

### `threat_add_ioc`

Add indicators of compromise. IOC type is automatically inferred if not specified.

**Example:**
```
threat_add_ioc({
  value: "192.0.2.1",
  type: "ip",
  actorId: "volt-typhoon",
  confidence: "high"
})
```

### `threat_search_ioc`

Search IOCs against stored threat intelligence. Returns matches with associated actor and campaign information.

**Example:**
```
threat_search_ioc({
  value: "192.0.2.1"
})
```

### `threat_list_campaigns`

List tracked campaigns with optional filtering by actor, status, or sector.

**Example:**
```
threat_list_campaigns({
  actorId: "volt-typhoon",
  status: "active"
})
```

### `threat_analyze_correlation`

Analyze correlations between IOCs, actors, and campaigns to identify patterns and relationships.

**Example:**
```
threat_analyze_correlation({
  actorId: "volt-typhoon"
})
```

## Data Storage

Threat intelligence data is stored in `~/.openclaw/cybersecurity/threats/`:
- `actors.jsonl`: Threat actor profiles
- `iocs.jsonl`: Indicators of compromise
- `campaigns.jsonl`: Campaign tracking

## Configuration

Enable threat intelligence in your config:

```json5
{
  cybersecurity: {
    threatIntelligence: {
      enabled: true,
      storagePath: "~/.openclaw/cybersecurity/threats/",
      autoUpdate: false,
      updateInterval: "24h"
    }
  }
}
```
