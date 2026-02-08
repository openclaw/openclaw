---
summary: "CLI کے لیے حوالہ برائے `openclaw approvals` (گیٹ وے یا نوڈ ہوسٹس کے لیے exec منظوریات)"
read_when:
  - آپ CLI سے exec منظوریات میں ترمیم کرنا چاہتے ہیں
  - آپ کو گیٹ وے یا نوڈ ہوسٹس پر اجازت فہرستیں منظم کرنے کی ضرورت ہے
title: "approvals"
x-i18n:
  source_path: cli/approvals.md
  source_hash: 4329cdaaec2c5f5d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:54Z
---

# `openclaw approvals`

**لوکل ہوسٹ**، **گیٹ وے ہوسٹ**، یا **نوڈ ہوسٹ** کے لیے exec منظوریات منظم کریں۔
بطورِ طے شدہ، کمانڈز ڈسک پر موجود لوکل منظوریات فائل کو ہدف بناتی ہیں۔ گیٹ وے کو ہدف بنانے کے لیے `--gateway` استعمال کریں، یا کسی مخصوص نوڈ کو ہدف بنانے کے لیے `--node` استعمال کریں۔

متعلقہ:

- Exec منظوریات: [Exec approvals](/tools/exec-approvals)
- نوڈز: [Nodes](/nodes)

## Common commands

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Replace approvals from a file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Allowlist helpers

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` وہی resolver استعمال کرتا ہے جو `openclaw nodes` کرتا ہے (id، نام، ip، یا id prefix)۔
- `--agent` بطورِ طے شدہ `"*"` پر ہوتا ہے، جو تمام ایجنٹس پر لاگو ہوتا ہے۔
- نوڈ ہوسٹ کو `system.execApprovals.get/set` کا اشتہار دینا لازمی ہے (macOS ایپ یا headless نوڈ ہوسٹ)۔
- منظوریات کی فائلیں ہر ہوسٹ کے لیے `~/.openclaw/exec-approvals.json` پر محفوظ کی جاتی ہیں۔
