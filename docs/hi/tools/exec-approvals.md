---
summary: "Exec अनुमोदन, allowlist, और sandbox से बाहर निकलने के प्रॉम्प्ट"
read_when:
  - Exec अनुमोदन या allowlist का विन्यास करते समय
  - macOS ऐप में exec अनुमोदन UX लागू करते समय
  - sandbox से बाहर निकलने के प्रॉम्प्ट और उनके प्रभावों की समीक्षा करते समय
title: "Exec अनुमोदन"
x-i18n:
  source_path: tools/exec-approvals.md
  source_hash: 66630b5d79671dd4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:02Z
---

# Exec अनुमोदन

Exec अनुमोदन **सहचर ऐप / node होस्ट गार्डरेल** हैं, जिनका उद्देश्य किसी sandboxed एजेंट को वास्तविक होस्ट पर
कमांड चलाने की अनुमति देना है (`gateway` या `node`)। इसे एक सुरक्षा इंटरलॉक की तरह समझें:
कमांड तभी अनुमत होते हैं जब नीति + allowlist + (वैकल्पिक) उपयोगकर्ता अनुमोदन—तीनों सहमत हों।
Exec अनुमोदन **टूल नीति और elevated gating के अतिरिक्त** होते हैं (जब तक elevated को `full` पर सेट न किया गया हो, जो अनुमोदनों को छोड़ देता है)।
प्रभावी नीति `tools.exec.*` और अनुमोदन डिफ़ॉल्ट्स में से **अधिक सख़्त** होती है; यदि किसी अनुमोदन फ़ील्ड को छोड़ा गया है, तो `tools.exec` मान उपयोग किया जाता है।

यदि सहचर ऐप UI **उपलब्ध नहीं** है, तो जिस भी अनुरोध को प्रॉम्प्ट की आवश्यकता होती है, उसे
**ask fallback** द्वारा सुलझाया जाता है (डिफ़ॉल्ट: deny)।

## जहाँ यह लागू होता है

Exec अनुमोदन निष्पादन होस्ट पर स्थानीय रूप से लागू किए जाते हैं:

- **gateway host** → गेटवे मशीन पर `openclaw` प्रक्रिया
- **node host** → node runner (macOS सहचर ऐप या headless node होस्ट)

macOS विभाजन:

- **node host service** स्थानीय IPC के माध्यम से `system.run` को **macOS ऐप** तक अग्रेषित करता है।
- **macOS ऐप** अनुमोदन लागू करता है + UI संदर्भ में कमांड निष्पादित करता है।

## सेटिंग्स और भंडारण

अनुमोदन निष्पादन होस्ट पर एक स्थानीय JSON फ़ाइल में रहते हैं:

`~/.openclaw/exec-approvals.json`

उदाहरण स्कीमा:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## नीति नियंत्रण

### सुरक्षा (`exec.security`)

- **deny**: सभी होस्ट exec अनुरोधों को अवरुद्ध करें।
- **allowlist**: केवल allowlist में मौजूद कमांड की अनुमति दें।
- **full**: सब कुछ अनुमति दें (elevated के समकक्ष)।

### Ask (`exec.ask`)

- **off**: कभी प्रॉम्प्ट न करें।
- **on-miss**: केवल तब प्रॉम्प्ट करें जब allowlist मेल न खाए।
- **always**: हर कमांड पर प्रॉम्प्ट करें।

### Ask fallback (`askFallback`)

यदि प्रॉम्प्ट आवश्यक है लेकिन कोई UI उपलब्ध नहीं है, तो fallback निर्णय करता है:

- **deny**: अवरुद्ध करें।
- **allowlist**: केवल तभी अनुमति दें जब allowlist मेल खाए।
- **full**: अनुमति दें।

## Allowlist (प्रति एजेंट)

Allowlists **प्रति एजेंट** होती हैं। यदि कई एजेंट मौजूद हैं, तो macOS ऐप में
जिस एजेंट को आप संपादित कर रहे हैं, उसे बदलें। पैटर्न **case-insensitive glob matches** होते हैं।
पैटर्न को **बाइनरी पथों** में रेज़ॉल्व होना चाहिए (केवल basename वाली प्रविष्टियाँ अनदेखी की जाती हैं)।
Legacy `agents.default` प्रविष्टियाँ लोड के समय `agents.main` में माइग्रेट की जाती हैं।

उदाहरण:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

प्रत्येक allowlist प्रविष्टि ट्रैक करती है:

- **id** UI पहचान के लिए स्थिर UUID (वैकल्पिक)
- **last used** टाइमस्टैम्प
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

जब **Auto-allow skill CLIs** सक्षम होता है, तो ज्ञात Skills द्वारा संदर्भित executables
को nodes पर allowlisted माना जाता है (macOS node या headless node होस्ट)। यह
Gateway RPC के माध्यम से `skills.bins` का उपयोग कर skill bin सूची प्राप्त करता है।
यदि आप सख़्त मैनुअल allowlists चाहते हैं, तो इसे अक्षम करें।

## Safe bins (stdin-only)

`tools.exec.safeBins` **stdin-only** बाइनरीज़ की एक छोटी सूची परिभाषित करता है (उदाहरण के लिए `jq`),
जो allowlist मोड में **बिना** स्पष्ट allowlist प्रविष्टियों के चल सकती हैं। Safe bins
positional फ़ाइल args और path-जैसे टोकन अस्वीकार करते हैं, इसलिए वे केवल आने वाली स्ट्रीम पर ही कार्य कर सकते हैं।
allowlist मोड में shell chaining और redirections स्वतः अनुमत नहीं होते।

Shell chaining (`&&`, `||`, `;`) तब अनुमत है जब हर top-level सेगमेंट
allowlist को संतुष्ट करता हो (safe bins या skill auto-allow सहित)। Redirections allowlist मोड में असमर्थित रहते हैं।
Command substitution (`$()` / backticks) allowlist पार्सिंग के दौरान अस्वीकार कर दिया जाता है,
यहाँ तक कि double quotes के भीतर भी; यदि आपको शाब्दिक `$()` पाठ चाहिए, तो single quotes का उपयोग करें।

डिफ़ॉल्ट safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`।

## Control UI संपादन

डिफ़ॉल्ट्स, प्रति‑एजेंट ओवरराइड्स, और allowlists संपादित करने के लिए
**Control UI → Nodes → Exec approvals** कार्ड का उपयोग करें। एक स्कोप चुनें (Defaults या कोई एजेंट),
नीति समायोजित करें, allowlist पैटर्न जोड़ें/हटाएँ, फिर **Save** करें। UI प्रत्येक पैटर्न के लिए
**last used** मेटाडेटा दिखाता है ताकि आप सूची को सुव्यवस्थित रख सकें।

टार्गेट सेलेक्टर **Gateway** (स्थानीय अनुमोदन) या किसी **Node** का चयन करता है। Nodes को
`system.execApprovals.get/set` का विज्ञापन करना चाहिए (macOS ऐप या headless node होस्ट)।
यदि कोई node अभी exec अनुमोदन का विज्ञापन नहीं करता है, तो उसकी स्थानीय
`~/.openclaw/exec-approvals.json` को सीधे संपादित करें।

CLI: `openclaw approvals` gateway या node संपादन का समर्थन करता है (देखें [Approvals CLI](/cli/approvals))।

## अनुमोदन प्रवाह

जब किसी प्रॉम्प्ट की आवश्यकता होती है, तो gateway ऑपरेटर क्लाइंट्स को `exec.approval.requested` प्रसारित करता है।
Control UI और macOS ऐप इसे `exec.approval.resolve` के माध्यम से सुलझाते हैं, फिर gateway
अनुमोदित अनुरोध को node होस्ट तक अग्रेषित करता है।

जब अनुमोदन आवश्यक होते हैं, तो exec टूल तुरंत एक approval id के साथ लौटता है। उस id का उपयोग
बाद की सिस्टम घटनाओं (`Exec finished` / `Exec denied`) को सहसंबद्ध करने के लिए करें।
यदि टाइमआउट से पहले कोई निर्णय नहीं आता, तो अनुरोध को अनुमोदन टाइमआउट माना जाता है
और इसे अस्वीकृति कारण के रूप में प्रदर्शित किया जाता है।

पुष्टिकरण संवाद में शामिल हैं:

- कमांड + args
- cwd
- agent id
- रेज़ॉल्व किया गया executable पथ
- होस्ट + नीति मेटाडेटा

क्रियाएँ:

- **Allow once** → अभी चलाएँ
- **Always allow** → allowlist में जोड़ें + चलाएँ
- **Deny** → अवरुद्ध करें

## चैट चैनलों पर अनुमोदन अग्रेषण

आप exec अनुमोदन प्रॉम्प्ट्स को किसी भी चैट चैनल (प्लगइन चैनलों सहित) पर अग्रेषित कर सकते हैं और
उन्हें `/approve` के साथ अनुमोदित कर सकते हैं। यह सामान्य आउटबाउंड डिलीवरी पाइपलाइन का उपयोग करता है।

विन्यास:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

चैट में उत्तर दें:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS IPC प्रवाह

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

सुरक्षा नोट्स:

- Unix socket मोड `0600`, टोकन `exec-approvals.json` में संग्रहीत।
- Same-UID peer जाँच।
- Challenge/response (nonce + HMAC टोकन + अनुरोध हैश) + छोटा TTL।

## सिस्टम घटनाएँ

Exec जीवनचक्र सिस्टम संदेशों के रूप में प्रदर्शित होता है:

- `Exec running` (केवल तब जब कमांड running notice थ्रेशहोल्ड से अधिक हो)
- `Exec finished`
- `Exec denied`

ये node द्वारा घटना रिपोर्ट करने के बाद एजेंट के सत्र में पोस्ट किए जाते हैं।
Gateway-host exec अनुमोदन भी वही जीवनचक्र घटनाएँ उत्सर्जित करते हैं जब कमांड समाप्त होता है
(और वैकल्पिक रूप से तब, जब वह थ्रेशहोल्ड से अधिक समय तक चल रहा हो)।
अनुमोदन-गेटेड execs इन संदेशों में `runId` के रूप में approval id का पुन: उपयोग करते हैं
ताकि सहसंबंध आसान हो।

## प्रभाव

- **full** शक्तिशाली है; जहाँ संभव हो allowlists को प्राथमिकता दें।
- **ask** आपको लूप में रखता है, जबकि तेज़ अनुमोदन की अनुमति देता है।
- प्रति‑एजेंट allowlists एक एजेंट के अनुमोदनों को दूसरों में लीक होने से रोकते हैं।
- अनुमोदन केवल **authorized senders** से आने वाले होस्ट exec अनुरोधों पर लागू होते हैं।
  अनधिकृत प्रेषक `/exec` जारी नहीं कर सकते।
- `/exec security=full` अधिकृत ऑपरेटरों के लिए सत्र‑स्तरीय सुविधा है और डिज़ाइन के अनुसार अनुमोदन छोड़ देता है।
  होस्ट exec को सख़्ती से अवरुद्ध करने के लिए, अनुमोदन सुरक्षा को `deny` पर सेट करें
  या टूल नीति के माध्यम से `exec` टूल को deny करें।

संबंधित:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
