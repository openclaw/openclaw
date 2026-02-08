---
summary: "WhatsApp (ဝဘ်ချန်နယ်) ပေါင်းစည်းမှု៖ လော့ဂ်အင်၊ inbox၊ ပြန်ကြားချက်များ၊ မီဒီယာနှင့် လုပ်ဆောင်မှုများ"
read_when:
  - WhatsApp/ဝဘ် ချန်နယ်၏ အပြုအမူ သို့မဟုတ် inbox လမ်းကြောင်းခွဲခြားမှုအပေါ် အလုပ်လုပ်နေချိန်
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:53Z
---

# WhatsApp (ဝဘ် ချန်နယ်)

အခြေအနေ: Baileys ကို အသုံးပြုသော WhatsApp Web သာလျှင် ပံ့ပိုးထားသည်။ Gateway သည် session(များ) ကို ပိုင်ဆိုင်ထားသည်။

## Quick setup (အစပြုသူများအတွက်)

1. ဖြစ်နိုင်ပါက **သီးခြား ဖုန်းနံပါတ်** တစ်ခုကို အသုံးပြုပါ (အကြံပြုသည်)။
2. `~/.openclaw/openclaw.json` တွင် WhatsApp ကို ဖွဲ့စည်းပြင်ဆင်ပါ။
3. QR code (Linked Devices) ကို စကန်ရန် `openclaw channels login` ကို လည်ပတ်ပါ။
4. Gateway ကို စတင်ပါ။

အနည်းဆုံး ဖွဲ့စည်းမှု:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## ရည်မှန်းချက်များ

- Gateway process တစ်ခုအတွင်း WhatsApp အကောင့်များ အများအပြား (multi-account) ကို အသုံးပြုနိုင်ရန်။
- တိကျသေချာသော လမ်းကြောင်းခွဲခြားမှု: ပြန်ကြားချက်များသည် WhatsApp သို့သာ ပြန်သွားပြီး မော်ဒယ်အလိုက် လမ်းကြောင်းမခွဲပါ။
- quoted replies များကို နားလည်နိုင်ရန် မော်ဒယ်က လိုအပ်သည့် context ကို လုံလောက်စွာ မြင်နိုင်စေရန်။

## Config ရေးသားမှုများ

ပုံမှန်အားဖြင့် WhatsApp သည် `/config set|unset` မှ အစပြုသော config update များကို ရေးသားခွင့်ရှိသည် (`commands.config: true` လိုအပ်သည်)။

ပိတ်ရန်:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Architecture (ဘယ်သူက ဘာကို ပိုင်ဆိုင်သလဲ)

- **Gateway** သည် Baileys socket နှင့် inbox loop ကို ပိုင်ဆိုင်ထားသည်။
- **CLI / macOS app** များသည် gateway နှင့်သာ ဆက်သွယ်ပြီး Baileys ကို တိုက်ရိုက် မသုံးပါ။
- **Active listener** မရှိပါက outbound send မအောင်မြင်ဘဲ ချက်ချင်း အမှားပြန်ပေးမည်ဖြစ်သည်။

## ဖုန်းနံပါတ် ရယူခြင်း (နည်းလမ်း ၂ မျိုး)

WhatsApp သည် အတည်ပြုရန် အမှန်တကယ် မိုဘိုင်းနံပါတ်တစ်ခု လိုအပ်ပါသည်။ VoIP နှင့် virtual နံပါတ်များကို ပုံမှန်အားဖြင့် ပိတ်ပင်ထားသည်။ OpenClaw ကို WhatsApp တွင် လည်ပတ်ရန် ပံ့ပိုးထားသော နည်းလမ်း ၂ မျိုးရှိသည်။

### Dedicated number (အကြံပြုသည်)

OpenClaw အတွက် **သီးခြား ဖုန်းနံပါတ်** တစ်ခုကို အသုံးပြုပါ။ UX ကောင်းမွန်ပြီး လမ်းကြောင်းသန့်ရှင်းကာ self-chat ဆိုင်ရာ ပြဿနာများ မရှိပါ။ အကောင်းဆုံး setup သည် **အသုံးမများတော့သော Android ဖုန်း + eSIM** ဖြစ်သည်။ Wi‑Fi နှင့် လျှပ်စစ်အား ချိတ်ထားပြီး QR ဖြင့် link လုပ်ပါ။

**WhatsApp Business:** တစ်စက်တည်းပေါ်တွင် နံပါတ်ကွဲပြားစွာ WhatsApp Business ကို အသုံးပြုနိုင်ပါသည်။ ကိုယ်ရေးကိုယ်တာ WhatsApp ကို သီးခြားထားရန် အထူးကောင်းမွန်ပါသည် — WhatsApp Business ကို ထည့်သွင်းပြီး OpenClaw နံပါတ်ကို အဲဒီမှာ မှတ်ပုံတင်ပါ။

**Sample config (dedicated number, single-user allowlist):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Pairing mode (optional):**
allowlist အစား pairing ကို အသုံးပြုလိုပါက `channels.whatsapp.dmPolicy` ကို `pairing` အဖြစ် သတ်မှတ်ပါ။ မသိသော ပို့သူများသည် pairing code ကို ရရှိမည်ဖြစ်ပြီး အောက်ပါအမိန့်ဖြင့် အတည်ပြုနိုင်သည် —
`openclaw pairing approve whatsapp <code>`

### Personal number (fallback)

အမြန် fallback အဖြစ် **ကိုယ်ပိုင်နံပါတ်** ပေါ်တွင် OpenClaw ကို လည်ပတ်နိုင်ပါသည်။ စမ်းသပ်ရန်အတွက် ကိုယ့်ကိုယ်ကို (WhatsApp “Message yourself”) မက်ဆေ့ချ်ပို့ပါ၊ အဆက်အသွယ်များကို spam မဖြစ်စေရန်ဖြစ်သည်။ setup နှင့် စမ်းသပ်မှုများအတွင်း အတည်ပြုကုဒ်များကို ကိုယ်ပိုင်ဖုန်းပေါ်တွင် ဖတ်ရမည်ကို မျှော်လင့်ထားပါ။ **Self-chat mode ကို ဖွင့်ထားရပါမည်။**
wizard က ကိုယ်ပိုင် WhatsApp နံပါတ်ကို မေးသောအခါ assistant နံပါတ်မဟုတ်ဘဲ သင် မက်ဆေ့ချ်ပို့မည့် ဖုန်း (owner/sender) ကို ထည့်ပါ။

**Sample config (personal number, self-chat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Self-chat ပြန်ကြားချက်များသည် သတ်မှတ်ထားပါက ပုံမှန်အားဖြင့် `[{identity.name}]` ကို အသုံးပြုမည်ဖြစ်ပြီး (မဟုတ်ပါက `[openclaw]`)
`messages.responsePrefix` ကို မသတ်မှတ်ထားပါက ဖြစ်သည်။ prefix ကို ပြင်ဆင်ရန် သို့မဟုတ် ပိတ်ရန် အတိအကျ သတ်မှတ်ပါ
(ဖယ်ရှားရန် `""` ကို အသုံးပြုပါ)။

### နံပါတ် ရယူခြင်း အကြံပြုချက်များ

- **ဒေသတွင်း eSIM** (အများဆုံး ယုံကြည်စိတ်ချရ)
  - Austria: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — အခမဲ့ SIM၊ စာချုပ်မလို
- **Prepaid SIM** — စျေးသက်သာပြီး အတည်ပြုရန် SMS တစ်စောင်သာ လက်ခံရပါသည်

**ရှောင်ရန်:** TextNow, Google Voice၊ “free SMS” ဝန်ဆောင်မှုအများစု — WhatsApp သည် အလွန်တင်းကြပ်စွာ ပိတ်ပင်ပါသည်။

**အကြံပြုချက်:** နံပါတ်သည် အတည်ပြု SMS တစ်စောင်သာ လက်ခံနိုင်ရင် လုံလောက်ပါသည်။ ထို့နောက် WhatsApp Web session များသည် `creds.json` ဖြင့် ဆက်လက် တည်ရှိနေပါသည်။

## Twilio ကို ဘာကြောင့် မသုံးသလဲ?

- OpenClaw ၏ အစောပိုင်း build များတွင် Twilio ၏ WhatsApp Business integration ကို ပံ့ပိုးခဲ့သည်။
- WhatsApp Business နံပါတ်များသည် ကိုယ်ပိုင် assistant အတွက် မသင့်လျော်ပါ။
- Meta သည် ၂၄ နာရီ ပြန်ကြားချိန် ကန့်သတ်ချက်ကို အတင်းအကျပ် သတ်မှတ်ထားသည် — နောက်ဆုံး ၂၄ နာရီအတွင်း မပြန်ကြားခဲ့ပါက business နံပါတ်မှ မက်ဆေ့ချ်အသစ် စတင်ပို့လို့ မရပါ။
- အသုံးပြုမှု များပြားခြင်း သို့မဟုတ် “chatty” ဖြစ်ခြင်းသည် ပြင်းထန်သော blocking ကို ဖြစ်စေတတ်သည်၊ business အကောင့်များကို ကိုယ်ပိုင် assistant မက်ဆေ့ချ်များ အများကြီး ပို့ရန် မရည်ရွယ်ထားသောကြောင့် ဖြစ်သည်။
- အကျိုးရလဒ်အဖြစ် ပို့ဆောင်မှု မယုံကြည်ရပြီး မကြာခဏ ပိတ်ပင်ခံရသဖြင့် ပံ့ပိုးမှုကို ဖယ်ရှားခဲ့သည်။

## Login + credentials

- Login အမိန့်: `openclaw channels login` (Linked Devices ဖြင့် QR)။
- Multi-account login: `openclaw channels login --account <id>` (`<id>` = `accountId`)။
- Default account (`--account` ကို မထည့်ပါက): `default` ရှိပါက ထိုအကောင့်၊ မဟုတ်ပါက ဖွဲ့စည်းထားသော account id များအနက် ပထမဆုံး (sorted)။
- Credentials များကို `~/.openclaw/credentials/whatsapp/<accountId>/creds.json` တွင် သိမ်းဆည်းထားသည်။
- Backup copy ကို `creds.json.bak` တွင် ထားရှိသည် (ပျက်စီးပါက ပြန်လည်အသုံးပြု)။
- Legacy compatibility: အဟောင်း install များတွင် Baileys ဖိုင်များကို `~/.openclaw/credentials/` တွင် တိုက်ရိုက် သိမ်းထားသည်။
- Logout: `openclaw channels logout` (သို့မဟုတ် `--account <id>`) သည် WhatsApp auth state ကို ဖျက်ပစ်သည် (မျှဝေထားသော `oauth.json` ကိုတော့ ထိန်းသိမ်းထားသည်)။
- Logged-out socket ⇒ re-link ပြုလုပ်ရန် ညွှန်ကြားသော error ပေါ်လာမည်။

## Inbound flow (DM + group)

- WhatsApp ဖြစ်ရပ်များသည် `messages.upsert` (Baileys) မှ လာသည်။
- shutdown အချိန်တွင် inbox listener များကို ဖယ်ရှားပြီး tests/restarts များတွင် event handler များ စုပုံမလာစေရန် ကာကွယ်သည်။
- Status/broadcast chats များကို လျစ်လျူရှုသည်။
- Direct chats များသည် E.164 ကို အသုံးပြုသည်; groups များသည် group JID ကို အသုံးပြုသည်။
- **DM policy**: direct chat ဝင်ရောက်ခွင့်ကို `channels.whatsapp.dmPolicy` က ထိန်းချုပ်သည် (ပုံမှန်: `pairing`)။
  - Pairing: မသိသော ပို့သူများသည် pairing code ကို ရရှိမည် ( `openclaw pairing approve whatsapp <code>` ဖြင့် အတည်ပြု; ကုဒ်များသည် ၁ နာရီအကြာတွင် သက်တမ်းကုန်)။
  - Open: `channels.whatsapp.allowFrom` တွင် `"*"` ပါဝင်ရမည်။
  - သင့် linked WhatsApp နံပါတ်ကို ယုံကြည်ထားသည်ဟု သတ်မှတ်ထားပြီး self messages များသည် `channels.whatsapp.dmPolicy` နှင့် `channels.whatsapp.allowFrom` စစ်ဆေးမှုများကို ကျော်လွန်သည်။

### Personal-number mode (fallback)

OpenClaw ကို **ကိုယ်ပိုင် WhatsApp နံပါတ်** ပေါ်တွင် လည်ပတ်ပါက `channels.whatsapp.selfChatMode` ကို ဖွင့်ပါ (အပေါ်ရှိ sample ကို ကြည့်ပါ)။

အပြုအမူများ:

- Outbound DM များသည် pairing reply မဖြစ်ပေါ်စေပါ (အဆက်အသွယ်များကို spam မဖြစ်စေရန်)။
- Inbound မသိသော ပို့သူများသည် `channels.whatsapp.dmPolicy` ကို ဆက်လက် လိုက်နာသည်။
- Self-chat mode (allowFrom တွင် သင့်နံပါတ် ပါဝင်) သည် auto read receipts မပို့ဘဲ mention JID များကို လျစ်လျူရှုသည်။
- Self-chat မဟုတ်သော DM များအတွက် read receipts ပို့သည်။

## Read receipts

ပုံမှန်အားဖြင့် gateway သည် လက်ခံလိုက်သော inbound WhatsApp မက်ဆေ့ချ်များကို read (အပြာတက်) အဖြစ် သတ်မှတ်သည်။

Global ပိတ်ရန်:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Account တစ်ခုချင်းစီအလိုက် ပိတ်ရန်:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

မှတ်ချက်များ:

- Self-chat mode တွင် read receipts ကို အမြဲ ကျော်လွန်သည်။

## WhatsApp FAQ: မက်ဆေ့ချ်ပို့ခြင်း + pairing

**WhatsApp ကို link လုပ်တဲ့အခါ OpenClaw က ကျပန်း အဆက်အသွယ်တွေကို မက်ဆေ့ချ်ပို့မလား?**  
မပို့ပါ။ ပုံမှန် DM policy သည် **pairing** ဖြစ်သောကြောင့် မသိသော ပို့သူများသည် pairing code ကိုသာ ရရှိပြီး သူတို့၏ မက်ဆေ့ချ်ကို **မလုပ်ဆောင်ပါ**။ OpenClaw သည် လက်ခံရရှိသော chats များ သို့မဟုတ် သင်က agent/CLI ဖြင့် ထုတ်လုပ်စေသော sends များကိုသာ ပြန်ကြားပါသည်။

**WhatsApp မှာ pairing ဘယ်လို အလုပ်လုပ်သလဲ?**  
Pairing သည် မသိသော ပို့သူများအတွက် DM gate ဖြစ်သည် —

- ပို့သူအသစ်ထံမှ ပထမဆုံး DM သည် short code ကို ပြန်ပို့သည် (မက်ဆေ့ချ်ကို မလုပ်ဆောင်ပါ)။
- `openclaw pairing approve whatsapp <code>` ဖြင့် အတည်ပြုနိုင်သည် (`openclaw pairing list whatsapp` ဖြင့် စာရင်းကြည့်နိုင်သည်)။
- ကုဒ်များသည် ၁ နာရီအကြာတွင် သက်တမ်းကုန်ပြီး pending request များကို ချန်နယ်တစ်ခုလျှင် ၃ ခုအထိသာ ခွင့်ပြုထားသည်။

**WhatsApp နံပါတ်တစ်ခုတည်းပေါ်မှာ လူအများက OpenClaw instance မတူဘဲ အသုံးပြုနိုင်မလား?**  
ရပါသည်၊ `bindings` ဖြင့် ပို့သူတစ်ဦးချင်းစီကို agent မတူဘဲ လမ်းကြောင်းခွဲနိုင်ပါသည် (peer `kind: "dm"`, sender E.164 ဥပမာ `+15551234567`)။ ပြန်ကြားချက်များသည် **WhatsApp အကောင့်တစ်ခုတည်း** မှသာ လာမည်ဖြစ်ပြီး direct chats များသည် agent တစ်ဦးချင်း၏ main session သို့ စုပေါင်းသွားသောကြောင့် **လူတစ်ဦးလျှင် agent တစ်ခု** ကို အသုံးပြုပါ။ DM access control (`dmPolicy`/`allowFrom`) သည် WhatsApp အကောင့်တစ်ခုလျှင် global ဖြစ်သည်။ [Multi-Agent Routing](/concepts/multi-agent) ကို ကြည့်ပါ။

**wizard မှာ ကိုယ်ပိုင်ဖုန်းနံပါတ်ကို ဘာကြောင့် မေးတာလဲ?**  
wizard သည် သင့်ကိုယ်ပိုင် DM များကို ခွင့်ပြုရန် **allowlist/owner** ကို သတ်မှတ်ရန် အသုံးပြုပါသည်။ auto-sending အတွက် မသုံးပါ။ ကိုယ်ပိုင် WhatsApp နံပါတ်ပေါ်တွင် လည်ပတ်ပါက ထိုနံပါတ်တူတူကို အသုံးပြုပြီး `channels.whatsapp.selfChatMode` ကို ဖွင့်ပါ။

## Message normalization (မော်ဒယ်မြင်သော အကြောင်းအရာ)

- `Body` သည် envelope ပါဝင်သော လက်ရှိ မက်ဆေ့ချ် body ဖြစ်သည်။
- Quoted reply context ကို **အမြဲ ထည့်သွင်း** ပါသည် —

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Reply metadata များလည်း သတ်မှတ်ထားသည် —
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = quoted body သို့မဟုတ် media placeholder
  - `ReplyToSender` = သိရှိပါက E.164
- Media-only inbound မက်ဆေ့ချ်များသည် placeholder များကို အသုံးပြုသည် —
  - `<media:image|video|audio|document|sticker>`

## Groups

- Groups များကို `agent:<agentId>:whatsapp:group:<jid>` session များအဖြစ် map လုပ်ထားသည်။
- Group policy: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (ပုံမှန် `allowlist`)။
- Activation modes:
  - `mention` (ပုံမှန်): @mention သို့မဟုတ် regex match လိုအပ်သည်။
  - `always`: အမြဲ trigger ဖြစ်သည်။
- `/activation mention|always` သည် owner-only ဖြစ်ပြီး သီးခြား မက်ဆေ့ချ်အဖြစ် ပို့ရပါမည်။
- Owner = `channels.whatsapp.allowFrom` (မသတ်မှတ်ပါက self E.164)။
- **History injection** (pending-only):
  - မလုပ်ဆောင်ရသေးသော မကြာသေးမီ မက်ဆေ့ချ်များ (ပုံမှန် 50) ကို အောက်တွင် ထည့်သွင်း —
    `[Chat messages since your last reply - for context]` (session ထဲရှိပြီးသား မက်ဆေ့ချ်များကို ပြန်မထည့်ပါ)
  - လက်ရှိ မက်ဆေ့ချ်ကို —
    `[Current message - respond to this]`
  - ပို့သူ suffix ကို ထည့်ပေါင်း —
    `[from: Name (+E164)]`
- Group metadata ကို ၅ မိနစ် cache လုပ်ထားသည် (subject + participants)။

## Reply delivery (threading)

- WhatsApp Web သည် standard မက်ဆေ့ချ်များကို ပို့သည် (လက်ရှိ gateway တွင် quoted reply threading မရှိပါ)။
- Reply tags များကို ဤချန်နယ်တွင် လျစ်လျူရှုသည်။

## Acknowledgment reactions (လက်ခံချိန် auto-react)

WhatsApp သည် မက်ဆေ့ချ်ကို လက်ခံရရှိသည်နှင့် bot ပြန်ကြားချက် မထုတ်လုပ်မီ အချိန်မှာပင် emoji reaction များကို အလိုအလျောက် ပို့နိုင်ပါသည်။ ယင်းသည် အသုံးပြုသူများအတွက် မက်ဆေ့ချ် လက်ခံရရှိကြောင်း ချက်ချင်း သိစေရန် ဖြစ်သည်။

**Configuration:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Options:**

- `emoji` (string): acknowledgment အတွက် အသုံးပြုမည့် Emoji (ဥပမာ "👀", "✅", "📨")။ ဗလာ သို့မဟုတ် မထည့်ပါက feature ပိတ်ထားသည်။
- `direct` (boolean, ပုံမှန်: `true`): direct/DM chats တွင် reaction ပို့မည်။
- `group` (string, ပုံမှန်: `"mentions"`): Group chat အပြုအမူ —
  - `"always"`: group မက်ဆေ့ချ်အားလုံးကို react (@mention မပါဘဲတောင်)
  - `"mentions"`: bot ကို @mention လုပ်သောအခါသာ react
  - `"never"`: group များတွင် မည်သည့်အခါမှ react မလုပ်

**Per-account override:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Behavior notes:**

- Reactions များကို မက်ဆေ့ချ် လက်ခံရရှိသည်နှင့် **ချက်ချင်း** ပို့ပြီး typing indicator သို့မဟုတ် bot reply မတိုင်မီ ဖြစ်သည်။
- `requireMention: false` (activation: always) ပါသော groups များတွင် `group: "mentions"` သည် မက်ဆေ့ချ်အားလုံးကို react လုပ်မည် (@mention များသာမက)။
- Fire-and-forget: reaction ပို့မအောင်မြင်မှုများကို log လုပ်ထားသော်လည်း bot ပြန်ကြားခြင်းကို မတားဆီးပါ။
- Group reactions အတွက် participant JID ကို အလိုအလျောက် ထည့်သွင်းပေးသည်။
- WhatsApp သည် `messages.ackReaction` ကို လျစ်လျူရှုသည်; အစား `channels.whatsapp.ackReaction` ကို အသုံးပြုပါ။

## Agent tool (reactions)

- Tool: `whatsapp` နှင့် `react` action (`chatJid`, `messageId`, `emoji`, optional `remove`)။
- Optional: `participant` (group sender), `fromMe` (ကိုယ်ပိုင် မက်ဆေ့ချ်ကို react လုပ်ခြင်း), `accountId` (multi-account)။
- Reaction ဖယ်ရှားခြင်း၏ အဓိပ္ပါယ်ဖွင့်ဆိုချက်များကို [/tools/reactions](/tools/reactions) တွင် ကြည့်ပါ။
- Tool gating: `channels.whatsapp.actions.reactions` (ပုံမှန်: enabled)။

## Limits

- Outbound text ကို `channels.whatsapp.textChunkLimit` အထိ ခွဲခြားပို့သည် (ပုံမှန် 4000)။
- Optional newline chunking: `channels.whatsapp.chunkMode="newline"` ကို သတ်မှတ်ပါက အရှည်အလိုက် ခွဲခြားမီ blank lines (paragraph boundaries) အလိုက် ခွဲမည်။
- Inbound media save များကို `channels.whatsapp.mediaMaxMb` ဖြင့် ကန့်သတ်ထားသည် (ပုံမှန် 50 MB)။
- Outbound media item များကို `agents.defaults.mediaMaxMb` ဖြင့် ကန့်သတ်ထားသည် (ပုံမှန် 5 MB)။

## Outbound send (text + media)

- Active web listener ကို အသုံးပြုသည်; gateway မလည်ပတ်ပါက error ပြန်ပေးမည်။
- Text chunking: မက်ဆေ့ချ်တစ်ခုလျှင် အများဆုံး 4k ( `channels.whatsapp.textChunkLimit` ဖြင့် ပြင်ဆင်နိုင်ပြီး optional `channels.whatsapp.chunkMode`)။
- Media:
  - Image/video/audio/document ကို ပံ့ပိုးထားသည်။
  - Audio ကို PTT အဖြစ် ပို့သည်; `audio/ogg` ⇒ `audio/ogg; codecs=opus`။
  - Caption ကို ပထမ media item တွင်သာ ထည့်နိုင်သည်။
  - Media fetch သည် HTTP(S) နှင့် local paths ကို ပံ့ပိုးသည်။
  - Animated GIFs: inline looping အတွက် WhatsApp သည် `gifPlayback: true` ပါသော MP4 ကို မျှော်လင့်သည်။
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send` params တွင် `gifPlayback: true` ပါဝင်သည်

## Voice notes (PTT audio)

WhatsApp သည် audio ကို **voice notes** (PTT bubble) အဖြစ် ပို့သည်။

- အကောင်းဆုံးရလဒ်များအတွက်: OGG/Opus။ OpenClaw သည် `audio/ogg` ကို `audio/ogg; codecs=opus` အဖြစ် ပြန်ရေးသည်။
- `[[audio_as_voice]]` သည် WhatsApp အတွက် လျစ်လျူရှုထားသည် (audio ကို voice note အဖြစ်ပင် ပို့ပြီးသားဖြစ်သည်)။

## Media limits + optimization

- Default outbound cap: media item တစ်ခုလျှင် 5 MB။
- Override: `agents.defaults.mediaMaxMb`။
- Images များကို cap အောက်တွင် JPEG အဖြစ် auto-optimized (resize + quality sweep) လုပ်သည်။
- အရွယ်အစားကြီးလွန်းသော media ⇒ error; media reply သည် text warning သို့ fallback ဖြစ်သည်။

## Heartbeats

- **Gateway heartbeat** သည် ချိတ်ဆက်မှု အခြေအနေကို log လုပ်သည် (`web.heartbeatSeconds`, ပုံမှန် 60s)။
- **Agent heartbeat** ကို agent တစ်ခုချင်းစီအလိုက် (`agents.list[].heartbeat`) သို့မဟုတ် global အနေဖြင့်
  `agents.defaults.heartbeat` ဖြင့် ဖွဲ့စည်းနိုင်သည် (per-agent entry မရှိပါက fallback)။
  - Configured heartbeat prompt (ပုံမှန်: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK` skip behavior ကို အသုံးပြုသည်။
  - Delivery သည် နောက်ဆုံး အသုံးပြုခဲ့သော ချန်နယ် (သို့မဟုတ် သတ်မှတ်ထားသော target) သို့ ပို့သည်။

## Reconnect behavior

- Backoff policy: `web.reconnect` —
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`။
- maxAttempts ရောက်ရှိပါက web monitoring ကို ရပ်တန့်မည် (degraded)။
- Logged-out ⇒ ရပ်တန့်ပြီး re-link လုပ်ရန် လိုအပ်သည်။

## Config quick map

- `channels.whatsapp.dmPolicy` (DM policy: pairing/allowlist/open/disabled)။
- `channels.whatsapp.selfChatMode` (same-phone setup; bot သည် ကိုယ်ပိုင် WhatsApp နံပါတ်ကို အသုံးပြုသည်)။
- `channels.whatsapp.allowFrom` (DM allowlist)။ WhatsApp သည် E.164 ဖုန်းနံပါတ်များကို အသုံးပြုသည် (username မရှိ)။
- `channels.whatsapp.mediaMaxMb` (inbound media save cap)။
- `channels.whatsapp.ackReaction` (မက်ဆေ့ချ် လက်ခံချိန် auto-reaction: `{emoji, direct, group}`)။
- `channels.whatsapp.accounts.<accountId>.*` (per-account settings + optional `authDir`)။
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (per-account inbound media cap)။
- `channels.whatsapp.accounts.<accountId>.ackReaction` (per-account ack reaction override)။
- `channels.whatsapp.groupAllowFrom` (group sender allowlist)။
- `channels.whatsapp.groupPolicy` (group policy)။
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (group history context; `0` disables)။
- `channels.whatsapp.dmHistoryLimit` (DM history limit in user turns)။ Per-user overrides: `channels.whatsapp.dms["<phone>"].historyLimit`။
- `channels.whatsapp.groups` (group allowlist + mention gating defaults; `"*"` ဖြင့် အားလုံးကို ခွင့်ပြု)
- `channels.whatsapp.actions.reactions` (WhatsApp tool reactions ကို gate လုပ်ခြင်း)။
- `agents.list[].groupChat.mentionPatterns` (သို့မဟုတ် `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (inbound prefix; per-account: `channels.whatsapp.accounts.<accountId>.messagePrefix`; deprecated: `messages.messagePrefix`)
- `messages.responsePrefix` (outbound prefix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (optional override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (per-agent overrides)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (false ဖြစ်ပါက channel startup ကို ပိတ်သည်)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + troubleshooting

- Subsystems: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`။
- Log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (ပြင်ဆင်နိုင်သည်)။
- Troubleshooting guide: [Gateway troubleshooting](/gateway/troubleshooting)။

## Troubleshooting (အမြန်)

**Not linked / QR login လိုအပ်**

- လက္ခဏာ: `channels status` တွင် `linked: false` ပြသခြင်း သို့မဟုတ် “Not linked” သတိပေးချက်။
- ဖြေရှင်းနည်း: gateway host ပေါ်တွင် `openclaw channels login` ကို လည်ပတ်ပြီး QR ကို စကန်ပါ (WhatsApp → Settings → Linked Devices)။

**Linked ဖြစ်သော်လည်း ချိတ်ဆက်မရ / reconnect loop**

- လက္ခဏာ: `channels status` တွင် `running, disconnected` ပြသခြင်း သို့မဟုတ် “Linked but disconnected” သတိပေးချက်။
- ဖြေရှင်းနည်း: `openclaw doctor` (သို့မဟုတ် gateway ကို restart လုပ်ပါ)။ မပြေလည်သေးပါက `channels login` ဖြင့် ပြန်လည် link လုပ်ပြီး `openclaw logs --follow` ကို စစ်ဆေးပါ။

**Bun runtime**

- Bun ကို **မအကြံပြုပါ**။ WhatsApp (Baileys) နှင့် Telegram သည် Bun ပေါ်တွင် မယုံကြည်ရပါ။
  Gateway ကို **Node** ဖြင့် လည်ပတ်ပါ။ (Getting Started runtime note ကို ကြည့်ပါ။)
