---
title: "Skills ဖန်တီးခြင်း"
x-i18n:
  source_path: tools/creating-skills.md
  source_hash: ad801da34fe361ff
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:59Z
---

# စိတ်ကြိုက် Skills ဖန်တီးခြင်း 🛠

OpenClaw ကို လွယ်ကူစွာ တိုးချဲ့နိုင်ရန် ဒီဇိုင်းပြုလုပ်ထားပါသည်။ "Skills" သည် သင့်အကူအညီပေးစနစ်တွင် လုပ်ဆောင်နိုင်စွမ်းအသစ်များ ထည့်သွင်းရန် အဓိကနည်းလမ်းဖြစ်ပါသည်။

## Skill ဆိုတာဘာလဲ?

Skill တစ်ခုဆိုသည်မှာ `SKILL.md` ဖိုင်တစ်ခု (LLM သို့ ညွှန်ကြားချက်များနှင့် ကိရိယာ သတ်မှတ်ချက်များ ပေးသော ဖိုင်) ကို ပါဝင်ထားသော ဒိုင်ရက်ထရီတစ်ခုဖြစ်ပြီး၊ လိုအပ်ပါက စကရစ်များ သို့မဟုတ် အရင်းအမြစ်များကိုလည်း ထပ်မံပါဝင်နိုင်ပါသည်။

## အဆင့်လိုက် လမ်းညွှန်: သင့်ပထမဆုံး Skill

### 1. ဒိုင်ရက်ထရီ ဖန်တီးပါ

Skills များသည် သင့် workspace အတွင်းတွင် ရှိပြီး ပုံမှန်အားဖြင့် `~/.openclaw/workspace/skills/` ဖြစ်ပါသည်။ သင့် Skill အတွက် ဖိုလ်ဒါအသစ်တစ်ခု ဖန်တီးပါ–

```bash
mkdir -p ~/.openclaw/workspace/skills/hello-world
```

### 2. `SKILL.md` ကို သတ်မှတ်ပါ

ထိုဒိုင်ရက်ထရီအတွင်း `SKILL.md` ဖိုင်တစ်ခု ဖန်တီးပါ။ ဤဖိုင်သည် metadata အတွက် YAML frontmatter ကို အသုံးပြုပြီး၊ ညွှန်ကြားချက်များအတွက် Markdown ကို အသုံးပြုပါသည်။

```markdown
---
name: hello_world
description: A simple skill that says hello.
---

# Hello World Skill

When the user asks for a greeting, use the `echo` tool to say "Hello from your custom skill!".
```

### 3. Tools များ ထည့်သွင်းပါ (ရွေးချယ်နိုင်)

Frontmatter အတွင်း စိတ်ကြိုက် tool များကို သတ်မှတ်နိုင်သလို၊ agent ကို ရှိပြီးသား system tools များ (ဥပမာ `bash` သို့မဟုတ် `browser`) ကို အသုံးပြုရန်လည်း ညွှန်ကြားနိုင်ပါသည်။

### 4. OpenClaw ကို Refresh လုပ်ပါ

သင့် agent ကို "refresh skills" လုပ်ရန် မေးမြန်းပါ သို့မဟုတ် Gateway ကို ပြန်လည်စတင်ပါ။ OpenClaw သည် ဒိုင်ရက်ထရီအသစ်ကို ရှာဖွေတွေ့ရှိပြီး `SKILL.md` ကို index လုပ်ပါလိမ့်မည်။

## အကောင်းဆုံး လေ့လာကျင့်သုံးရန် အချက်များ

- **တိုတောင်းစွာ ရေးသားပါ**: မော်ဒယ်ကို _ဘာကို_ လုပ်ရမည်ဆိုသည်ကိုသာ ညွှန်ကြားပါ၊ AI အဖြစ် ဘယ်လို ဖြစ်ရမည်ကို မရေးပါနှင့်။
- **လုံခြုံရေးကို ဦးစားပေးပါ**: သင့် Skill တွင် `bash` ကို အသုံးပြုပါက၊ မယုံကြည်ရသော အသုံးပြုသူ input များမှ arbitrary command injection မဖြစ်ပေါ်စေရန် prompt များကို သေချာစွာ ထိန်းချုပ်ပါ။
- **ဒေသတွင်း စမ်းသပ်ပါ**: `openclaw agent --message "use my new skill"` ကို အသုံးပြု၍ စမ်းသပ်ပါ။

## မျှဝေထားသော Skills

Skills များကို [ClawHub](https://clawhub.com) တွင် ကြည့်ရှုနိုင်ပြီး ပါဝင်ပံ့ပိုးနိုင်ပါသည်။
