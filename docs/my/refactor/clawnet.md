---
summary: "Clawnet ပြန်လည်ဖွဲ့စည်းခြင်း: ကွန်ယက်ပရိုတိုကော၊ အခန်းကဏ္ဍများ၊ အတည်ပြုခြင်း၊ အတည်ပြုချက်များနှင့် အိုင်ဒင်တီတီကို တစ်စုတစ်စည်းတည်း ပြုလုပ်ခြင်း"
read_when:
  - နိုဒ်များနှင့် အော်ပရေးတာ ကလိုင်ယင့်များအတွက် တစ်စုတစ်စည်းတည်းသော ကွန်ယက်ပရိုတိုကောကို စီမံကိန်းရေးဆွဲနေစဉ်
  - စက်ပစ္စည်းများအကြား approvals၊ pairing၊ TLS နှင့် presence ကို ပြန်လည်ပြုပြင်နေစဉ်
title: "Clawnet Refactor"
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

### 1. Gateway WebSocket (control plane)

- API အပြည့်အစုံ: config, channels, models, sessions, agent runs, logs, nodes စသည်တို့။
- Default bind: loopback. Remote access via SSH/Tailscale.
- Auth: token/password via `connect`။
- TLS pinning မရှိ (loopback/tunnel အပေါ် မူတည်)။
- Code:
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2. Bridge (node transport)

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

Role is per‑connection, not per device. A device may open both roles, separately.

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

Define it precisely to avoid a weak link. Prefer one:

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

Approval happens on node host (mac app node runtime). Prompt appears where node runs.

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

Required for auth; never changes.
အကြံပြု—

- Keypair fingerprint (public key hash).

## Cute slug (lobster‑themed)

Human label only.

- Example: `scarlet-claw`, `saltwave`, `mantis-pinch`.
- Stored in gateway registry, editable.
- Collision handling: `-2`, `-3`.

## UI grouping

Same `deviceId` across roles → single “Instance” row:

- Badge: `operator`, `node`.
- Shows capabilities + last seen.

---

# Migration strategy

## Phase 0: Document + align

- Publish this doc.
- Inventory all protocol calls + approval flows.

## Phase 1: Add roles/scopes to WS

- Extend `connect` params with `role`, `scope`, `deviceId`.
- Add allowlist gating for node role.

## Phase 2: Bridge compatibility

- Keep bridge running.
- Add WS node support in parallel.
- Gate features behind config flag.

## Phase 3: Central approvals

- Add approval request + resolve events in WS.
- Update mac app UI to prompt + respond.
- Node runtime stops prompting UI.

## Phase 4: TLS unification

- Add TLS config for WS using bridge TLS runtime.
- Add pinning to clients.

## Phase 5: Deprecate bridge

- Migrate iOS/Android/mac node to WS.
- Keep bridge as fallback; remove once stable.

## Phase 6: Device‑bound auth

- Require key‑based identity for all non‑local connections.
- Add revocation + rotation UI.

---

# Security notes

- Role/allowlist enforced at gateway boundary.
- No client gets “full” API without operator scope.
- Pairing required for _all_ connections.
- 1. Mobile အတွက် TLS + pinning သုံးခြင်းက MITM အန္တရာယ်ကို လျှော့ချပေးသည်။
- 2. SSH silent approval သည် အဆင်ပြေစေမှုတစ်ရပ်သာဖြစ်ပြီး၊ မှတ်တမ်းတင်ထားပြီး ပြန်လည်ရုပ်သိမ်းနိုင်သည်။
- 3. Discovery ကို ယုံကြည်မှုအခြေခံ (trust anchor) အဖြစ် မသုံးရ။
- 4. Capability claims များကို platform/type အလိုက် server allowlists များနှင့် နှိုင်းယှဉ်စစ်ဆေးသည်။

# Streaming + large payloads (node media)

5. WS control plane သည် message အသေးများအတွက် သင့်တော်သော်လည်း node များက အောက်ပါတို့ကိုလည်း လုပ်ဆောင်သည်။

- camera clips
- screen recordings
- audio streams

ရွေးချယ်စရာများ-

1. 6. WS binary frames + chunking + backpressure rules။
2. 7. သီးခြား streaming endpoint (TLS + auth ဆက်လက်အသုံးပြု)။
3. 8. Media များစွာပါဝင်သော commands များအတွက် bridge ကို ပိုကြာကြာ ထားရှိပြီး နောက်ဆုံးမှ ပြောင်းရွှေ့ပါ။

9) Implementation မလုပ်မီ တစ်ခုကို ရွေးချယ်ပါ၊ drift မဖြစ်စေရန်။

# Capability + command policy

- 10. Node မှ report လုပ်သော caps/commands များကို **claims** အဖြစ်သာ သတ်မှတ်သည်။
- 11. Gateway က platform အလိုက် allowlists များကို အကောင်အထည်ဖော်ထိန်းချုပ်သည်။
- 12. Command အသစ်တိုင်းအတွက် operator အတည်ပြုချက် သို့မဟုတ် allowlist ကို အထူးပြောင်းလဲရမည်။
- 13. ပြောင်းလဲမှုများကို timestamp များဖြင့် audit လုပ်ပါ။

# Audit + rate limiting

- 14. Log: pairing requests, approvals/denials, token issuance/rotation/revocation။
- 15. Pairing spam နှင့် approval prompts များကို rate‑limit လုပ်ပါ။

# Protocol hygiene

- 16. Protocol version ကို ရှင်းလင်းစွာ သတ်မှတ်ပြီး error codes ပါဝင်စေပါ။
- 17. Reconnect rules + heartbeat policy။
- 18. Presence TTL နှင့် last‑seen semantics။

---

# Open questions

1. 19. Device တစ်ခုတည်းက roles နှစ်ခုလုံး chạyနေပါက: token model။
   - 20. Role အလိုက် သီးခြား tokens (node vs operator) ကို အကြံပြုသည်။
   - 21. deviceId တူညီ၊ scopes ကွဲပြား၊ revocation ပိုမိုရှင်းလင်း။

2. 22. Operator scope granularity
   - 23. read/write/admin + approvals + pairing (minimum viable)။
   - 24. နောက်ပိုင်းတွင် per‑feature scopes ကို စဉ်းစားပါ။

3. Token rotation + revocation UX
   - 25. Role ပြောင်းလဲသည့်အခါ auto‑rotate လုပ်ပါ။
   - 26. deviceId + role အလိုက် revoke လုပ်နိုင်သော UI။

4. Discovery
   - 27. လက်ရှိ Bonjour TXT ကို WS TLS fingerprint + role hints ပါအောင် တိုးချဲ့ပါ။
   - 28. Locator hints အဖြစ်သာ သတ်မှတ်အသုံးပြုပါ။

5. Cross‑network approval
   - 29. Operator clients အားလုံးသို့ broadcast လုပ်ပြီး active UI တွင် modal ပြပါ။
   - 30. ပထမဆုံး တုံ့ပြန်သူသာ အနိုင်ရပြီး gateway က atomicity ကို အကောင်အထည်ဖော်သည်။

---

# Summary (TL;DR)

- 31. ယနေ့: WS control plane + Bridge node transport။
- 32. အခက်အခဲများ: approvals + duplication + stacks နှစ်ခု။
- 33. အဆိုပြုချက်: roles + scopes ကို ရှင်းလင်းစွာ သတ်မှတ်ထားသော WS protocol တစ်ခု၊ unified pairing + TLS pinning, gateway‑hosted approvals, stable device IDs + cute slugs။
- 34. ရလဒ်: UX ပိုမိုရိုးရှင်း၊ လုံခြုံရေးပိုမိုခိုင်မာ၊ duplication လျော့နည်း၊ mobile routing ပိုကောင်း။
