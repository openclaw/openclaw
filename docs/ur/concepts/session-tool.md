---
summary: "ایجنٹ سیشن ٹولز برائے سیشنز کی فہرست، ہسٹری حاصل کرنا، اور کراس‑سیشن پیغامات بھیجنا"
read_when:
  - سیشن ٹولز شامل یا ترمیم کرتے وقت
title: "سیشن ٹولز"
---

# سیشن ٹولز

ہدف: ایک چھوٹا، غلط استعمال سے محفوظ ٹول سیٹ تاکہ ایجنٹس سیشنز کی فہرست بنا سکیں، ہسٹری حاصل کر سکیں، اور کسی دوسرے سیشن میں پیغام بھیج سکیں۔

## ٹول کے نام

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## کی ماڈل

- مرکزی براہِ راست چیٹ بالٹی ہمیشہ لفظی کلید `"main"` ہوتی ہے (جو موجودہ ایجنٹ کی مرکزی کلید پر حل ہوتی ہے)۔
- گروپ چیٹس `agent:<agentId>:<channel>:group:<id>` یا `agent:<agentId>:<channel>:channel:<id>` استعمال کرتی ہیں (مکمل کلید پاس کریں)۔
- کرون جابز `cron:<job.id>` استعمال کرتی ہیں۔
- ہُکس `hook:<uuid>` استعمال کرتے ہیں جب تک واضح طور پر سیٹ نہ کیا جائے۔
- نوڈ سیشنز `node-<nodeId>` استعمال کرتے ہیں جب تک واضح طور پر سیٹ نہ کیا جائے۔

47. اگر `session.scope = "global"` ہو تو ہم اسے تمام tools کے لیے `main` سے alias کر دیتے ہیں تاکہ کالرز کبھی `global` نہ دیکھیں۔ 48. اگر wait ٹائم آؤٹ ہو جائے: `{ runId, status: "timeout", error }`۔

## sessions_list

سیشنز کو قطاروں کی ایک ارے کے طور پر فہرست کریں۔

Parameters:

- `kinds?: string[]` فلٹر: `"main" | "group" | "cron" | "hook" | "node" | "other"` میں سے کوئی
- `limit?: number` زیادہ سے زیادہ قطاریں (ڈیفالٹ: سرور ڈیفالٹ، حد مثلاً 200)
- `activeMinutes?: number` صرف وہ سیشنز جو N منٹ کے اندر اپڈیٹ ہوئے ہوں
- `messageLimit?: number` 0 = کوئی پیغامات نہیں (ڈیفالٹ 0)؛ >0 = آخری N پیغامات شامل کریں

Behavior:

- `messageLimit > 0` ہر سیشن کے لیے `chat.history` حاصل کرتا ہے اور آخری N پیغامات شامل کرتا ہے۔
- فہرست کے آؤٹ پٹ میں ٹول کے نتائج فلٹر کر دیے جاتے ہیں؛ ٹول پیغامات کے لیے `sessions_history` استعمال کریں۔
- **sandboxed** ایجنٹ سیشن میں چلانے پر، سیشن ٹولز بطورِ طے شدہ **spawned-only visibility** استعمال کرتے ہیں (نیچے دیکھیں)۔

Row shape (JSON):

- `key`: سیشن کلید (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (اگر دستیاب ہو تو گروپ ڈسپلے لیبل)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (اگر سیٹ ہو تو سیشن اووررائیڈ)
- `lastChannel`, `lastTo`
- `deliveryContext` (جب دستیاب ہو تو نارملائزڈ `{ channel, to, accountId }`)
- `transcriptPath` (اسٹور ڈائریکٹری + sessionId سے اخذ کردہ بہترین کوشش کی راہ)
- `messages?` (صرف جب `messageLimit > 0`)

## sessions_history

ایک سیشن کے لیے ٹرانسکرپٹ حاصل کریں۔

Parameters:

- `sessionKey` (لازم؛ سیشن کلید یا `sessions_list` سے `sessionId` قبول کرتا ہے)
- `limit?: number` زیادہ سے زیادہ پیغامات (سرور حد مقرر کرتا ہے)
- `includeTools?: boolean` (ڈیفالٹ false)

Behavior:

- `includeTools=false` `role: "toolResult"` پیغامات فلٹر کرتا ہے۔
- خام ٹرانسکرپٹ فارمیٹ میں پیغامات کی ارے واپس کرتا ہے۔
- جب `sessionId` دیا جائے تو OpenClaw اسے متعلقہ سیشن کلید پر حل کرتا ہے (غائب ids پر خرابی)۔

## sessions_send

کسی دوسرے سیشن میں پیغام بھیجیں۔

Parameters:

- `sessionKey` (لازم؛ سیشن کلید یا `sessions_list` سے `sessionId` قبول کرتا ہے)
- `message` (لازم)
- `timeoutSeconds?: number` (ڈیفالٹ >0؛ 0 = فائر‑اینڈ‑فورگیٹ)

Behavior:

- `timeoutSeconds = 0`: قطار میں ڈالیں اور `{ runId, status: "accepted" }` واپس کریں۔
- `timeoutSeconds > 0`: تکمیل کے لیے N سیکنڈ تک انتظار کریں، پھر `{ runId, status: "ok", reply }` واپس کریں۔
- 49. Run جاری رہتا ہے؛ بعد میں `sessions_history` کال کریں۔ 50. `agents.list[].subagents.allowAgents`: ایجنٹ ids کی فہرست جنہیں `agentId` کے ذریعے اجازت ہے (`["*"]` کسی کو بھی اجازت دینے کے لیے)۔
- اگر رَن ناکام ہو جائے: `{ runId, status: "error", error }`۔
- اعلان کی ترسیل پرائمری رَن مکمل ہونے کے بعد چلتی ہے اور بہترین کوشش پر مبنی ہوتی ہے؛ `status: "ok"` اس بات کی ضمانت نہیں دیتا کہ اعلان پہنچا۔
- انتظار gateway `agent.wait` (سرور سائیڈ) کے ذریعے ہوتا ہے تاکہ ری کنیکٹس انتظار کو منقطع نہ کریں۔
- پرائمری رَن کے لیے ایجنٹ‑سے‑ایجنٹ پیغام کا سیاق داخل کیا جاتا ہے۔
- پرائمری رَن مکمل ہونے کے بعد، OpenClaw ایک **reply-back loop** چلاتا ہے:
  - راؤنڈ 2+ میں درخواست گزار اور ہدف ایجنٹس باری باری جواب دیتے ہیں۔
  - پنگ‑پونگ روکنے کے لیے عین `REPLY_SKIP` کا جواب دیں۔
  - زیادہ سے زیادہ ٹرنز `session.agentToAgent.maxPingPongTurns` ہیں (0–5، ڈیفالٹ 5)۔
- لوپ ختم ہونے پر، OpenClaw **agent‑to‑agent announce step** چلاتا ہے (صرف ہدف ایجنٹ):
  - خاموش رہنے کے لیے عین `ANNOUNCE_SKIP` کا جواب دیں۔
  - کوئی بھی دوسرا جواب ہدف چینل پر بھیجا جاتا ہے۔
  - اعلان کے مرحلے میں اصل درخواست + راؤنڈ‑1 جواب + تازہ ترین پنگ‑پونگ جواب شامل ہوتا ہے۔

## چینل فیلڈ

- گروپس کے لیے، `channel` وہ چینل ہے جو سیشن اندراج پر ریکارڈ ہوتا ہے۔
- براہِ راست چیٹس کے لیے، `channel` `lastChannel` سے میپ ہوتا ہے۔
- کرون/ہُک/نوڈ کے لیے، `channel` `internal` ہوتا ہے۔
- اگر غائب ہو تو، `channel` `unknown` ہوتا ہے۔

## سکیورٹی / بھیجنے کی پالیسی

چینل/چیٹ کی قسم کے مطابق پالیسی پر مبنی بلاکنگ (فی سیشن id نہیں)۔

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

رن ٹائم اووررائیڈ (فی سیشن اندراج):

- `sendPolicy: "allow" | "deny"` (غیر سیٹ = کنفیگ وراثت)
- `sessions.patch` کے ذریعے یا صرف مالک کے لیے `/send on|off|inherit` (اسٹینڈ الون پیغام) کے ذریعے سیٹ کیا جا سکتا ہے۔

نفاذ کے مقامات:

- `chat.send` / `agent` (gateway)
- خودکار جواب کی ترسیلی منطق

## sessions_spawn

ایک الگ تھلگ سیشن میں ذیلی ایجنٹ رَن شروع کریں اور نتیجہ درخواست گزار کے چیٹ چینل پر اعلان کریں۔

Parameters:

- `task` (لازم)
- `label?` (اختیاری؛ لاگز/UI کے لیے استعمال)
- `agentId?` (اختیاری؛ اگر اجازت ہو تو کسی دوسرے ایجنٹ id کے تحت اسپان کریں)
- `model?` (اختیاری؛ ذیلی ایجنٹ ماڈل اووررائیڈ؛ غلط اقدار پر خرابی)
- `runTimeoutSeconds?` (ڈیفالٹ 0؛ سیٹ ہونے پر N سیکنڈ بعد ذیلی ایجنٹ رَن منسوخ)
- `cleanup?` (`delete|keep`، ڈیفالٹ `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: list of agent ids allowed via `agentId` (`["*"]` to allow any). OpenClaw **ہر ایجنٹ کے لیے ایک براہِ راست چیٹ سیشن** کو بنیادی سمجھتا ہے۔

Discovery:

- `agents_list` استعمال کریں تاکہ معلوم ہو سکے کہ `sessions_spawn` کے لیے کون سے ایجنٹ ids اجازت یافتہ ہیں۔

Behavior:

- `deliver: false` کے ساتھ ایک نیا `agent:<agentId>:subagent:<uuid>` سیشن شروع کرتا ہے۔
- ذیلی ایجنٹس بطورِ طے شدہ مکمل ٹول سیٹ کے ساتھ آتے ہیں **بجز سیشن ٹولز** (کنفیگریشن کے ذریعے `tools.subagents.tools`)۔
- ذیلی ایجنٹس کو `sessions_spawn` کال کرنے کی اجازت نہیں (ذیلی ایجنٹ → ذیلی ایجنٹ اسپان نہیں)۔
- ہمیشہ نان‑بلاکنگ: فوراً `{ status: "accepted", runId, childSessionKey }` واپس کرتا ہے۔
- تکمیل کے بعد، OpenClaw ایک ذیلی ایجنٹ **announce step** چلاتا ہے اور نتیجہ درخواست گزار کے چیٹ چینل پر پوسٹ کرتا ہے۔
- اعلان کے مرحلے کے دوران خاموش رہنے کے لیے عین `ANNOUNCE_SKIP` کا جواب دیں۔
- اعلان کے جوابات `Status`/`Result`/`Notes` پر نارملائز کیے جاتے ہیں؛ `Status` رن ٹائم نتیجے سے آتا ہے (ماڈل متن سے نہیں)۔
- ذیلی ایجنٹ سیشنز `agents.defaults.subagents.archiveAfterMinutes` کے بعد خودکار طور پر آرکائیو ہو جاتے ہیں (ڈیفالٹ: 60)۔
- اعلان کے جوابات میں ایک شماریاتی سطر شامل ہوتی ہے (رن ٹائم، ٹوکنز، sessionKey/sessionId، ٹرانسکرپٹ پاتھ، اور اختیاری لاگت)۔

## Sandbox سیشن کی مرئیت

Sandboxed سیشنز سیشن ٹولز استعمال کر سکتے ہیں، لیکن بطورِ طے شدہ وہ صرف وہی سیشنز دیکھتے ہیں جو انہوں نے `sessions_spawn` کے ذریعے اسپان کیے ہوں۔

Config:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
