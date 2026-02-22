---
summary: "Doctor အမိန့်: ကျန်းမာရေး စစ်ဆေးမှုများ၊ config ပြောင်းရွှေ့မှုများ၊ နှင့် ပြုပြင်ရေး အဆင့်များ"
read_when:
  - Doctor ပြောင်းရွှေ့မှုများကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်သောအခါ
  - ချိုးဖောက်မှုရှိသော config ပြောင်းလဲမှုများကို မိတ်ဆက်သောအခါ
title: "Doctor"
---

# Doctor

`openclaw doctor` is the repair + migration tool for OpenClaw. It fixes stale
config/state, checks health, and provides actionable repair steps.

## Quick start

```bash
openclaw doctor
```

### Headless / automation

```bash
openclaw doctor --yes
```

မေးမြန်းမှု မရှိဘဲ မူလသတ်မှတ်ချက်များကို လက်ခံပါ (သက်ဆိုင်ရာအခါ restart/service/sandbox ပြုပြင်ရေး အဆင့်များ အပါအဝင်)။

```bash
openclaw doctor --repair
```

မေးမြန်းမှု မရှိဘဲ အကြံပြုထားသော ပြုပြင်မှုများကို အသုံးချပါ (လုံခြုံသည့် အခြေအနေများတွင် ပြုပြင်မှုများ + restart များ)။

```bash
openclaw doctor --repair --force
```

ပြင်းထန်သော ပြုပြင်မှုများကိုပါ အသုံးချပါ (စိတ်ကြိုက် supervisor config များကို ထပ်ရေးသားသည်)။

```bash
openclaw doctor --non-interactive
```

Run without prompts and only apply safe migrations (config normalization + on-disk state moves). Skips restart/service/sandbox actions that require human confirmation.
Legacy state migrations run automatically when detected.

```bash
openclaw doctor --deep
```

အပို gateway ထည့်သွင်းမှုများကို ရှာဖွေရန် system services (launchd/systemd/schtasks) ကို စကန်လုပ်ပါ။

ရေးသားမီ ပြောင်းလဲမှုများကို ပြန်လည်သုံးသပ်လိုပါက config ဖိုင်ကို အရင်ဖွင့်ပါ:

```bash
cat ~/.openclaw/openclaw.json
```

## What it does (summary)

- git ထည့်သွင်းမှုများအတွက် ရွေးချယ်နိုင်သော pre-flight update (interactive အတွက်သာ)။
- UI protocol အသစ်တိုး စစ်ဆေးမှု (protocol schema အသစ်ဖြစ်လျှင် Control UI ကို ပြန်တည်ဆောက်သည်)။
- ကျန်းမာရေး စစ်ဆေးမှု + restart မေးမြန်းချက်။
- Skills အခြေအနေ အကျဉ်းချုပ် (အသုံးချနိုင်/ပျောက်ဆုံး/ပိတ်ထား)။
- အဟောင်းတန်ဖိုးများအတွက် config ကို စံပြုလုပ်ခြင်း။
- OpenCode Zen provider override သတိပေးချက်များ (`models.providers.opencode`)။
- အဟောင်း disk ပေါ်ရှိ state ပြောင်းရွှေ့မှု (sessions/agent dir/WhatsApp auth)။
- State အပြည့်အစုံနှင့် ခွင့်ပြုချက် စစ်ဆေးမှုများ (sessions, transcripts, state dir)။
- ဒေသတွင်း လည်ပတ်နေစဉ် config ဖိုင် ခွင့်ပြုချက် စစ်ဆေးမှု (chmod 600)။
- Model auth ကျန်းမာရေး: OAuth သက်တမ်းကုန်ဆုံးမှုကို စစ်ဆေးပြီး၊ သက်တမ်းကုန်ခါနီး token များကို refresh လုပ်နိုင်သည်၊ auth-profile cooldown/disabled အခြေအနေများကို တင်ပြသည်။
- အပို workspace dir ရှာဖွေတွေ့ရှိမှု (`~/openclaw`)။
- sandboxing ဖွင့်ထားလျှင် Sandbox image ပြုပြင်မှု။
- အဟောင်း service ပြောင်းရွှေ့မှုနှင့် အပို gateway ရှာဖွေတွေ့ရှိမှု။
- Gateway runtime စစ်ဆေးမှုများ (service တပ်ဆင်ထားသော်လည်း မလည်ပတ်ခြင်း; cached launchd label)။
- Channel အခြေအနေ သတိပေးချက်များ (လည်ပတ်နေသော gateway မှ probe လုပ်သည်)။
- Supervisor config စစ်ဆေးမှု (launchd/systemd/schtasks) နှင့် ရွေးချယ်နိုင်သော ပြုပြင်မှု။
- Gateway runtime အကောင်းဆုံး အလေ့အကျင့် စစ်ဆေးမှုများ (Node နှင့် Bun နှိုင်းယှဉ်ခြင်း၊ version-manager လမ်းကြောင်းများ)။
- Gateway port တိုက်ခိုက်မှု စမ်းသပ်ချက်များ (မူလ `18789`)။
- ဖွင့်ထားသော DM မူဝါဒများအတွက် လုံခြုံရေး သတိပေးချက်များ။
- `gateway.auth.token` မသတ်မှတ်ထားသောအခါ Gateway auth သတိပေးချက်များ (local mode; token ဖန်တီးရန် အကြံပြုသည်)။
- Linux တွင် systemd linger စစ်ဆေးမှု။
- Source ထည့်သွင်းမှု စစ်ဆေးမှုများ (pnpm workspace မကိုက်ညီမှု၊ UI assets မရှိခြင်း၊ tsx binary မရှိခြင်း)။
- ပြင်ဆင်ထားသော config + wizard metadata ကို ရေးသားခြင်း။

## Detailed behavior and rationale

### 0. Optional update (git installs)

ဤသည် git checkout ဖြစ်ပြီး doctor ကို interactive ဖြင့် လည်ပတ်နေပါက၊
doctor မလုပ်ဆောင်မီ update (fetch/rebase/build) ပြုလုပ်ရန် အကြံပြုသည်။

### 1. Config normalization

config တွင် အဟောင်းတန်ဖိုး ပုံစံများ ပါရှိပါက (ဥပမာ `messages.ackReaction`
channel-specific override မပါရှိခြင်း) doctor သည် လက်ရှိ schema သို့ စံပြုလုပ်သည်။

### 2. Legacy config key migrations

config တွင် deprecated keys ပါရှိပါက၊ အခြား အမိန့်များသည် မလည်ပတ်ဘဲ
`openclaw doctor` ကို လည်ပတ်ရန် တောင်းဆိုမည်ဖြစ်သည်။

Doctor သည် အောက်ပါအတိုင်း လုပ်ဆောင်မည်ဖြစ်သည်–

- တွေ့ရှိသော legacy keys များကို ရှင်းပြသည်။
- အသုံးချခဲ့သော migration ကို ပြသသည်။
- ပြင်ဆင်ပြီးသား schema ဖြင့် `~/.openclaw/openclaw.json` ကို ထပ်ရေးသားသည်။

Gateway သည် legacy config format ကို တွေ့ရှိပါက စတင်ချိန်တွင် doctor migrations ကို အလိုအလျောက် လည်ပတ်စေသဖြင့်
လက်ဖြင့် မ вмешရောက်ဘဲ အဟောင်း config များကို ပြုပြင်ပေးနိုင်သည်။

လက်ရှိ migrations များ–

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen provider overrides

If you’ve added `models.providers.opencode` (or `opencode-zen`) manually, it
overrides the built-in OpenCode Zen catalog from `@mariozechner/pi-ai`. That can
force every model onto a single API or zero out costs. Doctor warns so you can
remove the override and restore per-model API routing + costs.

### 3. Legacy state migrations (disk layout)

Doctor သည် အဟောင်း disk ပေါ်ရှိ layout များကို လက်ရှိ ဖွဲ့စည်းပုံသို့ ပြောင်းရွှေ့နိုင်သည်–

- Sessions store + transcripts:
  - `~/.openclaw/sessions/` မှ `~/.openclaw/agents/<agentId>/sessions/` သို့
- Agent dir:
  - `~/.openclaw/agent/` မှ `~/.openclaw/agents/<agentId>/agent/` သို့
- WhatsApp auth state (Baileys):
  - အဟောင်း `~/.openclaw/credentials/*.json` မှ (`oauth.json` မပါဝင်)
  - `~/.openclaw/credentials/whatsapp/<accountId>/...` သို့ (မူလ account id: `default`)

These migrations are best-effort and idempotent; doctor will emit warnings when
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates
the legacy sessions + agent dir on startup so history/auth/models land in the
per-agent path without a manual doctor run. WhatsApp auth is intentionally only
migrated via `openclaw doctor`.

### 4. State integrity checks (session persistence, routing, and safety)

The state directory is the operational brainstem. If it vanishes, you lose
sessions, credentials, logs, and config (unless you have backups elsewhere).

Doctor စစ်ဆေးသည့်အရာများ–

- **State dir မရှိခြင်း**: ပြင်းထန်သော state ဆုံးရှုံးမှုကို သတိပေးပြီး directory ကို ပြန်ဖန်တီးရန် မေးမြန်းသည်၊ ပျောက်ဆုံးသွားသော ဒေတာကို ပြန်လည်ရယူမနိုင်ကြောင်း သတိပေးသည်။
- **State dir ခွင့်ပြုချက်များ**: ရေးသားနိုင်မှုကို စစ်ဆေးပြီး ခွင့်ပြုချက် ပြုပြင်ရန် အကြံပြုသည် (owner/group မကိုက်ညီမှု တွေ့ရှိပါက `chown` အကြံပြုချက် ထုတ်ပေးသည်)။
- **Session dirs မရှိခြင်း**: history ကို သိမ်းဆည်းရန်နှင့် `ENOENT` crash မဖြစ်စေရန် `sessions/` နှင့် session store directory များ လိုအပ်သည်။
- **Transcript မကိုက်ညီမှု**: မကြာသေးမီ session entries များတွင် transcript ဖိုင် မရှိပါက သတိပေးသည်။
- **Main session “1-line JSONL”**: main transcript တွင် တစ်ကြောင်းသာ ရှိပါက (history မစုဆောင်းနေခြင်း) ကို အလံပြုသည်။
- **State dirs များစွာ**: home directories အနှံ့ `~/.openclaw` folder များစွာ ရှိပါက သို့မဟုတ် `OPENCLAW_STATE_DIR` သည် အခြားနေရာသို့ ညွှန်ပြနေပါက သတိပေးသည် (history သည် install များအကြား ကွဲထွက်နိုင်သည်)။
- **Remote mode သတိပေးချက်**: `gateway.mode=remote` ဖြစ်ပါက remote host ပေါ်တွင် လည်ပတ်ရန် သတိပေးသည် (state သည် ထိုနေရာတွင် ရှိသည်)။
- **Config ဖိုင် ခွင့်ပြုချက်များ**: `~/.openclaw/openclaw.json` သည် group/world ဖတ်ရှုနိုင်ပါက သတိပေးပြီး `600` သို့ တင်းကြပ်ရန် အကြံပြုသည်။

### 5. Model auth health (OAuth expiry)

Doctor inspects OAuth profiles in the auth store, warns when tokens are
expiring/expired, and can refresh them when safe. If the Anthropic Claude Code
profile is stale, it suggests running `claude setup-token` (or pasting a setup-token).
Refresh prompts only appear when running interactively (TTY); `--non-interactive`
skips refresh attempts.

Doctor သည် အောက်ပါအကြောင်းကြောင့် ယာယီ အသုံးမပြုနိုင်သော auth profiles များကိုလည်း တင်ပြသည်–

- အတိုချုံး cooldown များ (rate limits/timeouts/auth failures)
- ပိုရှည်သော disable များ (billing/credit failures)

### 6. Hooks model validation

`hooks.gmail.model` သတ်မှတ်ထားပါက doctor သည် model reference ကို catalog နှင့် allowlist နှိုင်းယှဉ် စစ်ဆေးပြီး resolve မဖြစ်နိုင်ပါက သို့မဟုတ် ခွင့်မပြုထားပါက သတိပေးသည်။

### 7. Sandbox image repair

sandboxing ဖွင့်ထားသောအခါ doctor သည် Docker images များကို စစ်ဆေးပြီး လက်ရှိ image မရှိပါက build ပြုလုပ်ရန် သို့မဟုတ် legacy အမည်များသို့ ပြောင်းရန် အကြံပြုသည်။

### 8. Gateway service migrations and cleanup hints

Doctor detects legacy gateway services (launchd/systemd/schtasks) and
offers to remove them and install the OpenClaw service using the current gateway
port. It can also scan for extra gateway-like services and print cleanup hints.
Profile-named OpenClaw gateway services are considered first-class and are not
flagged as "extra."

### 9. Security warnings

provider သည် allowlist မပါဘဲ DMs များကို ဖွင့်ထားပါက သို့မဟုတ် မူဝါဒကို အန္တရာယ်ရှိသော ပုံစံဖြင့် သတ်မှတ်ထားပါက doctor သည် သတိပေးချက်များ ထုတ်ပေးသည်။

### 10. systemd linger (Linux)

systemd user service အဖြစ် လည်ပတ်နေပါက doctor သည် logout ပြုလုပ်ပြီးနောက် gateway ဆက်လက် လည်ပတ်စေရန် lingering ကို ဖွင့်ထားကြောင်း သေချာစေသည်။

### 11. Skills status

Doctor သည် လက်ရှိ workspace အတွက် eligible/missing/blocked Skills များ၏ အကျဉ်းချုပ်ကို ထုတ်ပြသည်။

### 12. Gateway auth checks (local token)

Doctor warns when `gateway.auth` is missing on a local gateway and offers to
generate a token. 1. အလိုအလျောက်လုပ်ဆောင်မှုတွင် token ဖန်တီးခြင်းကို မဖြစ်မနေ ပြုလုပ်ရန် `openclaw doctor --generate-gateway-token` ကို အသုံးပြုပါ။

### 13. Gateway health check + restart

Doctor သည် ကျန်းမာရေး စစ်ဆေးမှုကို လုပ်ဆောင်ပြီး gateway မကျန်းမာဟု တွေ့ရှိပါက restart ပြုလုပ်ရန် အကြံပြုသည်။

### 14. Channel status warnings

gateway ကျန်းမာပါက doctor သည် channel status probe ကို လုပ်ဆောင်ပြီး ပြုပြင်ရန် အကြံပြုချက်များနှင့်အတူ သတိပေးချက်များကို တင်ပြသည်။

### 15. Supervisor config audit + repair

2. Doctor သည် ထည့်သွင်းထားသော supervisor config (launchd/systemd/schtasks) ကို စစ်ဆေးပြီး ပျောက်နေသော သို့မဟုတ် ခေတ်မီမှုမရှိသော default များ (ဥပမာ systemd network-online dependency များနှင့် restart delay) ကို ရှာဖွေပါသည်။ 3. မကိုက်ညီမှုကို တွေ့ရှိပါက update ပြုလုပ်ရန် အကြံပြုပေးပြီး လက်ရှိ default များအတိုင်း service file/task ကို ပြန်ရေးနိုင်ပါသည်။

မှတ်ချက်များ–

- `openclaw doctor` သည် supervisor config ကို ထပ်ရေးသားမီ မေးမြန်းသည်။
- `openclaw doctor --yes` သည် မူလ ပြုပြင်ရေး မေးမြန်းချက်များကို လက်ခံသည်။
- `openclaw doctor --repair` သည် မေးမြန်းမှု မရှိဘဲ အကြံပြု ပြုပြင်မှုများကို အသုံးချသည်။
- `openclaw doctor --repair --force` သည် စိတ်ကြိုက် supervisor config များကို ထပ်ရေးသားသည်။
- `openclaw gateway install --force` ဖြင့် အပြည့်အစုံ ထပ်ရေးသားမှုကို အတင်းအကျပ် လုပ်ဆောင်နိုင်သည်။

### 16. Gateway runtime + port diagnostics

4. Doctor သည် service runtime (PID, နောက်ဆုံး exit status) ကို စစ်ဆေးပြီး service ကို ထည့်သွင်းထားသော်လည်း အမှန်တကယ် မလည်ပတ်နေပါက သတိပေးပါသည်။ 5. Gateway port (default `18789`) တွင် port collision များ ရှိ/မရှိကိုလည်း စစ်ဆေးပြီး ဖြစ်နိုင်ချေရှိသော အကြောင်းရင်းများ (gateway ကို မကြာခဏ ပြန်လည် run နေခြင်း၊ SSH tunnel) ကို အစီရင်ခံပါသည်။

### 17. Gateway runtime best practices

6. Gateway service ကို Bun သို့မဟုတ် version-managed Node path (`nvm`, `fnm`, `volta`, `asdf`, စသည်) ပေါ်တွင် run နေလျှင် Doctor သည် သတိပေးပါသည်။ 7. WhatsApp + Telegram channel များသည် Node ကို လိုအပ်ပြီး version-manager path များသည် upgrade ပြီးနောက် service က သင့် shell init ကို မ load လုပ်သဖြင့် ပြဿနာ ဖြစ်နိုင်ပါသည်။ 8. ရနိုင်ပါက system Node install (Homebrew/apt/choco) သို့ migrate ပြုလုပ်ရန် Doctor က အကြံပြုပါသည်။

### 18. Config write + wizard metadata

Doctor သည် config ပြောင်းလဲမှုများကို သိမ်းဆည်းပြီး doctor run ကို မှတ်တမ်းတင်ရန် wizard metadata ကို အမှတ်အသားပြုလုပ်သည်။

### 19. Workspace tips (backup + memory system)

Doctor သည် workspace memory system မရှိပါက အကြံပြုကာ workspace သည် git အောက်တွင် မရှိသေးပါက backup အကြံပြုချက်ကို ထုတ်ပြသည်။

Workspace ဖွဲ့စည်းပုံနှင့် git backup (ကိုယ်ပိုင် GitHub သို့မဟုတ် GitLab ကို အကြံပြုသည်) အတွက် အပြည့်အစုံ လမ်းညွှန်ကို [/concepts/agent-workspace](/concepts/agent-workspace) တွင် ကြည့်ရှုပါ။
