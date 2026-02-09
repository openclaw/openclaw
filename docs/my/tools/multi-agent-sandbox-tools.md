---
summary: "အေးဂျင့်တစ်ခုချင်းစီအလိုက် sandbox နှင့် tool ကန့်သတ်ချက်များ၊ ဦးစားပေးအဆင့်များနှင့် ဥပမာများ"
title: Multi-Agent Sandbox & Tools
read_when: "multi-agent Gateway တစ်ခုတွင် အေးဂျင့်တစ်ခုချင်းစီအလိုက် sandboxing သို့မဟုတ် tool allow/deny မူဝါဒများ လိုအပ်သည့်အခါ"
status: active
---

# Multi-Agent Sandbox & Tools ဖွဲ့စည်းပြင်ဆင်ခြင်း

## အကျဉ်းချုပ်

multi-agent စနစ်တွင် အေးဂျင့်တစ်ခုချင်းစီသည် ယခုအခါ အောက်ပါတို့ကို သီးခြားစီ ပိုင်ဆိုင်နိုင်ပါသည်—

- **Sandbox ဖွဲ့စည်းပြင်ဆင်မှု** (`agents.list[].sandbox` သည် `agents.defaults.sandbox` ကို အစားထိုးသည်)
- **Tool ကန့်သတ်ချက်များ** (`tools.allow` / `tools.deny`, နှင့် `agents.list[].tools`)

ဤအရာကြောင့် လုံခြုံရေး ပရိုဖိုင် မတူညီသည့် အေးဂျင့်များကို အများအပြား ပြေးဆွဲနိုင်ပါသည်—

- ဝင်ရောက်ခွင့် အပြည့်အစုံရှိသော ကိုယ်ရေးကိုယ်တာ အကူအညီပေးသူ
- tool ကန့်သတ်ထားသော မိသားစု/အလုပ် အေးဂျင့်များ
- sandbox ထဲတွင် လည်ပတ်သော အများပြည်သူ ရည်ရွယ် အေးဂျင့်များ

`setupCommand` ကို `sandbox.docker` (global သို့မဟုတ် per-agent) အောက်တွင် ထားရှိရ며
container ဖန်တီးချိန်တွင် တစ်ကြိမ်သာ လည်ပတ်ပါသည်။

Auth သည် per-agent ဖြစ်ပြီး အေးဂျင့်တစ်ခုချင်းစီသည် ကိုယ်ပိုင် `agentDir` auth store မှ ဖတ်ယူပါသည်—

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

9. Credentials များကို agents များအကြား **မမျှဝေပါ**။ 10. agents များအကြား `agentDir` ကို ဘယ်တော့မှ ပြန်လည်အသုံးမပြုပါနှင့်။
10. creds များကို မျှဝေလိုပါက `auth-profiles.json` ကို အခြား agent ၏ `agentDir` ထဲသို့ ကူးထည့်ပါ။

12. runtime တွင် sandboxing ဘယ်လိုအလုပ်လုပ်သည်ကို သိရန် [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။
13. “ဘာကြောင့် ဒီဟာ blocked ဖြစ်နေတာလဲ?” ကို debug လုပ်ရန် [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) နှင့် `openclaw sandbox explain` ကို ကြည့်ပါ။

---

## ဖွဲ့စည်းပြင်ဆင်မှု ဥပမာများ

### ဥပမာ ၁: ကိုယ်ရေးကိုယ်တာ + ကန့်သတ်ထားသော မိသားစု အေးဂျင့်

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**ရလဒ်:**

- `main` အေးဂျင့်: ဟို့စ်ပေါ်တွင် လည်ပတ်ပြီး tool အပြည့်အစုံ အသုံးပြုနိုင်
- `family` အေးဂျင့်: Docker ထဲတွင် လည်ပတ် (အေးဂျင့်တစ်ခုလျှင် container တစ်ခု)၊ `read` tool သာ အသုံးပြုနိုင်

---

### ဥပမာ ၂: မျှဝေထားသော Sandbox ဖြင့် အလုပ်အေးဂျင့်

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### ဥပမာ ၂b: Global coding ပရိုဖိုင် + မက်ဆေ့ချ်ပို့ရန်သာ အေးဂျင့်

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**ရလဒ်:**

- default အေးဂျင့်များသည် coding tools များကို ရရှိ
- `support` အေးဂျင့်သည် မက်ဆေ့ချ်ပို့ရန်သာ (+ Slack tool)

---

### ဥပမာ ၃: အေးဂျင့်တစ်ခုချင်းစီအလိုက် Sandbox မုဒ် မတူညီမှု

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## ဖွဲ့စည်းပြင်ဆင်မှု ဦးစားပေးအဆင့်

global (`agents.defaults.*`) နှင့် agent-specific (`agents.list[].*`) ဖွဲ့စည်းမှုများ နှစ်မျိုးလုံး ရှိပါက—

### Sandbox ဖွဲ့စည်းမှု

agent-specific ဆက်တင်များသည် global ကို အစားထိုးပါသည်—

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**မှတ်ချက်များ:**

- `agents.list[].sandbox.{docker,browser,prune}.*` သည် ထိုအေးဂျင့်အတွက် `agents.defaults.sandbox.{docker,browser,prune}.*` ကို အစားထိုးသည် (`"shared"` သို့ sandbox scope သတ်မှတ်သွားသောအခါ မစဉ်းစားပါ)။

### Tool ကန့်သတ်ချက်များ

စစ်ထုတ် အစဉ်အလာမှာ—

1. **Tool ပရိုဖိုင်** (`tools.profile` သို့မဟုတ် `agents.list[].tools.profile`)
2. **Provider tool ပရိုဖိုင်** (`tools.byProvider[provider].profile` သို့မဟုတ် `agents.list[].tools.byProvider[provider].profile`)
3. **Global tool မူဝါဒ** (`tools.allow` / `tools.deny`)
4. **Provider tool မူဝါဒ** (`tools.byProvider[provider].allow/deny`)
5. **Agent-specific tool မူဝါဒ** (`agents.list[].tools.allow/deny`)
6. **Agent provider မူဝါဒ** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox tool မူဝါဒ** (`tools.sandbox.tools` သို့မဟုတ် `agents.list[].tools.sandbox.tools`)
8. **Subagent tool မူဝါဒ** (`tools.subagents.tools`, သက်ဆိုင်ပါက)

14) level တစ်ခုချင်းစီသည် tools များကို ထပ်မံကန့်သတ်နိုင်သော်လည်း ယခင် level များတွင် ငြင်းပယ်ထားသော tools များကို ပြန်လည်ခွင့်မပြုနိုင်ပါ။
15) `agents.list[].tools.sandbox.tools` ကို သတ်မှတ်ထားပါက ထို agent အတွက် `tools.sandbox.tools` ကို အစားထိုးသုံးမည်ဖြစ်သည်။
16) `agents.list[].tools.profile` ကို သတ်မှတ်ထားပါက ထို agent အတွက် `tools.profile` ကို override လုပ်မည်ဖြစ်သည်။
17) Provider tool keys များသည် `provider` (ဥပမာ `google-antigravity`) သို့မဟုတ် `provider/model` (ဥပမာ `openai/gpt-5.2`) ကို လက်ခံပါသည်။

### Tool အုပ်စုများ (အတိုကောက်)

Tool မူဝါဒများ (global, agent, sandbox) တွင် tool များစွာသို့ ချဲ့ထွင်သည့် `group:*` entries များကို ထောက်ပံ့ပါသည်—

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: OpenClaw built-in tools အားလုံး (provider plugins မပါဝင်)

### Elevated Mode

18. `tools.elevated` သည် global baseline (sender-based allowlist) ဖြစ်သည်။ 19. `agents.list[].tools.elevated` သည် agent တစ်ခုချင်းစီအတွက် elevated ကို ထပ်မံကန့်သတ်နိုင်သည် (နှစ်ဖက်စလုံးမှ ခွင့်ပြုရမည်)။

ကာကွယ်ရေး ပုံစံများ—

- မယုံကြည်ရသော အေးဂျင့်များအတွက် `exec` ကို ပိတ်ထားပါ (`agents.list[].tools.deny: ["exec"]`)
- ကန့်သတ်ထားသော အေးဂျင့်များသို့ လမ်းကြောင်းချသည့် sender များကို allowlist မထည့်ပါနှင့်
- sandboxed execution သာ လိုပါက elevated ကို global အနေဖြင့် ပိတ်ပါ (`tools.elevated.enabled: false`)
- အရေးကြီးသော ပရိုဖိုင်များအတွက် per-agent elevated ကို ပိတ်ပါ (`agents.list[].tools.elevated.enabled: false`)

---

## Single Agent မှ ပြောင်းလဲခြင်း

**အရင် (single agent):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**ပြီးနောက် (ပရိုဖိုင် မတူညီသော multi-agent):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Legacy `agent.*` ဖွဲ့စည်းမှုများကို `openclaw doctor` မှ ပြောင်းရွှေ့ပေးပါသည်; အနာဂတ်တွင် `agents.defaults` + `agents.list` ကို ဦးစားပေး အသုံးပြုပါ။

---

## Tool ကန့်သတ်ချက် ဥပမာများ

### ဖတ်ရှုရန်သာ အေးဂျင့်

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### လုံခြုံသော အကောင်အထည်ဖော် အေးဂျင့် (ဖိုင် ပြင်ဆင်မှု မရှိ)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### ဆက်သွယ်ရေးအတွက်သာ အေးဂျင့်

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## အများဆုံး တွေ့ရသော အမှား: "non-main"

20. `agents.defaults.sandbox.mode: "non-main"` သည် agent id မဟုတ်ဘဲ `session.mainKey` (default "main") အပေါ် အခြေခံထားသည်။ 21. Group/channel sessions များသည် အမြဲတမ်း ကိုယ်ပိုင် keys များကို ရရှိသဖြင့် non-main အဖြစ် သတ်မှတ်ခံရပြီး sandboxed ဖြစ်မည်။ 22. agent တစ်ခုကို ဘယ်တော့မှ sandbox မလုပ်ချင်ပါက `agents.list[].sandbox.mode: "off"` ကို သတ်မှတ်ပါ။

---

## စမ်းသပ်ခြင်း

multi-agent sandbox နှင့် tools ကို ဖွဲ့စည်းပြီးနောက်—

1. **Agent resolution စစ်ဆေးခြင်း:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Sandbox containers စစ်ဆေးခြင်း:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Tool ကန့်သတ်ချက်များ စမ်းသပ်ခြင်း:**
   - ကန့်သတ်ထားသော tool များ လိုအပ်သည့် မက်ဆေ့ချ်တစ်ခု ပို့ပါ
   - အေးဂျင့်သည် ပိတ်ထားသော tool များကို မသုံးနိုင်ကြောင်း အတည်ပြုပါ

4. **Logs ကို စောင့်ကြည့်ခြင်း:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## ပြဿနာဖြေရှင်းခြင်း

### `mode: "all"` ရှိသော်လည်း အေးဂျင့် sandbox မဖြစ်ခြင်း

- ၎င်းကို အစားထိုးနေသော global `agents.defaults.sandbox.mode` ရှိမရှိ စစ်ဆေးပါ
- agent-specific ဖွဲ့စည်းမှုသည် ဦးစားပေးဖြစ်သဖြင့် `agents.list[].sandbox.mode: "all"` ကို သတ်မှတ်ပါ

### deny list ရှိသော်လည်း tools များ ရရှိနေဆဲ

- tool filtering အစဉ်အလာကို စစ်ဆေးပါ: global → agent → sandbox → subagent
- အဆင့်တစ်ခုချင်းစီသည် ထပ်မံကန့်သတ်နိုင်သော်လည်း ပြန်လည် ခွင့်မပြုနိုင်ပါ
- logs ဖြင့် အတည်ပြုပါ: `[tools] filtering tools for agent:${agentId}`

### Container ကို အေးဂျင့်တစ်ခုချင်းစီအလိုက် သီးခြားမခွဲထားခြင်း

- agent-specific sandbox ဖွဲ့စည်းမှုတွင် `scope: "agent"` ကို သတ်မှတ်ပါ
- default သည် `"session"` ဖြစ်ပြီး ဆက်ရှင်တစ်ခုလျှင် container တစ်ခု ဖန်တီးပါသည်

---

## ဆက်စပ်အကြောင်းအရာများ

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
