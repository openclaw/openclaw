---
summary: "Clawnet ပြန်လည်ဖွဲ့စည်းခြင်း: ကွန်ယက်ပရိုတိုကော၊ အခန်းကဏ္ဍများ၊ အတည်ပြုခြင်း၊ အတည်ပြုချက်များနှင့် အိုင်ဒင်တီတီကို တစ်စုတစ်စည်းတည်း ပြုလုပ်ခြင်း"
read_when:
  - နိုဒ်များနှင့် အော်ပရေးတာ ကလိုင်ယင့်များအတွက် တစ်စုတစ်စည်းတည်းသော ကွန်ယက်ပရိုတိုကောကို စီမံကိန်းရေးဆွဲနေစဉ်
  - စက်ပစ္စည်းများအကြား approvals၊ pairing၊ TLS နှင့် presence ကို ပြန်လည်ပြုပြင်နေစဉ်
title: "Clawnet Refactor"
x-i18n:
  source_path: refactor/clawnet.md
  source_hash: 719b219c3b326479
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:30Z
---

# Clawnet refactor (protocol + auth unification)

## Hi

ဟိုင်း Peter — ဦးတည်ချက်က အလွန်ကောင်းပါတယ်; UX ကို ပိုမိုရိုးရှင်းစေပြီး လုံခြုံရေးကို ပိုမိုခိုင်မာစေပါမယ်။

## Purpose

အောက်ပါအချက်များအတွက် တစ်ခုတည်းသော တိကျခိုင်မာသည့် စာတမ်း—

- လက်ရှိအခြေအနေ: ပရိုတိုကောများ၊ လုပ်ဆောင်မှုလမ်းကြောင်းများ၊ ယုံကြည်မှုနယ်နိမိတ်များ။
- နာကျင်မှုအချက်များ: approvals၊ multi‑hop routing၊ UI ထပ်နေမှု။
- အဆိုပြုထားသည့် အခြေအနေအသစ်: ပရိုတိုကောတစ်ခု၊ အခန်းကဏ္ဍများကို အတိုင်းအတာထားခြင်း၊ auth/pairing ကို တစ်စုတစ်စည်းတည်း ပြုလုပ်ခြင်း၊ TLS pinning။
- Identity မော်ဒယ်: တည်ငြိမ်သော ID များ + ချစ်စရာ slug များ။
- Migration စီမံကိန်း၊ အန္တရာယ်များ၊ မေးခွန်းဖွင့်ထားမှုများ။

## Goals (from discussion)

- ကလိုင်ယင့်အားလုံးအတွက် ပရိုတိုကောတစ်ခု (mac app, CLI, iOS, Android, headless node)။
- ကွန်ယက်ပါဝင်သူတိုင်းကို အတည်ပြုထားပြီး pairing ပြုလုပ်ထားရမည်။
- အခန်းကဏ္ဍများကို ရှင်းလင်းစွာ ခွဲခြားခြင်း: nodes နှင့် operators။
- အတည်ပြုချက်များကို အသုံးပြုသူရှိရာသို့ ဗဟိုမှ လမ်းကြောင်းပြောင်းပို့ခြင်း။
- အဝေးမှ သွားလာသည့် traffic အားလုံးအတွက် TLS ကုဒ်သွင်းခြင်း + ရွေးချယ်နိုင်သော pinning။
- ကုဒ် ထပ်ရေးရမှုကို အနည်းဆုံးထားခြင်း။
- စက်တစ်လုံးကို UI/node ထပ်နေမှုမရှိဘဲ တစ်ကြိမ်သာ ပြသရမည်။

## Non‑goals (explicit)

- စွမ်းရည်ခွဲခြားမှုကို ဖယ်ရှားခြင်း (least‑privilege ကို ဆက်လက်လိုအပ်သည်)။
- scope စစ်ဆေးမှုမရှိဘဲ gateway control plane ကို အပြည့်အဝ ဖွင့်ပေးခြင်း။
- auth ကို လူသားအမည် (slug) များအပေါ် မူတည်စေခြင်း (slug များသည် လုံခြုံရေးမဟုတ်)။

---

# Current state (as‑is)

## Two protocols

### 1) Gateway WebSocket (control plane)

- API အပြည့်အစုံ: config, channels, models, sessions, agent runs, logs, nodes စသည်တို့။
- ပုံမှန် bind: loopback။ အဝေးမှ ဝင်ရောက်မှုကို SSH/Tailscale ဖြင့် ပြုလုပ်သည်။
- Auth: token/password via `connect`။
- TLS pinning မရှိ (loopback/tunnel အပေါ် မူတည်)။
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (node transport)

- ခွင့်ပြုစာရင်းအကန့်အသတ်ရှိသော surface၊ node identity + pairing။
- TCP အပေါ် JSONL; optional TLS + cert fingerprint pinning။
- TLS သည် discovery TXT တွင် fingerprint ကို ကြေညာသည်။
- Code:
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## Control plane clients today

- CLI → Gateway WS via `callGateway` (`src/gateway/call.ts`)။
- macOS app UI → Gateway WS (`GatewayConnection`)။
- Web Control UI → Gateway WS။
- ACP → Gateway WS။
- Browser control သည် ကိုယ်ပိုင် HTTP control server ကို အသုံးပြုသည်။

## Nodes today

- node mode ရှိ macOS app သည် Gateway bridge သို့ ချိတ်ဆက်သည် (`MacNodeBridgeSession`)။
- iOS/Android apps များသည် Gateway bridge သို့ ချိတ်ဆက်သည်။
- Pairing + per‑node token ကို gateway တွင် သိမ်းဆည်းထားသည်။

## Current approval flow (exec)

- Agent သည် Gateway မှတဆင့် `system.run` ကို အသုံးပြုသည်။
- Gateway သည် bridge မှတဆင့် node ကို ခေါ်ယူသည်။
- Node runtime သည် approval ကို ဆုံးဖြတ်သည်။
- UI prompt ကို mac app မှ ပြသသည် (node == mac app ဖြစ်သောအခါ)။
- Node သည် `invoke-res` ကို Gateway သို့ ပြန်ပို့သည်။
- Multi‑hop ဖြစ်ပြီး UI သည် node host နှင့် ချိတ်ဆက်နေသည်။

## Presence + identity today

- WS clients များမှ Gateway presence entries။
- Bridge မှ node presence entries။
- mac app တွင် တူညီသော စက်တစ်လုံးအတွက် entry နှစ်ခု (UI + node) ပြသနိုင်သည်။
- Node identity ကို pairing store တွင် သိမ်းထားပြီး UI identity သည် သီးခြားဖြစ်သည်။

---

# Problems / pain points

- WS + Bridge ဆိုသော protocol stack နှစ်ခုကို ထိန်းသိမ်းရသည်။
- အဝေးမှ node များတွင် approvals: prompt သည် အသုံးပြုသူရှိရာမဟုတ်ဘဲ node host တွင် ပေါ်လာသည်။
- TLS pinning သည် bridge တွင်သာ ရှိပြီး WS သည် SSH/Tailscale ကို မူတည်ရသည်။
- Identity ထပ်နေမှု: စက်တစ်လုံးတည်းကို instance အများအပြားအဖြစ် ပြသသည်။
- အခန်းကဏ္ဍများ မရှင်းလင်းခြင်း: UI + node + CLI စွမ်းရည်များကို သေချာမခွဲထားနိုင်။

---

# Proposed new state (Clawnet)

## One protocol, two roles

Role + scope ပါသော WS ပရိုတိုကောတစ်ခုတည်း။

- **Role: node** (စွမ်းရည်များကို ထမ်းဆောင်သော host)
- **Role: operator** (control plane)
- Operator အတွက် ရွေးချယ်နိုင်သော **scope**:
  - `operator.read` (အခြေအနေ + ကြည့်ရှုခြင်း)
  - `operator.write` (agent run, sends)
  - `operator.admin` (config, channels, models)

### Role behaviors

**Node**

- စွမ်းရည်များကို မှတ်ပုံတင်နိုင်သည် (`caps`, `commands`, permissions)။
- `invoke` command များကို လက်ခံနိုင်သည် (`system.run`, `camera.*`, `canvas.*`, `screen.record`, စသည်)။
- Events များ ပို့နိုင်သည်: `voice.transcript`, `agent.request`, `chat.subscribe`။
- config/models/channels/sessions/agent control plane API များကို ခေါ်ဆိုခွင့် မရှိပါ။

**Operator**

- scope ဖြင့် ကန့်သတ်ထားသော control plane API အပြည့်အစုံ။
- approvals အားလုံးကို လက်ခံရရှိသည်။
- OS လုပ်ဆောင်ချက်များကို တိုက်ရိုက် မလုပ်ဆောင်ဘဲ node များသို့ လမ်းကြောင်းပို့သည်။

### Key rule

Role သည် device အလိုက်မဟုတ်ဘဲ connection အလိုက် ဖြစ်သည်။ စက်တစ်လုံးတည်းက role နှစ်ခုကို သီးခြားဖွင့်နိုင်သည်။

---

# Unified authentication + pairing

## Client identity

Client တိုင်းသည် အောက်ပါအချက်များကို ပေးရမည်—

- `deviceId` (device key မှ ဆင်းသက်လာသော တည်ငြိမ် ID)။
- `displayName` (လူဖတ်ရလွယ်ကူသော အမည်)။
- `role` + `scope` + `caps` + `commands`။

## Pairing flow (unified)

- Client သည် authentication မရှိဘဲ ချိတ်ဆက်သည်။
- Gateway သည် 해당 `deviceId` အတွက် **pairing request** တစ်ခု ဖန်တီးသည်။
- Operator သည် prompt ကို လက်ခံပြီး approve/deny လုပ်သည်။
- Gateway သည် အောက်ပါအချက်များနှင့် ချိတ်ဆက်ထားသော credentials များ ထုတ်ပေးသည်—
  - device public key
  - role(s)
  - scope(s)
  - capabilities/commands
- Client သည် token ကို သိမ်းဆည်းပြီး authenticated အနေဖြင့် ပြန်ချိတ်ဆက်သည်။

## Device‑bound auth (bearer token replay ကို ရှောင်ရန်)

အကြိုက်ဆုံးနည်းလမ်း: device keypairs။

- Device သည် keypair ကို တစ်ကြိမ်သာ ဖန်တီးသည်။
- `deviceId = fingerprint(publicKey)`။
- Gateway သည် nonce ပို့သည်; device သည် လက်မှတ်ထိုးပြီး gateway က စစ်ဆေးသည်။
- Tokens များကို string မဟုတ်ဘဲ public key (proof‑of‑possession) နှင့် ချိတ်ဆက်ထားသည်။

အခြားနည်းလမ်းများ—

- mTLS (client certs): အလွန်ခိုင်မာသော်လည်း ops complexity မြင့်။
- Short‑lived bearer tokens ကို ယာယီအဆင့်အဖြစ်သာ အသုံးပြုခြင်း (rotate + revoke အမြန်လုပ်ရန်)။

## Silent approval (SSH heuristic)

အားနည်းချက် မဖြစ်စေရန် တိတိကျကျ သတ်မှတ်ရမည်။ အောက်ပါတစ်ခုကို ဦးစားပေး—

- **Local‑only**: client သည် loopback/Unix socket မှ ချိတ်ဆက်လာသောအခါ auto‑pair။
- **Challenge via SSH**: gateway သည် nonce ထုတ်ပေးပြီး client က SSH ဖြင့် fetch လုပ်နိုင်ကြောင်း သက်သေပြသည်။
- **Physical presence window**: gateway host UI တွင် local approval တစ်ကြိမ် ပြုလုပ်ပြီးနောက် အချိန်တို (ဥပမာ 10 မိနစ်) အတွင်း auto‑pair ခွင့်ပြုခြင်း။

auto‑approval များအားလုံးကို log မှတ်တမ်းတင်ရမည်။

---

# TLS everywhere (dev + prod)

## Reuse existing bridge TLS

လက်ရှိ TLS runtime + fingerprint pinning ကို အသုံးပြုပါ—

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` ထဲရှိ fingerprint verification logic

## Apply to WS

- WS server သည် တူညီသော cert/key + fingerprint ဖြင့် TLS ကို ထောက်ပံ့သည်။
- WS clients များသည် fingerprint ကို pin လုပ်နိုင်သည် (ရွေးချယ်နိုင်)။
- Discovery သည် endpoint အားလုံးအတွက် TLS + fingerprint ကို ကြေညာသည်။
  - Discovery သည် locator hints သာဖြစ်ပြီး trust anchor မဖြစ်ရ။

## Why

- confidentiality အတွက် SSH/Tailscale အပေါ် မူတည်မှုကို လျှော့ချရန်။
- mobile မှ အဝေးချိတ်ဆက်မှုများကို default အနေနှင့် လုံခြုံစေရန်။

---

# Approvals redesign (centralized)

## Current

Approval သည် node host (mac app node runtime) ပေါ်တွင် ဖြစ်ပေါ်ပြီး prompt သည် node လည်ပတ်ရာနေရာတွင် ပေါ်လာသည်။

## Proposed

Approval ကို **gateway‑hosted** အဖြစ် ပြုလုပ်ပြီး UI ကို operator clients များသို့ ပို့ပေးသည်။

### New flow

1. Gateway သည် `system.run` intent (agent) ကို လက်ခံသည်။
2. Gateway သည် approval record တစ်ခု ဖန်တီးသည်: `approval.requested`။
3. Operator UI များတွင် prompt ပြသသည်။
4. Approval ဆုံးဖြတ်ချက်ကို gateway သို့ ပို့သည်: `approval.resolve`။
5. Gateway သည် approve ဖြစ်ပါက node command ကို ခေါ်သည်။
6. Node သည် လုပ်ဆောင်ပြီး `invoke-res` ကို ပြန်ပို့သည်။

### Approval semantics (hardening)

- Operator အားလုံးသို့ broadcast လုပ်ပြီး active UI တွင်သာ modal ပြသသည် (အခြားများတွင် toast)။
- ပထမဆုံး ဖြေရှင်းချက်သာ အနိုင်ရပြီး နောက်ထပ် resolve များကို gateway က already settled အဖြစ် ငြင်းပယ်သည်။
- ပုံမှန် timeout: N စက္ကန့် (ဥပမာ 60s) ကျော်လွန်ပါက deny လုပ်ပြီး အကြောင်းပြချက်ကို log မှတ်တမ်းတင်သည်။
- Resolution အတွက် `operator.approvals` scope လိုအပ်သည်။

## Benefits

- Prompt သည် အသုံးပြုသူရှိရာ (mac/ဖုန်း) တွင် ပေါ်လာသည်။
- အဝေးမှ node များအတွက် approvals တူညီညီ ဖြစ်စေသည်။
- Node runtime သည် headless အဖြစ် ဆက်လက်လုပ်ဆောင်နိုင်ပြီး UI မလိုအပ်တော့ပါ။

---

# Role clarity examples

## iPhone app

- **Node role**: mic, camera, voice chat, location, push‑to‑talk အတွက်။
- Optional **operator.read**: အခြေအနေ နှင့် chat view အတွက်။
- Optional **operator.write/admin**: ထင်ရှားစွာ ဖွင့်ထားသောအခါမှသာ။

## macOS app

- ပုံမှန်အားဖြင့် Operator role (control UI)။
- “Mac node” ဖွင့်ထားသောအခါ Node role (system.run, screen, camera)။
- connection နှစ်ခုစလုံးတွင် deviceId တူ → UI entry ကို ပေါင်းစည်းပြသသည်။

## CLI

- အမြဲ Operator role။
- subcommand အလိုက် scope ကို ဆုံးဖြတ်သည်—
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - approvals + pairing → `operator.approvals` / `operator.pairing`

---

# Identity + slugs

## Stable ID

Auth အတွက် မဖြစ်မနေလိုအပ်ပြီး ဘယ်တော့မှ မပြောင်းလဲရ။

ဦးစားပေး—

- Keypair fingerprint (public key hash)။

## Cute slug (lobster‑themed)

လူဖတ်ရလွယ်ကူသော label သာဖြစ်သည်။

- ဥပမာ: `scarlet-claw`, `saltwave`, `mantis-pinch`။
- Gateway registry တွင် သိမ်းဆည်းပြီး ပြင်ဆင်နိုင်သည်။
- Collision ကို ကိုင်တွယ်ခြင်း: `-2`, `-3`။

## UI grouping

Role မတူသော်လည်း `deviceId` တူညီပါက “Instance” row တစ်ခုတည်းအဖြစ် ပြသသည်—

- Badge: `operator`, `node`။
- စွမ်းရည်များ + နောက်ဆုံး တွေ့ရှိချိန်ကို ပြသသည်။

---

# Migration strategy

## Phase 0: Document + align

- ဤစာတမ်းကို ထုတ်ဝေခြင်း။
- ပရိုတိုကောခေါ်ဆိုမှုများ + approval flows အားလုံးကို စာရင်းပြုစုခြင်း။

## Phase 1: Add roles/scopes to WS

- `connect` params များကို `role`, `scope`, `deviceId` ဖြင့် တိုးချဲ့ခြင်း။
- node role အတွက် allowlist gating ထည့်သွင်းခြင်း။

## Phase 2: Bridge compatibility

- Bridge ကို ဆက်လက် လည်ပတ်စေခြင်း။
- WS node support ကို parallel အဖြစ် ထည့်သွင်းခြင်း။
- config flag ဖြင့် feature များကို ထိန်းချုပ်ခြင်း။

## Phase 3: Central approvals

- WS တွင် approval request + resolve events များ ထည့်သွင်းခြင်း။
- mac app UI ကို prompt ပြ + respond ပြုလုပ်နိုင်အောင် update လုပ်ခြင်း။
- Node runtime သည် UI prompt မပြတော့ပါ။

## Phase 4: TLS unification

- Bridge TLS runtime ကို အသုံးပြုပြီး WS အတွက် TLS config ထည့်သွင်းခြင်း။
- Clients များတွင် pinning ထည့်သွင်းခြင်း။

## Phase 5: Deprecate bridge

- iOS/Android/mac node များကို WS သို့ ပြောင်းရွှေ့ခြင်း။
- fallback အဖြစ် bridge ကို ထားရှိပြီး တည်ငြိမ်ပြီးနောက် ဖယ်ရှားခြင်း။

## Phase 6: Device‑bound auth

- local မဟုတ်သော connection အားလုံးအတွက် key‑based identity ကို မဖြစ်မနေလိုအပ်စေခြင်း။
- revocation + rotation UI ထည့်သွင်းခြင်း။

---

# Security notes

- Role/allowlist ကို gateway နယ်နိမိတ်တွင် ခိုင်မာစွာ အတည်ပြုသည်။
- Operator scope မရှိဘဲ “full” API ကို မည်သည့် client မှ မရနိုင်ပါ။
- Connection အားလုံးအတွက် pairing မဖြစ်မနေ လိုအပ်သည်။
- TLS + pinning သည် mobile အတွက် MITM အန္တရာယ်ကို လျှော့ချသည်။
- SSH silent approval သည် အဆင်ပြေစေရန်သာ ဖြစ်ပြီး မှတ်တမ်းတင်ထားကာ revoke လုပ်နိုင်သည်။
- Discovery သည် trust anchor မဖြစ်ရ။
- Capability claims များကို platform/type အလိုက် server allowlists များဖြင့် စစ်ဆေးအတည်ပြုသည်။

# Streaming + large payloads (node media)

WS control plane သည် message အသေးများအတွက် သင့်တော်သော်လည်း node များတွင် အောက်ပါအရာများလည်း ရှိသည်—

- camera clips
- screen recordings
- audio streams

ရွေးချယ်စရာများ—

1. WS binary frames + chunking + backpressure rules။
2. သီးခြား streaming endpoint (TLS + auth ဆက်လက် အသုံးပြု)။
3. media‑heavy commands များအတွက် bridge ကို အချိန်ပိုထားပြီး နောက်ဆုံးမှ ပြောင်းရွှေ့ခြင်း။

implementation မလုပ်မီ တစ်ခုကို ရွေးချယ်ပါ—drift မဖြစ်စေရန်။

# Capability + command policy

- Node မှ ကြေညာသော caps/commands များကို **claims** အဖြစ်သာ သတ်မှတ်သည်။
- Gateway သည် platform အလိုက် allowlists များဖြင့် အတည်ပြုစစ်ဆေးသည်။
- command အသစ်တိုင်းအတွက် operator approval သို့မဟုတ် allowlist ပြောင်းလဲမှုကို လိုအပ်သည်။
- ပြောင်းလဲမှုများကို timestamp ဖြင့် audit လုပ်သည်။

# Audit + rate limiting

- Log: pairing requests, approvals/denials, token issuance/rotation/revocation။
- pairing spam နှင့် approval prompts များကို rate‑limit လုပ်သည်။

# Protocol hygiene

- protocol version + error codes ကို ထင်ရှားစွာ သတ်မှတ်ခြင်း။
- reconnect rules + heartbeat policy။
- presence TTL နှင့် last‑seen semantics။

---

# Open questions

1. Role နှစ်ခုလုံးကို စက်တစ်လုံးတည်း လည်ပတ်သောအခါ: token model
   - role အလိုက် token သီးခြားထားရန် အကြံပြုသည် (node vs operator)။
   - deviceId တူ; scope မတူ; revoke လုပ်ရန် ပိုရှင်းလင်း။

2. Operator scope အနုစိတ်အဆင့်
   - read/write/admin + approvals + pairing (အနည်းဆုံး လိုအပ်ချက်)။
   - နောက်ပိုင်းတွင် per‑feature scopes ကို စဉ်းစားနိုင်သည်။

3. Token rotation + revocation UX
   - role ပြောင်းလဲသောအခါ auto‑rotate။
   - deviceId + role အလိုက် revoke လုပ်နိုင်သော UI။

4. Discovery
   - လက်ရှိ Bonjour TXT ကို WS TLS fingerprint + role hints ဖြင့် တိုးချဲ့ခြင်း။
   - locator hints အဖြစ်သာ သတ်မှတ်ခြင်း။

5. Cross‑network approval
   - Operator clients အားလုံးသို့ broadcast; active UI တွင် modal ပြသသည်။
   - ပထမဆုံး ဖြေကြားချက်သာ အနိုင်ရပြီး gateway က atomicity ကို အတည်ပြုသည်။

---

# Summary (TL;DR)

- ယနေ့: WS control plane + Bridge node transport။
- နာကျင်မှု: approvals + duplication + stack နှစ်ခု။
- အဆိုပြုချက်: roles + scopes ရှင်းလင်းသော WS ပရိုတိုကောတစ်ခုတည်း၊ unified pairing + TLS pinning၊ gateway‑hosted approvals၊ တည်ငြိမ်သော device IDs + ချစ်စရာ slugs။
- ရလဒ်: UX ပိုရိုးရှင်း၊ လုံခြုံရေး ပိုခိုင်မာ၊ ထပ်နေမှုနည်း၊ mobile routing ပိုကောင်း။
