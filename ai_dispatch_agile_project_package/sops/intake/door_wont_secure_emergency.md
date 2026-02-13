# Intake SOP — Door Won’t Secure (Emergency)

## Purpose
Rapidly capture enough information to dispatch safely and correctly, while enforcing authorization and auditability.

## When to use
- Break-in risk
- Door will not lock/latch
- Storefront/egress security exposure

## Minimum required intake fields
- Site address (or site ID)
- On-site contact name + phone
- Whether the door is currently open/closed and if premises can be secured
- Business impact (main entry? alternate entrance?)
- Photos (request via SMS link):
  - full door view
  - latch/strike close-up
  - frame/hinge area
- Access instructions (keys, codes, escort)
- Time window for access (immediate if emergency)

## Triage rules
Emergency if any:
- cannot lock/secure premises
- security breach occurred
- glass/door hazards

## Script (dispatcher/agent)
1) “Are you able to lock the door right now?”
2) “Is this the main entrance, and is the store open?”
3) “Any damage to glass or frame?”
4) “Please send 3 photos via this link…”
5) “Who will meet the technician and what’s the best phone number?”

## Output
Create ticket:
- priority=EMERGENCY
- incident_type=DOOR_WONT_SECURE_V1
- risk_flags: SECURITY, SAFETY(if relevant)
- NTE: configured emergency NTE

