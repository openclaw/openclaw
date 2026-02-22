---
summary: "ClawHub လမ်းညွှန် — အများပြည်သူ အသုံးပြုနိုင်သော skills စာရင်းသွင်းမှု + CLI လုပ်ငန်းစဉ်များ"
read_when:
  - ClawHub ကို အသုံးပြုသူအသစ်များထံ မိတ်ဆက်ပေးသည့်အခါ
  - Skills များကို ထည့်သွင်းခြင်း၊ ရှာဖွေခြင်း သို့မဟုတ် ထုတ်ဝေခြင်း
  - ClawHub CLI flags များနှင့် sync လုပ်ဆောင်ပုံကို ရှင်းပြရာတွင်
title: "ClawHub"
---

# ClawHub

21. ClawHub သည် **OpenClaw အတွက် အများပြည်သူသုံး skill registry** ဖြစ်ပါသည်။ It is a free service: all skills are public, open, and visible to everyone for sharing and reuse. 23. skill တစ်ခုသည် `SKILL.md` ဖိုင် (နှင့် အထောက်အကူပြု စာသားဖိုင်များ) ပါသော ဖိုလ်ဒါတစ်ခုသာ ဖြစ်ပါသည်။ 24. web app တွင် skill များကို ကြည့်ရှုနိုင်သလို CLI ကို အသုံးပြုပြီး ရှာဖွေ၊ တပ်ဆင်၊ အပ်ဒိတ်လုပ်နှင့် ထုတ်ဝေ ပေးနိုင်ပါသည်။

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

25. သင့် OpenClaw agent သို့ စွမ်းရည်အသစ်များ ထည့်လိုပါက ClawHub သည် skill များကို ရှာဖွေပြီး တပ်ဆင်ရန် အလွယ်ဆုံး နည်းလမ်း ဖြစ်ပါသည်။ 26. backend မည်သို့ အလုပ်လုပ်သည်ကို သိရန် မလိုအပ်ပါ။ You can:

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

28. ပုံမှန်အားဖြင့် CLI သည် skill များကို သင့် လက်ရှိ working directory အောက်ရှိ `./skills` သို့ တပ်ဆင်ပါသည်။ 29. OpenClaw workspace ကို သတ်မှတ်ထားပါက `clawhub` သည် `--workdir` (သို့မဟုတ် `CLAWHUB_WORKDIR`) ဖြင့် မပြောင်းလဲလျှင် ထို workspace သို့ fallback လုပ်ပါသည်။ 30. OpenClaw သည် `<workspace>/skills` မှ workspace skills များကို တင်ပြီး **နောက်ထပ်** session တွင် ဖမ်းဆီးအသုံးပြုပါမည်။ 31. `~/.openclaw/skills` သို့မဟုတ် bundled skills များကို အသုံးပြုပြီးသားဖြစ်ပါက workspace skills များသည် ဦးစားပေးခံရပါသည်။

Skills များကို မည်သို့ load လုပ်သည်၊ မျှဝေသည်၊ gate လုပ်သည်တို့၏ အသေးစိတ်ကို
[Skills](/tools/skills) တွင် ကြည့်ပါ။

## Skill စနစ် အကျဉ်းချုပ်

32. skill တစ်ခုသည် OpenClaw ကို သီးခြား လုပ်ငန်းတစ်ခုကို မည်သို့ ဆောင်ရွက်ရမည်ကို သင်ပေးသော version ပါသော ဖိုင်စုတစ်ခု ဖြစ်ပါသည်။ 33. publish တစ်ကြိမ်စီတိုင်းသည် version အသစ်တစ်ခုကို ဖန်တီးပြီး registry သည် အသုံးပြုသူများ ပြောင်းလဲမှုများကို စစ်ဆေးနိုင်ရန် version history ကို ထိန်းသိမ်းထားပါသည်။

ပုံမှန် skill တစ်ခုတွင်—

- အဓိက ဖော်ပြချက်နှင့် အသုံးပြုနည်းပါဝင်သော `SKILL.md` ဖိုင်။
- Skill အသုံးပြုရန် လိုအပ်သည့် optional config များ၊ script များ သို့မဟုတ် ထောက်ပံ့ဖိုင်များ။
- တဂ်များ၊ အကျဉ်းချုပ်၊ ထည့်သွင်းလိုအပ်ချက်များကဲ့သို့ metadata များ။

34. ClawHub သည် skill စွမ်းရည်များကို လုံခြုံစွာ ဖော်ပြရန်နှင့် ရှာဖွေရေးကို အားပေးရန် metadata ကို အသုံးပြုပါသည်။
35. registry သည် အဆင့်သတ်မှတ်ခြင်းနှင့် မြင်သာမှုကို တိုးတက်စေရန် အသုံးပြုမှုအချက်အလက်များ (ဥပမာ stars နှင့် downloads) ကိုလည်း လိုက်လံမှတ်တမ်းတင်ပါသည်။

## ဝန်ဆောင်မှုမှ ပံ့ပိုးသည့် အင်္ဂါရပ်များ

- Skills များနှင့် ၎င်းတို့၏ `SKILL.md` အကြောင်းအရာများကို **အများပြည်သူကြည့်ရှုနိုင်ခြင်း**။
- Keyword များသာမက embeddings (vector search) ဖြင့် လုပ်ဆောင်သော **ရှာဖွေမှု**။
- **Versioning** — semver၊ changelog များနှင့် `latest` အပါအဝင် တဂ်များ။
- ဗားရှင်းတစ်ခုချင်းစီအလိုက် zip ဖြင့် **ဒေါင်းလုဒ်**။
- လူထုအကြံပြုချက်အတွက် **Stars နှင့် comments**။
- အတည်ပြုခြင်းနှင့် audit များအတွက် **Moderation hooks**။
- အလိုအလျောက်လုပ်ငန်းစဉ်များနှင့် scripting အတွက် **CLI-friendly API**။

## လုံခြုံရေးနှင့် moderation

36. ClawHub သည် ပုံမှန်အားဖြင့် ဖွင့်လှစ်ထားပါသည်။ 37. မည်သူမဆို skill များကို upload လုပ်နိုင်သော်လည်း publish လုပ်ရန် GitHub account သည် အနည်းဆုံး တစ်ပတ် သက်တမ်းရှိရပါသည်။ 38. ၎င်းသည် အလွဲသုံးစားမှုကို နှေးကွေးစေရန် ကူညီပြီး တရားဝင် ပံ့ပိုးသူများကို မပိတ်ဆို့ပါ။

တိုင်ကြားခြင်းနှင့် moderation—

- လက်မှတ်ထိုးဝင်ရောက်ထားသော အသုံးပြုသူ မည်သူမဆို skill တစ်ခုကို တိုင်ကြားနိုင်သည်။
- တိုင်ကြားရသည့် အကြောင်းရင်းများကို မဖြစ်မနေ ထည့်သွင်းရပြီး မှတ်တမ်းတင်ထားသည်။
- အသုံးပြုသူတစ်ဦးလျှင် တစ်ချိန်တည်းတွင် active reports ၂၀ ခုအထိသာ ရှိနိုင်သည်။
- မတူညီသော တိုင်ကြားချက် ၃ ခုကျော် ရရှိပါက skill ကို မူလအားဖြင့် အလိုအလျောက် ဖျောက်ထားမည်။
- Moderators များသည် ဖျောက်ထားသော skills များကို ကြည့်ရှု၊ ပြန်ဖော်၊ ဖျက် သို့မဟုတ် အသုံးပြုသူများကို ပိတ်ပင်နိုင်သည်။
- Report feature ကို အလွဲသုံးစားလုပ်ပါက အကောင့်ပိတ်ပင်ခြင်း ခံရနိုင်သည်။

39. moderator ဖြစ်လာရန် စိတ်ဝင်စားပါသလား? 40. OpenClaw Discord တွင် မေးမြန်းပြီး moderator သို့မဟုတ် maintainer တစ်ဦးကို ဆက်သွယ်ပါ။

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

41. updates များသည် content hash ကို အသုံးပြုပြီး local skill အကြောင်းအရာများကို registry version များနှင့် နှိုင်းယှဉ်ပါသည်။ 42. local ဖိုင်များသည် ထုတ်ဝေပြီးသား version မည်သည့်တစ်ခုနှင့်မျှ မကိုက်ညီပါက CLI သည် overwrite မလုပ်မီ မေးမြန်းပါသည် (သို့မဟုတ် non-interactive runs တွင် `--force` လိုအပ်ပါသည်)။

### Sync scan နှင့် fallback roots

43. `clawhub sync` သည် သင့် လက်ရှိ workdir ကို အရင်ဆုံး စကန်လုပ်ပါသည်။ 44. skill မတွေ့ရှိပါက သိထားသော legacy တည်နေရာများ (ဥပမာ `~/openclaw/skills` နှင့် `~/.openclaw/skills`) သို့ fallback လုပ်ပါသည်။ 45. အပို flag မလိုဘဲ အဟောင်း skill တပ်ဆင်မှုများကို ရှာဖွေရန် ဒီဇိုင်းလုပ်ထားပါသည်။

### Storage နှင့် lockfile

- ထည့်သွင်းထားသော skills များကို သင့် workdir အောက်ရှိ `.clawhub/lock.json` တွင် မှတ်တမ်းတင်ထားသည်။
- Auth tokens များကို ClawHub CLI config ဖိုင်တွင် သိမ်းဆည်းထားသည် (`CLAWHUB_CONFIG_PATH` ဖြင့် override လုပ်နိုင်သည်)။

### Telemetry (install အရေအတွက်)

46. logged in ဖြစ်နေစဉ် `clawhub sync` ကို လည်ပတ်ပါက CLI သည် install count များတွက်ချက်ရန် အနည်းဆုံး snapshot တစ်ခုကို ပို့ပါသည်။ 47. ဤအရာကို လုံးဝ ပိတ်နိုင်ပါသည်:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Environment variables

- `CLAWHUB_SITE`: Site URL ကို override လုပ်ရန်။
- `CLAWHUB_REGISTRY`: Registry API URL ကို override လုပ်ရန်။
- `CLAWHUB_CONFIG_PATH`: CLI မှ token/config ကို သိမ်းဆည်းရာနေရာကို override လုပ်ရန်။
- `CLAWHUB_WORKDIR`: မူလ workdir ကို override လုပ်ရန်။
- `CLAWHUB_DISABLE_TELEMETRY=1`: `sync` တွင် telemetry ကို ပိတ်ရန်။
