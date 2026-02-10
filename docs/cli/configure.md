---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw configure` (interactive configuration prompts)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to tweak credentials, devices, or agent defaults interactively（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "configure"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interactive prompt to set up credentials, devices, and agent defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: The **Model** section now includes a multi-select for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.models` allowlist (what shows up in `/model` and the model picker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: `openclaw config` without a subcommand opens the same wizard. Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw config get|set|unset` for non-interactive edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway configuration reference: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config CLI: [Config](/cli/config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure --section models --section channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
