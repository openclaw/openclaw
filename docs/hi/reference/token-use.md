---
summary: "OpenClaw प्रॉम्प्ट संदर्भ कैसे बनाता है और टोकन उपयोग + लागत की रिपोर्ट कैसे करता है"
read_when:
  - टोकन उपयोग, लागत, या संदर्भ विंडो समझाते समय
  - संदर्भ वृद्धि या संपीड़न व्यवहार का डिबग करते समय
title: "टोकन उपयोग और लागत"
---

# टोकन उपयोग और लागत

OpenClaw tracks **tokens**, not characters. Tokens are model-specific, but most
OpenAI-style models average ~4 characters per token for English text.

## सिस्टम प्रॉम्प्ट कैसे बनाया जाता है

OpenClaw assembles its own system prompt on every run. It includes:

- टूल सूची + संक्षिप्त विवरण
- Skills सूची (केवल मेटाडेटा; निर्देश आवश्यकता पड़ने पर `read` के साथ लोड होते हैं)
- स्वयं-अपडेट निर्देश
- Workspace + bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` when new). Large files are truncated by `agents.defaults.bootstrapMaxChars` (default: 20000).
- समय (UTC + उपयोगकर्ता समय-क्षेत्र)
- उत्तर टैग + हार्टबीट व्यवहार
- रनटाइम मेटाडेटा (होस्ट/OS/मॉडल/थिंकिंग)

पूर्ण विवरण के लिए [System Prompt](/concepts/system-prompt) देखें।

## संदर्भ विंडो में क्या गिना जाता है

मॉडल को जो भी प्राप्त होता है, वह संदर्भ सीमा में गिना जाता है:

- सिस्टम प्रॉम्प्ट (ऊपर सूचीबद्ध सभी अनुभाग)
- वार्तालाप इतिहास (उपयोगकर्ता + सहायक संदेश)
- टूल कॉल और टूल परिणाम
- संलग्नक/प्रतिलिपियाँ (चित्र, ऑडियो, फ़ाइलें)
- संपीड़न सारांश और प्रूनिंग आर्टिफ़ैक्ट्स
- प्रदाता रैपर या सुरक्षा हेडर (दिखाई नहीं देते, लेकिन फिर भी गिने जाते हैं)

For a practical breakdown (per injected file, tools, skills, and system prompt size), use `/context list` or `/context detail`. See [Context](/concepts/context).

## वर्तमान टोकन उपयोग कैसे देखें

चैट में इनका उपयोग करें:

- `/status` → सत्र मॉडल, संदर्भ उपयोग,
  अंतिम उत्तर के इनपुट/आउटपुट टोकन, और **अनुमानित लागत** (केवल API कुंजी) के साथ **इमोजी‑समृद्ध स्टेटस कार्ड**।
- `/usage off|tokens|full` → हर उत्तर में **प्रति-उत्तर उपयोग फ़ुटर** जोड़ता है।
  - प्रति सत्र स्थायी रहता है ( `responseUsage` के रूप में संग्रहीत)।
  - OAuth प्रमाणीकरण **लागत छुपाता है** (केवल टोकन)।
- `/usage cost` → OpenClaw सत्र लॉग से स्थानीय लागत सारांश दिखाता है।

अन्य सतहें:

- **TUI/Web TUI:** `/status` + `/usage` समर्थित हैं।
- **CLI:** `openclaw status --usage` और `openclaw channels list`
  प्रदाता कोटा विंडो दिखाते हैं (प्रति-उत्तर लागत नहीं)।

## लागत अनुमान (जब दिखाया जाए)

लागत आपके मॉडल मूल्य निर्धारण विन्यास से अनुमानित की जाती है:

```
models.providers.<provider>.models[].cost
```

These are **USD per 1M tokens** for `input`, `output`, `cacheRead`, and
`cacheWrite`. If pricing is missing, OpenClaw shows tokens only. OAuth tokens
never show dollar cost.

## कैश TTL और प्रूनिंग का प्रभाव

Provider prompt caching only applies within the cache TTL window. OpenClaw can
optionally run **cache-ttl pruning**: it prunes the session once the cache TTL
has expired, then resets the cache window so subsequent requests can re-use the
freshly cached context instead of re-caching the full history. This keeps cache
write costs lower when a session goes idle past the TTL.

इसे [Gateway configuration](/gateway/configuration) में विन्यस्त करें और
व्यवहार विवरण [Session pruning](/concepts/session-pruning) में देखें।

Heartbeat can keep the cache **warm** across idle gaps. If your model cache TTL
is `1h`, setting the heartbeat interval just under that (e.g., `55m`) can avoid
re-caching the full prompt, reducing cache write costs.

For Anthropic API pricing, cache reads are significantly cheaper than input
tokens, while cache writes are billed at a higher multiplier. See Anthropic’s
prompt caching pricing for the latest rates and TTL multipliers:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### उदाहरण: हार्टबीट के साथ 1h कैश warm रखें

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## टोकन दबाव कम करने के सुझाव

- लंबे सत्रों का सारांश बनाने के लिए `/compact` का उपयोग करें।
- अपने वर्कफ़्लो में बड़े टूल आउटपुट ट्रिम करें।
- Skill विवरण छोटे रखें (Skill सूची प्रॉम्प्ट में इंजेक्ट होती है)।
- विस्तृत, अन्वेषणात्मक कार्य के लिए छोटे मॉडलों को प्राथमिकता दें।

सटीक Skill सूची ओवरहेड सूत्र के लिए [Skills](/tools/skills) देखें।
