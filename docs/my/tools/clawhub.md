---
summary: "ClawHub လမ်းညွှန် — အများပြည်သူ အသုံးပြုနိုင်သော skills စာရင်းသွင်းမှု + CLI လုပ်ငန်းစဉ်များ"
read_when:
  - ClawHub ကို အသုံးပြုသူအသစ်များထံ မိတ်ဆက်ပေးသည့်အခါ
  - Skills များကို ထည့်သွင်းခြင်း၊ ရှာဖွေခြင်း သို့မဟုတ် ထုတ်ဝေခြင်း
  - ClawHub CLI flags များနှင့် sync လုပ်ဆောင်ပုံကို ရှင်းပြရာတွင်
title: "ClawHub"
x-i18n:
  source_path: tools/clawhub.md
  source_hash: b572473a11246357
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:33Z
---

# ClawHub

ClawHub သည် **OpenClaw အတွက် အများပြည်သူ အသုံးပြုနိုင်သော skill registry** ဖြစ်သည်။ ၎င်းသည် အခမဲ့ ဝန်ဆောင်မှုတစ်ခုဖြစ်ပြီး skill အားလုံးကို အများပြည်သူမြင်နိုင်၊ ဖွင့်လှစ်ထားပြီး မျှဝေခြင်းနှင့် ပြန်လည်အသုံးချခြင်းအတွက် ဖြစ်သည်။ Skill တစ်ခုဆိုသည်မှာ `SKILL.md` ဖိုင် (နှင့် ထောက်ပံ့ပေးသည့် စာသားဖိုင်များ) ပါဝင်သော ဖိုလ်ဒါတစ်ခုသာ ဖြစ်ပါသည်။ Web app တွင် skills များကို ကြည့်ရှုနိုင်သလို CLI ကို အသုံးပြုပြီး ရှာဖွေခြင်း၊ ထည့်သွင်းခြင်း၊ အပ်ဒိတ်လုပ်ခြင်း နှင့် ထုတ်ဝေခြင်းတို့ကို လုပ်ဆောင်နိုင်ပါသည်။

ဆိုက်: [clawhub.ai](https://clawhub.ai)

## ClawHub သည် မည်သို့သောအရာဖြစ်သနည်း

- OpenClaw skills များအတွက် အများပြည်သူ registry တစ်ခု။
- Skill bundle များနှင့် metadata များကို ဗားရှင်းအလိုက် သိမ်းဆည်းထားသော စတိုး။
- ရှာဖွေမှု၊ တဂ်များနှင့် အသုံးပြုမှု လက္ခဏာများအတွက် discovery မျက်နှာပြင်။

## အလုပ်လုပ်ပုံ

1. အသုံးပြုသူတစ်ဦးသည် skill bundle (ဖိုင်များ + metadata) ကို ထုတ်ဝေသည်။
2. ClawHub သည် bundle ကို သိမ်းဆည်းပြီး metadata ကို ခွဲခြမ်းစိတ်ဖြာကာ ဗားရှင်းတစ်ခု သတ်မှတ်ပေးသည်။
3. Registry သည် skill ကို ရှာဖွေမှုနှင့် discovery အတွက် index ပြုလုပ်သည်။
4. အသုံးပြုသူများသည် OpenClaw အတွင်း skills များကို ကြည့်ရှု၊ ဒေါင်းလုဒ်နှင့် ထည့်သွင်းနိုင်သည်။

## သင်လုပ်ဆောင်နိုင်သောအရာများ

- Skill အသစ်များနှင့် ရှိပြီးသား skill များ၏ ဗားရှင်းအသစ်များကို ထုတ်ဝေခြင်း။
- အမည်၊ တဂ်များ သို့မဟုတ် ရှာဖွေမှုဖြင့် skills များကို ရှာဖွေခြင်း။
- Skill bundle များကို ဒေါင်းလုဒ်လုပ်၍ ဖိုင်များကို စစ်ဆေးကြည့်ရှုခြင်း။
- အန္တရာယ်ရှိ သို့မဟုတ် မသင့်လျော်သော skills များကို တိုင်ကြားခြင်း။
- Moderator ဖြစ်ပါက ဖျောက်ထားခြင်း၊ ပြန်ဖော်ခြင်း၊ ဖျက်ခြင်း သို့မဟုတ် ပိတ်ပင်ခြင်း။

## မည်သူများအတွက် ရည်ရွယ်သနည်း (အစပြုသူများအတွက် အဆင်ပြေ)

သင်၏ OpenClaw agent ထဲသို့ စွမ်းဆောင်ရည်အသစ်များ ထည့်ချင်ပါက ClawHub သည် skills များကို ရှာဖွေ၍ ထည့်သွင်းရန် အလွယ်ကူဆုံး နည်းလမ်းဖြစ်ပါသည်။ Backend အလုပ်လုပ်ပုံကို သိရန် မလိုအပ်ပါ။ သင်သည်—

- သဘာဝဘာသာစကားဖြင့် skills များကို ရှာဖွေခြင်း။
- Skill တစ်ခုကို သင့် workspace ထဲသို့ ထည့်သွင်းခြင်း။
- အမိန့်တစ်ခုဖြင့် နောက်မှ skills များကို အပ်ဒိတ်လုပ်ခြင်း။
- သင့်ကိုယ်ပိုင် skills များကို ထုတ်ဝေခြင်းဖြင့် အရန်သိမ်းဆည်းခြင်း။

## အမြန်စတင်ရန် (နည်းပညာမလို)

1. CLI ကို ထည့်သွင်းပါ (နောက်အပိုင်းကို ကြည့်ပါ)။
2. သင်လိုအပ်သည့်အရာကို ရှာဖွေပါ—
   - `clawhub search "calendar"`
3. Skill တစ်ခုကို ထည့်သွင်းပါ—
   - `clawhub install <skill-slug>`
4. Skill အသစ်ကို သိရှိစေရန် OpenClaw session အသစ်တစ်ခု စတင်ပါ။

## CLI ကို ထည့်သွင်းခြင်း

အောက်ပါတစ်ခုကို ရွေးချယ်ပါ—

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## OpenClaw နှင့် မည်သို့ ကိုက်ညီသနည်း

မူလအနေဖြင့် CLI သည် skills များကို သင့်လက်ရှိ အလုပ်လုပ်နေသော လမ်းကြောင်းအောက်ရှိ `./skills` ထဲသို့ ထည့်သွင်းပါသည်။ OpenClaw workspace တစ်ခုကို ဖွဲ့စည်းထားပါက `clawhub` သည် `--workdir` (သို့မဟုတ် `CLAWHUB_WORKDIR`) ကို override မလုပ်ထားလျှင် ထို workspace ကို fallback လုပ်ပါသည်။ OpenClaw သည် workspace skills များကို `<workspace>/skills` မှ load လုပ်ပြီး **နောက်** session တွင်သာ အသက်ဝင်ပါမည်။ သင် `~/.openclaw/skills` သို့မဟုတ် bundled skills များကို အသုံးပြုနေပြီးသားဖြစ်ပါက workspace skills များကို ဦးစားပေးပါသည်။

Skills များကို မည်သို့ load လုပ်သည်၊ မျှဝေသည်၊ gate လုပ်သည်တို့၏ အသေးစိတ်ကို
[Skills](/tools/skills) တွင် ကြည့်ပါ။

## Skill စနစ် အကျဉ်းချုပ်

Skill ဆိုသည်မှာ OpenClaw ကို အလုပ်တစ်ခုကို လုပ်ဆောင်နိုင်ရန် သင်ကြားပေးသော ဗားရှင်းအလိုက် စုစည်းထားသည့် ဖိုင် bundle တစ်ခုဖြစ်သည်။ ထုတ်ဝေမှုတိုင်းသည် ဗားရှင်းအသစ်တစ်ခု ဖန်တီးပြီး registry သည် အသုံးပြုသူများ ပြောင်းလဲမှုများကို စစ်ဆေးနိုင်ရန် ဗားရှင်းသမိုင်းကို သိမ်းဆည်းထားပါသည်။

ပုံမှန် skill တစ်ခုတွင်—

- အဓိက ဖော်ပြချက်နှင့် အသုံးပြုနည်းပါဝင်သော `SKILL.md` ဖိုင်။
- Skill အသုံးပြုရန် လိုအပ်သည့် optional config များ၊ script များ သို့မဟုတ် ထောက်ပံ့ဖိုင်များ။
- တဂ်များ၊ အကျဉ်းချုပ်၊ ထည့်သွင်းလိုအပ်ချက်များကဲ့သို့ metadata များ။

ClawHub သည် metadata ကို အသုံးပြု၍ discovery ကို ပံ့ပိုးပြီး skill စွမ်းရည်များကို လုံခြုံစွာ ဖော်ပြပါသည်။ Registry သည် star များ၊ download များကဲ့သို့ အသုံးပြုမှု လက္ခဏာများကိုလည်း ခြေရာခံကာ အဆင့်သတ်မှတ်ခြင်းနှင့် မြင်သာမှုကို တိုးတက်စေပါသည်။

## ဝန်ဆောင်မှုမှ ပံ့ပိုးသည့် အင်္ဂါရပ်များ

- Skills များနှင့် ၎င်းတို့၏ `SKILL.md` အကြောင်းအရာများကို **အများပြည်သူကြည့်ရှုနိုင်ခြင်း**။
- Keyword များသာမက embeddings (vector search) ဖြင့် လုပ်ဆောင်သော **ရှာဖွေမှု**။
- **Versioning** — semver၊ changelog များနှင့် `latest` အပါအဝင် တဂ်များ။
- ဗားရှင်းတစ်ခုချင်းစီအလိုက် zip ဖြင့် **ဒေါင်းလုဒ်**။
- လူထုအကြံပြုချက်အတွက် **Stars နှင့် comments**။
- အတည်ပြုခြင်းနှင့် audit များအတွက် **Moderation hooks**။
- အလိုအလျောက်လုပ်ငန်းစဉ်များနှင့် scripting အတွက် **CLI-friendly API**။

## လုံခြုံရေးနှင့် moderation

ClawHub သည် မူလအားဖြင့် ဖွင့်လှစ်ထားပါသည်။ မည်သူမဆို skills များကို upload လုပ်နိုင်သော်လည်း ထုတ်ဝေရန် GitHub အကောင့်သည် အနည်းဆုံး တစ်ပတ်အရွယ် ရှိရပါမည်။ ဤအချက်သည် တရားဝင် ပါဝင်ကူညီသူများကို မတားဆီးဘဲ အလွဲသုံးစားမှုကို လျှော့ချပေးပါသည်။

တိုင်ကြားခြင်းနှင့် moderation—

- လက်မှတ်ထိုးဝင်ရောက်ထားသော အသုံးပြုသူ မည်သူမဆို skill တစ်ခုကို တိုင်ကြားနိုင်သည်။
- တိုင်ကြားရသည့် အကြောင်းရင်းများကို မဖြစ်မနေ ထည့်သွင်းရပြီး မှတ်တမ်းတင်ထားသည်။
- အသုံးပြုသူတစ်ဦးလျှင် တစ်ချိန်တည်းတွင် active reports ၂၀ ခုအထိသာ ရှိနိုင်သည်။
- မတူညီသော တိုင်ကြားချက် ၃ ခုကျော် ရရှိပါက skill ကို မူလအားဖြင့် အလိုအလျောက် ဖျောက်ထားမည်။
- Moderators များသည် ဖျောက်ထားသော skills များကို ကြည့်ရှု၊ ပြန်ဖော်၊ ဖျက် သို့မဟုတ် အသုံးပြုသူများကို ပိတ်ပင်နိုင်သည်။
- Report feature ကို အလွဲသုံးစားလုပ်ပါက အကောင့်ပိတ်ပင်ခြင်း ခံရနိုင်သည်။

Moderator ဖြစ်ရန် စိတ်ဝင်စားပါသလား။ OpenClaw Discord တွင် မေးမြန်းပြီး moderator သို့မဟုတ် maintainer တစ်ဦးကို ဆက်သွယ်ပါ။

## CLI အမိန့်များနှင့် ပါရာမီတာများ

Global options (အမိန့်အားလုံးတွင် အသုံးချနိုင်):

- `--workdir <dir>`: အလုပ်လုပ်မည့် လမ်းကြောင်း (မူလ: လက်ရှိ dir; OpenClaw workspace ကို fallback လုပ်သည်)။
- `--dir <dir>`: Workdir နှင့် ဆက်စပ်သော skills directory (မူလ: `skills`)။
- `--site <url>`: Site base URL (browser login)။
- `--registry <url>`: Registry API base URL။
- `--no-input`: Prompt များကို ပိတ်ထားခြင်း (non-interactive)။
- `-V, --cli-version`: CLI ဗားရှင်းကို ပြသခြင်း။

Auth:

- `clawhub login` (browser flow) သို့မဟုတ် `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Options:

- `--token <token>`: API token ကို ကူးထည့်ခြင်း။
- `--label <label>`: Browser login tokens အတွက် သိမ်းဆည်းမည့် label (မူလ: `CLI token`)။
- `--no-browser`: Browser မဖွင့်ပါ ( `--token` လိုအပ်သည်)။

Search:

- `clawhub search "query"`
- `--limit <n>`: ရလဒ် အများဆုံးအရေအတွက်။

Install:

- `clawhub install <slug>`
- `--version <version>`: သတ်မှတ်ထားသော ဗားရှင်းတစ်ခုကို ထည့်သွင်းခြင်း။
- `--force`: ဖိုလ်ဒါ ရှိပြီးသားဖြစ်ပါက overwrite လုပ်ခြင်း။

Update:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: သတ်မှတ်ထားသော ဗားရှင်းသို့ အပ်ဒိတ်လုပ်ခြင်း (slug တစ်ခုတည်းသာ)။
- `--force`: Local ဖိုင်များသည် ထုတ်ဝေထားသော ဗားရှင်း မည်သည့်တစ်ခုနှင့်မှ မကိုက်ညီပါက overwrite လုပ်ခြင်း။

List:

- `clawhub list` (`.clawhub/lock.json` ကို ဖတ်သည်)

Publish:

- `clawhub publish <path>`
- `--slug <slug>`: Skill slug။
- `--name <name>`: ပြသမည့် အမည်။
- `--version <version>`: Semver ဗားရှင်း။
- `--changelog <text>`: Changelog စာသား (ဗလာဖြစ်နိုင်)။
- `--tags <tags>`: ကော်မာဖြင့် ခွဲထားသော တဂ်များ (မူလ: `latest`)။

Delete/undelete (owner/admin များသာ):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Sync (local skills များကို scan လုပ်ပြီး အသစ်/အပ်ဒိတ်များကို ထုတ်ဝေ):

- `clawhub sync`
- `--root <dir...>`: အပို scan roots များ။
- `--all`: Prompt မပါဘဲ အားလုံး upload လုပ်ခြင်း။
- `--dry-run`: ဘာတွေ upload လုပ်မည်ကို ပြသခြင်း။
- `--bump <type>`: Updates အတွက် `patch|minor|major` (မူလ: `patch`)။
- `--changelog <text>`: Non-interactive updates အတွက် changelog။
- `--tags <tags>`: ကော်မာဖြင့် ခွဲထားသော တဂ်များ (မူလ: `latest`)။
- `--concurrency <n>`: Registry စစ်ဆေးမှုများ (မူလ: 4)။

## Agent များအတွက် အသုံးများသော လုပ်ငန်းစဉ်များ

### Skills များကို ရှာဖွေခြင်း

```bash
clawhub search "postgres backups"
```

### Skill အသစ်များကို ဒေါင်းလုဒ်လုပ်ခြင်း

```bash
clawhub install my-skill-pack
```

### ထည့်သွင်းပြီးသား skills များကို အပ်ဒိတ်လုပ်ခြင်း

```bash
clawhub update --all
```

### သင့် skills များကို အရန်သိမ်းဆည်းခြင်း (publish သို့မဟုတ် sync)

Skill ဖိုလ်ဒါတစ်ခုတည်းအတွက်—

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Skills အများအပြားကို တစ်ခါတည်း scan လုပ်ပြီး အရန်သိမ်းရန်—

```bash
clawhub sync --all
```

## အဆင့်မြင့် အသေးစိတ်များ (နည်းပညာပိုင်း)

### Versioning နှင့် တဂ်များ

- ထုတ်ဝေမှုတိုင်းသည် **semver** `SkillVersion` အသစ်တစ်ခု ဖန်တီးသည်။
- `latest` ကဲ့သို့သော တဂ်များသည် ဗားရှင်းတစ်ခုကို ညွှန်းဆိုပြီး တဂ်ကို ရွှေ့ပြောင်းခြင်းဖြင့် rollback လုပ်နိုင်သည်။
- Sync သို့မဟုတ် update ထုတ်ဝေရာတွင် changelog များကို ဗားရှင်းတစ်ခုချင်းစီအလိုက် တွဲဖက်ထားပြီး ဗလာဖြစ်နိုင်သည်။

### Local ပြောင်းလဲမှုများနှင့် registry ဗားရှင်းများ

Update လုပ်ရာတွင် local skill အကြောင်းအရာများကို content hash ဖြင့် registry ဗားရှင်းများနှင့် နှိုင်းယှဉ်ပါသည်။ Local ဖိုင်များသည် ထုတ်ဝေထားသော ဗားရှင်း မည်သည့်တစ်ခုနှင့်မှ မကိုက်ညီပါက overwrite မလုပ်မီ CLI သည် မေးမြန်းပါသည် (သို့မဟုတ် non-interactive run များတွင် `--force` လိုအပ်ပါသည်)။

### Sync scan နှင့် fallback roots

`clawhub sync` သည် သင့်လက်ရှိ workdir ကို ဦးစွာ scan လုပ်ပါသည်။ Skills မတွေ့ပါက ယခင် legacy နေရာများ (ဥပမာ `~/openclaw/skills` နှင့် `~/.openclaw/skills`) သို့ fallback လုပ်ပါသည်။ Flag အပိုမလိုဘဲ အဟောင်း skill installs များကို ရှာဖွေရန် ဒီဇိုင်းလုပ်ထားခြင်းဖြစ်သည်။

### Storage နှင့် lockfile

- ထည့်သွင်းထားသော skills များကို သင့် workdir အောက်ရှိ `.clawhub/lock.json` တွင် မှတ်တမ်းတင်ထားသည်။
- Auth tokens များကို ClawHub CLI config ဖိုင်တွင် သိမ်းဆည်းထားသည် (`CLAWHUB_CONFIG_PATH` ဖြင့် override လုပ်နိုင်သည်)။

### Telemetry (install အရေအတွက်)

သင် လက်မှတ်ထိုးဝင်ရောက်ထားပြီး `clawhub sync` ကို လုပ်ဆောင်သည့်အခါ install အရေအတွက်ကို တွက်ချက်ရန် CLI သည် အနည်းဆုံး snapshot တစ်ခုကို ပို့ပါသည်။ ဤအရာကို လုံးဝ ပိတ်နိုင်ပါသည်—

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Environment variables

- `CLAWHUB_SITE`: Site URL ကို override လုပ်ရန်။
- `CLAWHUB_REGISTRY`: Registry API URL ကို override လုပ်ရန်။
- `CLAWHUB_CONFIG_PATH`: CLI မှ token/config ကို သိမ်းဆည်းရာနေရာကို override လုပ်ရန်။
- `CLAWHUB_WORKDIR`: မူလ workdir ကို override လုပ်ရန်။
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` တွင် telemetry ကို ပိတ်ရန်။
