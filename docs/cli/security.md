---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to run a quick security audit on config/state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw security`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security tools (audit + optional fixes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security guide: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Audit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw security audit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw security audit --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw security audit --fix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The audit warns when multiple DM senders share the main session and recommends **secure DM mode**: `session.dmScope="per-channel-peer"` (or `per-account-channel-peer` for multi-account channels) for shared inboxes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It also warns when small models (`<=300B`) are used without sandboxing and with web/browser tools enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
