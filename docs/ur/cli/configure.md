---
summary: "CLI کے لیے حوالہ: `openclaw configure` (انٹرایکٹو کنفیگریشن پرامپٹس)"
read_when:
  - آپ اس وقت جب اسناد، ڈیوائسز، یا ایجنٹ کی ڈیفالٹس کو انٹرایکٹو طور پر ایڈجسٹ کرنا چاہتے ہوں
title: "کنفیگر"
---

# `openclaw configure`

اسناد، ڈیوائسز، اور ایجنٹ کی ڈیفالٹس سیٹ کرنے کے لیے انٹرایکٹو پرامپٹ۔

نوٹ: **Model** سیکشن میں اب `agents.defaults.models` اجازت فہرست کے لیے ملٹی-سلیکٹ شامل ہے (جو `/model` اور ماڈل پکر میں ظاہر ہوتا ہے)۔

Tip: `openclaw config` without a subcommand opens the same wizard. Use
`openclaw config get|set|unset` for non-interactive edits.

متعلقہ:

- Gateway کنفیگریشن حوالہ: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

نوٹس:

- Choosing where the Gateway runs always updates `gateway.mode`. You can select "Continue" without other sections if that is all you need.
- Channel-oriented services (Slack/Discord/Matrix/Microsoft Teams) prompt for channel/room allowlists during setup. You can enter names or IDs; the wizard resolves names to IDs when possible.

## مثالیں

```bash
openclaw configure
openclaw configure --section models --section channels
```
