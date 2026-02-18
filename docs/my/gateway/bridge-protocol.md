---
summary: "Bridge ပရိုတိုကော (legacy နိုဒ်များ): TCP JSONL၊ pairing၊ scoped RPC"
read_when:
  - iOS/Android/macOS နိုဒ်မုဒ်အတွက် နိုဒ် client များကို တည်ဆောက်ခြင်း သို့မဟုတ် ပြဿနာရှာဖွေခြင်း
  - pairing သို့မဟုတ် bridge authentication မအောင်မြင်မှုများကို စုံစမ်းစစ်ဆေးခြင်း
  - Gateway မှ ဖော်ထုတ်ထားသော နိုဒ် surface ကို စိစစ်သုံးသပ်ခြင်း
title: "Bridge Protocol"
---

# Bridge protocol (legacy node transport)

Bridge protocol သည် **legacy** node transport (TCP JSONL) ဖြစ်ပါသည်။ Node client အသစ်များသည် unified Gateway WebSocket protocol ကို အသုံးပြုသင့်ပါသည်။

Operator သို့မဟုတ် နိုဒ် client ကို တည်ဆောက်နေပါက
[Gateway protocol](/gateway/protocol) ကို အသုံးပြုပါ။

**Note:** Current OpenClaw builds no longer ship the TCP bridge listener; this document is kept for historical reference.
Legacy `bridge.*` config keys များသည် config schema ၏ အစိတ်အပိုင်း မဟုတ်တော့ပါ။

## ဘာကြောင့် နှစ်မျိုးလုံး ရှိသနည်း

- **လုံခြုံရေး အကန့်အသတ်**: bridge သည် gateway API surface အပြည့်အစုံအစား ခွင့်ပြုစာရင်း အနည်းငယ်ကိုသာ ဖော်ထုတ်ပေးသည်။
- **Pairing + နိုဒ် အမှတ်အသား**: နိုဒ် ဝင်ရောက်ခွင့်ကို gateway က ထိန်းချုပ်ပြီး နိုဒ်တစ်ခုချင်းစီအလိုက် token နှင့် ချိတ်ဆက်ထားသည်။
- **Discovery UX**: နိုဒ်များသည် LAN ပေါ်တွင် Bonjour ဖြင့် Gateway များကို ရှာဖွေနိုင်သကဲ့သို့ tailnet မှတဆင့် တိုက်ရိုက် ချိတ်ဆက်နိုင်သည်။
- **Loopback WS**: SSH ဖြင့် tunnel မလုပ်ပါက WS control plane အပြည့်အစုံသည် local တွင်သာ ရှိနေပါသည်။

## Transport

- TCP၊ တစ်လိုင်းလျှင် JSON object တစ်ခု (JSONL)။
- Optional TLS (`bridge.tls.enabled` true ဖြစ်သည့်အခါ)။
- Legacy default listener port သည် `18790` ဖြစ်သည် (လက်ရှိ build များတွင် TCP bridge ကို မစတင်ပါ)။

TLS ကို ဖွင့်ထားသည့်အခါ discovery TXT record များတွင် `bridgeTls=1` နှင့်
`bridgeTlsSha256` ကို ထည့်သွင်းပေးပြီး နိုဒ်များက certificate ကို pin လုပ်နိုင်စေပါသည်။

## Handshake + pairing

1. Client သည် နိုဒ် metadata + token (pair လုပ်ပြီးသားဖြစ်ပါက) ပါဝင်သော `hello` ကို ပို့သည်။
2. Pair မလုပ်ရသေးပါက gateway သည် `error` (`NOT_PAIRED`/`UNAUTHORIZED`) ဖြင့် ပြန်ကြားသည်။
3. Client သည် `pair-request` ကို ပို့သည်။
4. Gateway သည် အတည်ပြုချက်ကို စောင့်ပြီးနောက် `pair-ok` နှင့် `hello-ok` ကို ပို့သည်။

`hello-ok` သည် `serverName` ကို ပြန်ပေးပြီး `canvasHostUrl` ပါဝင်နိုင်ပါသည်။

## Frames

Client → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: နိုဒ် signal များ (voice transcript, agent request, chat subscribe, exec lifecycle)

Gateway → Client:

- `invoke` / `invoke-res`: နိုဒ် command များ (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: subscribe လုပ်ထားသော ဆက်ရှင်များအတွက် chat update များ
- `ping` / `pong`: keepalive

Legacy allowlist enforcement သည် `src/gateway/server-bridge.ts` တွင် ရှိခဲ့ပြီး (ဖယ်ရှားပြီးဖြစ်သည်)။

## Exec lifecycle events

Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)

Payload field များ (ဖော်ပြထားခြင်းမရှိပါက အားလုံး optional):

- `sessionKey` (required): system event ကို လက်ခံရရှိရန် agent ဆက်ရှင်။
- `runId`: grouping အတွက် unique exec id။
- `command`: raw သို့မဟုတ် formatted command string။
- `exitCode`, `timedOut`, `success`, `output`: completion အသေးစိတ်များ (finished ဖြစ်သည့်အခါသာ)။
- `reason`: ငြင်းပယ်ရသည့် အကြောင်းပြချက် (denied ဖြစ်သည့်အခါသာ)။

## Tailnet usage

- Bridge ကို tailnet IP သို့ bind လုပ်ပါ: `bridge.bind: "tailnet"` ကို
  `~/.openclaw/openclaw.json` အတွင်းတွင် သတ်မှတ်ပါ။
- Client များသည် MagicDNS name သို့မဟုတ် tailnet IP ဖြင့် ချိတ်ဆက်ပါသည်။
- Bonjour သည် ကွန်ရက်များကို မဖြတ်ကျော်နိုင်ပါ။ လိုအပ်သည့်အခါ manual host/port သို့မဟုတ် wide-area DNS‑SD ကို အသုံးပြုပါ။

## Versioning

Bridge သည် လက်ရှိ **implicit v1** (min/max negotiation မရှိ) ဖြစ်ပါသည်။ Backward‑compat
is expected; add a bridge protocol version field before any breaking changes.
