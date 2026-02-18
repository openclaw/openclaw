---
summary: "အေးဂျင့်များစွာထံသို့ WhatsApp မက်ဆေ့ခ်ျကို ထုတ်လွှင့်ပို့ရန်"
read_when:
  - ထုတ်လွှင့်အုပ်စုများကို ဖွဲ့စည်းပြင်ဆင်ခြင်း
  - WhatsApp တွင် အေးဂျင့်များစွာ၏ ပြန်ကြားချက်များကို အမှားရှာဖွေခြင်း
status: experimental
title: "ထုတ်လွှင့် အုပ်စုများ"
---

# ထုတ်လွှင့် အုပ်စုများ

**အခြေအနေ:** စမ်းသပ်အဆင့်  
**ဗားရှင်း:** 2026.1.9 တွင် ထည့်သွင်းခဲ့သည်

## အကျဉ်းချုပ်

35. Broadcast Groups များသည် agent အများအပြားကို တစ်ပြိုင်နက်တည်း တူညီသော message ကို ကိုင်တွယ်ပြီး တုံ့ပြန်နိုင်စေသည်။ 36. ဤအရာကြောင့် WhatsApp group သို့မဟုတ် DM တစ်ခုအတွင်း phone number တစ်ခုတည်းကို အသုံးပြုပြီး အထူးပြု agent team များကို အတူတကွ အလုပ်လုပ်စေနိုင်သည်။

လက်ရှိ အကျုံးဝင်မှု: **WhatsApp သာလျှင်** (web channel)။

37. Broadcast group များကို channel allowlist နှင့် group activation rule များအပြီးတွင် အကဲဖြတ်သည်။ 38. WhatsApp group များတွင် ဆိုလိုသည်မှာ OpenClaw ပုံမှန်အားဖြင့် reply လုပ်မည့်အချိန် (ဥပမာ၊ group setting အပေါ်မူတည်၍ mention ရှိသောအခါ) broadcast ဖြစ်မည်ဖြစ်သည်။

## အသုံးပြုမှုများ

### 39. 1. 40. အထူးပြု Agent Team များ

အခြေခံတာဝန်များကို အလေးထားထားသော အေးဂျင့်များစွာကို တပ်ဆင်အသုံးချပါ—

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

အေးဂျင့်တစ်ဦးချင်းစီသည် မက်ဆေ့ချ်တစ်ခုတည်းကို ကိုင်တွယ်ပြီး မိမိအထူးပြုမြင်ကွင်းမှ အမြင်ကို ပေးပါသည်။

### 41. 2. 42. ဘာသာစကား မျိုးစုံ ပံ့ပိုးမှု

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 43. 3. 44. အရည်အသွေး အာမခံ Workflow များ

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 45. 4. 46. Task Automation

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## ဖွဲ့စည်းပြင်ဆင်ခြင်း

### အခြေခံ တပ်ဆင်မှု

47. `bindings` ဘေးတွင် top-level `broadcast` section တစ်ခု ထည့်ပါ။ 48. Key များမှာ WhatsApp peer id များ ဖြစ်သည်။

- အုပ်စုချတ်များ: group JID (ဥပမာ— `120363403215116621@g.us`)
- DM များ: E.164 ဖုန်းနံပါတ် (ဥပမာ— `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**ရလဒ်:** OpenClaw သည် ဤချတ်တွင် ပြန်ကြားမည့်အချိန်တိုင်း အေးဂျင့် သုံးဦးလုံးကို လည်ပတ်စေမည်ဖြစ်သည်။

### ကိုင်တွယ်ဆောင်ရွက်မှု မဟာဗျူဟာ

အေးဂျင့်များ မက်ဆေ့ချ်ကို ကိုင်တွယ်ပုံကို ထိန်းချုပ်ပါ—

#### အပြိုင် (ပုံမှန်)

အေးဂျင့်အားလုံးကို တစ်ပြိုင်နက်တည်း ကိုင်တွယ်စေသည်—

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### အစဉ်လိုက်

အေးဂျင့်များကို အစဉ်လိုက် ကိုင်တွယ်စေသည် (ရှေ့တစ်ဦးပြီးမှ နောက်တစ်ဦး)—

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### ပြည့်စုံသော ဥပမာ

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## အလုပ်လုပ်ပုံ

### မက်ဆေ့ချ် စီးဆင်းမှု

1. **ဝင်လာသော မက်ဆေ့ချ်** သည် WhatsApp အုပ်စုတစ်ခုတွင် ရောက်ရှိသည်
2. **ထုတ်လွှင့် စစ်ဆေးခြင်း**: peer ID သည် `broadcast` တွင် ပါဝင်/မပါဝင် စနစ်က စစ်ဆေးသည်
3. **ထုတ်လွှင့်စာရင်းတွင် ပါဝင်ပါက**:
   - စာရင်းပါ အေးဂျင့်အားလုံး မက်ဆေ့ချ်ကို ကိုင်တွယ်သည်
   - အေးဂျင့်တစ်ဦးချင်းစီတွင် ကိုယ်ပိုင် session key နှင့် သီးခြား context ရှိသည်
   - အေးဂျင့်များကို အပြိုင် (ပုံမှန်) သို့မဟုတ် အစဉ်လိုက် ကိုင်တွယ်သည်
4. **မပါဝင်ပါက**:
   - ပုံမှန် routing ကို အသုံးပြုသည် (ပထမဆုံး ကိုက်ညီသော binding)

49) မှတ်ချက်: broadcast group များသည် channel allowlist သို့မဟုတ် group activation rule (mentions/commands စသည်) များကို မကျော်လွှားပါ။ 50. Message တစ်ခုကို processing ပြုလုပ်နိုင်သောအခါ **ဘယ် agent များ chạy မည်ကိုသာ** ပြောင်းလဲပေးသည်။

### ဆက်ရှင် သီးခြားခွဲခြားမှု

ထုတ်လွှင့် အုပ်စုအတွင်းရှိ အေးဂျင့်တစ်ဦးချင်းစီသည် အပြည့်အဝ သီးခြားထားရှိပါသည်—

- **Session keys** (`agent:alfred:whatsapp:group:120363...` နှင့် `agent:baerbel:whatsapp:group:120363...`)
- **စကားပြော မှတ်တမ်း** (အေးဂျင့်တစ်ဦးသည် အခြားအေးဂျင့်များ၏ မက်ဆေ့ချ်များကို မမြင်နိုင်)
- **Workspace** (ဖွဲ့စည်းထားပါက sandbox များကို သီးခြားထားရှိ)
- **ကိရိယာ အသုံးပြုခွင့်** (ခွင့်ပြု/ပိတ်ပင် စာရင်း မတူညီနိုင်)
- **မှတ်ဉာဏ်/Context** (IDENTITY.md, SOUL.md စသည် သီးခြား)
- **အုပ်စု context buffer** (context အတွက် အသုံးပြုသော အုပ်စု မက်ဆေ့ချ်များ) ကို peer တစ်ခုလျှင် မျှဝေထားပြီး ထုတ်လွှင့် အေးဂျင့်အားလုံးသည် trigger ဖြစ်သည့်အချိန် တူညီသော context ကို မြင်နိုင်ပါသည်

ထို့ကြောင့် အေးဂျင့်တစ်ဦးချင်းစီတွင်—

- ကိုယ်ရည်ကိုယ်သွေး မတူညီနိုင်
- ကိရိယာ အသုံးပြုခွင့် မတူညီနိုင် (ဥပမာ—ဖတ်ရန်သာ vs. ဖတ်ရေး)
- မော်ဒယ် မတူညီနိုင် (ဥပမာ— opus vs. sonnet)
- Skills မတူညီစွာ ထည့်သွင်းနိုင်

### ဥပမာ: ဆက်ရှင်များကို သီးခြားထားရှိခြင်း

အုပ်စု `120363403215116621@g.us` တွင် အေးဂျင့်များ `["alfred", "baerbel"]` ပါဝင်သည်—

**Alfred ၏ context:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Bärbel ၏ context:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## အကောင်းဆုံး အလေ့အကျင့်များ

### 1. အေးဂျင့်များကို အာရုံစိုက်ထားပါ

အေးဂျင့်တစ်ဦးချင်းစီကို တာဝန်တစ်ခုတည်းဖြင့် ရှင်းလင်းစွာ ဒီဇိုင်းလုပ်ပါ—

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **ကောင်းသည်:** အေးဂျင့်တစ်ဦးလျှင် တာဝန်တစ်ခု  
❌ **မကောင်းပါ:** ယေဘုယျ “dev-helper” အေးဂျင့်တစ်ဦးတည်း

### 2. ဖော်ပြချက်ပါသော အမည်များကို အသုံးပြုပါ

အေးဂျင့်တစ်ဦးချင်းစီ၏ တာဝန်ကို ရှင်းလင်းစေပါ—

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. ကိရိယာအသုံးပြုခွင့်များကို မတူကွဲပြားစွာ ပြင်ဆင်သတ်မှတ်ပါ

လိုအပ်သော ကိရိယာများကိုသာ ပေးပါ—

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. စွမ်းဆောင်ရည်ကို စောင့်ကြည့်ပါ

အေးဂျင့်များ များလာပါက—

- မြန်နှုန်းအတွက် `"strategy": "parallel"` (ပုံမှန်) ကို အသုံးပြုပါ
- ထုတ်လွှင့် အုပ်စုတစ်ခုလျှင် အေးဂျင့် 5–10 ဦးအတွင်း ကန့်သတ်ပါ
- ရိုးရှင်းသော အေးဂျင့်များအတွက် မြန်ဆန်သော မော်ဒယ်များကို အသုံးပြုပါ

### 5. မအောင်မြင်မှုများကို အလှပစွာ ကိုင်တွယ်ဖြေရှင်းပါ

အေးဂျင့်များသည် သီးခြားလွတ်လပ်စွာ မအောင်မြင်နိုင်ပါသည်။ အေးဂျင့်တစ်ခု၏ အမှားသည် အခြားများကို မတားဆီးပါ။

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## ကိုက်ညီမှု

### ပံ့ပိုးသူများ

လက်ရှိ ထုတ်လွှင့် အုပ်စုများသည် အောက်ပါအရာများနှင့် အလုပ်လုပ်ပါသည်—

- ✅ WhatsApp (အကောင်အထည်ဖော်ပြီး)
- 🚧 Telegram (စီစဉ်ထားသည်)
- 🚧 Discord (စီစဉ်ထားသည်)
- 🚧 Slack (စီစဉ်ထားသည်)

### Routing

ထုတ်လွှင့် အုပ်စုများသည် ရှိပြီးသား routing နှင့် တွဲဖက်အလုပ်လုပ်ပါသည်—

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: alfred သာ ပြန်ကြားသည် (ပုံမှန် routing)
- `GROUP_B`: agent1 နှင့် agent2 နှစ်ဦးစလုံး ပြန်ကြားသည် (ထုတ်လွှင့်)

**ဦးစားပေးမှု:** `broadcast` သည် `bindings` ထက် ဦးစားပေးပါသည်။

## ပြဿနာဖြေရှင်းခြင်း

### အေးဂျင့်များ မပြန်ကြားပါက

**စစ်ဆေးရန်:**

1. အေးဂျင့် ID များသည် `agents.list` တွင် ရှိနေပါသည်
2. Peer ID ဖော်မတ် မှန်ကန်ပါသည် (ဥပမာ— `120363403215116621@g.us`)
3. အေးဂျင့်များသည် deny lists များထဲတွင် မပါဝင်ပါ

**Debug:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### အေးဂျင့်တစ်ဦးသာ ပြန်ကြားနေပါက

**အကြောင်းရင်း:** Peer ID သည် `bindings` တွင် ရှိသော်လည်း `broadcast` တွင် မပါဝင်နိုင်ပါသည်။

**ဖြေရှင်းချက်:** ထုတ်လွှင့် ဖွဲ့စည်းမှုထဲသို့ ထည့်ပါ သို့မဟုတ် bindings မှ ဖယ်ရှားပါ။

### စွမ်းဆောင်ရည် ပြဿနာများ

**အေးဂျင့်များ များလျှင် နှေးကွေးပါက:**

- အုပ်စုတစ်ခုလျှင် အေးဂျင့်အရေအတွက်ကို လျှော့ချပါ
- ပေါ့ပါးသော မော်ဒယ်များကို အသုံးပြုပါ (opus အစား sonnet)
- sandbox စတင်ချိန်ကို စစ်ဆေးပါ

## ဥပမာများ

### ဥပမာ 1: ကုဒ် ပြန်လည်သုံးသပ် အဖွဲ့

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**အသုံးပြုသူ ပို့သည်:** ကုဒ် အပိုင်းအစ  
**ပြန်ကြားချက်များ:**

- code-formatter: "Indentation ကို ပြင်ပြီး type hints ထည့်ပြီးပါပြီ"
- security-scanner: "⚠️ လိုင်း 12 တွင် SQL injection အားနည်းချက်ရှိသည်"
- test-coverage: "Coverage 45% ဖြစ်ပြီး error cases အတွက် စမ်းသပ်မှုများ မရှိပါ"
- docs-checker: "function `process_data` အတွက် docstring မရှိပါ"

### ဥပမာ 2: ဘာသာစကားအများအပြား ပံ့ပိုးမှု

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API အညွှန်း

### Config Schema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### အကွက်များ

- `strategy` (မဖြစ်မနေ မလို): အေးဂျင့်များကို ကိုင်တွယ်ပုံ
  - `"parallel"` (ပုံမှန်): အေးဂျင့်အားလုံးကို တစ်ပြိုင်နက်တည်း ကိုင်တွယ်သည်
  - `"sequential"`: အေးဂျင့်များကို array အစဉ်လိုက် ကိုင်တွယ်သည်
- `[peerId]`: WhatsApp group JID၊ E.164 နံပါတ် သို့မဟုတ် အခြား peer ID
  - တန်ဖိုး: မက်ဆေ့ချ်များကို ကိုင်တွယ်ရမည့် အေးဂျင့် ID များ၏ အရေအတွက်စာရင်း

## ကန့်သတ်ချက်များ

1. **အများဆုံး အေးဂျင့်များ:** တင်းကျပ်သော ကန့်သတ်ချက် မရှိသော်လည်း အေးဂျင့် 10 ဦးကျော်ပါက နှေးကွေးနိုင်ပါသည်
2. **မျှဝေထားသော context:** အေးဂျင့်များသည် အခြားသူများ၏ ပြန်ကြားချက်များကို မမြင်နိုင်ပါ (ဒီဇိုင်းအရ)
3. **မက်ဆေ့ချ် အစဉ်အလာ:** အပြိုင် ပြန်ကြားချက်များသည် မည်သည့်အစဉ်ဖြင့်မဆို ရောက်ရှိနိုင်ပါသည်
4. **Rate limits:** အေးဂျင့်အားလုံးသည် WhatsApp rate limits တွင် တွက်ချက်ပါဝင်ပါသည်

## အနာဂတ် တိုးတက်မှုများ

စီစဉ်ထားသော လုပ်ဆောင်ချက်များ—

- [ ] မျှဝေထားသော context မုဒ် (အေးဂျင့်များသည် အချင်းချင်း၏ ပြန်ကြားချက်များကို မြင်နိုင်)
- [ ] အေးဂျင့် အညှိနှိုင်းမှု (အေးဂျင့်များ အချင်းချင်း အချက်ပြနိုင်)
- [ ] ဒိုင်နမစ် အေးဂျင့် ရွေးချယ်မှု (မက်ဆေ့ချ် အကြောင်းအရာအပေါ် အခြေခံ၍ ရွေးချယ်)
- [ ] အေးဂျင့် ဦးစားပေးမှုများ (အချို့ အေးဂျင့်များကို အရင်ပြန်ကြားစေခြင်း)

## ဆက်လက်ဖတ်ရှုရန်

- [Multi-Agent Configuration](/tools/multi-agent-sandbox-tools)
- [Routing Configuration](/channels/channel-routing)
- [Session Management](/concepts/sessions)
