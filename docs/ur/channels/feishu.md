---
summary: "Feishu بوٹ کا جائزہ، خصوصیات، اور کنفیگریشن"
read_when:
  - آپ Feishu/Lark بوٹ کو منسلک کرنا چاہتے ہیں
  - آپ Feishu چینل کو کنفیگر کر رہے ہیں
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:14Z
---

# Feishu بوٹ

Feishu (Lark) ایک ٹیم چیٹ پلیٹ فارم ہے جسے کمپنیاں پیغام رسانی اور تعاون کے لیے استعمال کرتی ہیں۔ یہ پلگ اِن OpenClaw کو Feishu/Lark بوٹ سے پلیٹ فارم کی WebSocket ایونٹ سبسکرپشن کے ذریعے جوڑتا ہے تاکہ عوامی webhook URL کو ظاہر کیے بغیر پیغامات موصول کیے جا سکیں۔

---

## درکار پلگ اِن

Feishu پلگ اِن انسٹال کریں:

```bash
openclaw plugins install @openclaw/feishu
```

لوکل چیک آؤٹ (جب git ریپو سے چلایا جا رہا ہو):

```bash
openclaw plugins install ./extensions/feishu
```

---

## فوری آغاز

Feishu چینل شامل کرنے کے دو طریقے ہیں:

### طریقہ 1: آن بورڈنگ وزارڈ (سفارش کردہ)

اگر آپ نے ابھی OpenClaw انسٹال کیا ہے، تو وزارڈ چلائیں:

```bash
openclaw onboard
```

وزارڈ آپ کی رہنمائی کرتا ہے:

1. Feishu ایپ بنانا اور اسناد جمع کرنا
2. OpenClaw میں ایپ اسناد کنفیگر کرنا
3. گیٹ وے شروع کرنا

✅ **کنفیگریشن کے بعد**، گیٹ وے کی حالت چیک کریں:

- `openclaw gateway status`
- `openclaw logs --follow`

### طریقہ 2: CLI سیٹ اپ

اگر آپ ابتدائی انسٹال مکمل کر چکے ہیں، تو CLI کے ذریعے چینل شامل کریں:

```bash
openclaw channels add
```

**Feishu** منتخب کریں، پھر App ID اور App Secret درج کریں۔

✅ **کنفیگریشن کے بعد**، گیٹ وے کا نظم کریں:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## مرحلہ 1: Feishu ایپ بنائیں

### 1. Feishu Open Platform کھولیں

[Feishu Open Platform](https://open.feishu.cn/app) پر جائیں اور سائن اِن کریں۔

Lark (عالمی) ٹیننٹس کے لیے [https://open.larksuite.com/app](https://open.larksuite.com/app) استعمال کریں اور Feishu کنفیگ میں `domain: "lark"` سیٹ کریں۔

### 2. ایپ بنائیں

1. **Create enterprise app** پر کلک کریں
2. ایپ کا نام اور وضاحت درج کریں
3. ایپ آئیکن منتخب کریں

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. اسناد کاپی کریں

**Credentials & Basic Info** سے یہ کاپی کریں:

- **App ID** (فارمیٹ: `cli_xxx`)
- **App Secret**

❗ **اہم:** App Secret کو نجی رکھیں۔

![Get credentials](../images/feishu-step3-credentials.png)

### 4. اجازتیں کنفیگر کریں

**Permissions** میں، **Batch import** پر کلک کریں اور یہ پیسٹ کریں:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. بوٹ کی صلاحیت فعال کریں

**App Capability** > **Bot** میں:

1. بوٹ کی صلاحیت فعال کریں
2. بوٹ کا نام سیٹ کریں

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. ایونٹ سبسکرپشن کنفیگر کریں

⚠️ **اہم:** ایونٹ سبسکرپشن سیٹ کرنے سے پہلے، یقینی بنائیں:

1. آپ Feishu کے لیے پہلے ہی `openclaw channels add` چلا چکے ہیں
2. گیٹ وے چل رہا ہو (`openclaw gateway status`)

**Event Subscription** میں:

1. **Use long connection to receive events** (WebSocket) منتخب کریں
2. یہ ایونٹ شامل کریں: `im.message.receive_v1`

⚠️ اگر گیٹ وے نہیں چل رہا، تو لانگ کنکشن سیٹ اپ محفوظ ہونے میں ناکام ہو سکتا ہے۔

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. ایپ شائع کریں

1. **Version Management & Release** میں ایک ورژن بنائیں
2. ریویو کے لیے جمع کروائیں اور شائع کریں
3. ایڈمن منظوری کا انتظار کریں (انٹرپرائز ایپس عموماً خودکار طور پر منظور ہو جاتی ہیں)

---

## مرحلہ 2: OpenClaw کنفیگر کریں

### وزارڈ کے ساتھ کنفیگر کریں (سفارش کردہ)

```bash
openclaw channels add
```

**Feishu** منتخب کریں اور اپنا App ID اور App Secret پیسٹ کریں۔

### کنفیگ فائل کے ذریعے کنفیگر کریں

`~/.openclaw/openclaw.json` میں ترمیم کریں:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### ماحولیاتی متغیرات کے ذریعے کنفیگر کریں

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (عالمی) ڈومین

اگر آپ کا ٹیننٹ Lark (بین الاقوامی) پر ہے، تو ڈومین کو `lark` (یا مکمل ڈومین اسٹرنگ) پر سیٹ کریں۔ آپ اسے `channels.feishu.domain` پر یا فی اکاؤنٹ (`channels.feishu.accounts.<id>.domain`) سیٹ کر سکتے ہیں۔

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## مرحلہ 3: شروع کریں اور جانچ کریں

### 1. گیٹ وے شروع کریں

```bash
openclaw gateway
```

### 2. ٹیسٹ پیغام بھیجیں

Feishu میں، اپنے بوٹ کو تلاش کریں اور پیغام بھیجیں۔

### 3. جوڑی بنانے کی منظوری دیں

بطورِ طے شدہ، بوٹ جوڑی بنانے کا کوڈ جواب میں بھیجتا ہے۔ اسے منظور کریں:

```bash
openclaw pairing approve feishu <CODE>
```

منظوری کے بعد، آپ معمول کے مطابق چیٹ کر سکتے ہیں۔

---

## جائزہ

- **Feishu بوٹ چینل**: گیٹ وے کے زیرِ انتظام Feishu بوٹ
- **متعین روٹنگ**: جوابات ہمیشہ Feishu پر واپس آتے ہیں
- **سیشن آئسولیشن**: DMs ایک مرکزی سیشن شیئر کرتے ہیں؛ گروپس الگ ہوتے ہیں
- **WebSocket کنکشن**: Feishu SDK کے ذریعے لانگ کنکشن، عوامی URL کی ضرورت نہیں

---

## رسائی کا کنٹرول

### براہِ راست پیغامات

- **بطورِ طے شدہ**: `dmPolicy: "pairing"` (نامعلوم صارفین کو جوڑی بنانے کا کوڈ ملتا ہے)
- **جوڑی بنانے کی منظوری دیں**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **اجازت فہرست موڈ**: اجازت یافتہ Open IDs کے ساتھ `channels.feishu.allowFrom` سیٹ کریں

### گروپ چیٹس

**1. گروپ پالیسی** (`channels.feishu.groupPolicy`):

- `"open"` = گروپس میں سب کو اجازت دیں (بطورِ طے شدہ)
- `"allowlist"` = صرف `groupAllowFrom` کو اجازت دیں
- `"disabled"` = گروپ پیغامات غیر فعال کریں

**2. ذکر کی شرط** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @mention لازمی (بطورِ طے شدہ)
- `false` = بغیر ذکر کے جواب دیں

---

## گروپ کنفیگریشن کی مثالیں

### تمام گروپس کی اجازت، @mention لازمی (بطورِ طے شدہ)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### تمام گروپس کی اجازت، @mention درکار نہیں

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### صرف مخصوص صارفین کو گروپس میں اجازت دیں

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## گروپ/صارف IDs حاصل کریں

### گروپ IDs (chat_id)

گروپ IDs کی شکل `oc_xxx` جیسی ہوتی ہے۔

**طریقہ 1 (سفارش کردہ)**

1. گیٹ وے شروع کریں اور گروپ میں بوٹ کو @mention کریں
2. `openclaw logs --follow` چلائیں اور `chat_id` تلاش کریں

**طریقہ 2**

Feishu API ڈیباگر استعمال کر کے گروپ چیٹس کی فہرست بنائیں۔

### صارف IDs (open_id)

صارف IDs کی شکل `ou_xxx` جیسی ہوتی ہے۔

**طریقہ 1 (سفارش کردہ)**

1. گیٹ وے شروع کریں اور بوٹ کو DM کریں
2. `openclaw logs --follow` چلائیں اور `open_id` تلاش کریں

**طریقہ 2**

صارف Open IDs کے لیے جوڑی بنانے کی درخواستیں چیک کریں:

```bash
openclaw pairing list feishu
```

---

## عام کمانڈز

| کمانڈ     | وضاحت                   |
| --------- | ----------------------- |
| `/status` | بوٹ کی حالت دکھائیں     |
| `/reset`  | سیشن ری سیٹ کریں        |
| `/model`  | ماڈل دکھائیں/تبدیل کریں |

> نوٹ: Feishu ابھی مقامی کمانڈ مینو کی حمایت نہیں کرتا، اس لیے کمانڈز متن کی صورت میں بھیجنی ہوں گی۔

## گیٹ وے مینجمنٹ کمانڈز

| کمانڈ                      | وضاحت                        |
| -------------------------- | ---------------------------- |
| `openclaw gateway status`  | گیٹ وے کی حالت دکھائیں       |
| `openclaw gateway install` | گیٹ وے سروس انسٹال/شروع کریں |
| `openclaw gateway stop`    | گیٹ وے سروس بند کریں         |
| `openclaw gateway restart` | گیٹ وے سروس دوبارہ شروع کریں |
| `openclaw logs --follow`   | گیٹ وے لاگز دیکھیں           |

---

## خرابیوں کا ازالہ

### بوٹ گروپ چیٹس میں جواب نہیں دیتا

1. یقینی بنائیں کہ بوٹ گروپ میں شامل ہے
2. یقینی بنائیں کہ آپ بوٹ کو @mention کر رہے ہیں (بطورِ طے شدہ رویہ)
3. چیک کریں کہ `groupPolicy` کو `"disabled"` پر سیٹ نہیں کیا گیا
4. لاگز چیک کریں: `openclaw logs --follow`

### بوٹ پیغامات موصول نہیں کرتا

1. یقینی بنائیں کہ ایپ شائع اور منظور شدہ ہے
2. یقینی بنائیں کہ ایونٹ سبسکرپشن میں `im.message.receive_v1` شامل ہے
3. یقینی بنائیں کہ **لانگ کنکشن** فعال ہے
4. یقینی بنائیں کہ ایپ کی اجازتیں مکمل ہیں
5. یقینی بنائیں کہ گیٹ وے چل رہا ہے: `openclaw gateway status`
6. لاگز چیک کریں: `openclaw logs --follow`

### App Secret کا افشا ہونا

1. Feishu Open Platform میں App Secret ری سیٹ کریں
2. اپنی کنفیگ میں App Secret اپ ڈیٹ کریں
3. گیٹ وے دوبارہ شروع کریں

### پیغام بھیجنے میں ناکامی

1. یقینی بنائیں کہ ایپ کے پاس `im:message:send_as_bot` کی اجازت ہے
2. یقینی بنائیں کہ ایپ شائع شدہ ہے
3. تفصیلی غلطیوں کے لیے لاگز چیک کریں

---

## اعلیٰ درجے کی کنفیگریشن

### متعدد اکاؤنٹس

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### پیغام کی حدود

- `textChunkLimit`: آؤٹ باؤنڈ متن کے حصے کا سائز (بطورِ طے شدہ: 2000 حروف)
- `mediaMaxMb`: میڈیا اپ لوڈ/ڈاؤن لوڈ حد (بطورِ طے شدہ: 30MB)

### اسٹریمنگ

Feishu انٹرایکٹو کارڈز کے ذریعے اسٹریمنگ جوابات کی حمایت کرتا ہے۔ فعال ہونے پر، بوٹ متن تیار کرتے ہوئے کارڈ کو اپ ڈیٹ کرتا ہے۔

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

مکمل جواب بھیجنے سے پہلے انتظار کرنے کے لیے `streaming: false` سیٹ کریں۔

### ملٹی ایجنٹ روٹنگ

Feishu DMs یا گروپس کو مختلف ایجنٹس کی طرف روٹ کرنے کے لیے `bindings` استعمال کریں۔

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

روٹنگ فیلڈز:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` یا `"group"`
- `match.peer.id`: صارف Open ID (`ou_xxx`) یا گروپ ID (`oc_xxx`)

تلاش کے نکات کے لیے [Get group/user IDs](#get-groupuser-ids) دیکھیں۔

---

## کنفیگریشن حوالہ

مکمل کنفیگریشن: [Gateway configuration](/gateway/configuration)

اہم اختیارات:

| سیٹنگ                                             | وضاحت                          | بطورِ طے شدہ |
| ------------------------------------------------- | ------------------------------ | ------------ |
| `channels.feishu.enabled`                         | چینل فعال/غیرفعال              | `true`       |
| `channels.feishu.domain`                          | API ڈومین (`feishu` یا `lark`) | `feishu`     |
| `channels.feishu.accounts.<id>.appId`             | App ID                         | -            |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                     | -            |
| `channels.feishu.accounts.<id>.domain`            | فی اکاؤنٹ API ڈومین اووررائیڈ  | `feishu`     |
| `channels.feishu.dmPolicy`                        | DM پالیسی                      | `pairing`    |
| `channels.feishu.allowFrom`                       | DM اجازت فہرست (open_id فہرست) | -            |
| `channels.feishu.groupPolicy`                     | گروپ پالیسی                    | `open`       |
| `channels.feishu.groupAllowFrom`                  | گروپ اجازت فہرست               | -            |
| `channels.feishu.groups.<chat_id>.requireMention` | @mention لازمی                 | `true`       |
| `channels.feishu.groups.<chat_id>.enabled`        | گروپ فعال کریں                 | `true`       |
| `channels.feishu.textChunkLimit`                  | پیغام کے حصے کا سائز           | `2000`       |
| `channels.feishu.mediaMaxMb`                      | میڈیا سائز کی حد               | `30`         |
| `channels.feishu.streaming`                       | اسٹریمنگ کارڈ آؤٹ پٹ فعال کریں | `true`       |
| `channels.feishu.blockStreaming`                  | بلاک اسٹریمنگ فعال کریں        | `true`       |

---

## dmPolicy حوالہ

| قدر           | رویہ                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `"pairing"`   | **بطورِ طے شدہ۔** نامعلوم صارفین کو جوڑی بنانے کا کوڈ ملتا ہے؛ منظوری لازم |
| `"allowlist"` | صرف `allowFrom` میں موجود صارفین چیٹ کر سکتے ہیں                           |
| `"open"`      | تمام صارفین کو اجازت دیں (requires `"*"` in allowFrom)                     |
| `"disabled"`  | DMs غیر فعال کریں                                                          |

---

## معاون پیغام کی اقسام

### وصول کریں

- ✅ متن
- ✅ رچ ٹیکسٹ (post)
- ✅ تصاویر
- ✅ فائلیں
- ✅ آڈیو
- ✅ ویڈیو
- ✅ اسٹیکرز

### بھیجیں

- ✅ متن
- ✅ تصاویر
- ✅ فائلیں
- ✅ آڈیو
- ⚠️ رچ ٹیکسٹ (جزوی معاونت)
