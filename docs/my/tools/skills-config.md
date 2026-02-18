---
summary: "Skills ဖွဲ့စည်းပြင်ဆင်မှု စခီးမာနှင့် ဥပမာများ"
read_when:
  - Skills ဖွဲ့စည်းပြင်ဆင်မှုကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း
  - bundled allowlist သို့မဟုတ် install အပြုအမူကို ချိန်ညှိခြင်း
title: "Skills Config"
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

- `allowBundled`: optional allowlist for **bundled** skills only. When set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).
- `load.extraDirs`: စကင်လုပ်ရန် ထည့်သွင်းပေးထားသော skill ဒိုင်ရက်ထရီများ (အနိမ့်ဆုံး ဦးစားပေးအဆင့်)။
- `load.watch`: skill ဖိုလ်ဒါများကို စောင့်ကြည့်ပြီး skills snapshot ကို ပြန်လည်အသစ်ပြုလုပ်ခြင်း (မူလသတ်မှတ်ချက်: true)။
- `load.watchDebounceMs`: skill watcher ဖြစ်ရပ်များအတွက် debounce ကို မီလီစက္ကန့်ဖြင့် သတ်မှတ်ခြင်း (မူလသတ်မှတ်ချက်: 250)။
- `install.preferBrew`: ရနိုင်ပါက brew installer များကို ဦးစားပေးအသုံးပြုခြင်း (မူလသတ်မှတ်ချက်: true)။
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn` | `bun`, default: npm).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun not recommended for WhatsApp/Telegram).
- `entries.<skillKey>`: per-skill overrides.

Skill တစ်ခုချင်းစီအတွက် fields များ:

- `enabled`: bundled/installed ဖြစ်နေသော်လည်း skill တစ်ခုကို ပိတ်ရန် `false` ကို သတ်မှတ်နိုင်သည်။
- `env`: agent ကို run လုပ်စဉ် ထည့်သွင်းပေးမည့် environment variables (မတိုင်မီ သတ်မှတ်ထားပြီးသား မဟုတ်ပါကသာ)။
- `apiKey`: primary env var ကို ကြေညာထားသော skills များအတွက် optional အဆင်ပြေမှု။

## Notes

- Keys under `entries` map to the skill name by default. If a skill defines
  `metadata.openclaw.skillKey`, use that key instead.
- watcher ကို ဖွင့်ထားပါက skills အပြောင်းအလဲများကို နောက်လာမည့် agent turn တွင် သိရှိမည်ဖြစ်သည်။

### Sandboxed skills + env vars

When a session is **sandboxed**, skill processes run inside Docker. The sandbox
does **not** inherit the host `process.env`.

အောက်ပါအနက် တစ်ခုကို အသုံးပြုပါ–

- `agents.defaults.sandbox.docker.env` (သို့မဟုတ် per-agent `agents.list[].sandbox.docker.env`)
- သင်၏ custom sandbox image ထဲတွင် env ကို bake လုပ်ထားခြင်း

Global `env` and `skills.entries.<skill>.env/apiKey` apply to **host** runs only.
