---
summary: "CLI reference for `clawdbot configure` / `clawdbot config` (interactive configuration prompts)"
read_when:
  - You want to tweak credentials, devices, or agent defaults interactively
---

# `clawdbot configure` (alias: `config`)

Interactive prompt to set up credentials, devices, and agent defaults.

Related:
- Gateway configuration reference: [Configuration](/gateway/configuration)

Notes:
- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.

## Examples

```bash
clawdbot configure
clawdbot configure --section models --section channels
```
