---
summary: "Google Chat အက်ပ်၏ ပံ့ပိုးမှုအခြေအနေ၊ စွမ်းဆောင်ရည်များနှင့် ဖွဲ့စည်းပြင်ဆင်ခြင်း"
read_when:
  - Google Chat ချန်နယ် အင်္ဂါရပ်များကို လုပ်ဆောင်နေချိန်
title: "Google Chat"
---

# Google Chat (Chat API)

အခြေအနေ: Google Chat API webhooks (HTTP သာ) မှတစ်ဆင့် DMs + spaces အတွက် အသင့်ဖြစ်နေပါသည်။

## အမြန်စတင်ရန် (အစပြုသူများ)

1. Google Cloud project တစ်ခု ဖန်တီးပြီး **Google Chat API** ကို ဖွင့်ပါ။
   - သွားရန်: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - API ကို မဖွင့်ရသေးပါက ဖွင့်ပါ။
2. **Service Account** တစ်ခု ဖန်တီးပါ:
   - **Create Credentials** > **Service Account** ကို နှိပ်ပါ။
   - အမည်ကို စိတ်ကြိုက်ပေးပါ (ဥပမာ `openclaw-chat`)။
   - ခွင့်ပြုချက်များကို လွတ်ထားပါ (**Continue** ကို နှိပ်ပါ)။
   - ဝင်ရောက်ခွင့်ရှိသော principals များကို လွတ်ထားပါ (**Done** ကို နှိပ်ပါ)။
3. **JSON Key** ကို ဖန်တီးပြီး ဒေါင်းလုဒ်လုပ်ပါ:
   - ဖန်တီးပြီးသော service accounts စာရင်းထဲမှ သင်ဖန်တီးထားသည့် account ကို နှိပ်ပါ။
   - **Keys** 탭 သို့ သွားပါ။
   - **Add Key** > **Create new key** ကို နှိပ်ပါ။
   - **JSON** ကို ရွေးပြီး **Create** ကို နှိပ်ပါ။
4. ဒေါင်းလုဒ်လုပ်ထားသော JSON ဖိုင်ကို သင့် Gateway ဟို့စ် တွင် သိမ်းဆည်းပါ (ဥပမာ `~/.openclaw/googlechat-service-account.json`)။
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) တွင် Google Chat အက်ပ် တစ်ခု ဖန်တီးပါ:
   - **Application info** ကို ဖြည့်ပါ:
     - **App name**: (ဥပမာ `OpenClaw`)
     - **Avatar URL**: (ဥပမာ `https://openclaw.ai/logo.png`)
     - **Description**: (ဥပမာ `Personal AI Assistant`)
   - **Interactive features** ကို ဖွင့်ပါ။
   - **Functionality** အောက်တွင် **Join spaces and group conversations** ကို အမှန်ခြစ်ပါ။
   - **Connection settings** အောက်တွင် **HTTP endpoint URL** ကို ရွေးပါ။
   - **Triggers** အောက်တွင် **Use a common HTTP endpoint URL for all triggers** ကို ရွေးပြီး သင့် Gateway ၏ public URL နောက်တွင် `/googlechat` ကို ဆက်ထည့်ပါ။
     - _အကြံပြုချက်: သင့် Gateway ၏ public URL ကို ရှာရန် `openclaw status` ကို ပြေးပါ။_
   - **Visibility** အောက်တွင် **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** ကို အမှန်ခြစ်ပါ။
   - စာသားဘောက်စ်ထဲတွင် သင့် အီးမေးလ်လိပ်စာ (ဥပမာ `user@example.com`) ကို ထည့်ပါ။
   - အောက်ဆုံးရှိ **Save** ကို နှိပ်ပါ။
6. **အက်ပ် အခြေအနေကို ဖွင့်ပါ**:
   - သိမ်းပြီးနောက် **စာမျက်နှာကို ပြန်လည်ဆန်းသစ်ပါ**။
   - **App status** အပိုင်းကို ရှာပါ (အများအားဖြင့် သိမ်းပြီးနောက် အပေါ် သို့မဟုတ် အောက်တွင် တွေ့ရပါမည်)။
   - အခြေအနေကို **Live - available to users** သို့ ပြောင်းပါ။
   - **Save** ကို ထပ်မံ နှိပ်ပါ။
7. OpenClaw ကို service account path + webhook audience ဖြင့် ဖွဲ့စည်းပါ:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - သို့မဟုတ် config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`။
8. webhook audience အမျိုးအစား + တန်ဖိုးကို သတ်မှတ်ပါ (သင့် Chat app config နှင့် ကိုက်ညီရပါမည်)။
9. gateway ကို စတင်ပါ။ Google Chat will POST to your webhook path.

## Google Chat တွင် ထည့်သွင်းခြင်း

Gateway ကို စတင်ထားပြီး သင့် အီးမေးလ်ကို visibility စာရင်းထဲ ထည့်ထားပြီးနောက်:

1. [Google Chat](https://chat.google.com/) သို့ သွားပါ။
2. **Direct Messages** ဘေးရှိ **+** (plus) အိုင်ကွန်ကို နှိပ်ပါ။
3. ရှာဖွေရေးဘားတွင် (လူများကို ထည့်လေ့ရှိသည့် နေရာ) Google Cloud Console တွင် သင် သတ်မှတ်ထားသော **App name** ကို ရိုက်ထည့်ပါ။
   - **Note**: The bot will _not_ appear in the "Marketplace" browse list because it is a private app. You must search for it by name.
4. ရလဒ်များထဲမှ သင့် bot ကို ရွေးပါ။
5. **Add** သို့မဟုတ် **Chat** ကို နှိပ်ပြီး 1:1 စကားပြောကို စတင်ပါ။
6. အကူအညီပေးသူကို စတင်အလုပ်လုပ်စေရန် "Hello" ကို ပို့ပါ။

## Public URL (Webhook-only)

Google Chat webhooks require a public HTTPS endpoint. For security, **only expose the `/googlechat` path** to the internet. Keep the OpenClaw dashboard and other sensitive endpoints on your private network.

### Option A: Tailscale Funnel (အကြံပြု)

Use Tailscale Serve for the private dashboard and Funnel for the public webhook path. This keeps `/` private while exposing only `/googlechat`.

1. **သင့် Gateway သည် မည်သည့်လိပ်စာတွင် bind လုပ်ထားသည်ကို စစ်ဆေးပါ:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP လိပ်စာကို မှတ်သားပါ (ဥပမာ `127.0.0.1`, `0.0.0.0`, သို့မဟုတ် `100.x.x.x` ကဲ့သို့သော သင့် Tailscale IP)။

2. **dashboard ကို tailnet အတွင်းသာ ဖော်ပြပါ (port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **webhook path ကိုသာ public အဖြစ် ဖော်ပြပါ:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel ဝင်ရောက်ခွင့်အတွက် node ကို အတည်ပြုပါ:**
   တောင်းဆိုလာပါက output တွင် ပြထားသော authorization URL သို့ သွားပြီး သင့် tailnet policy တွင် ဤ node အတွက် Funnel ကို ဖွင့်ပါ။

5. **ဖွဲ့စည်းမှုကို အတည်ပြုပါ:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Your public webhook URL will be:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Your private dashboard stays tailnet-only:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat app config တွင် `:8443` မပါဘဲ public URL ကို အသုံးပြုပါ။

> Note: This configuration persists across reboots. To remove it later, run `tailscale funnel reset` and `tailscale serve reset`.

### Option B: Reverse Proxy (Caddy)

Caddy ကဲ့သို့သော reverse proxy ကို အသုံးပြုပါက path သီးသန့်ကိုသာ proxy လုပ်ပါ:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

ဤဖွဲ့စည်းမှုဖြင့် `your-domain.com/` သို့ လာသော request များကို လျစ်လျူရှုမည် သို့မဟုတ် 404 ဖြင့် ပြန်ပို့မည်ဖြစ်ပြီး `your-domain.com/googlechat` ကိုသာ OpenClaw သို့ လုံခြုံစွာ လမ်းကြောင်းချပါမည်။

### Option C: Cloudflare Tunnel

Tunnel ၏ ingress rules များကို webhook path ကိုသာ လမ်းကြောင်းချရန် ဖွဲ့စည်းပါ:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## အလုပ်လုပ်ပုံ

1. Google Chat sends webhook POSTs to the gateway. Each request includes an `Authorization: Bearer <token>` header.
2. OpenClaw သည် သတ်မှတ်ထားသော `audienceType` + `audience` ကို အသုံးပြု၍ token ကို စစ်ဆေးပါသည်:
   - `audienceType: "app-url"` → audience သည် သင့် HTTPS webhook URL ဖြစ်ပါသည်။
   - `audienceType: "project-number"` → audience သည် Cloud project number ဖြစ်ပါသည်။
3. မက်ဆေ့ချ်များကို space အလိုက် လမ်းကြောင်းခွဲပါသည်:
   - DMs များသည် session key `agent:<agentId>:googlechat:dm:<spaceId>` ကို အသုံးပြုပါသည်။
   - Spaces များသည် session key `agent:<agentId>:googlechat:group:<spaceId>` ကို အသုံးပြုပါသည်။
4. DM access is pairing by default. Unknown senders receive a pairing code; approve with:
   - `openclaw pairing approve googlechat <code>`
5. Group spaces require @-mention by default. Use `botUser` if mention detection needs the app’s user name.

## Targets

ပို့ဆောင်မှုနှင့် allowlists အတွက် အောက်ပါ အမှတ်အသားများကို အသုံးပြုပါ:

- Direct messages: `users/<userId>` သို့မဟုတ် `users/<email>` (အီးမေးလ်လိပ်စာများကို လက်ခံပါသည်)။
- Spaces: `spaces/<spaceId>`။

## Config highlights

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

မှတ်ချက်များ:

- Service account credentials ကို `serviceAccount` (JSON string) ဖြင့် inline အဖြစ်လည်း ပေးနိုင်ပါသည်။
- `webhookPath` ကို မသတ်မှတ်ထားပါက default webhook path သည် `/googlechat` ဖြစ်ပါသည်။
- `actions.reactions` ကို ဖွင့်ထားပါက `reactions` tool နှင့် `channels action` မှတစ်ဆင့် Reactions ကို အသုံးပြုနိုင်ပါသည်။
- `typingIndicator` သည် `none`, `message` (default), နှင့် `reaction` ကို ပံ့ပိုးပါသည် (reaction များအတွက် user OAuth လိုအပ်ပါသည်)။
- Attachments များကို Chat API မှတစ်ဆင့် ဒေါင်းလုဒ်လုပ်ပြီး media pipeline တွင် သိမ်းဆည်းပါသည် (အရွယ်အစားကို `mediaMaxMb` ဖြင့် ကန့်သတ်ထားပါသည်)။

## ပြဿနာဖြေရှင်းခြင်း

### 405 Method Not Allowed

Google Cloud Logs Explorer တွင် အောက်ပါကဲ့သို့သော အမှားများကို ပြသပါက:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

This means the webhook handler isn't registered. Common causes:

1. **Channel not configured**: The `channels.googlechat` section is missing from your config. အတည်ပြုရန်–

   ```bash
   openclaw config get channels.googlechat
   ```

   "Config path not found" ဟုပြပါက ဖွဲ့စည်းမှုကို ထည့်ပါ ([Config highlights](#config-highlights) ကို ကြည့်ပါ)။

2. **Plugin မဖွင့်ထားခြင်း**: plugin အခြေအနေကို စစ်ဆေးပါ:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   "disabled" ဟုပြပါက သင့် config တွင် `plugins.entries.googlechat.enabled: true` ကို ထည့်ပါ။

3. **Gateway ကို ပြန်မစတင်ရသေးခြင်း**: config ထည့်ပြီးနောက် Gateway ကို ပြန်စတင်ပါ:

   ```bash
   openclaw gateway restart
   ```

ချန်နယ် လည်ပတ်နေကြောင်း အတည်ပြုပါ:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### အခြား ပြဿနာများ

- auth အမှားများ သို့မဟုတ် audience config မပြည့်စုံခြင်းများအတွက် `openclaw channels status --probe` ကို စစ်ဆေးပါ။
- မက်ဆေ့ချ် မရောက်ပါက Chat app ၏ webhook URL + event subscriptions ကို အတည်ပြုပါ။
- mention gating ကြောင့် အဖြေများ ပိတ်ဆို့ခံရပါက `botUser` ကို အက်ပ်၏ user resource name အဖြစ် သတ်မှတ်ပြီး `requireMention` ကို စစ်ဆေးပါ။
- test message ပို့နေစဉ် Gateway သို့ request များ ရောက်မရောက်ကို ကြည့်ရန် `openclaw logs --follow` ကို အသုံးပြုပါ။

ဆက်စပ်စာတမ်းများ:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
