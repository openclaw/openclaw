---
summary: "Google Chat ایپ کی سپورٹ اسٹیٹس، صلاحیتیں، اور کنفیگریشن"
read_when:
  - Google Chat چینل کی خصوصیات پر کام کرتے وقت
title: "Google Chat"
---

# Google Chat (Chat API)

اسٹیٹس: Google Chat API ویب ہُکس کے ذریعے DMs + spaces کے لیے تیار (صرف HTTP)۔

## فوری سیٹ اپ (مبتدی)

1. ایک Google Cloud پروجیکٹ بنائیں اور **Google Chat API** فعال کریں۔
   - جائیں: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - اگر API پہلے سے فعال نہیں ہے تو اسے فعال کریں۔
2. ایک **Service Account** بنائیں:
   - **Create Credentials** > **Service Account** پر کلک کریں۔
   - کوئی بھی نام رکھیں (مثلاً `openclaw-chat`)۔
   - اجازتیں خالی چھوڑ دیں (**Continue** دبائیں)۔
   - رسائی کے حامل principals خالی چھوڑ دیں (**Done** دبائیں)۔
3. **JSON Key** بنائیں اور ڈاؤن لوڈ کریں:
   - سروس اکاؤنٹس کی فہرست میں، ابھی بنائے گئے اکاؤنٹ پر کلک کریں۔
   - **Keys** ٹیب پر جائیں۔
   - **Add Key** > **Create new key** پر کلک کریں۔
   - **JSON** منتخب کریں اور **Create** دبائیں۔
4. ڈاؤن لوڈ کی گئی JSON فائل کو اپنے گیٹ وے ہوسٹ پر محفوظ کریں (مثلاً `~/.openclaw/googlechat-service-account.json`)۔
5. [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) میں ایک Google Chat ایپ بنائیں:
   - **Application info** پُر کریں:
     - **App name**: (مثلاً `OpenClaw`)
     - **Avatar URL**: (مثلاً `https://openclaw.ai/logo.png`)
     - **Description**: (مثلاً `Personal AI Assistant`)
   - **Interactive features** فعال کریں۔
   - **Functionality** کے تحت **Join spaces and group conversations** منتخب کریں۔
   - **Connection settings** کے تحت **HTTP endpoint URL** منتخب کریں۔
   - **Triggers** کے تحت **Use a common HTTP endpoint URL for all triggers** منتخب کریں اور اسے اپنے گیٹ وے کے عوامی URL کے بعد `/googlechat` کے ساتھ سیٹ کریں۔
     - _مشورہ: اپنے گیٹ وے کا عوامی URL معلوم کرنے کے لیے `openclaw status` چلائیں۔_
   - **Visibility** کے تحت **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** منتخب کریں۔
   - ٹیکسٹ باکس میں اپنا ای میل ایڈریس درج کریں (مثلاً `user@example.com`)۔
   - نیچے **Save** پر کلک کریں۔
6. **ایپ اسٹیٹس فعال کریں**:
   - محفوظ کرنے کے بعد **صفحہ ریفریش کریں**۔
   - **App status** سیکشن تلاش کریں (عموماً محفوظ کرنے کے بعد اوپر یا نیچے ہوتا ہے)۔
   - اسٹیٹس کو **Live - available to users** پر تبدیل کریں۔
   - دوبارہ **Save** پر کلک کریں۔
7. OpenClaw کو سروس اکاؤنٹ کے راستے + ویب ہُک آڈینس کے ساتھ کنفیگر کریں:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - یا کنفیگ: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`۔
8. ویب ہُک آڈینس کی قسم + ویلیو سیٹ کریں (آپ کی Chat ایپ کنفیگ سے مطابقت رکھتی ہو)۔
9. gateway شروع کریں۔ Google Chat will POST to your webhook path.

## Google Chat میں شامل کریں

جب گیٹ وے چل رہا ہو اور آپ کا ای میل visibility فہرست میں شامل ہو:

1. [Google Chat](https://chat.google.com/) پر جائیں۔
2. **Direct Messages** کے ساتھ موجود **+** (پلس) آئیکن پر کلک کریں۔
3. سرچ بار میں (جہاں آپ عام طور پر لوگوں کو شامل کرتے ہیں) وہ **App name** ٹائپ کریں جو آپ نے Google Cloud Console میں کنفیگر کیا تھا۔
   - **Note**: The bot will _not_ appear in the "Marketplace" browse list because it is a private app. You must search for it by name.
4. نتائج میں سے اپنے بوٹ کو منتخب کریں۔
5. 1:1 گفتگو شروع کرنے کے لیے **Add** یا **Chat** پر کلک کریں۔
6. اسسٹنٹ کو متحرک کرنے کے لیے "Hello" بھیجیں!

## عوامی URL (صرف ویب ہُک)

Google Chat webhooks require a public HTTPS endpoint. For security, **only expose the `/googlechat` path** to the internet. Keep the OpenClaw dashboard and other sensitive endpoints on your private network.

### آپشن A: Tailscale Funnel (سفارش کردہ)

Use Tailscale Serve for the private dashboard and Funnel for the public webhook path. This keeps `/` private while exposing only `/googlechat`.

1. **چیک کریں کہ آپ کا گیٹ وے کس ایڈریس پر باؤنڈ ہے:**

   ```bash
   ss -tlnp | grep 18789
   ```

   IP ایڈریس نوٹ کریں (مثلاً `127.0.0.1`، `0.0.0.0`، یا آپ کا Tailscale IP جیسے `100.x.x.x`)۔

2. **ڈیش بورڈ کو صرف tailnet کے لیے ایکسپوز کریں (پورٹ 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **صرف ویب ہُک راستہ عوامی طور پر ایکسپوز کریں:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Funnel رسائی کے لیے نوڈ کو مجاز بنائیں:**
   اگر اشارہ دیا جائے، تو آؤٹ پٹ میں دکھائے گئے اجازت نامہ URL پر جا کر اپنی tailnet پالیسی میں اس نوڈ کے لیے Funnel فعال کریں۔

5. **کنفیگریشن کی تصدیق کریں:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Your public webhook URL will be:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Your private dashboard stays tailnet-only:
`https://<node-name>.<tailnet>.ts.net:8443/`

Google Chat ایپ کنفیگ میں عوامی URL استعمال کریں (`:8443` کے بغیر)۔

> Note: This configuration persists across reboots. To remove it later, run `tailscale funnel reset` and `tailscale serve reset`.

### آپشن B: ریورس پراکسی (Caddy)

اگر آپ Caddy جیسی ریورس پراکسی استعمال کرتے ہیں، تو صرف مخصوص راستے کو پراکسی کریں:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

اس کنفیگ کے ساتھ، `your-domain.com/` پر آنے والی کسی بھی درخواست کو نظرانداز کیا جائے گا یا 404 واپس کیا جائے گا، جبکہ `your-domain.com/googlechat` محفوظ طریقے سے OpenClaw کی طرف روٹ ہوگا۔

### آپشن C: Cloudflare Tunnel

اپنے ٹنل کے ingress قواعد کو اس طرح کنفیگر کریں کہ صرف ویب ہُک راستہ روٹ ہو:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## یہ کیسے کام کرتا ہے

1. Google Chat sends webhook POSTs to the gateway. Each request includes an `Authorization: Bearer <token>` header.
2. OpenClaw کنفیگر کیے گئے `audienceType` + `audience` کے خلاف ٹوکن کی تصدیق کرتا ہے:
   - `audienceType: "app-url"` → آڈینس آپ کا HTTPS ویب ہُک URL ہوتا ہے۔
   - `audienceType: "project-number"` → آڈینس Cloud پروجیکٹ نمبر ہوتا ہے۔
3. پیغامات space کے مطابق روٹ ہوتے ہیں:
   - DMs سیشن کی `agent:<agentId>:googlechat:dm:<spaceId>` استعمال کرتے ہیں۔
   - Spaces سیشن کی `agent:<agentId>:googlechat:group:<spaceId>` استعمال کرتے ہیں۔
4. DM access is pairing by default. Unknown senders receive a pairing code; approve with:
   - `openclaw pairing approve googlechat <code>`
5. Group spaces require @-mention by default. Use `botUser` if mention detection needs the app’s user name.

## Targets

ترسیل اور اجازت فہرستوں کے لیے یہ شناخت کنندگان استعمال کریں:

- براہِ راست پیغامات: `users/<userId>` یا `users/<email>` (ای میل ایڈریس قبول کیے جاتے ہیں)۔
- Spaces: `spaces/<spaceId>`۔

## کنفیگ نمایاں نکات

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

نوٹس:

- سروس اکاؤنٹ کی اسناد `serviceAccount` (JSON اسٹرنگ) کے ساتھ inline بھی دی جا سکتی ہیں۔
- اگر `webhookPath` سیٹ نہ ہو تو ڈیفالٹ ویب ہُک راستہ `/googlechat` ہوتا ہے۔
- ری ایکشنز `reactions` اوزار اور `channels action` کے ذریعے دستیاب ہیں جب `actions.reactions` فعال ہو۔
- `typingIndicator`، `none`، `message` (ڈیفالٹ)، اور `reaction` کی سپورٹ کرتا ہے (ری ایکشن کے لیے صارف OAuth درکار ہوتا ہے)۔
- اٹیچمنٹس Chat API کے ذریعے ڈاؤن لوڈ ہو کر میڈیا پائپ لائن میں محفوظ ہوتے ہیں (سائز `mediaMaxMb` سے محدود)۔

## خرابیوں کا ازالہ

### 405 Method Not Allowed

اگر Google Cloud Logs Explorer میں اس طرح کی غلطیاں دکھائی دیں:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

This means the webhook handler isn't registered. Common causes:

1. **Channel not configured**: The `channels.googlechat` section is missing from your config. تصدیق کریں:

   ```bash
   openclaw config get channels.googlechat
   ```

   اگر "Config path not found" آئے تو کنفیگریشن شامل کریں (دیکھیں [کنفیگ نمایاں نکات](#config-highlights))۔

2. **پلگ اِن فعال نہیں**: پلگ اِن اسٹیٹس چیک کریں:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   اگر "disabled" دکھائے تو اپنی کنفیگ میں `plugins.entries.googlechat.enabled: true` شامل کریں۔

3. **گیٹ وے ری اسٹارٹ نہیں ہوا**: کنفیگ شامل کرنے کے بعد گیٹ وے ری اسٹارٹ کریں:

   ```bash
   openclaw gateway restart
   ```

تصدیق کریں کہ چینل چل رہا ہے:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### دیگر مسائل

- تصدیقی غلطیوں یا آڈینس کنفیگ کی کمی کے لیے `openclaw channels status --probe` چیک کریں۔
- اگر کوئی پیغامات موصول نہ ہوں تو Chat ایپ کے ویب ہُک URL + ایونٹ سبسکرپشنز کی تصدیق کریں۔
- اگر mention gating جوابات کو بلاک کرے تو `botUser` کو ایپ کے صارف resource نام پر سیٹ کریں اور `requireMention` کی تصدیق کریں۔
- ٹیسٹ پیغام بھیجتے وقت `openclaw logs --follow` استعمال کریں تاکہ معلوم ہو سکے کہ درخواستیں گیٹ وے تک پہنچ رہی ہیں یا نہیں۔

متعلقہ دستاویزات:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
