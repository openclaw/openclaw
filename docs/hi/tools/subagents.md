---
summary: "उप-एजेंट: ऐसे पृथक एजेंट रन उत्पन्न करना जो अनुरोधकर्ता चैट को परिणामों की घोषणा करते हैं"
read_when:
  - आप एजेंट के माध्यम से पृष्ठभूमि/समानांतर कार्य चाहते हैं
  - आप sessions_spawn या उप-एजेंट टूल नीति बदल रहे हैं
title: "उप-एजेंट"
---

# उप-एजेंट

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel.

## स्लैश कमांड

**वर्तमान सत्र** के लिए उप-एजेंट रन का निरीक्षण या नियंत्रण करने हेतु `/subagents` का उपयोग करें:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` रन मेटाडेटा दिखाता है (स्थिति, टाइमस्टैम्प, सत्र आईडी, ट्रांसक्रिप्ट पथ, क्लीनअप)।

मुख्य लक्ष्य:

- मुख्य रन को अवरुद्ध किए बिना “अनुसंधान / लंबे कार्य / धीमे टूल” कार्यों का समानांतर निष्पादन।
- डिफ़ॉल्ट रूप से उप-एजेंट को पृथक रखना (सत्र पृथक्करण + वैकल्पिक sandboxing)।
- टूल सतह को दुरुपयोग से कठिन रखना: उप-एजेंट को डिफ़ॉल्ट रूप से सत्र टूल **नहीं** मिलते।
- नेस्टेड फैन-आउट से बचना: उप-एजेंट उप-एजेंट उत्पन्न नहीं कर सकते।

Cost note: each sub-agent has its **own** context and token usage. For heavy or repetitive
tasks, set a cheaper model for sub-agents and keep your main agent on a higher-quality model.
You can configure this via `agents.defaults.subagents.model` or per-agent overrides.

## टूल

`sessions_spawn` का उपयोग करें:

- एक उप-एजेंट रन प्रारंभ करता है (`deliver: false`, वैश्विक लेन: `subagent`)
- फिर एक घोषणा चरण चलाता है और घोषणा उत्तर को अनुरोधकर्ता चैट चैनल में पोस्ट करता है
- डिफ़ॉल्ट मॉडल: कॉलर से विरासत में मिलता है, जब तक आप `agents.defaults.subagents.model` (या प्रति-एजेंट `agents.list[].subagents.model`) सेट न करें; स्पष्ट `sessions_spawn.model` फिर भी प्रभावी रहता है।
- डिफ़ॉल्ट थिंकिंग: कॉलर से विरासत में मिलता है, जब तक आप `agents.defaults.subagents.thinking` (या प्रति-एजेंट `agents.list[].subagents.thinking`) सेट न करें; स्पष्ट `sessions_spawn.thinking` फिर भी प्रभावी रहता है।

टूल पैरामीटर:

- `task` (आवश्यक)
- `label?` (वैकल्पिक)
- `agentId?` (वैकल्पिक; यदि अनुमति हो तो किसी अन्य एजेंट आईडी के अंतर्गत स्पॉन करें)
- `model?` (वैकल्पिक; उप-एजेंट मॉडल को ओवरराइड करता है; अमान्य मान छोड़े जाते हैं और टूल परिणाम में चेतावनी के साथ उप-एजेंट डिफ़ॉल्ट मॉडल पर चलता है)
- `thinking?` (वैकल्पिक; उप-एजेंट रन के लिए थिंकिंग स्तर ओवरराइड करता है)
- `runTimeoutSeconds?` (डिफ़ॉल्ट `0`; सेट होने पर N सेकंड बाद उप-एजेंट रन निरस्त हो जाता है)
- `cleanup?` (`delete|keep`, डिफ़ॉल्ट `keep`)

अनुमति-सूची (Allowlist):

- `agents.list[].subagents.allowAgents`: list of agent ids that can be targeted via `agentId` (`["*"]` to allow any). Default: only the requester agent.

डिस्कवरी:

- `agents_list` का उपयोग करके देखें कि वर्तमान में `sessions_spawn` के लिए कौन-सी एजेंट आईडी अनुमत हैं।

ऑटो-आर्काइव:

- उप-एजेंट सत्र `agents.defaults.subagents.archiveAfterMinutes` के बाद स्वचालित रूप से आर्काइव हो जाते हैं (डिफ़ॉल्ट: 60)।
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` घोषणा के तुरंत बाद आर्काइव करता है (फिर भी नाम बदलकर ट्रांसक्रिप्ट रखता है)।
- ऑटो-आर्काइव सर्वोत्तम-प्रयास है; गेटवे के पुनः आरंभ होने पर लंबित टाइमर खो जाते हैं।
- `runTimeoutSeconds` does **not** auto-archive; it only stops the run. The session remains until auto-archive.

## प्रमाणीकरण

उप-एजेंट प्रमाणीकरण **एजेंट आईडी** द्वारा हल किया जाता है, सत्र प्रकार द्वारा नहीं:

- उप-एजेंट सत्र कुंजी `agent:<agentId>:subagent:<uuid>` है।
- प्रमाणीकरण स्टोर उस एजेंट के `agentDir` से लोड होता है।
- मुख्य एजेंट की प्रमाणीकरण प्रोफ़ाइल्स को **फ़ॉलबैक** के रूप में मर्ज किया जाता है; टकराव होने पर एजेंट प्रोफ़ाइल्स मुख्य प्रोफ़ाइल्स को ओवरराइड करती हैं।

Note: the merge is additive, so main profiles are always available as fallbacks. Fully isolated auth per agent is not supported yet.

## घोषणा

उप-एजेंट एक घोषणा चरण के माध्यम से रिपोर्ट करते हैं:

- घोषणा चरण उप-एजेंट सत्र के भीतर चलता है (अनुरोधकर्ता सत्र में नहीं)।
- यदि उप-एजेंट ठीक `ANNOUNCE_SKIP` का उत्तर देता है, तो कुछ भी पोस्ट नहीं किया जाता।
- अन्यथा घोषणा उत्तर को अनुरोधकर्ता चैट चैनल में फ़ॉलो-अप `agent` कॉल (`deliver=true`) के माध्यम से पोस्ट किया जाता है।
- उपलब्ध होने पर घोषणा उत्तर थ्रेड/टॉपिक रूटिंग को संरक्षित रखते हैं (Slack थ्रेड्स, Telegram टॉपिक्स, Matrix थ्रेड्स)।
- घोषणा संदेशों को एक स्थिर टेम्पलेट में सामान्यीकृत किया जाता है:
  - `Status:` रन परिणाम से व्युत्पन्न (`success`, `error`, `timeout`, या `unknown`)।
  - `Result:` घोषणा चरण से सारांश सामग्री (या यदि अनुपलब्ध हो तो `(not available)`)।
  - `Notes:` त्रुटि विवरण और अन्य उपयोगी संदर्भ।
- `Status` मॉडल आउटपुट से अनुमानित नहीं किया जाता; यह रनटाइम परिणाम संकेतों से आता है।

घोषणा पेलोड्स के अंत में एक आँकड़े पंक्ति शामिल होती है (रैप होने पर भी):

- रनटाइम (उदा., `runtime 5m12s`)
- टोकन उपयोग (इनपुट/आउटपुट/कुल)
- मॉडल मूल्य निर्धारण विन्यस्त होने पर अनुमानित लागत (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, और ट्रांसक्रिप्ट पथ (ताकि मुख्य एजेंट `sessions_history` के माध्यम से इतिहास प्राप्त कर सके या डिस्क पर फ़ाइल का निरीक्षण कर सके)

## टूल नीति (उप-एजेंट टूल्स)

डिफ़ॉल्ट रूप से, उप-एजेंट को **सत्र टूल्स को छोड़कर सभी टूल्स** मिलते हैं:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

विन्यास के माध्यम से ओवरराइड करें:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## समवर्तीता

उप-एजेंट एक समर्पित इन-प्रोसेस क्यू लेन का उपयोग करते हैं:

- लेन नाम: `subagent`
- समवर्तीता: `agents.defaults.subagents.maxConcurrent` (डिफ़ॉल्ट `8`)

## रोकना

- अनुरोधकर्ता चैट में `/stop` भेजने से अनुरोधकर्ता सत्र निरस्त हो जाता है और उससे उत्पन्न किसी भी सक्रिय उप-एजेंट रन को रोक देता है।

## सीमाएँ

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- उप-एजेंट अभी भी उसी गेटवे प्रक्रिया संसाधनों को साझा करते हैं; `maxConcurrent` को सुरक्षा वाल्व के रूप में मानें।
- `sessions_spawn` हमेशा नॉन-ब्लॉकिंग है: यह तुरंत `{ status: "accepted", runId, childSessionKey }` लौटाता है।
- उप-एजेंट संदर्भ केवल `AGENTS.md` + `TOOLS.md` इंजेक्ट करता है (कोई `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, या `BOOTSTRAP.md` नहीं)।
