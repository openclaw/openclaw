---
summary: "Exec अनुमोदन, allowlist, और sandbox से बाहर निकलने के प्रॉम्प्ट"
read_when:
  - Exec अनुमोदन या allowlist का विन्यास करते समय
  - macOS ऐप में exec अनुमोदन UX लागू करते समय
  - sandbox से बाहर निकलने के प्रॉम्प्ट और उनके प्रभावों की समीक्षा करते समय
title: "Exec अनुमोदन"
---

# Exec अनुमोदन

Exec approvals एक sandboxed agent को वास्तविक host (`gateway` या `node`) पर commands चलाने देने के लिए **companion app / node host guardrail** हैं। इसे एक safety interlock की तरह समझें:
commands केवल तब allowed होते हैं जब policy + allowlist + (वैकल्पिक) user approval सभी सहमत हों।
Exec approvals tool policy और elevated gating के **अतिरिक्त** होते हैं (जब तक elevated को `full` पर सेट न किया गया हो, जो approvals को skip करता है)।
Effective policy `tools.exec.*` और approvals defaults में से **अधिक सख़्त** होती है; यदि कोई approvals field छोड़ी गई है, तो `tools.exec` मान का उपयोग किया जाता है।

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

Allowlists **per agent** होती हैं। यदि कई agents मौजूद हैं, तो macOS app में आप जिस agent को edit कर रहे हैं उसे switch करें। Patterns **case-insensitive glob matches** होते हैं।
Patterns को **binary paths** में resolve होना चाहिए (केवल basename वाली entries को अनदेखा किया जाता है)।
Legacy `agents.default` entries को load पर `agents.main` में migrate किया जाता है।

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

जब **Auto-allow skill CLIs** सक्षम होता है, तो ज्ञात skills द्वारा संदर्भित executables को nodes (macOS node या headless node host) पर allowlisted माना जाता है। यह skill bin सूची fetch करने के लिए Gateway RPC के माध्यम से `skills.bins` का उपयोग करता है। यदि आप सख़्त manual allowlists चाहते हैं तो इसे अक्षम करें।

## Safe bins (stdin-only)

`tools.exec.safeBins` **stdin-only** binaries (उदाहरण के लिए `jq`) की एक छोटी सूची परिभाषित करता है
जो explicit allowlist entries के **बिना** allowlist mode में चल सकते हैं। Safe bins positional file args और path-like tokens को reject करते हैं, इसलिए वे केवल incoming stream पर ही operate कर सकते हैं।
Allowlist mode में shell chaining और redirections auto-allowed नहीं होते।

Shell chaining (`&&`, `||`, `;`) तब allowed होती है जब हर top-level segment allowlist को संतुष्ट करता हो
(जिसमें safe bins या skill auto-allow शामिल हैं)। Allowlist mode में redirections असमर्थित रहती हैं।
Command substitution (`$()` / backticks) allowlist parsing के दौरान reject की जाती है, जिसमें
double quotes के अंदर भी शामिल है; यदि आपको literal `$()` text चाहिए तो single quotes का उपयोग करें।

डिफ़ॉल्ट safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`।

## Control UI संपादन

**Control UI → Nodes → Exec approvals** कार्ड का उपयोग defaults, per‑agent
overrides, और allowlists को edit करने के लिए करें। एक scope (Defaults या कोई agent) चुनें, policy को tweak करें,
allowlist patterns जोड़ें/हटाएँ, फिर **Save** करें। UI प्रत्येक pattern के लिए **last used** metadata दिखाता है
ताकि आप सूची को सुव्यवस्थित रख सकें।

लक्ष्य चयनकर्ता **Gateway** (स्थानीय अनुमोदन) या किसी **Node** को चुनता है। Nodes को `system.execApprovals.get/set` का विज्ञापन करना चाहिए (macOS ऐप या हेडलेस नोड होस्ट)।
यदि कोई नोड अभी exec approvals का विज्ञापन नहीं करता है, तो उसकी स्थानीय `~/.openclaw/exec-approvals.json` फ़ाइल को सीधे संपादित करें।

CLI: `openclaw approvals` gateway या node संपादन का समर्थन करता है (देखें [Approvals CLI](/cli/approvals))।

## अनुमोदन प्रवाह

जब किसी प्रॉम्प्ट की आवश्यकता होती है, तो गेटवे ऑपरेटर क्लाइंट्स को `exec.approval.requested` ब्रॉडकास्ट करता है।
Control UI और macOS ऐप इसे `exec.approval.resolve` के माध्यम से सुलझाते हैं, फिर गेटवे अनुमोदित अनुरोध को नोड होस्ट तक अग्रेषित करता है।

जब अनुमोदन आवश्यक होते हैं, तो exec टूल तुरंत एक approval id के साथ लौट आता है। उस id का उपयोग बाद की सिस्टम घटनाओं (`Exec finished` / `Exec denied`) को सहसंबद्ध करने के लिए करें। यदि टाइमआउट से पहले कोई निर्णय नहीं आता है, तो अनुरोध को approval timeout माना जाता है और इसे अस्वीकृति के कारण के रूप में दिखाया जाता है।

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

आप exec approval प्रॉम्प्ट्स को किसी भी चैट चैनल (प्लगइन चैनल सहित) में फ़ॉरवर्ड कर सकते हैं और `/approve` के साथ उन्हें स्वीकृत कर सकते हैं। यह सामान्य आउटबाउंड डिलीवरी पाइपलाइन का उपयोग करता है।

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

नोड द्वारा इवेंट रिपोर्ट करने के बाद इन्हें एजेंट के सेशन में पोस्ट किया जाता है।
Gateway-host exec approvals कमांड समाप्त होने पर (और वैकल्पिक रूप से थ्रेशहोल्ड से अधिक समय तक चलने पर) वही लाइफ़साइकल इवेंट्स उत्सर्जित करते हैं।
Approval-gated execs आसान सहसंबंध के लिए इन संदेशों में approval id को `runId` के रूप में पुनः उपयोग करते हैं।

## प्रभाव

- **full** शक्तिशाली है; जहाँ संभव हो allowlists को प्राथमिकता दें।
- **ask** आपको लूप में रखता है, जबकि तेज़ अनुमोदन की अनुमति देता है।
- प्रति‑एजेंट allowlists एक एजेंट के अनुमोदनों को दूसरों में लीक होने से रोकते हैं।
- Approvals केवल **authorized senders** से आने वाले host exec अनुरोधों पर लागू होते हैं। Unauthorized senders `/exec` जारी नहीं कर सकते।
- `/exec security=full` अधिकृत ऑपरेटरों के लिए सेशन-स्तरीय सुविधा है और डिज़ाइन के अनुसार अनुमोदन को छोड़ देता है।
  Host exec को पूरी तरह ब्लॉक करने के लिए, approvals security को `deny` पर सेट करें या tool policy के माध्यम से `exec` टूल को deny करें।

संबंधित:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
