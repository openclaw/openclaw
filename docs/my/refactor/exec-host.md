---
summary: "Refactor အစီအစဉ် — exec host routing၊ node approvals နှင့် headless runner"
read_when:
  - Exec host routing သို့မဟုတ် exec approvals ကို ဒီဇိုင်းဆွဲနေချိန်
  - Node runner + UI IPC ကို အကောင်အထည်ဖော်နေချိန်
  - Exec host security modes နှင့် slash commands ကို ထည့်သွင်းနေချိန်
title: "Exec Host Refactor"
---

# Exec host ပြန်လည်ဖွဲ့စည်းရေး အစီအစဉ်

## ရည်မှန်းချက်များ

- **sandbox**, **gateway**, နှင့် **node** အကြား execution ကို route လုပ်ရန် `exec.host` + `exec.security` ကို ထည့်သွင်းရန်။
- မူလသတ်မှတ်ချက်များကို **လုံခြုံစိတ်ချရ** အောင်ထားရန် — အတိအကျ ဖွင့်မထားပါက cross-host execution မပြုလုပ်။
- Execution ကို **headless runner service** အဖြစ် ခွဲထုတ်ပြီး local IPC ဖြင့် ချိတ်ဆက်သော optional UI (macOS app) ကို ပံ့ပိုးရန်။
- **အေးဂျင့်တစ်ခုချင်းစီအလိုက်** policy၊ allowlist၊ ask mode နှင့် node binding ကို ပံ့ပိုးရန်။
- allowlist ပါရှိခြင်း/မပါရှိခြင်း နှစ်မျိုးစလုံးနှင့် အလုပ်လုပ်နိုင်သော **ask modes** ကို ပံ့ပိုးရန်။
- Cross-platform — Unix socket + token auth (macOS/Linux/Windows အညီညွတ်မှု)။

## မပါဝင်သောအချက်များ (Non-goals)

- Legacy allowlist migration သို့မဟုတ် legacy schema ပံ့ပိုးမှု မရှိ။
- Node exec အတွက် PTY/streaming မရှိ (output ကို စုပေါင်းထားခြင်းသာ)။
- ရှိပြီးသား Bridge + Gateway အပြင် network layer အသစ် မထည့်သွင်း။

## ဆုံးဖြတ်ချက်များ (အတည်ပြုပြီး)

- **Config keys:** `exec.host` + `exec.security` (အေးဂျင့်အလိုက် override ခွင့်ပြု)။
- **Elevation:** gateway full access အတွက် `/elevated` ကို alias အဖြစ် ဆက်လက်ထားရှိ။
- **Ask default:** `on-miss`။
- **Approvals store:** `~/.openclaw/exec-approvals.json` (JSON၊ legacy migration မရှိ)။
- **Runner:** headless system service; UI app သည် approvals အတွက် Unix socket ကို host လုပ်ပေးသည်။
- **Node identity:** ရှိပြီးသား `nodeId` ကို အသုံးပြု။
- **Socket auth:** Unix socket + token (cross-platform)၊ လိုအပ်ပါက နောက်ပိုင်း ခွဲထုတ်နိုင်။
- **Node host state:** `~/.openclaw/node.json` (node id + pairing token)။
- **macOS exec host:** macOS app အတွင်း `system.run` ကို run လုပ်ပြီး node host service သည် local IPC ဖြင့် request များကို forward လုပ်သည်။
- **XPC helper မသုံး:** Unix socket + token + peer checks ကိုသာ အသုံးပြု။

## အဓိက အယူအဆများ

### Host

- `sandbox`: Docker exec (လက်ရှိ အပြုအမူ)။
- `gateway`: gateway host ပေါ်တွင် exec လုပ်ခြင်း။
- `node`: Bridge (`system.run`) မှတဆင့် node runner ပေါ်တွင် exec လုပ်ခြင်း။

### Security mode

- `deny`: အမြဲတမ်း ပိတ်ဆို့။
- `allowlist`: ကိုက်ညီသည့်အရာများကိုသာ ခွင့်ပြု။
- `full`: အားလုံး ခွင့်ပြု (elevated နှင့် တူညီ)။

### Ask mode

- `off`: မမေး။
- `on-miss`: allowlist မကိုက်ညီပါကသာ မေး။
- `always`: အမြဲ မေး။

Ask သည် allowlist နှင့် **လွတ်လပ်သီးခြား** ဖြစ်ပြီး allowlist ကို `always` သို့မဟုတ် `on-miss` နှင့်အတူ အသုံးပြုနိုင်သည်။

### Policy resolution (exec တစ်ကြိမ်ချင်းစီ)

1. `exec.host` ကို ဖြေရှင်း (tool param → agent override → global default)။
2. `exec.security` နှင့် `exec.ask` ကို ဖြေရှင်း (တူညီသော အဆင့်လိုက်စည်းမျဉ်း)။
3. Host သည် `sandbox` ဖြစ်ပါက local sandbox exec ကို ဆက်လက်လုပ်ဆောင်။
4. Host သည် `gateway` သို့မဟုတ် `node` ဖြစ်ပါက ထို host ပေါ်တွင် security + ask policy ကို အသုံးချ။

## မူလ လုံခြုံရေး

- မူလသတ်မှတ်ချက် `exec.host = sandbox`။
- `gateway` နှင့် `node` အတွက် မူလသတ်မှတ်ချက် `exec.security = deny`။
- မူလသတ်မှတ်ချက် `exec.ask = on-miss` (security ခွင့်ပြုထားပါကသာ သက်ဆိုင်)။
- Node binding မသတ်မှတ်ထားပါက **အေးဂျင့်သည် မည်သည့် node ကိုမဆို ရွေးနိုင်သည်** — သို့သော် policy ခွင့်ပြုထားရမည်။

## Config အကျယ်အဝန်း

### Tool parameters

- `exec.host` (optional): `sandbox | gateway | node`။
- `exec.security` (optional): `deny | allowlist | full`။
- `exec.ask` (optional): `off | on-miss | always`။
- `exec.node` (optional): `host=node` ဖြစ်သည့်အခါ အသုံးပြုမည့် node id/name။

### Config keys (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (မူလ node binding)

### Config keys (အေးဂျင့်အလိုက်)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = agent session အတွက် `tools.exec.host=gateway`၊ `tools.exec.security=full` ကို သတ်မှတ်။
- `/elevated off` = agent session အတွက် ယခင် exec settings များကို ပြန်လည်ထားရှိ။

## Approvals store (JSON)

Path: `~/.openclaw/exec-approvals.json`

ရည်ရွယ်ချက်များ:

- **execution host** (gateway သို့မဟုတ် node runner) အတွက် local policy + allowlists။
- UI မရရှိနိုင်သည့်အခါ ask fallback။
- UI clients များအတွက် IPC credentials။

အဆိုပြု schema (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

မှတ်ချက်များ:

- Legacy allowlist format များ မရှိ။
- `ask` လိုအပ်ပြီး UI မရောက်နိုင်သည့်အခါတွင်သာ `askFallback` ကို အသုံးပြု။
- File permissions: `0600`။

## Runner service (headless)

### အခန်းကဏ္ဍ

- `exec.security` + `exec.ask` ကို local တွင် အတည်ပြု အသုံးချ။
- System commands များကို execute လုပ်ပြီး output ကို ပြန်ပို့။
- Exec lifecycle အတွက် Bridge events များကို ထုတ်လွှတ် (optional သော်လည်း အကြံပြု)။

### Service lifecycle

- macOS တွင် Launchd/daemon; Linux/Windows တွင် system service။
- Approvals JSON သည် execution host အပေါ်တွင် local ဖြစ်သည်။
- UI သည် local Unix socket ကို host လုပ်ပြီး runner များက လိုအပ်သည့်အခါ ချိတ်ဆက်။

## UI ပေါင်းစည်းမှု (macOS app)

### IPC

- Unix socket — `~/.openclaw/exec-approvals.sock` (0600)။
- Token ကို `exec-approvals.json` (0600) တွင် သိမ်းဆည်း။
- Peer checks: same-UID သာ ခွင့်ပြု။
- Challenge/response: nonce + HMAC(token, request-hash) ဖြင့် replay ကို ကာကွယ်။
- Short TTL (ဥပမာ 10s) + max payload + rate limit။

### Ask flow (macOS app exec host)

1. Node service သည် gateway မှ `system.run` ကို လက်ခံရရှိ။
2. Node service သည် local socket သို့ ချိတ်ဆက်ပြီး prompt/exec request ကို ပို့။
3. App သည် peer + token + HMAC + TTL ကို စစ်ဆေးပြီး လိုအပ်ပါက dialog ပြသ။
4. App သည် UI context အတွင်း command ကို execute လုပ်ပြီး output ပြန်ပို့။
5. Node service သည် output ကို gateway သို့ ပြန်ပို့။

UI မရှိပါက:

- `askFallback` (`deny|allowlist|full`) ကို အသုံးချ။

### Diagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node identity + binding

- Bridge pairing မှ ရှိပြီးသား `nodeId` ကို အသုံးပြု။
- Binding မော်ဒယ်:
  - `tools.exec.node` သည် အေးဂျင့်ကို သီးသန့် node တစ်ခုနှင့် ကန့်သတ်။
  - မသတ်မှတ်ထားပါက အေးဂျင့်သည် မည်သည့် node ကိုမဆို ရွေးနိုင်သည် (policy မူလသတ်မှတ်ချက်များ ဆက်လက်အလုပ်လုပ်)။
- Node selection ဖြေရှင်းမှု:
  - `nodeId` exact match
  - `displayName` (normalized)
  - `remoteIp`
  - `nodeId` prefix (>= 6 chars)

## Eventing

### မည်သူများက events ကို မြင်နိုင်သနည်း

- System events များသည် **session အလိုက်** ဖြစ်ပြီး နောက်တစ်ကြိမ် prompt တွင် အေးဂျင့်အား ပြသ။
- Gateway in-memory queue (`enqueueSystemEvent`) တွင် သိမ်းဆည်းထားသည်။

### Event စာသား

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + optional output tail
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Option A (အကြံပြု):

- Runner သည် Bridge `event` frames `exec.started` / `exec.finished` ကို ပို့။
- Gateway `handleBridgeEvent` သည် ထိုများကို `enqueueSystemEvent` အဖြစ် map လုပ်။

Option B:

- Gateway `exec` tool သည် lifecycle ကို တိုက်ရိုက် ကိုင်တွယ် (synchronous သာ)။

## Exec flows

### Sandbox host

- ရှိပြီးသား `exec` အပြုအမူ (Docker သို့မဟုတ် unsandboxed ဖြစ်ပါက host)။
- Non-sandbox mode တွင်သာ PTY ကို ပံ့ပိုး။

### Gateway host

- Gateway process သည် ကိုယ်ပိုင် စက်ပေါ်တွင် execute လုပ်သည်။
- Local `exec-approvals.json` (security/ask/allowlist) ကို အတည်ပြု အသုံးချ။

### Node host

- Gateway သည် `system.run` ဖြင့် `node.invoke` ကို ခေါ်ဆို။
- Runner သည် local approvals ကို အတည်ပြု။
- Runner သည် stdout/stderr ကို စုပေါင်းပြီး ပြန်ပို့။
- Start/finish/deny အတွက် optional Bridge events။

## Output ကန့်သတ်ချက်များ

- stdout+stderr စုပေါင်းကို **200k** အထိ ကန့်သတ်; events အတွက် **tail 20k** ကို ထားရှိ။
- 35. အဆုံးသတ်ကို ရှင်းလင်းသော suffix ဖြင့် truncate လုပ်ပါ (ဥပမာ၊ `"…` 36. (truncated)\`)။

## Slash commands

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- အေးဂျင့်အလိုက်၊ session အလိုက် override များ — config ဖြင့် မသိမ်းဆည်းပါက မတည်မြဲ။
- `/elevated on|off|ask|full` သည် `host=gateway security=full` အတွက် shortcut အဖြစ် ဆက်လက်ရှိ (approvals ကို skip လုပ်ရန် `full` နှင့်အတူ)။

## Cross-platform အကြောင်း

- Runner service သည် portable execution target ဖြစ်သည်။
- UI သည် optional ဖြစ်ပြီး မရှိပါက `askFallback` ကို အသုံးချ။
- Windows/Linux သည် approvals JSON + socket protocol တူညီစွာ ပံ့ပိုး။

## Implementation အဆင့်များ

### Phase 1: config + exec routing

- `exec.host`, `exec.security`, `exec.ask`, `exec.node` အတွက် config schema ထည့်သွင်း။
- Tool plumbing ကို `exec.host` ကို လေးစားအောင် ပြင်ဆင်။
- `/exec` slash command ထည့်သွင်းပြီး `/elevated` alias ကို ထိန်းသိမ်း။

### Phase 2: approvals store + gateway enforcement

- `exec-approvals.json` reader/writer ကို အကောင်အထည်ဖော်။
- `gateway` host အတွက် allowlist + ask modes ကို အတည်ပြု အသုံးချ။
- Output caps ထည့်သွင်း။

### Phase 3: node runner enforcement

- Node runner ကို allowlist + ask ကို အတည်ပြု အသုံးချရန် update။
- macOS app UI သို့ Unix socket prompt bridge ထည့်သွင်း။
- `askFallback` ကို ချိတ်ဆက်။

### Phase 4: events

- Exec lifecycle အတွက် node → gateway Bridge events ထည့်သွင်း။
- Agent prompts အတွက် `enqueueSystemEvent` သို့ map လုပ်။

### Phase 5: UI polish

- Mac app: allowlist editor၊ အေးဂျင့်အလိုက် switcher၊ ask policy UI။
- Node binding controls (optional)။

## Testing အစီအစဉ်

- Unit tests: allowlist matching (glob + case-insensitive)။
- Unit tests: policy resolution precedence (tool param → agent override → global)။
- Integration tests: node runner deny/allow/ask flows။
- Bridge event tests: node event → system event routing။

## ဖွင့်လှစ်ထားသော အန္တရာယ်များ

- UI မရရှိနိုင်မှု: `askFallback` ကို လေးစားအောင် သေချာစေရန်။
- ကြာရှည်လုပ်ဆောင်သော commands များ: timeout + output caps ကို အားထား။
- Node အများအပြား မရှင်းလင်းမှု: node binding သို့မဟုတ် explicit node param မရှိပါက error ပြန်ပို့။

## ဆက်စပ် စာတမ်းများ

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
