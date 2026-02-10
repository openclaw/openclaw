---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "macOS Skills settings UI and gateway-backed status"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating the macOS Skills settings UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing skills gating or install behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Skills"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Skills (macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app surfaces OpenClaw skills via the gateway; it does not parse skills locally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Data source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills.status` (gateway) returns all skills plus eligibility and missing requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (including allowlist blocks for bundled skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requirements are derived from `metadata.openclaw.requires` in each `SKILL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `metadata.openclaw.install` defines install options (brew/node/go/uv).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app calls `skills.install` to run installers on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The gateway surfaces only one preferred installer when multiple are provided（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (brew when available, otherwise node manager from `skills.install`, default npm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Env/API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app stores keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills.update` patches `enabled`, `apiKey`, and `env`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install + config updates happen on the gateway host (not the local Mac).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
