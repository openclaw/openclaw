---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw status` (diagnostics, probes, usage snapshots)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a quick diagnosis of channel health + recent session recipients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a pasteable “all” status for debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagnostics for channels + sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deep` runs live probes (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output includes per-agent session stores when multiple agents are configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overview includes Gateway + node host service install/runtime status when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overview includes update channel + git SHA (for source checkouts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update info surfaces in the Overview; if an update is available, status prints a hint to run `openclaw update` (see [Updating](/install/updating)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
