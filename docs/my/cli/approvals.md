---
summary: "Gateway သို့မဟုတ် နိုဒ် ဟို့စ်များအတွက် exec approvals ကို CLI မှ ကိုးကားအသုံးပြုရန် (`openclaw approvals`)"
read_when:
  - CLI မှ exec approvals ကို ပြင်ဆင်လိုသည့်အခါ
  - Gateway သို့မဟုတ် နိုဒ် ဟို့စ်များပေါ်ရှိ allowlist များကို စီမံခန့်ခွဲရန် လိုအပ်သည့်အခါ
title: "approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
default အနေဖြင့် commands များသည် disk ပေါ်ရှိ local approvals file ကို target လုပ်သည်။ gateway ကို target လုပ်ရန် `--gateway` ကို၊ node တစ်ခုကို target လုပ်ရန် `--node` ကို အသုံးပြုပါ။

ဆက်စပ်အကြောင်းအရာများ:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

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

- `--node` သည် `openclaw nodes` နှင့် တူညီသော resolver (id, name, ip, သို့မဟုတ် id prefix) ကို အသုံးပြုသည်။
- `--agent` သည် မူလအားဖြင့် `"*"` ဖြစ်ပြီး၊ အေးဂျင့်အားလုံးအတွက် သက်ရောက်မှုရှိသည်။
- နိုဒ် ဟို့စ်သည် `system.execApprovals.get/set` ကို ကြေညာပေးရမည် (macOS app သို့မဟုတ် headless node host)။
- Approvals ဖိုင်များကို ဟို့စ်အလိုက် `~/.openclaw/exec-approvals.json` တွင် သိမ်းဆည်းထားသည်။
