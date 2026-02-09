---
summary: "SSH ဖြင့် အဝေးရှိ OpenClaw Gateway ကို ထိန်းချုပ်ရန် macOS အက်ပ်၏ လုပ်ဆောင်ပုံ"
read_when:
  - အဝေးမှ mac ထိန်းချုပ်မှုကို တပ်ဆင်ခြင်း သို့မဟုတ် အမှားရှာဖွေခြင်း ပြုလုပ်နေစဉ်
title: "အဝေးမှ ထိန်းချုပ်မှု"
---

# Remote OpenClaw (macOS ⇄ အဝေးရှိ ဟို့စ်)

ဤ flow ကြောင့် macOS app သည် အခြား host (desktop/server) ပေါ်တွင် chạy နေသော OpenClaw gateway အတွက် ပြည့်စုံသော remote control အဖြစ် လုပ်ဆောင်နိုင်ပါသည်။ ဤအရာသည် app ၏ **Remote over SSH** (remote run) feature ဖြစ်သည်။ Feature အားလုံး—health checks, Voice Wake forwarding နှင့် Web Chat—တို့သည် _Settings → General_ ထဲရှိ remote SSH configuration တစ်ခုတည်းကို ပြန်လည်အသုံးပြုပါသည်။

## Modes

- **Local (this Mac)**: အရာအားလုံးကို laptop ပေါ်တွင်ပင် chạy ပါသည်။ SSH မပါဝင်ပါ။
- **Remote over SSH (default)**: OpenClaw command များကို remote host ပေါ်တွင် chạy ပါသည်။ mac app သည် `-o BatchMode` ပါသော SSH connection ကို သင်ရွေးချယ်ထားသော identity/key နှင့် local port-forward အပါအဝင် ဖွင့်ပါသည်။
- **Remote direct (ws/wss)**: SSH tunnel မပါ။ mac app သည် gateway URL သို့ တိုက်ရိုက် ချိတ်ဆက်ပါသည် (ဥပမာ Tailscale Serve သို့မဟုတ် public HTTPS reverse proxy မှတစ်ဆင့်)။

## Remote transports

Remote mode သည် ပို့ဆောင်ရေးအလွှာ နှစ်မျိုးကို ပံ့ပိုးပါသည်—

- **SSH tunnel** (default): `ssh -N -L ...` ကို အသုံးပြု၍ gateway port ကို localhost သို့ forward လုပ်ပါသည်။ Tunnel သည် loopback ဖြစ်သောကြောင့် gateway က node ၏ IP ကို `127.0.0.1` ဟု မြင်ပါမည်။
- **Direct (ws/wss)**: Connects straight to the gateway URL. Gateway က တကယ့် client IP ကို မြင်ပါသည်။

## အဝေးရှိ ဟို့စ် ပေါ်ရှိ ကြိုတင်လိုအပ်ချက်များ

1. Node + pnpm ကို ထည့်သွင်းတပ်ဆင်ပြီး OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`) ကို build/install ပြုလုပ်ပါ။
2. Non-interactive shells အတွက် PATH ထဲတွင် `openclaw` ပါဝင်နေကြောင်း သေချာစေပါ (လိုအပ်ပါက `/usr/local/bin` သို့မဟုတ် `/opt/homebrew/bin` ထဲသို့ symlink ပြုလုပ်ပါ)။
3. Key auth ဖြင့် SSH ကို ဖွင့်ပါ။ LAN အပြင်ဘက်တွင် တည်ငြိမ်စွာ ချိတ်ဆက်နိုင်ရန် **Tailscale** IP များကို အကြံပြုပါသည်။

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
3. **Test remote** ကို နှိပ်ပါ။ အောင်မြင်ပါက remote `openclaw status --json` သည် မှန်ကန်စွာ chạy နေကြောင်း ဆိုလိုပါသည်။ မအောင်မြင်ခြင်းများသည် မကြာခဏ PATH/CLI ပြဿနာများကြောင့် ဖြစ်ပြီး exit 127 ဆိုသည်မှာ remote တွင် CLI ကို မတွေ့ရခြင်း ဖြစ်သည်။
4. Health checks နှင့် Web Chat များသည် ယခုအချိန်မှစ၍ ဤ SSH တန်နယ်မှတစ်ဆင့် အလိုအလျောက် လည်ပတ်ပါမည်။

## Web Chat

- **SSH tunnel**: Web Chat သည် forward လုပ်ထားသော WebSocket control port (default 18789) မှတစ်ဆင့် Gateway သို့ ချိတ်ဆက်ပါသည်။
- **Direct (ws/wss)**: Web Chat သည် သတ်မှတ်ထားသော Gateway URL သို့ တိုက်ရိုက် ချိတ်ဆက်ပါသည်။
- ယခုအခါ WebChat အတွက် သီးခြား HTTP server မရှိတော့ပါ။

## ခွင့်ပြုချက်များ

- Remote host သည် local နှင့် တူညီသော TCC approval များ (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications) လိုအပ်ပါသည်။ အဲဒီ machine ပေါ်တွင် onboarding ကို တစ်ကြိမ် chạy လုပ်ပြီး ခွင့်ပြုချက်များ ပေးပါ။
- နိုဒ်များသည် ၎င်းတို့၏ ခွင့်ပြုချက် အခြေအနေကို `node.list` / `node.describe` မှတစ်ဆင့် ကြော်ငြာသဖြင့် အေးဂျင့်များက ရရှိနိုင်သည့် အရာများကို သိနိုင်ပါသည်။

## လုံခြုံရေး မှတ်ချက်များ

- အဝေးရှိ ဟို့စ် ပေါ်တွင် loopback binds ကို ဦးစားပေးအသုံးပြုပြီး SSH သို့မဟုတ် Tailscale ဖြင့် ချိတ်ဆက်ပါ။
- Gateway ကို non-loopback interface သို့ bind လုပ်ပါက token/password auth ကို မဖြစ်မနေ လိုအပ်စေပါ။
- [Security](/gateway/security) နှင့် [Tailscale](/gateway/tailscale) ကို ကြည့်ပါ။

## WhatsApp login flow (remote)

- `openclaw channels login --verbose` ကို **remote host ပေါ်တွင်ပင်** chạy ပါ။ သင့်ဖုန်းရှိ WhatsApp ဖြင့် QR ကို scan လုပ်ပါ။
- Auth သက်တမ်းကုန်သွားပါက အဲဒီ host ပေါ်တွင် login ကို ပြန်လုပ်ပါ။ Health check သည် link ပြဿနာများကို ဖော်ပြပေးပါမည်။

## Troubleshooting

- **exit 127 / not found**: `openclaw` သည် non-login shell များအတွက် PATH ထဲတွင် မရှိပါ။ `/etc/paths`၊ သင့် shell rc ထဲသို့ ထည့်ပါ သို့မဟုတ် `/usr/local/bin` / `/opt/homebrew/bin` သို့ symlink လုပ်ပါ။
- **Health probe failed**: SSH ချိတ်ဆက်နိုင်မှု၊ PATH နှင့် Baileys သည် login ပြုလုပ်ထားကြောင်း (`openclaw status --json`) ကို စစ်ဆေးပါ။
- **Web Chat stuck**: Gateway သည် အဝေးရှိ ဟို့စ် ပေါ်တွင် လည်ပတ်နေကြောင်းနှင့် forward လုပ်ထားသော port သည် Gateway WS port နှင့် ကိုက်ညီကြောင်း အတည်ပြုပါ; UI သည် ကျန်းမာသော WS ချိတ်ဆက်မှုကို လိုအပ်ပါသည်။
- **Node IP သည် 127.0.0.1 ဟု ပြသည်**: SSH tunnel အသုံးပြုနေချိန်တွင် ပုံမှန်ဖြစ်ပါသည်။ Gateway က တကယ့် client IP ကို မြင်စေလိုပါက **Transport** ကို **Direct (ws/wss)** သို့ ပြောင်းပါ။
- **Voice Wake**: Remote mode တွင် trigger စကားစုများကို အလိုအလျောက် forward လုပ်ပါသည်; သီးခြား forwarder မလိုအပ်ပါ။

## Notification sounds

`openclaw` နှင့် `node.invoke` ပါဝင်သော scripts များမှ notification တစ်ခုချင်းစီအလိုက် အသံများကို ရွေးချယ်နိုင်ပါသည်၊ ဥပမာ—

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

ယခုအခါ အက်ပ်တွင် အပြည်ပြည်ဆိုင်ရာ “default sound” toggle မရှိတော့ပါ; ခေါ်ယူသူများသည် တောင်းဆိုမှု တစ်ခုချင်းစီအလိုက် အသံတစ်ခု (သို့မဟုတ် မပါ) ကို ရွေးချယ်ရပါမည်။
