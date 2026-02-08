---
summary: "Skills ဖွဲ့စည်းပြင်ဆင်မှု စခီးမာနှင့် ဥပမာများ"
read_when:
  - Skills ဖွဲ့စည်းပြင်ဆင်မှုကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - bundled allowlist သို့မဟုတ် install အပြုအမူကို ချိန်ညှိခြင်း
title: "Skills Config"
x-i18n:
  source_path: tools/skills-config.md
  source_hash: e265c93da7856887
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:05Z
---

# Skills Config

Skills နှင့် သက်ဆိုင်သော ဖွဲ့စည်းပြင်ဆင်မှုအားလုံးသည် `~/.openclaw/openclaw.json` ထဲရှိ `skills` အောက်တွင် တည်ရှိသည်။

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: **bundled** skills များအတွက်သာ အသုံးပြုသည့် optional allowlist ဖြစ်သည်။ သတ်မှတ်ထားပါက
  စာရင်းထဲရှိ bundled skills များသာ အကျုံးဝင်မည်ဖြစ်ပြီး (managed/workspace skills များ မထိခိုက်ပါ)။
- `load.extraDirs`: စကင်လုပ်ရန် ထည့်သွင်းပေးထားသော skill ဒိုင်ရက်ထရီများ (အနိမ့်ဆုံး ဦးစားပေးအဆင့်)။
- `load.watch`: skill ဖိုလ်ဒါများကို စောင့်ကြည့်ပြီး skills snapshot ကို ပြန်လည်အသစ်ပြုလုပ်ခြင်း (မူလသတ်မှတ်ချက်: true)။
- `load.watchDebounceMs`: skill watcher ဖြစ်ရပ်များအတွက် debounce ကို မီလီစက္ကန့်ဖြင့် သတ်မှတ်ခြင်း (မူလသတ်မှတ်ချက်: 250)။
- `install.preferBrew`: ရနိုင်ပါက brew installer များကို ဦးစားပေးအသုံးပြုခြင်း (မူလသတ်မှတ်ချက်: true)။
- `install.nodeManager`: node installer အတွက် ဦးစားပေးရွေးချယ်မှု (`npm` | `pnpm` | `yarn` | `bun`, မူလသတ်မှတ်ချက်: npm)။
  ဤအချက်သည် **skill installs** များကိုသာ သက်ရောက်မှုရှိပြီး Gateway runtime သည် Node ဖြစ်နေရမည်ဖြစ်သည်
  (WhatsApp/Telegram အတွက် Bun ကို မအကြံပြုပါ)။
- `entries.<skillKey>`: skill တစ်ခုချင်းစီအလိုက် override များ။

Skill တစ်ခုချင်းစီအတွက် fields များ:

- `enabled`: bundled/installed ဖြစ်နေသော်လည်း skill တစ်ခုကို ပိတ်ရန် `false` ကို သတ်မှတ်နိုင်သည်။
- `env`: agent ကို run လုပ်စဉ် ထည့်သွင်းပေးမည့် environment variables (မတိုင်မီ သတ်မှတ်ထားပြီးသား မဟုတ်ပါကသာ)။
- `apiKey`: primary env var ကို ကြေညာထားသော skills များအတွက် optional အဆင်ပြေမှု။

## Notes

- `entries` အောက်ရှိ ကီးများသည် ပုံမှန်အားဖြင့် skill အမည်နှင့် တိုက်ရိုက်ကိုက်ညီသည်။ Skill တစ်ခုတွင်
  `metadata.openclaw.skillKey` ကို သတ်မှတ်ထားပါက ထိုကီးကို အသုံးပြုပါ။
- watcher ကို ဖွင့်ထားပါက skills အပြောင်းအလဲများကို နောက်လာမည့် agent turn တွင် သိရှိမည်ဖြစ်သည်။

### Sandboxed skills + env vars

ဆက်ရှင်တစ်ခုသည် **sandboxed** ဖြစ်နေသောအခါ skill process များကို Docker အတွင်းတွင် run လုပ်ပါသည်။ Sandbox သည်
ဟို့စ်၏ `process.env` ကို **အမွေဆက်ခံမထားပါ**။

အောက်ပါအနက် တစ်ခုကို အသုံးပြုပါ–

- `agents.defaults.sandbox.docker.env` (သို့မဟုတ် per-agent `agents.list[].sandbox.docker.env`)
- သင်၏ custom sandbox image ထဲတွင် env ကို bake လုပ်ထားခြင်း

Global `env` နှင့် `skills.entries.<skill>.env/apiKey` သည် **host** run များအတွက်သာ အသုံးဝင်ပါသည်။
