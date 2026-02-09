---
summary: "OpenClaw sandboxing कैसे काम करता है: मोड, स्कोप, वर्कस्पेस एक्सेस, और इमेजेज़"
title: Sandboxing
read_when: "आप sandboxing की समर्पित व्याख्या चाहते हैं या agents.defaults.sandbox को ट्यून करना चाहते हैं।"
status: active
---

# Sandboxing

OpenClaw **Docker containers के अंदर tools** चला सकता है ताकि blast radius कम हो।
यह **वैकल्पिक** है और कॉन्फ़िगरेशन (`agents.defaults.sandbox` या
`agents.list[].sandbox`) द्वारा नियंत्रित होता है। यदि sandboxing बंद है, तो tools होस्ट पर चलते हैं।
Gateway होस्ट पर ही रहता है; tool execution सक्षम होने पर एक अलग-थलग sandbox में चलता है।

यह पूर्ण सुरक्षा सीमा नहीं है, लेकिन जब मॉडल कोई गलत काम करता है तो यह फ़ाइलसिस्टम
और प्रोसेस एक्सेस को वास्तविक रूप से सीमित करता है।

## क्या sandboxed होता है

- टूल निष्पादन (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, आदि)।
- वैकल्पिक sandboxed ब्राउज़र (`agents.defaults.sandbox.browser`)।
  - डिफ़ॉल्ट रूप से, sandbox browser अपने आप शुरू हो जाता है (यह सुनिश्चित करता है कि CDP पहुँचे योग्य हो) जब browser tool को इसकी आवश्यकता होती है।
    `agents.defaults.sandbox.browser.autoStart` और `agents.defaults.sandbox.browser.autoStartTimeoutMs` के माध्यम से कॉन्फ़िगर करें।
  - `agents.defaults.sandbox.browser.allowHostControl` sandboxed सत्रों को होस्ट ब्राउज़र को स्पष्ट रूप से लक्षित करने देता है।
  - वैकल्पिक allowlists `target: "custom"` को नियंत्रित करती हैं: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`।

Sandboxed नहीं:

- Gateway प्रक्रिया स्वयं।
- कोई भी टूल जिसे स्पष्ट रूप से होस्ट पर चलाने की अनुमति दी गई हो (जैसे, `tools.elevated`)।
  - **Elevated exec होस्ट पर चलता है और sandboxing को बायपास करता है।**
  - यदि sandboxing बंद है, तो `tools.elevated` execution को नहीं बदलता (पहले से ही होस्ट पर)। देखें [Elevated Mode](/tools/elevated)।

## मोड

`agents.defaults.sandbox.mode` यह नियंत्रित करता है कि sandboxing **कब** उपयोग किया जाता है:

- `"off"`: कोई sandboxing नहीं।
- `"non-main"`: केवल **non-main** सत्रों को sandbox करें (यदि आप सामान्य चैट्स होस्ट पर चाहते हैं तो डिफ़ॉल्ट)।
- `"all"`: हर session sandbox में चलता है।
  नोट: `"non-main"` `session.mainKey` (डिफ़ॉल्ट `"main"`) पर आधारित है, agent id पर नहीं।
  Group/channel sessions अपनी खुद की keys का उपयोग करते हैं, इसलिए वे non-main माने जाते हैं और sandbox किए जाएँगे।

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

Inbound media को सक्रिय sandbox workspace (`media/inbound/*`) में कॉपी किया जाता है।
Skills नोट: `read` tool sandbox-rooted है। `workspaceAccess: "none"` के साथ,
OpenClaw योग्य skills को sandbox workspace (`.../skills`) में मिरर करता है ताकि
उन्हें पढ़ा जा सके। `"rw"` के साथ, workspace skills
`/workspace/skills` से पढ़ने योग्य होते हैं।

## कस्टम bind mounts

`agents.defaults.sandbox.docker.binds` अतिरिक्त host directories को container में माउंट करता है।
फ़ॉर्मेट: `host:container:mode` (जैसे, `"/home/user/source:/source:rw"`)।

Global और per-agent binds **merge** किए जाते हैं (replace नहीं होते)। `scope: "shared"` के अंतर्गत, per-agent binds को अनदेखा किया जाता है।

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

नोट: डिफ़ॉल्ट image में **Node शामिल नहीं** है। यदि किसी skill को Node (या
अन्य runtimes) की आवश्यकता है, तो या तो एक कस्टम image बनाएँ या
`sandbox.docker.setupCommand` के माध्यम से इंस्टॉल करें (network egress + writable root +
root user आवश्यक)।

Sandboxed ब्राउज़र इमेज:

```bash
scripts/sandbox-browser-setup.sh
```

By default, sandbox containers run with **no network**.
Override with `agents.defaults.sandbox.docker.network`.

Docker इंस्टॉलेशन और कंटेनराइज़्ड Gateway यहाँ रहते हैं:
[Docker](/install/docker)

## setupCommand (एक-बार का कंटेनर सेटअप)

`setupCommand` runs **once** after the sandbox container is created (not on every run).
It executes inside the container via `sh -lc`.

पाथ्स:

- ग्लोबल: `agents.defaults.sandbox.docker.setupCommand`
- प्रति-एजेंट: `agents.list[].sandbox.docker.setupCommand`

सामान्य समस्याएँ:

- डिफ़ॉल्ट `docker.network` `"none"` है (कोई egress नहीं), इसलिए पैकेज इंस्टॉल विफल होंगे।
- `readOnlyRoot: true` लिखने से रोकता है; `readOnlyRoot: false` सेट करें या कस्टम इमेज बेक करें।
- पैकेज इंस्टॉल के लिए `user` को root होना चाहिए (`user` छोड़ें या `user: "0:0"` सेट करें)।
- Sandbox exec does **not** inherit host `process.env`. Use
  `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.

## टूल पॉलिसी + escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied
globally or per-agent, sandboxing doesn’t bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` on the host.
`/exec` directives only apply for authorized senders and persist per session; to hard-disable
`exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

डिबगिंग:

- प्रभावी sandbox मोड, टूल पॉलिसी, और fix-it विन्यास कुंजियों का निरीक्षण करने के लिए `openclaw sandbox explain` का उपयोग करें।
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the “why is this blocked?” mental model.
  Keep it locked down.

## मल्टी-एजेंट ओवरराइड्स

Each agent can override sandbox + tools:
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox tool policy).
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

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
