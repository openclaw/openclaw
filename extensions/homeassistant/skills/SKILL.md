---
name: homeassistant
description: Home Assistant control (safe usage rules + examples).
metadata: { "openclaw": { "emoji": "🏠" } }
---

# Home Assistant (Safe Use)

## Critical Rules

1) **Always call `ha_ping` first.**
   - If ping fails, report that HA is unreachable and propose diagnostics.
   - **Do not** claim to control devices if ping fails.

2) **Never claim success without verification.**
   - `ha_call_service` and `ha_universal_control` return a `verification` object.
   - If `verification.ok` is false, you must say the command was sent but not confirmed.
   - If a fallback was applied, explain the fallback and do not claim full success.
   - Respect `verification.level`: `state` means state/attributes changed, `ha_event` means only the service event was seen.
   - `ha_event` is a weak confirmation: say “HA accepted the command, state did not confirm.”

3) **Prefer universal control**
   - Use `ha_universal_control` for user-facing control.
   - It resolves semantics + capabilities, chooses the right service/payload, applies safe fallbacks, and verifies.
   - If you need raw inventory, use `ha_inventory_report` or `ha_inventory_snapshot`.

4) **Use friendly args**
   - Use high-level, natural fields (ex: `"brightness": "60%"`, `"color": "purple"`, `"volume": "30%"`, `"temperature": 22`).
   - `ha_universal_control` and `ha_call_service` normalize payloads based on capabilities.

5) **Human-mode semantics**
   - Use `ha_semantic_resolve` or `ha_inventory_report` to see semantic type + confidence.
   - `ha_semantic_resolve` returns candidates with risk level + recommended control strategy.
   - Overrides live in `/home/node/.openclaw/homeassistant/semantic_overrides.json`.
   - Use `ha_list_semantic_overrides` and `ha_upsert_semantic_override`.
   - Ambiguous devices should be marked `NEEDS_OVERRIDE` and handled with safe defaults.
   - `ha_inventory_report` includes `NO_JEBANCI_SCORE` and ambiguous list.

6) **1-time confirm caching**
   - High-risk actions (lock/alarm/vacuum/climate) require confirmation once.
   - After confirmation, approvals are cached in `/home/node/.openclaw/homeassistant/risk_approvals.json`.

7) **Reversible probes**
   - `ha_universal_control` with `safe_probe: true` performs reversible, low-risk probes.
   - High-risk domains return read-only verification.

8) **Automations**
   - Use `ha_list_automations` to find automations.
   - Use `ha_get_automation_config` before changing.
   - For edits, call `ha_upsert_automation_config` with full config and `reload: true`.

## Example flows

### Ping

```bash
ha_ping
```

### Inventory report

```bash
ha_inventory_report
```

### Turn light on (purple)

```bash
ha_universal_control {
  "target": { "name": "blagovaona" },
  "intent": { "action": "turn_on" },
  "data": { "color": "ljubicasto", "brightness": "60%" }
}
```

### Turn light on (xy vs rgb)

```bash
ha_universal_control {
  "target": { "entity_id": "light.tv_strip" },
  "intent": { "action": "turn_on" },
  "data": { "color": "purple", "brightness": "50%" }
}
```

### TV volume (30%)

```bash
ha_universal_control {
  "target": { "name": "TV" },
  "intent": { "action": "set", "property": "volume", "value": "30%" }
}
```

### Climate temperature (22C)

```bash
ha_universal_control {
  "target": { "name": "living room" },
  "intent": { "action": "set", "property": "temperature", "value": 22 }
}
```

### Cover position (30%)

```bash
ha_universal_control {
  "target": { "name": "blinds" },
  "intent": { "action": "set", "property": "position", "value": "30%" }
}
```

### Safe notification (no confirm required)

```bash
ha_call_service {
  "domain": "persistent_notification",
  "service": "create",
  "data": { "title": "OpenClaw", "message": "Test notification" }
}
```

### Forced confirm flow (risky devices)

```bash
ha_universal_control { "target": { "name": "door lock" }, "intent": { "action": "lock" } }
ha_prepare_risky_action { "kind": "ha_call_service", "action": { "domain": "lock", "service": "lock", "data": { "entity_id": ["lock.front_door"] } } }
ha_confirm_action { "token": "<token>" }
```

### On/off-only fan requested at 60%

```bash
ha_universal_control {
  "target": { "entity_id": "switch.ventilation" },
  "intent": { "action": "set", "property": "percentage", "value": "60%" }
}
```

### Fan implemented as switch (semantic fan)

```bash
ha_universal_control {
  \"target\": { \"entity_id\": \"switch.ventilator\" },
  \"intent\": { \"action\": \"turn_on\" }
}
```

### Climate read-only probe

```bash
ha_universal_control {
  \"target\": { \"name\": \"klima\" },
  \"safe_probe\": true
}
```

### Lock confirm once + cached approval

```bash
ha_prepare_risky_action { \"kind\": \"ha_call_service\", \"action\": { \"domain\": \"lock\", \"service\": \"unlock\", \"data\": { \"entity_id\": [\"lock.front_door\"] } } }
ha_confirm_action { \"token\": \"<token>\" }
```

### Add a semantic override

```bash
ha_upsert_semantic_override {
  "scope": "entity",
  "id": "switch.ventilation",
  "semantic_type": "fan",
  "control_model": "onoff",
  "smoke_test_safe": false,
  "notes": "Switch-backed fan"
}
```
