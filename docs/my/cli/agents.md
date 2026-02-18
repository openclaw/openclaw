---
summary: "`openclaw agents` (list/add/delete/set identity) အတွက် CLI ကိုးကားချက်"
read_when:
  - အလုပ်ခွင်များ + လမ်းကြောင်းသတ်မှတ်ခြင်း + အထောက်အထားအတည်ပြုခြင်း ပါဝင်သည့် သီးခြားခွဲထားသော အေးဂျင့်များ အများအပြား လိုအပ်သည့်အခါ
title: "agents"
---

# `openclaw agents`

သီးခြားခွဲထားသော အေးဂျင့်များ (workspaces + auth + routing) ကို စီမံခန့်ခွဲပါ။

ဆက်စပ်အကြောင်းအရာများ—

- အေးဂျင့်အများအပြား လမ်းကြောင်းသတ်မှတ်ခြင်း: [Multi-Agent Routing](/concepts/multi-agent)
- အေးဂျင့် အလုပ်ခွင်: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Identity files

အေးဂျင့် အလုပ်ခွင်တစ်ခုချင်းစီတွင် အလုပ်ခွင် root တွင် `IDENTITY.md` ကို ထည့်သွင်းနိုင်ပါသည်—

- ဥပမာ လမ်းကြောင်း: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` သည် အလုပ်ခွင် root (သို့မဟုတ် သတ်မှတ်ထားသော `--identity-file`) မှ ဖတ်ယူပါသည်

Avatar လမ်းကြောင်းများကို အလုပ်ခွင် root ကို အခြေခံ၍ ဖြေရှင်းပါသည်။

## Set identity

`set-identity` သည် `agents.list[].identity` ထဲသို့ အချက်အလက်များကို ရေးသွင်းပါသည်—

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative လမ်းကြောင်း၊ http(s) URL၊ သို့မဟုတ် data URI)

`IDENTITY.md` မှ တင်ယူပါ—

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

အချက်အလက်များကို တိုက်ရိုက် အစားထိုးသတ်မှတ်ပါ—

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Config နမူနာ—

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
