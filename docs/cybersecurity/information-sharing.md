# Information Sharing

OpenClaw supports CISA-style threat indicator sharing with protections under CISA 2015.

## Overview

The information sharing capabilities allow you to:
- Export threat indicators in STIX/TAXII format
- Import threat indicators from external sources
- Check information sharing status and protections

## Tools

### `threat_share_export`

Export threat indicators in STIX/TAXII or JSON format. PII is automatically stripped per CISA 2015 requirements.

**Example:**
```
threat_share_export({
  format: "json",
  actorIds: ["volt-typhoon"]
})
```

### `threat_share_import`

Import threat indicators from external sources. Supports JSON format (STIX/TAXII parsing pending).

**Example:**
```
threat_share_import({
  source: "CISA Feed",
  format: "json",
  data: "[{\"value\":\"192.0.2.1\",\"type\":\"ip\"}]"
})
```

### `threat_share_status`

Check information sharing status and available protections.

**Example:**
```
threat_share_status({})
```

## CISA 2015 Protections

When sharing under CISA 2015, the following protections apply:
- No waiver of applicable privilege
- Antitrust liability exemption
- Exemption from federal/state disclosure laws
- Treatment as trade secret or commercial information
- CISA 2015 liability protection (when using DHS mechanism)

## Configuration

Enable information sharing in your config:

```json5
{
  cybersecurity: {
    informationSharing: {
      enabled: true,
      stixEndpoint: "https://example.com/stix",
      cisaCompliant: true,
      autoExport: false
    }
  }
}
```
