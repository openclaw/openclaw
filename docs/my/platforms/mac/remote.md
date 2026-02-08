---
summary: "SSH ဖြင့် အဝေးရှိ OpenClaw Gateway ကို ထိန်းချုပ်ရန် macOS အက်ပ်၏ လုပ်ဆောင်ပုံ"
read_when:
  - အဝေးမှ mac ထိန်းချုပ်မှုကို တပ်ဆင်ခြင်း သို့မဟုတ် အမှားရှာဖွေခြင်း ပြုလုပ်နေစဉ်
title: "အဝေးမှ ထိန်းချုပ်မှု"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:54Z
---

# Remote OpenClaw (macOS ⇄ အဝေးရှိ ဟို့စ်)

ဤလုပ်ဆောင်ပုံသည် macOS အက်ပ်ကို အခြား ဟို့စ် (desktop/server) ပေါ်တွင် လည်ပတ်နေသော OpenClaw Gateway ကို အပြည့်အဝ အဝေးမှ ထိန်းချုပ်နိုင်စေပါသည်။ ၎င်းသည် အက်ပ်၏ **Remote over SSH** (remote run) အင်္ဂါရပ် ဖြစ်ပါသည်။ Health checks၊ Voice Wake forwarding နှင့် Web Chat အပါအဝင် အင်္ဂါရပ်အားလုံးသည် _Settings → General_ မှ တူညီသော remote SSH ဖွဲ့စည်းပြင်ဆင်မှုကို ပြန်လည်အသုံးပြုပါသည်။

## Modes

- **Local (this Mac)**: အရာအားလုံးကို လက်တော့ပ်ပေါ်တွင် လည်ပတ်စေပါသည်။ SSH မပါဝင်ပါ။
- **Remote over SSH (default)**: OpenClaw အမိန့်များကို အဝေးရှိ ဟို့စ် ပေါ်တွင် အကောင်အထည်ဖော်ပါသည်။ mac အက်ပ်သည် `-o BatchMode` နှင့် သင်ရွေးချယ်ထားသော identity/key နှင့် local port-forward တို့ဖြင့် SSH ချိတ်ဆက်မှုကို ဖွင့်ပါသည်။
- **Remote direct (ws/wss)**: SSH တန်နယ် မရှိပါ။ mac အက်ပ်သည် Gateway URL သို့ တိုက်ရိုက် ချိတ်ဆက်ပါသည် (ဥပမာ Tailscale Serve သို့မဟုတ် public HTTPS reverse proxy ဖြင့်)။

## Remote transports

Remote mode သည် ပို့ဆောင်ရေးအလွှာ နှစ်မျိုးကို ပံ့ပိုးပါသည်—

- **SSH tunnel** (default): `ssh -N -L ...` ကို အသုံးပြု၍ Gateway ပေါက်ကို localhost သို့ forward လုပ်ပါသည်။ တန်နယ်သည် loopback ဖြစ်သောကြောင့် Gateway သည် နိုဒ်၏ IP ကို `127.0.0.1` အဖြစ် မြင်ရပါမည်။
- **Direct (ws/wss)**: Gateway URL သို့ တိုက်ရိုက် ချိတ်ဆက်ပါသည်။ Gateway သည် အမှန်တကယ် client IP ကို မြင်ရပါမည်။

## အဝေးရှိ ဟို့စ် ပေါ်ရှိ ကြိုတင်လိုအပ်ချက်များ

1. Node + pnpm ကို ထည့်သွင်းတပ်ဆင်ပြီး OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`) ကို build/install ပြုလုပ်ပါ။
2. Non-interactive shells အတွက် PATH ထဲတွင် `openclaw` ပါဝင်နေကြောင်း သေချာစေပါ (လိုအပ်ပါက `/usr/local/bin` သို့မဟုတ် `/opt/homebrew/bin` ထဲသို့ symlink ပြုလုပ်ပါ)။
3. Key auth ဖြင့် SSH ကို ဖွင့်ထားပါ။ LAN အပြင်ဘက်မှ တည်ငြိမ်စွာ ချိတ်ဆက်နိုင်ရန် **Tailscale** IP များကို အကြံပြုပါသည်။

## macOS အက်ပ် တပ်ဆင်ခြင်း

1. _Settings → General_ ကို ဖွင့်ပါ။
2. **OpenClaw runs** အောက်တွင် **Remote over SSH** ကို ရွေးပြီး အောက်ပါအချက်များကို သတ်မှတ်ပါ—
   - **Transport**: **SSH tunnel** သို့မဟုတ် **Direct (ws/wss)**။
   - **SSH target**: `user@host` (ရွေးချယ်စရာအနေဖြင့် `:port`)။
     - Gateway သည် တူညီသော LAN ပေါ်တွင်ရှိပြီး Bonjour ကို ကြော်ငြာထားပါက၊ ရှာဖွေတွေ့ရှိထားသော စာရင်းမှ ရွေးချယ်ပါက ဤအကွက်ကို အလိုအလျောက် ဖြည့်ပေးပါမည်။
   - **Gateway URL** (Direct အတွက်သာ): `wss://gateway.example.ts.net` (local/LAN အတွက် `ws://...`)။
   - **Identity file** (အဆင့်မြင့်): သင့် key သို့ သွားသော လမ်းကြောင်း။
   - **Project root** (အဆင့်မြင့်): အမိန့်များအတွက် အသုံးပြုမည့် အဝေးရှိ checkout လမ်းကြောင်း။
   - **CLI path** (အဆင့်မြင့်): လည်ပတ်နိုင်သော `openclaw` entrypoint/binary သို့ လမ်းကြောင်း (ကြော်ငြာထားပါက အလိုအလျောက် ဖြည့်ပေးပါမည်)။
3. **Test remote** ကို နှိပ်ပါ။ အောင်မြင်ပါက အဝေးရှိ `openclaw status --json` သည် မှန်ကန်စွာ လည်ပတ်နေကြောင်း ပြသပါသည်။ မအောင်မြင်မှုများသည် များသောအားဖြင့် PATH/CLI ပြဿနာများကြောင့် ဖြစ်ပါသည်; exit 127 သည် အဝေးတွင် CLI ကို မတွေ့ရှိခြင်းကို ဆိုလိုပါသည်။
4. Health checks နှင့် Web Chat များသည် ယခုအချိန်မှစ၍ ဤ SSH တန်နယ်မှတစ်ဆင့် အလိုအလျောက် လည်ပတ်ပါမည်။

## Web Chat

- **SSH tunnel**: Web Chat သည် forward လုပ်ထားသော WebSocket control port (default 18789) မှတစ်ဆင့် Gateway သို့ ချိတ်ဆက်ပါသည်။
- **Direct (ws/wss)**: Web Chat သည် သတ်မှတ်ထားသော Gateway URL သို့ တိုက်ရိုက် ချိတ်ဆက်ပါသည်။
- ယခုအခါ WebChat အတွက် သီးခြား HTTP server မရှိတော့ပါ။

## ခွင့်ပြုချက်များ

- အဝေးရှိ ဟို့စ် သည် local နှင့် တူညီသော TCC ခွင့်ပြုချက်များ (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications) လိုအပ်ပါသည်။ တစ်ကြိမ်သာ ခွင့်ပြုချက်များ ပေးရန် ထိုစက်ပေါ်တွင် onboarding ကို လည်ပတ်ပါ။
- နိုဒ်များသည် ၎င်းတို့၏ ခွင့်ပြုချက် အခြေအနေကို `node.list` / `node.describe` မှတစ်ဆင့် ကြော်ငြာသဖြင့် အေးဂျင့်များက ရရှိနိုင်သည့် အရာများကို သိနိုင်ပါသည်။

## လုံခြုံရေး မှတ်ချက်များ

- အဝေးရှိ ဟို့စ် ပေါ်တွင် loopback binds ကို ဦးစားပေးအသုံးပြုပြီး SSH သို့မဟုတ် Tailscale ဖြင့် ချိတ်ဆက်ပါ။
- Gateway ကို non-loopback interface သို့ bind လုပ်ပါက token/password auth ကို မဖြစ်မနေ လိုအပ်စေပါ။
- [Security](/gateway/security) နှင့် [Tailscale](/gateway/tailscale) ကို ကြည့်ပါ။

## WhatsApp login flow (remote)

- `openclaw channels login --verbose` ကို **အဝေးရှိ ဟို့စ် ပေါ်တွင်** လည်ပတ်ပါ။ သင့်ဖုန်းရှိ WhatsApp ဖြင့် QR ကို scan ပြုလုပ်ပါ။
- Auth သက်တမ်းကုန်ဆုံးပါက ထိုဟို့စ် ပေါ်တွင် login ကို ပြန်လည်လုပ်ဆောင်ပါ။ Health check သည် ချိတ်ဆက်မှု ပြဿနာများကို ပြသပါလိမ့်မည်။

## Troubleshooting

- **exit 127 / not found**: `openclaw` သည် non-login shells အတွက် PATH ထဲတွင် မရှိပါ။ ၎င်းကို `/etc/paths`၊ သင့် shell rc ထဲသို့ ထည့်ပါ သို့မဟုတ် `/usr/local/bin`/`/opt/homebrew/bin` ထဲသို့ symlink ပြုလုပ်ပါ။
- **Health probe failed**: SSH ချိတ်ဆက်နိုင်မှု၊ PATH နှင့် Baileys သည် login ပြုလုပ်ထားကြောင်း (`openclaw status --json`) ကို စစ်ဆေးပါ။
- **Web Chat stuck**: Gateway သည် အဝေးရှိ ဟို့စ် ပေါ်တွင် လည်ပတ်နေကြောင်းနှင့် forward လုပ်ထားသော port သည် Gateway WS port နှင့် ကိုက်ညီကြောင်း အတည်ပြုပါ; UI သည် ကျန်းမာသော WS ချိတ်ဆက်မှုကို လိုအပ်ပါသည်။
- **Node IP shows 127.0.0.1**: SSH တန်နယ် အသုံးပြုသောအခါ မျှော်လင့်ထားသည့် အပြုအမူ ဖြစ်ပါသည်။ Gateway သည် အမှန်တကယ် client IP ကို မြင်စေရန် **Transport** ကို **Direct (ws/wss)** သို့ ပြောင်းပါ။
- **Voice Wake**: Remote mode တွင် trigger စကားစုများကို အလိုအလျောက် forward လုပ်ပါသည်; သီးခြား forwarder မလိုအပ်ပါ။

## Notification sounds

`openclaw` နှင့် `node.invoke` ပါဝင်သော scripts များမှ notification တစ်ခုချင်းစီအလိုက် အသံများကို ရွေးချယ်နိုင်ပါသည်၊ ဥပမာ—

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

ယခုအခါ အက်ပ်တွင် အပြည်ပြည်ဆိုင်ရာ “default sound” toggle မရှိတော့ပါ; ခေါ်ယူသူများသည် တောင်းဆိုမှု တစ်ခုချင်းစီအလိုက် အသံတစ်ခု (သို့မဟုတ် မပါ) ကို ရွေးချယ်ရပါမည်။
