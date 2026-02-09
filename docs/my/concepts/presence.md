---
summary: "OpenClaw presence အင်ထရီများကို မည်သို့ ထုတ်လုပ်၊ ပေါင်းစည်း၊ ပြသသည်ကို ရှင်းလင်းဖော်ပြခြင်း"
read_when:
  - Instances တဘ်ကို ဒီဘဂ်လုပ်နေချိန်
  - ထပ်နေသော သို့မဟုတ် အဟောင်းကျန်နေသည့် instance အတန်းများကို စစ်ဆေးနေချိန်
  - Gateway WS ချိတ်ဆက်မှု သို့မဟုတ် system-event beacon များကို ပြောင်းလဲနေချိန်
title: "Presence"
---

# Presence

OpenClaw “presence” သည် ပေါ့ပါးပြီး အကောင်းဆုံးကြိုးပမ်းမှုအခြေပြု မြင်ကွင်းတစ်ခုဖြစ်ပြီး—

- **Gateway** ကိုယ်တိုင်နှင့်
- **Gateway နှင့် ချိတ်ဆက်ထားသော client များ** (mac app, WebChat, CLI စသည်)

တို့ကို ပြသပေးသည်။

## ၂၄။ Presence fields (ပြသပုံ)

၂၅။ Presence entries များသည် အောက်ပါကဲ့သို့သော fields ပါဝင်သည့် structured objects များဖြစ်ပါသည်:

- ၂၆။ `instanceId` (optional ဖြစ်သော်လည်း အလွန်အရေးကြီးပါသည်): stable client identity (အများအားဖြင့် `connect.client.instanceId`)
- ၂၇။ `host`: လူဖတ်ရလွယ်သော host name
- ၂၈။ `ip`: အကောင်းဆုံးကြိုးစားမှုအဖြစ် ရရှိသော IP address
- ၂၉။ `version`: client version string
- ၃၀။ `deviceFamily` / `modelIdentifier`: hardware ဆိုင်ရာ hints
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- ၃၁။ `lastInputSeconds`: “နောက်ဆုံး user input မှစ၍ ကြာမြင့်ခဲ့သော စက္ကန့်များ” (သိရှိပါက)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- ၃၂။ `ts`: နောက်ဆုံး update timestamp (epoch မှစ၍ ms)

## ၃၃။ Producers (presence ရင်းမြစ်များ)

၃၄။ Presence entries များကို ရင်းမြစ်များစွာမှ ထုတ်လုပ်ပြီး **merged** လုပ်ထားပါသည်။

### ၃၅။ ၁) Gateway self entry

၃၆။ Gateway သည် startup အချိန်တွင် “self” entry ကို အမြဲ seed လုပ်ထားသောကြောင့် client များ မချိတ်ဆက်ရသေးခင်တောင် UIs များတွင် gateway host ကို ပြသနိုင်ပါသည်။

### ၃၇။ ၂) WebSocket connect

၃၈။ WS client တစ်ခုချင်းစီသည် `connect` request ဖြင့် စတင်ပါသည်။ ၃၉။ Handshake အောင်မြင်ပြီးနောက် Gateway သည် အဆိုပါ connection အတွက် presence entry ကို upsert လုပ်ပါသည်။

#### ၄၀။ တစ်ကြိမ်တည်း run လုပ်သော CLI commands များ မပေါ်လာရသည့် အကြောင်းရင်း

၄၁။ CLI သည် မကြာခဏ အချိန်တိုအတွင်း တစ်ကြိမ်တည်းသော commands များအတွက် ချိတ်ဆက်ပါသည်။ ၄၂။ Instances list ကို spam မဖြစ်စေရန် `client.mode === "cli"` ကို presence entry အဖြစ် **မပြောင်းလဲပါ**။

### ၄၃။ ၃) `system-event` beacons

၄၄။ Clients များသည် `system-event` method ဖြင့် ပိုမိုအသေးစိတ်သော periodic beacons များကို ပို့နိုင်ပါသည်။ ၄၅။ mac app သည် host name၊ IP နှင့် `lastInputSeconds` ကို report လုပ်ရန် ဤနည်းကို အသုံးပြုပါသည်။

### ၄၆။ ၄) Node connects (role: node)

၄၇။ Node တစ်ခုသည် Gateway WebSocket ကို `role: node` ဖြင့် ချိတ်ဆက်လာသောအခါ Gateway သည် အခြား WS clients များနှင့် အတူတူသော flow ဖြင့် အဆိုပါ node အတွက် presence entry ကို upsert လုပ်ပါသည်။

## ၄၈။ Merge + dedupe rules (`instanceId` အရေးကြီးရခြင်း)

၄၉။ Presence entries များကို in-memory map တစ်ခုတည်းအတွင်း သိမ်းဆည်းထားပါသည်:

- ၅၀။ Entries များကို **presence key** ဖြင့် key လုပ်ထားပါသည်။
- The best key is a stable `instanceId` (from `connect.client.instanceId`) that survives restarts.
- Keys are case‑insensitive.

If a client reconnects without a stable `instanceId`, it may show up as a
**duplicate** row.

## TTL and bounded size

Presence is intentionally ephemeral:

- **TTL:** entries older than 5 minutes are pruned
- **Max entries:** 200 (oldest dropped first)

This keeps the list fresh and avoids unbounded memory growth.

## Remote/tunnel caveat (loopback IPs)

When a client connects over an SSH tunnel / local port forward, the Gateway may
see the remote address as `127.0.0.1`. To avoid overwriting a good client‑reported
IP, loopback remote addresses are ignored.

## Consumers

### macOS Instances tab

The macOS app renders the output of `system-presence` and applies a small status
indicator (Active/Idle/Stale) based on the age of the last update.

## Debugging tips

- To see the raw list, call `system-presence` against the Gateway.
- If you see duplicates:
  - confirm clients send a stable `client.instanceId` in the handshake
  - confirm periodic beacons use the same `instanceId`
  - check whether the connection‑derived entry is missing `instanceId` (duplicates are expected)
