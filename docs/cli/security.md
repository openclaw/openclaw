---
summary: "CLI reference for `clawdbot security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)
---

# `clawdbot security`

Security tools (audit + optional fixes).

Related:
- Security guide: [Security](/gateway/security)

## Audit

```bash
clawdbot security audit
clawdbot security audit --deep
clawdbot security audit --fix
```

The audit warns when multiple DM senders share the main session and recommends `session.dmScope="per-channel-peer"` for shared inboxes.
