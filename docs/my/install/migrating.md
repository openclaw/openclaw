---
summary: "စက်တစ်လုံးမှ အခြားတစ်လုံးသို့ OpenClaw ထည့်သွင်းမှုကို ရွှေ့ပြောင်း (migrate) လုပ်ခြင်း"
read_when:
  - OpenClaw ကို လက်ပ်တော့/ဆာဗာ အသစ်သို့ ရွှေ့နေသည့်အခါ
  - ဆက်ရှင်များ၊ အတည်ပြုချက် (auth) နှင့် ချန်နယ် လော့ဂ်အင်များ (WhatsApp စသည်) ကို ထိန်းသိမ်းထားချင်သည့်အခါ
title: "Migration လမ်းညွှန်"
---

# OpenClaw ကို စက်အသစ်သို့ ရွှေ့ပြောင်းခြင်း

ဤလမ်းညွှန်သည် **onboarding ကို ပြန်မလုပ်ဘဲ** OpenClaw Gateway ကို စက်တစ်လုံးမှ အခြားတစ်လုံးသို့ ရွှေ့ပြောင်းပေးပါသည်။

အယူအဆအရ Migration သည် ရိုးရှင်းပါသည်—

- **state directory** ကို ကူးယူပါ (`$OPENCLAW_STATE_DIR`, ပုံမှန်အားဖြင့်: `~/.openclaw/`) — config၊ auth၊ sessions နှင့် channel state များ ပါဝင်ပါသည်။
- သင့် **workspace** ကို ကူးယူပါ (`~/.openclaw/workspace/` ပုံမှန်) — သင့် agent ဖိုင်များ (memory၊ prompts စသည်) ပါဝင်ပါသည်။

သို့သော် **profiles**, **permissions**, နှင့် **partial copies** ကြောင့် ဖြစ်တတ်သော footgun များ ရှိပါသည်။

## စတင်မီ (သင် ရွှေ့ပြောင်းမည့် အရာများ)

### 1. သင့် state directory ကို သတ်မှတ်ပါ

အများစုသော ထည့်သွင်းမှုများတွင် ပုံမှန်ကို အသုံးပြုပါသည်—

- **State dir:** `~/.openclaw/`

သို့သော် အောက်ပါအရာများကို အသုံးပြုပါက မတူနိုင်ပါ—

- `--profile <name>` (မကြာခဏ `~/.openclaw-<profile>/` အဖြစ် ပြောင်းလဲတတ်သည်)
- `OPENCLAW_STATE_DIR=/some/path`

မသေချာပါက **ဟောင်းသော** စက်ပေါ်တွင် အောက်ပါအမိန့်ကို chạy ပါ—

```bash
openclaw status
```

Look for mentions of `OPENCLAW_STATE_DIR` / profile in the output. If you run multiple gateways, repeat for each profile.

### 2. သင့် workspace ကို သတ်မှတ်ပါ

အများအားဖြင့် အသုံးများသော ပုံမှန်များ—

- `~/.openclaw/workspace/` (အကြံပြုထားသော workspace)
- သင်ကိုယ်တိုင် ဖန်တီးထားသော custom folder တစ်ခု

Workspace သည် `MEMORY.md`, `USER.md`, နှင့် `memory/*.md` ကဲ့သို့သော ဖိုင်များ တည်ရှိရာ နေရာဖြစ်ပါသည်။

### 3. ဘာတွေကို ထိန်းသိမ်းထားမလဲ ဆိုတာကို နားလည်ပါ

state dir နှင့် workspace **နှစ်ခုလုံး** ကို ကူးယူပါက အောက်ပါအရာများကို ဆက်လက် ထိန်းသိမ်းနိုင်ပါသည်—

- Gateway configuration (`openclaw.json`)
- Auth profiles / API keys / OAuth tokens
- Session history + agent state
- Channel state (ဥပမာ WhatsApp လော့ဂ်အင်/ဆက်ရှင်)
- Workspace ဖိုင်များ (memory၊ skills notes စသည်)

workspace ကို **တစ်ခုတည်းသာ** ကူးယူပါက (ဥပမာ Git ဖြင့်) အောက်ပါအရာများကို **မထိန်းသိမ်းနိုင်ပါ**—

- sessions
- credentials
- channel logins

၎င်းတို့သည် `$OPENCLAW_STATE_DIR` အောက်တွင် ရှိပါသည်။

## Migration လုပ်ဆောင်ရမည့် အဆင့်များ (အကြံပြု)

### အဆင့် 0 — အရန်ကူးယူခြင်း (ဟောင်းသော စက်)

**ဟောင်းသော** စက်ပေါ်တွင် ဖိုင်များကို ကူးယူနေစဉ် ပြောင်းလဲမသွားစေရန် Gateway ကို အရင် ရပ်တန့်ပါ—

```bash
openclaw gateway stop
```

(ရွေးချယ်နိုင်သော်လည်း အကြံပြုသည်) state dir နှင့် workspace ကို archive လုပ်ပါ—

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

profile/state dir များ အများကြီးရှိပါက (ဥပမာ `~/.openclaw-main`, `~/.openclaw-work`) တစ်ခုချင်းစီကို archive လုပ်ပါ။

### အဆင့် 1 — စက်အသစ်တွင် OpenClaw ကို ထည့်သွင်းပါ

**စက်အသစ်** ပေါ်တွင် CLI (လိုအပ်ပါက Node) ကို ထည့်သွင်းပါ—

- ကြည့်ရန်: [Install](/install)

ဤအဆင့်တွင် onboarding မှ `~/.openclaw/` အသစ်တစ်ခု ဖန်တီးသွားလျှင်လည်း ပြဿနာမရှိပါ — နောက်အဆင့်တွင် ထပ်ရေးအစားထိုးပါမည်။

### အဆင့် 2 — state dir + workspace ကို စက်အသစ်သို့ ကူးယူပါ

**နှစ်ခုလုံး** ကို ကူးယူပါ—

- `$OPENCLAW_STATE_DIR` (ပုံမှန် `~/.openclaw/`)
- သင့် workspace (ပုံမှန် `~/.openclaw/workspace/`)

အများအားဖြင့် အသုံးများသော နည်းလမ်းများ—

- `scp` tarball များကို ကူးယူပြီး extract လုပ်ခြင်း
- `rsync -a` ဖြင့် SSH ကနေ ကူးယူခြင်း
- external drive အသုံးပြုခြင်း

ကူးယူပြီးနောက် အောက်ပါအချက်များကို သေချာစစ်ဆေးပါ—

- Hidden directories များပါဝင်နေခြင်း (ဥပမာ `.openclaw/`)
- Gateway ကို chạy မည့် user အတွက် ဖိုင်ပိုင်ဆိုင်မှု (ownership) မှန်ကန်နေခြင်း

### အဆင့် 3 — Doctor ကို chạy လုပ်ပါ (migrations + service repair)

**စက်အသစ်** ပေါ်တွင်—

```bash
openclaw doctor
```

Doctor က “အန္တရာယ်ကင်းပြီး ပုံမှန်” command ပါ။ ဒါက services တွေကို ပြုပြင်ပေးပြီး config migrations ကို အသုံးချကာ မကိုက်ညီမှုတွေကို သတိပေးပါတယ်။

ထို့နောက်—

```bash
openclaw gateway restart
openclaw status
```

## အဖြစ်များသော footgun များ (နှင့် ရှောင်ရှားနည်း)

### Footgun: profile / state-dir မကိုက်ညီခြင်း

ဟောင်းသော gateway ကို profile (သို့) `OPENCLAW_STATE_DIR` ဖြင့် chạy လုပ်ထားပြီး စက်အသစ်တွင် မတူညီသော profile ကို အသုံးပြုပါက အောက်ပါ လက္ခဏာများကို တွေ့ရနိုင်ပါသည်—

- config ပြောင်းလဲမှုများ မသက်ရောက်ခြင်း
- channels မတွေ့ရခြင်း / logout ဖြစ်နေခြင်း
- session history အလွတ် ဖြစ်နေခြင်း

ဖြေရှင်းနည်း: သင် ရွှေ့ပြောင်းထားသော **တူညီသော** profile/state dir ကို အသုံးပြု၍ gateway/service ကို chạy လုပ်ပြီး အောက်ပါအမိန့်ကို ထပ် chạy ပါ—

```bash
openclaw doctor
```

### Footgun: `openclaw.json` ကိုသာ ကူးယူခြင်း

`openclaw.json` is not enough. Many providers store state under:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

`$OPENCLAW_STATE_DIR` folder တစ်ခုလုံးကို အမြဲ ရွှေ့ပြောင်းပါ။

### Footgun: permissions / ownership

root ဖြင့် ကူးယူခဲ့ခြင်း သို့မဟုတ် user ပြောင်းလဲထားပါက Gateway သည် credentials/sessions များကို ဖတ်မရနိုင်ပါ။

ဖြေရှင်းနည်း: state dir နှင့် workspace ကို Gateway ကို chạy မည့် user ပိုင်ဆိုင်နေကြောင်း သေချာစေပါ။

### Footgun: remote/local mode အကြား ရွှေ့ပြောင်းခြင်း

- သင့် UI (WebUI/TUI) သည် **remote** Gateway ကို ညွှန်ပြထားပါက session store + workspace ကို remote host ပိုင်ဆိုင်ပါသည်။
- သင့် လက်ပ်တော့ကို ရွှေ့ပြောင်းခြင်းဖြင့် remote Gateway ၏ state ကို မရွှေ့ပြောင်းနိုင်ပါ။

remote mode ဖြစ်ပါက **gateway host** ကို ရွှေ့ပြောင်းပါ။

### Footgun: အရန်ကူးယူမှုများအတွင်း လျှို့ဝှက်ချက်များ

`$OPENCLAW_STATE_DIR` contains secrets (API keys, OAuth tokens, WhatsApp creds). Treat backups like production secrets:

- encrypted အဖြစ် သိမ်းဆည်းပါ
- မလုံခြုံသော ချန်နယ်များမှ မမျှဝေပါနှင့်
- ထိတွေ့မှုရှိနိုင်သည်ဟု သံသယရှိပါက keys များကို rotate လုပ်ပါ

## စစ်ဆေးရန် checklist

စက်အသစ်ပေါ်တွင် အောက်ပါအချက်များကို အတည်ပြုပါ—

- `openclaw status` မှ Gateway chạy နေကြောင်း ပြသခြင်း
- Channels များ ဆက်လက် ချိတ်ဆက်ထားခြင်း (ဥပမာ WhatsApp ကို ပြန် pair မလုပ်ရ)
- Dashboard ဖွင့်လို့ရပြီး ရှိပြီးသား sessions များကို ပြသခြင်း
- Workspace ဖိုင်များ (memory၊ configs) ရှိနေခြင်း

## ဆက်စပ်အကြောင်းအရာများ

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [OpenClaw သည် ၎င်း၏ ဒေတာများကို ဘယ်မှာ သိမ်းဆည်းထားသလဲ?](/help/faq#where-does-openclaw-store-its-data)
