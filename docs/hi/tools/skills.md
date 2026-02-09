---
summary: "Skills: प्रबंधित बनाम वर्कस्पेस, गेटिंग नियम, और कॉन्फ़िग/एनवायरनमेंट वायरिंग"
read_when:
  - Skills जोड़ते या संशोधित करते समय
  - Skill गेटिंग या लोड नियम बदलते समय
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw एजेंट को टूल्स का उपयोग सिखाने के लिए **[AgentSkills](https://agentskills.io)-compatible** स्किल फ़ोल्डर्स का उपयोग करता है। प्रत्येक स्किल एक डायरेक्टरी होती है जिसमें YAML फ्रंटमैटर और निर्देशों के साथ एक `SKILL.md` होता है। OpenClaw **बंडल्ड स्किल्स** के साथ वैकल्पिक लोकल ओवरराइड्स लोड करता है, और वातावरण, कॉन्फ़िग, और बाइनरी की उपलब्धता के आधार पर लोड समय पर उन्हें फ़िल्टर करता है।

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

**मल्टी-एजेंट** सेटअप्स में, प्रत्येक एजेंट का अपना वर्कस्पेस होता है। इसका अर्थ है:

- **Per-agent skills** केवल उस एजेंट के लिए `<workspace>/skills` में रहती हैं।
- **Shared skills** `~/.openclaw/skills` (managed/local) में रहती हैं और उसी मशीन पर
  **सभी एजेंट्स** को दिखाई देती हैं।
- **Shared folders** को `skills.load.extraDirs` के माध्यम से भी जोड़ा जा सकता है (न्यूनतम
  प्राथमिकता) यदि आप कई एजेंट्स द्वारा उपयोग किया जाने वाला एक सामान्य skills पैक चाहते हैं।

यदि एक ही skill नाम एक से अधिक स्थानों पर मौजूद है, तो सामान्य प्राथमिकता लागू होती है:
वर्कस्पेस जीतता है, फिर managed/local, फिर bundled।

## Plugins + skills

प्लगइन्स अपने स्वयं के स्किल्स शिप कर सकते हैं, इसके लिए
`openclaw.plugin.json` में `skills` डायरेक्टरीज़ सूचीबद्ध करें (प्लगइन रूट के सापेक्ष पथ)। प्लगइन स्किल्स
प्लगइन सक्षम होने पर लोड होती हैं और सामान्य स्किल प्रीसिडेंस नियमों में भाग लेती हैं।
आप उन्हें प्लगइन के कॉन्फ़िग एंट्री पर `metadata.openclaw.requires.config` के माध्यम से गेट कर सकते हैं। डिस्कवरी/कॉन्फ़िग के लिए [Plugins](/tools/plugin) और उन टूल्स की सतह के लिए [Tools](/tools) देखें जिन्हें ये स्किल्स सिखाती हैं।

## ClawHub (install + sync)

ClawHub, OpenClaw के लिए सार्वजनिक स्किल्स रजिस्ट्री है। यहाँ ब्राउज़ करें
[https://clawhub.com](https://clawhub.com)। इसे स्किल्स खोजने, इंस्टॉल करने, अपडेट करने और बैकअप लेने के लिए उपयोग करें।
पूर्ण गाइड: [ClawHub](/tools/clawhub)।

सामान्य प्रवाह:

- किसी skill को अपने वर्कस्पेस में इंस्टॉल करें:
  - `clawhub install <skill-slug>`
- सभी इंस्टॉल की गई skills अपडेट करें:
  - `clawhub update --all`
- Sync (स्कैन + अपडेट प्रकाशित करें):
  - `clawhub sync --all`

डिफ़ॉल्ट रूप से, `clawhub` आपकी वर्तमान वर्किंग
डायरेक्टरी के अंतर्गत `./skills` में इंस्टॉल करता है (या कॉन्फ़िगर किए गए OpenClaw वर्कस्पेस पर फ़ॉलबैक करता है)। अगले सेशन में OpenClaw
इसे `<workspace>/skills` के रूप में पहचान लेता है।

## Security notes

- थर्ड-पार्टी स्किल्स को **अविश्वसनीय कोड** के रूप में मानें। सक्षम करने से पहले उन्हें पढ़ें।
- अविश्वसनीय इनपुट्स और जोखिमपूर्ण टूल्स के लिए सैंडबॉक्स्ड रन को प्राथमिकता दें। [Sandboxing](/gateway/sandboxing) देखें।
- `skills.entries.*.env` और `skills.entries.*.apiKey` सीक्रेट्स को **होस्ट** प्रोसेस में
  उस एजेंट टर्न के लिए इंजेक्ट करते हैं (सैंडबॉक्स में नहीं)। सीक्रेट्स को प्रॉम्प्ट्स और लॉग्स से बाहर रखें।
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
  - `user-invocable` — `true|false` (डिफ़ॉल्ट: `true`)। जब `true` हो, तो स्किल को यूज़र स्लैश कमांड के रूप में एक्सपोज़ किया जाता है।
  - `disable-model-invocation` — `true|false` (डिफ़ॉल्ट: `false`)। जब `true` हो, तो स्किल को मॉडल प्रॉम्प्ट से बाहर रखा जाता है (फिर भी यूज़र इन्वोकेशन के माध्यम से उपलब्ध रहती है)।
  - `command-dispatch` — `tool` (वैकल्पिक)। जब `tool` पर सेट किया जाता है, तो स्लैश कमांड मॉडल को बायपास करता है और सीधे किसी टूल को डिस्पैच करता है।
  - `command-tool` — जब `command-dispatch: tool` सेट हो, तब इनवोक किया जाने वाला टूल नाम।
  - `command-arg-mode` — `raw` (डिफ़ॉल्ट)। टूल डिस्पैच के लिए, रॉ args स्ट्रिंग को टूल तक फ़ॉरवर्ड करता है (कोई कोर पार्सिंग नहीं)।

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
- `os` — प्लेटफ़ॉर्म्स की वैकल्पिक सूची (`darwin`, `linux`, `win32`)। यदि सेट किया गया हो, तो स्किल केवल उन्हीं OSes पर पात्र होती है।
- `requires.bins` — सूची; प्रत्येक `PATH` पर मौजूद होना चाहिए।
- `requires.anyBins` — सूची; कम से कम एक `PATH` पर मौजूद होना चाहिए।
- `requires.env` — सूची; env var मौजूद होना चाहिए **या** कॉन्फ़िग में प्रदान किया जाना चाहिए।
- `requires.config` — `openclaw.json` पथों की सूची जो truthy होने चाहिए।
- `primaryEnv` — `skills.entries.<name>` से संबद्ध env var नाम.apiKey\`।
- `install` — macOS Skills UI द्वारा उपयोग किए जाने वाले installer specs की वैकल्पिक array (brew/node/go/uv/download)।

Sandboxing पर नोट:

- `requires.bins` को skill लोड समय पर **host** पर जाँचा जाता है।
- यदि कोई एजेंट सैंडबॉक्स्ड है, तो बाइनरी को **कंटेनर के अंदर भी** मौजूद होना चाहिए।
  इसे `agents.defaults.sandbox.docker.setupCommand` (या किसी कस्टम इमेज) के माध्यम से इंस्टॉल करें।
  `setupCommand` कंटेनर बनने के बाद एक बार चलता है।
  Package installs also require network egress, a writable root FS, and a root user in the sandbox.
  Example: the `summarize` skill (`skills/summarize/SKILL.md`) needs the `summarize` CLI
  in the sandbox container to run there.

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
- Node installs honor `skills.install.nodeManager` in `openclaw.json` (default: npm; options: npm/pnpm/yarn/bun).
  This only affects **skill installs**; the Gateway runtime should still be Node
  (Bun is not recommended for WhatsApp/Telegram).
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

Config keys match the **skill name** by default. If a skill defines
`metadata.openclaw.skillKey`, use that key under `skills.entries`.

Rules:

- `enabled: false` skill को अक्षम करता है, भले ही वह bundled/installed हो।
- `env`: **केवल तभी** इंजेक्ट किया जाता है जब वैरिएबल पहले से प्रक्रिया में सेट न हो।
- `apiKey`: उन skills के लिए सुविधा जो `metadata.openclaw.primaryEnv` घोषित करती हैं।
- `config`: कस्टम प्रति-skill फ़ील्ड्स के लिए वैकल्पिक बैग; कस्टम कुंजियाँ यहीं होनी चाहिए।
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only
  bundled skills in the list are eligible (managed/workspace skills unaffected).

## Environment injection (per agent run)

जब कोई एजेंट रन शुरू होता है, OpenClaw:

1. skill मेटाडेटा पढ़ता है।
2. Applies any `skills.entries.<key>.env` or `skills.entries.<key>.apiKey` to
   `process.env`.
3. **योग्य** skills के साथ सिस्टम प्रॉम्प्ट बनाता है।
4. रन समाप्त होने के बाद मूल environment को पुनर्स्थापित करता है।

यह **एजेंट रन तक सीमित** है, किसी वैश्विक शेल environment तक नहीं।

## Session snapshot (performance)

OpenClaw snapshots the eligible skills **when a session starts** and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.

Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a **hot reload**: the refreshed list is picked up on the next agent turn.

## Remote macOS nodes (Linux gateway)

If the Gateway is running on Linux but a **macOS node** is connected **with `system.run` allowed** (Exec approvals security not set to `deny`), OpenClaw can treat macOS-only skills as eligible when the required binaries are present on that node. The agent should execute those skills via the `nodes` tool (typically `nodes.run`).

This relies on the node reporting its command support and on a bin probe via `system.run`. If the macOS node goes offline later, the skills remain visible; invocations may fail until the node reconnects.

## Skills watcher (auto-refresh)

By default, OpenClaw watches skill folders and bumps the skills snapshot when `SKILL.md` files change. Configure this under `skills.load`:

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

When skills are eligible, OpenClaw injects a compact XML list of available skills into the system prompt (via `formatSkillsForPrompt` in `pi-coding-agent`). The cost is deterministic:

- **Base overhead (केवल जब ≥1 skill):** 195 अक्षर।
- **प्रति skill:** 97 अक्षर + XML-escaped `<name>`, `<description>`, और `<location>` मानों की लंबाई।

सूत्र (अक्षरों में):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notes:

- XML escaping `& < > " '` को entities (`&amp;`, `&lt;`, आदि) में विस्तारित करता है, जिससे लंबाई बढ़ती है।
- Token counts vary by model tokenizer. A rough OpenAI-style estimate is ~4 chars/token, so **97 chars ≈ 24 tokens** per skill plus your actual field lengths.

## Managed skills lifecycle

OpenClaw ships a baseline set of skills as **bundled skills** as part of the
install (npm package or OpenClaw.app). `~/.openclaw/skills` exists for local
overrides (for example, pinning/patching a skill without changing the bundled
copy). Workspace skills are user-owned and override both on name conflicts.

## Config reference

पूर्ण कॉन्फ़िगरेशन स्कीमा के लिए [Skills config](/tools/skills-config) देखें।

## Looking for more skills?

[https://clawhub.com](https://clawhub.com) ब्राउज़ करें।

---
