---
summary: "Skills: प्रबंधित बनाम वर्कस्पेस, गेटिंग नियम, और कॉन्फ़िग/एनवायरनमेंट वायरिंग"
read_when:
  - Skills जोड़ते या संशोधित करते समय
  - Skill गेटिंग या लोड नियम बदलते समय
title: "Skills"
x-i18n:
  source_path: tools/skills.md
  source_hash: 70d7eb9e422c17a4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:22Z
---

# Skills (OpenClaw)

OpenClaw **[AgentSkills](https://agentskills.io)-संगत** skill फ़ोल्डरों का उपयोग करता है ताकि एजेंट को टूल्स का उपयोग सिखाया जा सके। प्रत्येक skill एक डायरेक्टरी होती है जिसमें YAML फ्रंटमैटर और निर्देशों के साथ एक `SKILL.md` होता है। OpenClaw **bundled skills** के साथ वैकल्पिक लोकल ओवरराइड्स लोड करता है, और वातावरण, विन्यास, तथा बाइनरी की उपलब्धता के आधार पर लोड समय पर उन्हें फ़िल्टर करता है।

## Locations and precedence

Skills **तीन** स्थानों से लोड होती हैं:

1. **Bundled skills**: इंस्टॉलेशन के साथ शिप की जाती हैं (npm पैकेज या OpenClaw.app)
2. **Managed/local skills**: `~/.openclaw/skills`
3. **Workspace skills**: `<workspace>/skills`

यदि किसी skill नाम में टकराव होता है, तो प्राथमिकता क्रम इस प्रकार है:

`<workspace>/skills` (उच्चतम) → `~/.openclaw/skills` → bundled skills (न्यूनतम)

इसके अतिरिक्त, आप अतिरिक्त skill फ़ोल्डर (न्यूनतम प्राथमिकता) कॉन्फ़िगर कर सकते हैं
`skills.load.extraDirs` के माध्यम से, `~/.openclaw/openclaw.json` में।

## Per-agent vs shared skills

**मल्टी-एजेंट** सेटअप में, प्रत्येक एजेंट का अपना वर्कस्पेस होता है। इसका अर्थ है:

- **Per-agent skills** केवल उस एजेंट के लिए `<workspace>/skills` में रहती हैं।
- **Shared skills** `~/.openclaw/skills` (managed/local) में रहती हैं और उसी मशीन पर
  **सभी एजेंट्स** को दिखाई देती हैं।
- **Shared folders** को `skills.load.extraDirs` के माध्यम से भी जोड़ा जा सकता है (न्यूनतम
  प्राथमिकता) यदि आप कई एजेंट्स द्वारा उपयोग किया जाने वाला एक सामान्य skills पैक चाहते हैं।

यदि एक ही skill नाम एक से अधिक स्थानों पर मौजूद है, तो सामान्य प्राथमिकता लागू होती है:
वर्कस्पेस जीतता है, फिर managed/local, फिर bundled।

## Plugins + skills

Plugins अपने स्वयं के skills शिप कर सकते हैं, इसके लिए वे `skills` डायरेक्टरियों को
`openclaw.plugin.json` में सूचीबद्ध करते हैं (प्लगइन रूट के सापेक्ष पथ)। प्लगइन skills तब लोड होती हैं
जब प्लगइन सक्षम हो और सामान्य skill प्राथमिकता नियमों में भाग लेती हैं।
आप उन्हें प्लगइन की कॉन्फ़िग प्रविष्टि पर `metadata.openclaw.requires.config` के माध्यम से गेट कर सकते हैं।
डिस्कवरी/कॉन्फ़िग के लिए [Plugins](/tools/plugin) और उन टूल्स के लिए [Tools](/tools) देखें
जिन्हें ये skills सिखाती हैं।

## ClawHub (install + sync)

ClawHub OpenClaw के लिए सार्वजनिक skills रजिस्ट्री है। यहाँ ब्राउज़ करें:
[https://clawhub.com](https://clawhub.com)। इसका उपयोग skills खोजने, इंस्टॉल करने,
अपडेट करने और बैकअप लेने के लिए करें।
पूर्ण मार्गदर्शिका: [ClawHub](/tools/clawhub)।

सामान्य प्रवाह:

- किसी skill को अपने वर्कस्पेस में इंस्टॉल करें:
  - `clawhub install <skill-slug>`
- सभी इंस्टॉल की गई skills अपडेट करें:
  - `clawhub update --all`
- Sync (स्कैन + अपडेट प्रकाशित करें):
  - `clawhub sync --all`

डिफ़ॉल्ट रूप से, `clawhub` आपके वर्तमान वर्किंग डायरेक्टरी के अंतर्गत
`./skills` में इंस्टॉल करता है (या कॉन्फ़िगर किए गए OpenClaw वर्कस्पेस पर वापस जाता है)।
OpenClaw इसे अगली सत्र में `<workspace>/skills` के रूप में पहचान लेता है।

## Security notes

- तृतीय-पक्ष skills को **अविश्वसनीय कोड** मानें। सक्षम करने से पहले उन्हें पढ़ें।
- अविश्वसनीय इनपुट और जोखिम भरे टूल्स के लिए sandboxed रन को प्राथमिकता दें।
  देखें [Sandboxing](/gateway/sandboxing)।
- `skills.entries.*.env` और `skills.entries.*.apiKey` उस एजेंट टर्न के लिए **host** प्रक्रिया में
  सीक्रेट्स इंजेक्ट करते हैं (sandbox में नहीं)। सीक्रेट्स को प्रॉम्प्ट्स और लॉग्स से दूर रखें।
- व्यापक थ्रेट मॉडल और चेकलिस्ट्स के लिए [Security](/gateway/security) देखें।

## Format (AgentSkills + Pi-compatible)

`SKILL.md` में कम से कम यह शामिल होना चाहिए:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notes:

- हम लेआउट/इरादे के लिए AgentSkills स्पेसिफ़िकेशन का पालन करते हैं।
- एम्बेडेड एजेंट द्वारा उपयोग किया गया पार्सर केवल **single-line** फ्रंटमैटर कुंजियों का समर्थन करता है।
- `metadata` एक **single-line JSON object** होना चाहिए।
- निर्देशों में skill फ़ोल्डर पथ को संदर्भित करने के लिए `{baseDir}` का उपयोग करें।
- वैकल्पिक फ्रंटमैटर कुंजियाँ:
  - `homepage` — macOS Skills UI में “Website” के रूप में प्रदर्शित URL ( `metadata.openclaw.homepage` के माध्यम से भी समर्थित)।
  - `user-invocable` — `true|false` (डिफ़ॉल्ट: `true`)। जब `true` हो, तो skill उपयोगकर्ता स्लैश कमांड के रूप में उजागर होती है।
  - `disable-model-invocation` — `true|false` (डिफ़ॉल्ट: `false`)। जब `true` हो, तो skill को मॉडल प्रॉम्प्ट से बाहर रखा जाता है (फिर भी उपयोगकर्ता इनवोकेशन के माध्यम से उपलब्ध)।
  - `command-dispatch` — `tool` (वैकल्पिक)। जब `tool` पर सेट हो, तो स्लैश कमांड मॉडल को बायपास कर सीधे किसी टूल को डिस्पैच करता है।
  - `command-tool` — जब `command-dispatch: tool` सेट हो, तब इनवोक किया जाने वाला टूल नाम।
  - `command-arg-mode` — `raw` (डिफ़ॉल्ट)। टूल डिस्पैच के लिए, कच्ची args स्ट्रिंग को टूल तक फ़ॉरवर्ड करता है (कोई कोर पार्सिंग नहीं)।

    टूल को इन पैरामीटर्स के साथ इनवोक किया जाता है:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`।

## Gating (load-time filters)

OpenClaw **लोड समय पर skills को फ़िल्टर करता है** `metadata` का उपयोग करके (single-line JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

`metadata.openclaw` के अंतर्गत फ़ील्ड्स:

- `always: true` — skill को हमेशा शामिल करें (अन्य गेट्स को स्किप करें)।
- `emoji` — macOS Skills UI द्वारा उपयोग किया जाने वाला वैकल्पिक इमोजी।
- `homepage` — macOS Skills UI में “Website” के रूप में दिखाया जाने वाला वैकल्पिक URL।
- `os` — प्लेटफ़ॉर्म्स की वैकल्पिक सूची (`darwin`, `linux`, `win32`)। यदि सेट हो, तो skill केवल उन्हीं OSes पर योग्य होती है।
- `requires.bins` — सूची; प्रत्येक `PATH` पर मौजूद होना चाहिए।
- `requires.anyBins` — सूची; कम से कम एक `PATH` पर मौजूद होना चाहिए।
- `requires.env` — सूची; env var मौजूद होना चाहिए **या** कॉन्फ़िग में प्रदान किया जाना चाहिए।
- `requires.config` — `openclaw.json` पथों की सूची जो truthy होने चाहिए।
- `primaryEnv` — `skills.entries.<name>.apiKey` से संबद्ध env var नाम।
- `install` — macOS Skills UI द्वारा उपयोग किए जाने वाले installer specs की वैकल्पिक array (brew/node/go/uv/download)।

Sandboxing पर नोट:

- `requires.bins` को skill लोड समय पर **host** पर जाँचा जाता है।
- यदि कोई एजेंट sandboxed है, तो बाइनरी **कंटेनर के अंदर** भी मौजूद होनी चाहिए।
  इसे `agents.defaults.sandbox.docker.setupCommand` (या किसी कस्टम इमेज) के माध्यम से इंस्टॉल करें।
  `setupCommand` कंटेनर बनने के बाद एक बार चलता है।
  पैकेज इंस्टॉलेशन के लिए नेटवर्क egress, writable root FS, और sandbox में root उपयोगकर्ता की भी आवश्यकता होती है।
  उदाहरण: `summarize` skill (`skills/summarize/SKILL.md`) को वहाँ चलने के लिए sandbox कंटेनर में
  `summarize` CLI की आवश्यकता होती है।

Installer उदाहरण:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notes:

- यदि कई installers सूचीबद्ध हैं, तो Gateway **एकल** पसंदीदा विकल्प चुनता है (उपलब्ध होने पर brew, अन्यथा node)।
- यदि सभी installers `download` हैं, तो OpenClaw प्रत्येक प्रविष्टि सूचीबद्ध करता है ताकि आप उपलब्ध आर्टिफ़ैक्ट्स देख सकें।
- Installer specs में प्लेटफ़ॉर्म के अनुसार विकल्प फ़िल्टर करने के लिए `os: ["darwin"|"linux"|"win32"]` शामिल हो सकता है।
- Node इंस्टॉल्स `openclaw.json` में `skills.install.nodeManager` का सम्मान करते हैं (डिफ़ॉल्ट: npm; विकल्प: npm/pnpm/yarn/bun)।
  यह केवल **skill installs** को प्रभावित करता है; Gateway runtime फिर भी Node होना चाहिए
  (WhatsApp/Telegram के लिए Bun की अनुशंसा नहीं की जाती)।
- Go इंस्टॉल्स: यदि `go` अनुपस्थित है और `brew` उपलब्ध है, तो Gateway पहले Homebrew के माध्यम से Go इंस्टॉल करता है और संभव होने पर `GOBIN` को Homebrew के `bin` पर सेट करता है।
- Download इंस्टॉल्स: `url` (आवश्यक), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (डिफ़ॉल्ट: आर्काइव मिलने पर auto), `stripComponents`, `targetDir` (डिफ़ॉल्ट: `~/.openclaw/tools/<skillKey>`)।

यदि कोई `metadata.openclaw` मौजूद नहीं है, तो skill हमेशा योग्य होती है
(जब तक कि कॉन्फ़िग में अक्षम न की गई हो या bundled skills के लिए `skills.allowBundled` द्वारा ब्लॉक न की गई हो)।

## Config overrides (`~/.openclaw/openclaw.json`)

Bundled/managed skills को टॉगल किया जा सकता है और उन्हें env मान प्रदान किए जा सकते हैं:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Note: यदि skill नाम में हाइफ़न हों, तो कुंजी को कोट करें (JSON5 कोटेड कुंजियों की अनुमति देता है)।

Config कुंजियाँ डिफ़ॉल्ट रूप से **skill name** से मेल खाती हैं। यदि कोई skill
`metadata.openclaw.skillKey` परिभाषित करती है, तो `skills.entries` के अंतर्गत उसी कुंजी का उपयोग करें।

Rules:

- `enabled: false` skill को अक्षम करता है, भले ही वह bundled/installed हो।
- `env`: **केवल तभी** इंजेक्ट किया जाता है जब वैरिएबल पहले से प्रक्रिया में सेट न हो।
- `apiKey`: उन skills के लिए सुविधा जो `metadata.openclaw.primaryEnv` घोषित करती हैं।
- `config`: कस्टम प्रति-skill फ़ील्ड्स के लिए वैकल्पिक बैग; कस्टम कुंजियाँ यहीं होनी चाहिए।
- `allowBundled`: केवल **bundled** skills के लिए वैकल्पिक allowlist। यदि सेट हो, तो सूची में शामिल bundled skills ही योग्य होंगी (managed/workspace skills अप्रभावित)।

## Environment injection (per agent run)

जब कोई एजेंट रन शुरू होता है, OpenClaw:

1. skill मेटाडेटा पढ़ता है।
2. किसी भी `skills.entries.<key>.env` या `skills.entries.<key>.apiKey` को
   `process.env` पर लागू करता है।
3. **योग्य** skills के साथ सिस्टम प्रॉम्प्ट बनाता है।
4. रन समाप्त होने के बाद मूल environment को पुनर्स्थापित करता है।

यह **एजेंट रन तक सीमित** है, किसी वैश्विक शेल environment तक नहीं।

## Session snapshot (performance)

OpenClaw **सत्र शुरू होने पर** योग्य skills का स्नैपशॉट लेता है और उसी सत्र में बाद के टर्न्स के लिए उसी सूची का पुनः उपयोग करता है। Skills या कॉन्फ़िग में किए गए परिवर्तन अगले नए सत्र में प्रभावी होते हैं।

Skills मिड-सेशन भी रिफ़्रेश हो सकती हैं जब skills watcher सक्षम हो या जब कोई नया योग्य रिमोट नोड दिखाई दे (नीचे देखें)। इसे **हॉट रीलोड** के रूप में समझें: रिफ़्रेश की गई सूची अगले एजेंट टर्न पर लागू होती है।

## Remote macOS nodes (Linux gateway)

यदि Gateway Linux पर चल रहा है लेकिन एक **macOS node** कनेक्टेड है **और `system.run` की अनुमति है**
(Exec approvals सुरक्षा `deny` पर सेट नहीं है), तो OpenClaw macOS-केवल skills को योग्य मान सकता है
जब आवश्यक बाइनरी उस नोड पर मौजूद हों। एजेंट को उन skills को
`nodes` टूल (आमतौर पर `nodes.run`) के माध्यम से निष्पादित करना चाहिए।

यह नोड द्वारा उसके कमांड सपोर्ट की रिपोर्टिंग और `system.run` के माध्यम से bin probe पर निर्भर करता है।
यदि macOS नोड बाद में ऑफ़लाइन हो जाता है, तो skills दिखाई देती रहती हैं; इनवोकेशन विफल हो सकते हैं जब तक नोड पुनः कनेक्ट न हो जाए।

## Skills watcher (auto-refresh)

डिफ़ॉल्ट रूप से, OpenClaw skill फ़ोल्डरों को मॉनिटर करता है और जब `SKILL.md` फ़ाइलें बदलती हैं तो skills स्नैपशॉट को बढ़ाता/अपडेट करता है। इसे `skills.load` के अंतर्गत कॉन्फ़िगर करें:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Token impact (skills list)

जब skills योग्य होती हैं, OpenClaw सिस्टम प्रॉम्प्ट में उपलब्ध skills की एक संक्षिप्त XML सूची इंजेक्ट करता है
(`pi-coding-agent` में `formatSkillsForPrompt` के माध्यम से)। लागत निर्धारक है:

- **Base overhead (केवल जब ≥1 skill):** 195 अक्षर।
- **प्रति skill:** 97 अक्षर + XML-escaped `<name>`, `<description>`, और `<location>` मानों की लंबाई।

सूत्र (अक्षरों में):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes:

- XML escaping `& < > " '` को entities (`&amp;`, `&lt;`, आदि) में विस्तारित करता है, जिससे लंबाई बढ़ती है।
- टोकन गिनती मॉडल tokenizer के अनुसार बदलती है। एक मोटा OpenAI-शैली अनुमान ~4 chars/token है, इसलिए **97 chars ≈ 24 tokens** प्रति skill, साथ में आपके वास्तविक फ़ील्ड की लंबाइयाँ।

## Managed skills lifecycle

OpenClaw इंस्टॉलेशन (npm पैकेज या OpenClaw.app) के हिस्से के रूप में **bundled skills** का एक बेसलाइन सेट शिप करता है।
`~/.openclaw/skills` लोकल ओवरराइड्स के लिए मौजूद है (उदाहरण के लिए, bundled कॉपी बदले बिना किसी skill को पिन/पैच करना)।
Workspace skills उपयोगकर्ता-स्वामित्व वाली होती हैं और नाम टकराव पर दोनों को ओवरराइड करती हैं।

## Config reference

पूर्ण कॉन्फ़िगरेशन स्कीमा के लिए [Skills config](/tools/skills-config) देखें।

## Looking for more skills?

[https://clawhub.com](https://clawhub.com) ब्राउज़ करें।

---
