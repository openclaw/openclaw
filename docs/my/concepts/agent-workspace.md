---
summary: "အေးဂျင့် Workspace — တည်နေရာ၊ ဖိုင်အလွှာအလေးအနက်၊ နှင့် အရန်သိမ်းဆည်းမဟာဗျူဟာ"
read_when:
  - အေးဂျင့် Workspace သို့မဟုတ် ၎င်း၏ ဖိုင်အလွှာအလေးအနက်ကို ရှင်းပြရန်လိုအပ်သောအခါ
  - အေးဂျင့် Workspace ကို အရန်သိမ်းဆည်းခြင်း သို့မဟုတ် ရွှေ့ပြောင်းရန်လိုအပ်သောအခါ
title: "Agent Workspace"
x-i18n:
  source_path: concepts/agent-workspace.md
  source_hash: d3cc655c58f00965
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:36Z
---

# Agent workspace

Workspace သည် အေးဂျင့်၏ အိမ်ဖြစ်သည်။ ဖိုင်ကိရိယာများနှင့် workspace context အတွက် အသုံးပြုသော တစ်ခုတည်းသော အလုပ်လုပ်ရာ ဒိုင်ရက်ထရီ ဖြစ်သည်။ ၎င်းကို ပုဂ္ဂိုလ်ရေးအဖြစ် ထိန်းသိမ်းပြီး မှတ်ဉာဏ်ကဲ့သို့ ဆက်ဆံသင့်သည်။

ဤအရာသည် config၊ အထောက်အထားများ၊ နှင့် ဆက်ရှင်များကို သိမ်းဆည်းသည့် `~/.openclaw/` နှင့် သီးခြားဖြစ်သည်။

**အရေးကြီးချက်:** Workspace သည် **မူလ cwd** ဖြစ်ပြီး hard sandbox မဟုတ်ပါ။ ကိရိယာများသည် relative path များကို workspace အပေါ်အခြေခံ၍ ဖြေရှင်းသော်လည်း sandboxing ကို မဖွင့်ထားပါက absolute path များက ဟို့စ်၏ အခြားနေရာများသို့ ဆက်လက်ရောက်ရှိနိုင်ပါသည်။ သီးခြားခွဲထားမှု လိုအပ်ပါက [`agents.defaults.sandbox`](/gateway/sandboxing) (နှင့်/သို့မဟုတ် အေးဂျင့်တစ်ခုချင်းစီအလိုက် sandbox config) ကို အသုံးပြုပါ။
Sandboxing ကို ဖွင့်ထားပြီး `workspaceAccess` သည် `"rw"` မဟုတ်ပါက ကိရိယာများသည် ဟို့စ် workspace မဟုတ်ဘဲ `~/.openclaw/sandboxes` အောက်ရှိ sandbox workspace အတွင်းတွင် လည်ပတ်ပါမည်။

## Default location

- Default: `~/.openclaw/workspace`
- `OPENCLAW_PROFILE` ကို သတ်မှတ်ထားပြီး `"default"` မဟုတ်ပါက default သည်
  `~/.openclaw/workspace-<profile>` ဖြစ်လာပါမည်။
- `~/.openclaw/openclaw.json` တွင် override ပြုလုပ်နိုင်ပါသည် —

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure`, သို့မဟုတ် `openclaw setup` ကို အသုံးပြုပါက
workspace ကို ဖန်တီးပြီး bootstrap ဖိုင်များ မရှိပါက seed လုပ်ပေးပါမည်။

Workspace ဖိုင်များကို ကိုယ်တိုင် စီမံခန့်ခွဲပြီးသားဖြစ်ပါက bootstrap ဖိုင်ဖန်တီးခြင်းကို ပိတ်နိုင်ပါသည် —

```json5
{ agent: { skipBootstrap: true } }
```

## Extra workspace folders

အဟောင်းတင်ထားသော install များတွင် `~/openclaw` ကို ဖန်တီးထားနိုင်ပါသည်။ Workspace ဒိုင်ရက်ထရီ များစွာကို တပြိုင်နက် ထားရှိထားပါက အတည်ပြုခြင်း (auth) သို့မဟုတ် state drift အတွင်း မရှင်းလင်းမှုများ ဖြစ်စေနိုင်ပါသည်၊ အကြောင်းမှာ တစ်ချိန်တည်းတွင် workspace တစ်ခုသာ အလုပ်လုပ်နေသောကြောင့် ဖြစ်သည်။

**အကြံပြုချက်:** အလုပ်လုပ်နေသော workspace တစ်ခုတည်းကိုသာ ထားရှိပါ။ အပိုဖိုလ်ဒါများကို မသုံးတော့ပါက archive လုပ်ပါ သို့မဟုတ် Trash သို့ ရွှေ့ပါ (ဥပမာ `trash ~/openclaw`)။
Workspace များကို ရည်ရွယ်ချက်ရှိရှိ များစွာ ထားရှိထားပါက `agents.defaults.workspace` သည် လက်ရှိ အသုံးပြုနေသော workspace ကို ညွှန်ပြနေကြောင်း သေချာစေပါ။

`openclaw doctor` သည် အပို workspace ဒိုင်ရက်ထရီများကို တွေ့ရှိပါက သတိပေးပါမည်။

## Workspace file map (ဖိုင်တစ်ခုချင်းစီ၏ အဓိပ္ပါယ်)

အောက်ပါဖိုင်များသည် OpenClaw က workspace အတွင်းတွင် မျှော်မှန်းထားသော စံဖိုင်များ ဖြစ်သည် —

- `AGENTS.md`
  - အေးဂျင့်အတွက် လည်ပတ်ညွှန်ကြားချက်များနှင့် မှတ်ဉာဏ်ကို မည်သို့ အသုံးပြုရမည်ကို ဖော်ပြထားသည်။
  - ဆက်ရှင်တိုင်း စတင်ချိန်တွင် load လုပ်သည်။
  - စည်းမျဉ်းများ၊ ဦးစားပေးချက်များ၊ “ဘယ်လို ပြုမူရမည်” ဆိုင်ရာ အသေးစိတ်များ ထည့်ရန် သင့်တော်သည်။

- `SOUL.md`
  - Persona၊ tone၊ နှင့် boundaries။
  - ဆက်ရှင်တိုင်း load လုပ်သည်။

- `USER.md`
  - အသုံးပြုသူသည် မည်သူဖြစ်သည်နှင့် မည်သို့ ခေါ်ဆိုရမည်ကို ဖော်ပြထားသည်။
  - ဆက်ရှင်တိုင်း load လုပ်သည်။

- `IDENTITY.md`
  - အေးဂျင့်၏ အမည်၊ vibe၊ နှင့် emoji။
  - Bootstrap ritual အတွင်း ဖန်တီး/အပ်ဒိတ် လုပ်သည်။

- `TOOLS.md`
  - သင့် local ကိရိယာများနှင့် အလေ့အကျင့်များအကြောင်း မှတ်စုများ။
  - ကိရိယာ အသုံးပြုနိုင်မှုကို မထိန်းချုပ်ပါ၊ လမ်းညွှန်အဖြစ်သာ ဖြစ်သည်။

- `HEARTBEAT.md`
  - Heartbeat run များအတွက် ရွေးချယ်နိုင်သော စစ်ဆေးစာရင်းအသေး။
  - Token burn မဖြစ်စေရန် တိုတောင်းစွာ ထားပါ။

- `BOOT.md`
  - Internal hooks ကို ဖွင့်ထားပါက gateway ပြန်စတင်ချိန်တွင် အကောင်အထည်ဖော်သော ရွေးချယ်နိုင်သော startup checklist။
  - တိုတောင်းစွာ ထားပါ၊ အပြင်ဘက်သို့ ပို့ရန် message tool ကို အသုံးပြုပါ။

- `BOOTSTRAP.md`
  - ပထမအကြိမ် လည်ပတ်သည့် ritual တစ်ကြိမ်သာ အသုံးပြုရန်။
  - အလုံးစုံ အသစ် workspace အတွက်သာ ဖန်တီးသည်။
  - Ritual ပြီးဆုံးပါက ဖျက်ပစ်ပါ။

- `memory/YYYY-MM-DD.md`
  - နေ့စဉ် မှတ်ဉာဏ် လော့ဂ် (တစ်နေ့လျှင် ဖိုင်တစ်ခု)။
  - ဆက်ရှင်စတင်ချိန်တွင် ယနေ့ + မနေ့က ဖိုင်များကို ဖတ်ရန် အကြံပြုပါသည်။

- `MEMORY.md` (optional)
  - ရွေးချယ်ထားသော ရေရှည်မှတ်ဉာဏ်။
  - အဓိက၊ ပုဂ္ဂိုလ်ရေး ဆက်ရှင်တွင်သာ load လုပ်ပါ (shared/group context များတွင် မလုပ်ပါ)။

Workflow နှင့် အလိုအလျောက် memory flush အကြောင်းကို [Memory](/concepts/memory) တွင် ကြည့်ပါ။

- `skills/` (optional)
  - Workspace သီးသန့် Skills။
  - အမည် တူညီပါက managed/bundled skills များကို override လုပ်ပါသည်။

- `canvas/` (optional)
  - နိုဒ် ပြသမှုများအတွက် Canvas UI ဖိုင်များ (ဥပမာ `canvas/index.html`)။

Bootstrap ဖိုင်တစ်ခုခု မရှိပါက OpenClaw သည် “missing file” marker ကို ဆက်ရှင်အတွင်း ထည့်သွင်းပြီး ဆက်လက် လည်ပတ်ပါမည်။ Bootstrap ဖိုင်ကြီးများကို ထည့်သွင်းရာတွင် truncate လုပ်ပါမည်။ ကန့်သတ်ချက်ကို `agents.defaults.bootstrapMaxChars` ဖြင့် ချိန်ညှိနိုင်ပါသည် (default: 20000)။
`openclaw setup` သည် ရှိပြီးသား ဖိုင်များကို မအစားထိုးဘဲ ပျောက်နေသော default များကို ပြန်လည် ဖန်တီးနိုင်ပါသည်။

## Workspace ထဲတွင် မပါဝင်သင့်သော အရာများ

အောက်ပါအရာများသည် `~/.openclaw/` အောက်တွင် တည်ရှိပြီး workspace repo ထဲသို့ မ commit လုပ်သင့်ပါ —

- `~/.openclaw/openclaw.json` (config)
- `~/.openclaw/credentials/` (OAuth tokens၊ API keys)
- `~/.openclaw/agents/<agentId>/sessions/` (session transcripts + metadata)
- `~/.openclaw/skills/` (managed skills)

Session များ သို့မဟုတ် config ကို ရွှေ့ပြောင်းရန် လိုအပ်ပါက သီးခြားစီ ကူးယူပြီး version control အပြင်ဘက်တွင် ထားရှိပါ။

## Git backup (အကြံပြုထားသော၊ ပုဂ္ဂိုလ်ရေး)

Workspace ကို ပုဂ္ဂိုလ်ရေး မှတ်ဉာဏ်အဖြစ် ဆက်ဆံပါ။ **ပုဂ္ဂိုလ်ရေး** git repo တစ်ခုထဲသို့ ထည့်ထားခြင်းဖြင့် အရန်သိမ်းဆည်းထားနိုင်ပြီး ပြန်လည်ရယူနိုင်ပါသည်။

Gateway လည်ပတ်နေသော စက်ပေါ်တွင် အောက်ပါအဆင့်များကို လုပ်ဆောင်ပါ (workspace သည် ထိုနေရာတွင် တည်ရှိပါသည်)။

### 1) Repo ကို စတင် initialize လုပ်ခြင်း

Git ထည့်သွင်းထားပါက အသစ်ဖန်တီးသော workspace များကို အလိုအလျောက် initialize လုပ်ပေးပါသည်။ ဤ workspace သည် repo မဖြစ်သေးပါက အောက်ပါအမိန့်ကို လုပ်ဆောင်ပါ —

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) Private remote တစ်ခု ထည့်ခြင်း (အစပြုသူများအတွက် လွယ်ကူသော ရွေးချယ်မှုများ)

Option A: GitHub web UI

1. GitHub တွင် **private** repository အသစ် တစ်ခု ဖန်တီးပါ။
2. README ဖြင့် initialize မလုပ်ပါ (merge conflict မဖြစ်စေရန်)။
3. HTTPS remote URL ကို ကူးယူပါ။
4. Remote ကို ထည့်ပြီး push လုပ်ပါ —

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Option B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Option C: GitLab web UI

1. GitLab တွင် **private** repository အသစ် တစ်ခု ဖန်တီးပါ။
2. README ဖြင့် initialize မလုပ်ပါ (merge conflict မဖြစ်စေရန်)။
3. HTTPS remote URL ကို ကူးယူပါ။
4. Remote ကို ထည့်ပြီး push လုပ်ပါ —

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) ဆက်လက် အပ်ဒိတ်များ

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## လျှို့ဝှက်ချက်များကို commit မလုပ်ပါနှင့်

Private repo ဖြစ်သော်လည်း workspace ထဲတွင် လျှို့ဝှက်ချက်များကို သိမ်းဆည်းခြင်းမှ ရှောင်ကြဉ်ပါ —

- API keys၊ OAuth tokens၊ စကားဝှက်များ သို့မဟုတ် ကိုယ်ရေးကိုယ်တာ အထောက်အထားများ။
- `~/.openclaw/` အောက်ရှိ အရာအားလုံး။
- Chat များ၏ raw dump များ သို့မဟုတ် အထူးအရေးကြီးသော attachment များ။

လျှို့ဝှက်ကိုးကားချက်များကို မဖြစ်မနေ သိမ်းဆည်းရပါက placeholder များကို အသုံးပြုပြီး အမှန်တကယ် လျှို့ဝှက်ချက်ကို အခြားနေရာတွင် ထားရှိပါ (password manager၊ environment variables၊ သို့မဟုတ် `~/.openclaw/`)။

အကြံပြုထားသော `.gitignore` starter —

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Workspace ကို စက်အသစ်သို့ ရွှေ့ပြောင်းခြင်း

1. Repo ကို လိုချင်သော path သို့ clone လုပ်ပါ (default `~/.openclaw/workspace`)။
2. `~/.openclaw/openclaw.json` ထဲတွင် `agents.defaults.workspace` ကို ထို path သို့ သတ်မှတ်ပါ။
3. ပျောက်နေသော ဖိုင်များကို seed လုပ်ရန် `openclaw setup --workspace <path>` ကို လုပ်ဆောင်ပါ။
4. Session များ လိုအပ်ပါက `~/.openclaw/agents/<agentId>/sessions/` ကို စက်ဟောင်းမှ သီးခြားစီ ကူးယူပါ။

## Advanced notes

- Multi-agent routing တွင် အေးဂျင့်တစ်ခုချင်းစီအလိုက် workspace မတူညီစွာ အသုံးပြုနိုင်ပါသည်။ Routing configuration အတွက်
  [Channel routing](/channels/channel-routing) ကို ကြည့်ပါ။
- `agents.defaults.sandbox` ကို ဖွင့်ထားပါက main မဟုတ်သော ဆက်ရှင်များသည် `agents.defaults.sandbox.workspaceRoot` အောက်ရှိ per-session sandbox workspaces များကို အသုံးပြုနိုင်ပါသည်။
