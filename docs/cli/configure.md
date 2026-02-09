---
summary: "CLI reference for `EasyHub configure` (interactive configuration prompts)"
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
title: "configure"
---

# `EasyHub configure`

Interactive prompt to set up credentials, devices, and agent defaults.

Note: The **Model** section now includes a multi-select for the
`agents.defaults.models` allowlist (what shows up in `/model` and the model picker).

Tip: `EasyHub config` without a subcommand opens the same wizard. Use
`EasyHub config get|set|unset` for non-interactive edits.

Related:

- Gateway configuration reference: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Notes:

- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.

## Examples

```bash
EasyHub configure
EasyHub configure --section models --section channels
```
