---
summary: "OpenClaw sandboxing कैसे काम करता है: मोड, स्कोप, वर्कस्पेस एक्सेस, और इमेजेज़"
title: Sandboxing
read_when: "आप sandboxing की समर्पित व्याख्या चाहते हैं या agents.defaults.sandbox को ट्यून करना चाहते हैं।"
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:29Z
---

# Sandboxing

OpenClaw **Docker कंटेनरों के भीतर टूल्स चला सकता है** ताकि ब्लास्ट रेडियस कम हो।
यह **वैकल्पिक** है और विन्यास (`agents.defaults.sandbox` या
`agents.list[].sandbox`) द्वारा नियंत्रित होता है। यदि sandboxing बंद है, तो टूल्स होस्ट पर चलते हैं।
Gateway होस्ट पर ही रहता है; सक्षम होने पर टूल निष्पादन एक पृथक sandbox में चलता है।

यह पूर्ण सुरक्षा सीमा नहीं है, लेकिन जब मॉडल कोई गलत काम करता है तो यह फ़ाइलसिस्टम
और प्रोसेस एक्सेस को वास्तविक रूप से सीमित करता है।

## क्या sandboxed होता है

- टूल निष्पादन (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, आदि)।
- वैकल्पिक sandboxed ब्राउज़र (`agents.defaults.sandbox.browser`)।
  - डिफ़ॉल्ट रूप से, sandbox ब्राउज़र स्वतः शुरू होता है (यह सुनिश्चित करता है कि CDP पहुँच योग्य हो) जब ब्राउज़र टूल को इसकी आवश्यकता होती है।
    `agents.defaults.sandbox.browser.autoStart` और `agents.defaults.sandbox.browser.autoStartTimeoutMs` के माध्यम से विन्यास करें।
  - `agents.defaults.sandbox.browser.allowHostControl` sandboxed सत्रों को होस्ट ब्राउज़र को स्पष्ट रूप से लक्षित करने देता है।
  - वैकल्पिक allowlists `target: "custom"` को नियंत्रित करती हैं: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`।

Sandboxed नहीं:

- Gateway प्रक्रिया स्वयं।
- कोई भी टूल जिसे स्पष्ट रूप से होस्ट पर चलाने की अनुमति दी गई हो (जैसे, `tools.elevated`)।
  - **Elevated exec होस्ट पर चलता है और sandboxing को बायपास करता है।**
  - यदि sandboxing बंद है, तो `tools.elevated` निष्पादन को नहीं बदलता (पहले से ही होस्ट पर)। देखें [Elevated Mode](/tools/elevated)।

## मोड

`agents.defaults.sandbox.mode` यह नियंत्रित करता है कि sandboxing **कब** उपयोग किया जाता है:

- `"off"`: कोई sandboxing नहीं।
- `"non-main"`: केवल **non-main** सत्रों को sandbox करें (यदि आप सामान्य चैट्स होस्ट पर चाहते हैं तो डिफ़ॉल्ट)।
- `"all"`: हर सत्र sandbox में चलता है।
  टिप्पणी: `"non-main"` `session.mainKey` (डिफ़ॉल्ट `"main"`) पर आधारित है, एजेंट id पर नहीं।
  समूह/चैनल सत्र अपनी स्वयं की कुंजियाँ उपयोग करते हैं, इसलिए वे non-main गिने जाते हैं और sandboxed होंगे।

## स्कोप

`agents.defaults.sandbox.scope` यह नियंत्रित करता है कि **कितने कंटेनर** बनाए जाते हैं:

- `"session"` (डिफ़ॉल्ट): प्रति सत्र एक कंटेनर।
- `"agent"`: प्रति एजेंट एक कंटेनर।
- `"shared"`: सभी sandboxed सत्रों द्वारा साझा किया गया एक कंटेनर।

## वर्कस्पेस एक्सेस

`agents.defaults.sandbox.workspaceAccess` यह नियंत्रित करता है कि sandbox **क्या देख सकता है**:

- `"none"` (डिफ़ॉल्ट): टूल्स `~/.openclaw/sandboxes` के अंतर्गत एक sandbox वर्कस्पेस देखते हैं।
- `"ro"`: एजेंट वर्कस्पेस को केवल-पढ़ने योग्य रूप में `/agent` पर माउंट करता है (यह `write`/`edit`/`apply_patch` को निष्क्रिय करता है)।
- `"rw"`: एजेंट वर्कस्पेस को पढ़ने/लिखने योग्य रूप में `/workspace` पर माउंट करता है।

इनबाउंड मीडिया सक्रिय sandbox वर्कस्पेस में कॉपी किया जाता है (`media/inbound/*`)।
Skills टिप्पणी: `read` टूल sandbox-rooted है। `workspaceAccess: "none"` के साथ,
OpenClaw पात्र Skills को sandbox वर्कस्पेस (`.../skills`) में मिरर करता है ताकि
उन्हें पढ़ा जा सके। `"rw"` के साथ, वर्कस्पेस Skills
`/workspace/skills` से पढ़ने योग्य होती हैं।

## कस्टम bind mounts

`agents.defaults.sandbox.docker.binds` अतिरिक्त होस्ट निर्देशिकाओं को कंटेनर में माउंट करता है।
फ़ॉर्मेट: `host:container:mode` (उदाहरण के लिए, `"/home/user/source:/source:rw"`)।

ग्लोबल और प्रति-एजेंट binds **मर्ज** किए जाते हैं (प्रतिस्थापित नहीं)। `scope: "shared"` के अंतर्गत, प्रति-एजेंट binds को अनदेखा किया जाता है।

उदाहरण (केवल-पढ़ने योग्य स्रोत + docker socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

सुरक्षा नोट्स:

- Binds sandbox फ़ाइलसिस्टम को बायपास करते हैं: वे होस्ट पाथ्स को आपके सेट किए गए मोड (`:ro` या `:rw`) के साथ उजागर करते हैं।
- संवेदनशील माउंट्स (जैसे, `docker.sock`, सीक्रेट्स, SSH कुंजियाँ) को `:ro` होना चाहिए जब तक कि बिल्कुल आवश्यक न हो।
- यदि आपको केवल वर्कस्पेस के लिए read एक्सेस चाहिए तो `workspaceAccess: "ro"` के साथ संयोजन करें; bind मोड स्वतंत्र रहते हैं।
- टूल पॉलिसी और elevated exec के साथ binds कैसे इंटरैक्ट करते हैं, इसके लिए [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) देखें।

## इमेजेज़ + सेटअप

डिफ़ॉल्ट इमेज: `openclaw-sandbox:bookworm-slim`

इसे एक बार बनाएं:

```bash
scripts/sandbox-setup.sh
```

टिप्पणी: डिफ़ॉल्ट इमेज में Node शामिल **नहीं** है। यदि किसी Skill को Node (या
अन्य रनटाइम्स) की आवश्यकता है, तो या तो एक कस्टम इमेज बेक करें या
`sandbox.docker.setupCommand` के माध्यम से इंस्टॉल करें (नेटवर्क egress + writable root +
root user आवश्यक)।

Sandboxed ब्राउज़र इमेज:

```bash
scripts/sandbox-browser-setup.sh
```

डिफ़ॉल्ट रूप से, sandbox कंटेनर **बिना नेटवर्क** के चलते हैं।
`agents.defaults.sandbox.docker.network` के साथ ओवरराइड करें।

Docker इंस्टॉलेशन और कंटेनराइज़्ड Gateway यहाँ रहते हैं:
[Docker](/install/docker)

## setupCommand (एक-बार का कंटेनर सेटअप)

`setupCommand` sandbox कंटेनर बनने के बाद **एक बार** चलता है (हर रन पर नहीं)।
यह `sh -lc` के माध्यम से कंटेनर के भीतर निष्पादित होता है।

पाथ्स:

- ग्लोबल: `agents.defaults.sandbox.docker.setupCommand`
- प्रति-एजेंट: `agents.list[].sandbox.docker.setupCommand`

सामान्य समस्याएँ:

- डिफ़ॉल्ट `docker.network` `"none"` है (कोई egress नहीं), इसलिए पैकेज इंस्टॉल विफल होंगे।
- `readOnlyRoot: true` लिखने से रोकता है; `readOnlyRoot: false` सेट करें या कस्टम इमेज बेक करें।
- पैकेज इंस्टॉल के लिए `user` को root होना चाहिए (`user` छोड़ें या `user: "0:0"` सेट करें)।
- Sandbox exec होस्ट `process.env` को इनहेरिट **नहीं** करता। Skill API कुंजियों के लिए
  `agents.defaults.sandbox.docker.env` (या कस्टम इमेज) का उपयोग करें।

## टूल पॉलिसी + escape hatches

Sandbox नियमों से पहले टूल allow/deny पॉलिसी लागू होती है। यदि कोई टूल
ग्लोबली या प्रति-एजेंट निषिद्ध है, तो sandboxing उसे वापस सक्षम नहीं करता।

`tools.elevated` एक स्पष्ट escape hatch है जो `exec` को होस्ट पर चलाता है।
`/exec` निर्देश केवल अधिकृत प्रेषकों पर लागू होते हैं और प्रति सत्र स्थायी रहते हैं; `exec` को हार्ड-डिसेबल करने के लिए,
टूल पॉलिसी deny का उपयोग करें (देखें [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated))।

डिबगिंग:

- प्रभावी sandbox मोड, टूल पॉलिसी, और fix-it विन्यास कुंजियों का निरीक्षण करने के लिए `openclaw sandbox explain` का उपयोग करें।
- “यह क्यों ब्लॉक है?” मानसिक मॉडल के लिए [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) देखें।
  इसे लॉक्ड डाउन रखें।

## मल्टी-एजेंट ओवरराइड्स

प्रत्येक एजेंट sandbox + tools को ओवरराइड कर सकता है:
`agents.list[].sandbox` और `agents.list[].tools` (साथ ही sandbox टूल पॉलिसी के लिए `agents.list[].tools.sandbox.tools`)।
प्राथमिकता के लिए [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) देखें।

## न्यूनतम सक्षम उदाहरण

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## संबंधित दस्तावेज़

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
