---
summary: "रीफैक्टर योजना: exec होस्ट रूटिंग, नोड अनुमोदन, और हेडलेस रनर"
read_when:
  - exec होस्ट रूटिंग या exec अनुमोदन डिज़ाइन करते समय
  - नोड रनर + UI IPC लागू करते समय
  - exec होस्ट सुरक्षा मोड और स्लैश कमांड जोड़ते समय
title: "Exec होस्ट रीफैक्टर"
---

# Exec होस्ट रीफैक्टर योजना

## लक्ष्य

- **sandbox**, **gateway**, और **node** के बीच निष्पादन रूट करने के लिए `exec.host` + `exec.security` जोड़ना।
- डिफ़ॉल्ट को **सुरक्षित** रखना: स्पष्ट रूप से सक्षम किए बिना क्रॉस-होस्ट निष्पादन नहीं।
- निष्पादन को एक **हेडलेस रनर सेवा** में विभाजित करना, वैकल्पिक UI (macOS ऐप) के साथ local IPC के माध्यम से।
- **प्रति-एजेंट** नीति, allowlist, ask मोड, और नोड बाइंडिंग प्रदान करना।
- **ask मोड** का समर्थन करना जो allowlists के _साथ_ या _बिना_ काम करें।
- क्रॉस-प्लेटफ़ॉर्म: Unix सॉकेट + टोकन प्रमाणीकरण (macOS/Linux/Windows समानता)।

## गैर-लक्ष्य

- किसी भी legacy allowlist माइग्रेशन या legacy स्कीमा समर्थन नहीं।
- नोड exec के लिए PTY/स्ट्रीमिंग नहीं (केवल समेकित आउटपुट)।
- मौजूदा Bridge + Gateway से आगे कोई नया नेटवर्क लेयर नहीं।

## निर्णय (लॉक्ड)

- **Config keys:** `exec.host` + `exec.security` (प्रति-एजेंट ओवरराइड की अनुमति)।
- **Elevation:** `/elevated` को Gateway पूर्ण पहुँच के उपनाम के रूप में बनाए रखना।
- **Ask default:** `on-miss`।
- **Approvals store:** `~/.openclaw/exec-approvals.json` (JSON, कोई legacy माइग्रेशन नहीं)।
- **Runner:** हेडलेस सिस्टम सेवा; UI ऐप अनुमोदनों के लिए Unix सॉकेट होस्ट करता है।
- **Node identity:** मौजूदा `nodeId` का उपयोग।
- **Socket auth:** Unix सॉकेट + टोकन (क्रॉस-प्लेटफ़ॉर्म); आवश्यकता होने पर बाद में विभाजन।
- **Node host state:** `~/.openclaw/node.json` (node id + pairing token)।
- **macOS exec host:** macOS ऐप के भीतर `system.run` चलाएँ; नोड होस्ट सेवा local IPC पर अनुरोध अग्रेषित करती है।
- **कोई XPC helper नहीं:** Unix सॉकेट + टोकन + peer checks पर ही बने रहें।

## प्रमुख अवधारणाएँ

### Host

- `sandbox`: Docker exec (वर्तमान व्यवहार)।
- `gateway`: Gateway होस्ट पर exec।
- `node`: Bridge के माध्यम से नोड रनर पर exec (`system.run`)।

### Security mode

- `deny`: हमेशा ब्लॉक।
- `allowlist`: केवल मेल खाने वालों को अनुमति।
- `full`: सब कुछ अनुमति (elevated के समतुल्य)।

### Ask mode

- `off`: कभी न पूछें।
- `on-miss`: केवल तब पूछें जब allowlist मेल न खाए।
- `always`: हर बार पूछें।

Ask, allowlist से **स्वतंत्र** है; allowlist को `always` या `on-miss` के साथ उपयोग किया जा सकता है।

### नीति समाधान (प्रति exec)

1. `exec.host` का समाधान करें (tool param → agent override → global default)।
2. `exec.security` और `exec.ask` का समाधान करें (समान प्राथमिकता)।
3. यदि host `sandbox` है, तो local sandbox exec के साथ आगे बढ़ें।
4. यदि host `gateway` या `node` है, तो उस host पर सुरक्षा + ask नीति लागू करें।

## डिफ़ॉल्ट सुरक्षा

- डिफ़ॉल्ट `exec.host = sandbox`।
- `gateway` और `node` के लिए डिफ़ॉल्ट `exec.security = deny`।
- डिफ़ॉल्ट `exec.ask = on-miss` (केवल तब प्रासंगिक जब सुरक्षा अनुमति देती हो)।
- यदि कोई नोड बाइंडिंग सेट नहीं है, तो **एजेंट किसी भी नोड को लक्षित कर सकता है**, लेकिन केवल तब जब नीति इसकी अनुमति दे।

## Config surface

### Tool parameters

- `exec.host` (वैकल्पिक): `sandbox | gateway | node`।
- `exec.security` (वैकल्पिक): `deny | allowlist | full`।
- `exec.ask` (वैकल्पिक): `off | on-miss | always`।
- `exec.node` (वैकल्पिक): `host=node` होने पर उपयोग करने के लिए node id/name।

### Config keys (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (डिफ़ॉल्ट नोड बाइंडिंग)

### Config keys (per agent)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = एजेंट सत्र के लिए `tools.exec.host=gateway`, `tools.exec.security=full` सेट करें।
- `/elevated off` = एजेंट सत्र के लिए पूर्व exec सेटिंग्स पुनर्स्थापित करें।

## Approvals store (JSON)

Path: `~/.openclaw/exec-approvals.json`

उद्देश्य:

- **execution host** (Gateway या node runner) के लिए स्थानीय नीति + allowlists।
- UI उपलब्ध न होने पर ask फ़ॉलबैक।
- UI क्लाइंट्स के लिए IPC क्रेडेंशियल्स।

प्रस्तावित स्कीमा (v1):

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

टिप्पणियाँ:

- कोई legacy allowlist फ़ॉर्मैट नहीं।
- `ask` आवश्यक होने और UI उपलब्ध न होने पर ही `askFallback` लागू होता है।
- फ़ाइल अनुमतियाँ: `0600`।

## Runner सेवा (हेडलेस)

### भूमिका

- स्थानीय रूप से `exec.security` + `exec.ask` लागू करना।
- सिस्टम कमांड निष्पादित करना और आउटपुट लौटाना।
- exec जीवनचक्र के लिए Bridge इवेंट्स उत्सर्जित करना (वैकल्पिक लेकिन अनुशंसित)।

### सेवा जीवनचक्र

- macOS पर Launchd/daemon; Linux/Windows पर सिस्टम सेवा।
- Approvals JSON निष्पादन होस्ट पर स्थानीय होता है।
- UI एक स्थानीय Unix सॉकेट होस्ट करता है; रनर आवश्यकता अनुसार कनेक्ट करते हैं।

## UI एकीकरण (macOS ऐप)

### IPC

- Unix सॉकेट: `~/.openclaw/exec-approvals.sock` (0600)।
- टोकन: `exec-approvals.json` (0600) में संग्रहीत।
- Peer checks: केवल same-UID।
- Challenge/response: nonce + HMAC(token, request-hash) ताकि replay रोका जा सके।
- छोटा TTL (उदा., 10s) + अधिकतम payload + rate limit।

### Ask फ़्लो (macOS ऐप exec होस्ट)

1. नोड सेवा Gateway से `system.run` प्राप्त करती है।
2. नोड सेवा स्थानीय सॉकेट से कनेक्ट होकर prompt/exec अनुरोध भेजती है।
3. ऐप peer + token + HMAC + TTL सत्यापित करता है, फिर आवश्यकता होने पर डायलॉग दिखाता है।
4. ऐप UI संदर्भ में कमांड निष्पादित करता है और आउटपुट लौटाता है।
5. नोड सेवा आउटपुट Gateway को लौटाती है।

यदि UI अनुपस्थित हो:

- `askFallback` लागू करें (`deny|allowlist|full`)।

### आरेख (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node identity + binding

- Bridge pairing से मौजूदा `nodeId` का उपयोग करें।
- बाइंडिंग मॉडल:
  - `tools.exec.node` एजेंट को किसी विशिष्ट नोड तक सीमित करता है।
  - यदि सेट न हो, एजेंट किसी भी नोड का चयन कर सकता है (नीति अभी भी डिफ़ॉल्ट लागू करती है)।
- नोड चयन समाधान:
  - `nodeId` सटीक मिलान
  - `displayName` (normalized)
  - `remoteIp`
  - `nodeId` उपसर्ग (>= 6 अक्षर)

## Eventing

### कौन इवेंट्स देखता है

- सिस्टम इवेंट्स **प्रति सत्र** होते हैं और अगले प्रॉम्प्ट पर एजेंट को दिखाए जाते हैं।
- Gateway इन-मेमोरी क्यू (`enqueueSystemEvent`) में संग्रहीत।

### Event पाठ

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + वैकल्पिक आउटपुट टेल
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

विकल्प A (अनुशंसित):

- Runner Bridge `event` फ्रेम्स `exec.started` / `exec.finished` भेजता है।
- Gateway `handleBridgeEvent` इन्हें `enqueueSystemEvent` में मैप करता है।

विकल्प B:

- Gateway `exec` टूल सीधे जीवनचक्र संभालता है (केवल synchronous)।

## Exec फ़्लोज़

### Sandbox होस्ट

- मौजूदा `exec` व्यवहार (Docker या unsandboxed होने पर होस्ट)।
- PTY केवल non-sandbox मोड में समर्थित।

### Gateway होस्ट

- Gateway प्रक्रिया अपनी ही मशीन पर निष्पादित होती है।
- स्थानीय `exec-approvals.json` (security/ask/allowlist) लागू करती है।

### Node होस्ट

- Gateway `node.invoke` को `system.run` के साथ कॉल करता है।
- Runner स्थानीय अनुमोदन लागू करता है।
- Runner समेकित stdout/stderr लौटाता है।
- प्रारंभ/समाप्ति/अस्वीकृति के लिए वैकल्पिक Bridge इवेंट्स।

## Output caps

- संयुक्त stdout+stderr को **200k** पर सीमित करें; इवेंट्स के लिए **tail 20k** रखें।
- Truncate with a clear suffix (e.g., `"… (truncated)"`).

## Slash commands

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- प्रति-एजेंट, प्रति-सत्र ओवरराइड; config के माध्यम से सहेजने तक non-persistent।
- `/elevated on|off|ask|full` `host=gateway security=full` के लिए शॉर्टकट बना रहता है (`full` के साथ अनुमोदन छोड़ते हुए)।

## Cross-platform कहानी

- Runner सेवा पोर्टेबल निष्पादन लक्ष्य है।
- UI वैकल्पिक है; यदि अनुपस्थित हो, `askFallback` लागू होता है।
- Windows/Linux वही approvals JSON + सॉकेट प्रोटोकॉल का समर्थन करते हैं।

## कार्यान्वयन चरण

### चरण 1: config + exec रूटिंग

- `exec.host`, `exec.security`, `exec.ask`, `exec.node` के लिए config स्कीमा जोड़ें।
- tool plumbing को `exec.host` का सम्मान करने के लिए अपडेट करें।
- `/exec` स्लैश कमांड जोड़ें और `/elevated` alias बनाए रखें।

### चरण 2: approvals store + gateway प्रवर्तन

- `exec-approvals.json` reader/writer लागू करें।
- `gateway` होस्ट के लिए allowlist + ask मोड लागू करें।
- आउटपुट caps जोड़ें।

### चरण 3: node runner प्रवर्तन

- node runner को allowlist + ask लागू करने के लिए अपडेट करें।
- macOS ऐप UI के लिए Unix सॉकेट prompt ब्रिज जोड़ें।
- `askFallback` वायर करें।

### चरण 4: events

- exec जीवनचक्र के लिए node → gateway Bridge इवेंट्स जोड़ें।
- एजेंट प्रॉम्प्ट्स के लिए `enqueueSystemEvent` में मैप करें।

### चरण 5: UI polish

- Mac ऐप: allowlist editor, प्रति-एजेंट स्विचर, ask नीति UI।
- नोड बाइंडिंग नियंत्रण (वैकल्पिक)।

## Testing योजना

- Unit tests: allowlist matching (glob + case-insensitive)।
- Unit tests: नीति समाधान प्राथमिकता (tool param → agent override → global)।
- Integration tests: node runner deny/allow/ask फ़्लो।
- Bridge event tests: node event → system event रूटिंग।

## Open जोखिम

- UI अनुपलब्धता: सुनिश्चित करें कि `askFallback` का सम्मान हो।
- लंबे समय तक चलने वाले कमांड: timeout + output caps पर निर्भर रहें।
- multi-node अस्पष्टता: नोड बाइंडिंग या स्पष्ट node param के बिना त्रुटि।

## संबंधित दस्तावेज़

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
