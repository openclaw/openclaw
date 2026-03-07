# Trello Setup Guide

## Board Template

Every new client gets a board with these standard lists:

1. **Awaiting Details** — Initial cards for gathering client info
2. **In Progress** — Active work by designer
3. **Needs Review** — Ready for internal QA or client review
4. **Ready for Delivery** — Approved and ready to send
5. **Published/Delivered** — Sent to client / published
6. **Resources** — Brand assets, briefs, reference material

## Standard Cards (created on deal won)

### Awaiting Details
- "Gather client details" — contact info, project scope
- "Brand assets collection" — logos, colors, fonts, existing creative

### Resources
- "Project brief" — scope, timeline, deliverables
- "Brand guidelines" — style guide link

## Webhook Events

### Card Moved → GHL Stage Update
| Trello List | GHL Tags | GHL Action |
|-------------|----------|------------|
| Needs Review | `needs_review`, `in_progress` | Update stage to IN_PROGRESS |
| Ready for Delivery | `ready_for_delivery` | Notify team |
| Published/Delivered | `delivered` | Update stage to DELIVERED, send delivery email |

## Member Assignment
- Assign based on designer workload (pending implementation of workload rules)
- Default: round-robin across active designers

## Permissions
- Workspace: OpenClaw team
- Board visibility: Workspace (not public)
- Webhook callback URL: `https://your-domain/webhooks/trello`
