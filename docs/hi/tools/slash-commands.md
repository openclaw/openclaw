---
summary: "स्लैश कमांड्स: टेक्स्ट बनाम नेटिव, विन्यास, और समर्थित कमांड"
read_when:
  - चैट कमांड का उपयोग या विन्यास करते समय
  - कमांड रूटिंग या अनुमतियों का डीबग करते समय
title: "स्लैश कमांड्स"
---

# स्लैश कमांड्स

Commands are handled by the Gateway. Most commands must be sent as a **standalone** message that starts with `/`.
The host-only bash chat command uses `! <cmd>` (with `/bash <cmd>` as an alias).

दो संबंधित प्रणालियाँ हैं:

- **Commands**: स्वतंत्र `/...` संदेश।
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`।
  - मॉडल के संदेश देखने से पहले directives को संदेश से हटा दिया जाता है।
  - सामान्य चैट संदेशों में (directive-only नहीं), इन्हें “inline hints” के रूप में माना जाता है और ये सत्र सेटिंग्स को **स्थायी** नहीं करतीं।
  - directive-only संदेशों में (संदेश में केवल directives हों), ये सत्र में स्थायी होती हैं और एक acknowledgement के साथ उत्तर देती हैं।
  - Directives are only applied for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).
    Unauthorized senders see directives treated as plain text.

There are also a few **inline shortcuts** (allowlisted/authorized senders only): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## Config

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (डिफ़ॉल्ट `true`) चैट संदेशों में `/...` के पार्सिंग को सक्षम करता है।
  - जिन सतहों पर नेटिव कमांड नहीं हैं (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), वहाँ इसे `false` पर सेट करने पर भी टेक्स्ट कमांड काम करते हैं।
- `commands.native` (डिफ़ॉल्ट `"auto"`) नेटिव कमांड पंजीकृत करता है।
  - Auto: Discord/Telegram के लिए चालू; Slack के लिए बंद (जब तक आप स्लैश कमांड नहीं जोड़ते); जिन प्रदाताओं में नेटिव सपोर्ट नहीं है, उनके लिए अनदेखा।
  - प्रति-प्रदाता ओवरराइड करने के लिए `channels.discord.commands.native`, `channels.telegram.commands.native`, या `channels.slack.commands.native` सेट करें (bool या `"auto"`)।
  - `false` clears previously registered commands on Discord/Telegram at startup. Slack commands are managed in the Slack app and are not removed automatically.
- `commands.nativeSkills` (डिफ़ॉल्ट `"auto"`) समर्थित होने पर **skill** कमांड को नेटिव रूप से पंजीकृत करता है।
  - Auto: Discord/Telegram के लिए चालू; Slack के लिए बंद (Slack में प्रति-skill एक स्लैश कमांड बनाना आवश्यक है)।
  - प्रति-प्रदाता ओवरराइड के लिए `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, या `channels.slack.commands.nativeSkills` सेट करें (bool या `"auto"`)।
- `commands.bash` (default `false`) enables `! <cmd>` to run host shell commands (`/bash <cmd>` is an alias; requires `tools.elevated` allowlists).
- `commands.bashForegroundMs` (डिफ़ॉल्ट `2000`) यह नियंत्रित करता है कि बैकग्राउंड मोड में स्विच करने से पहले bash कितनी देर प्रतीक्षा करे (`0` तुरंत बैकग्राउंड करता है)।
- `commands.config` (डिफ़ॉल्ट `false`) `/config` को सक्षम करता है (`openclaw.json` पढ़ता/लिखता है)।
- `commands.debug` (डिफ़ॉल्ट `false`) `/debug` को सक्षम करता है (केवल रनटाइम ओवरराइड)।
- `commands.useAccessGroups` (डिफ़ॉल्ट `true`) कमांड के लिए allowlists/नीतियों को लागू करता है।

## Command list

टेक्स्ट + नेटिव (जब सक्षम हो):

- `/help`
- `/commands`
- `/skill <name> [input]` (नाम से एक skill चलाएँ)
- `/status` (वर्तमान स्थिति दिखाएँ; उपलब्ध होने पर वर्तमान मॉडल प्रदाता के लिए प्रदाता उपयोग/कोटा शामिल)
- `/allowlist` (allowlist प्रविष्टियाँ सूचीबद्ध/जोड़ें/हटाएँ)
- `/approve <id> allow-once|allow-always|deny` (exec अनुमोदन प्रॉम्प्ट का समाधान)
- `/context [list|detail|json]` (“context” समझाएँ; `detail` प्रति-फ़ाइल + प्रति-टूल + प्रति-skill + सिस्टम प्रॉम्प्ट आकार दिखाता है)
- `/whoami` (आपका sender id दिखाएँ; उपनाम: `/id`)
- `/subagents list|stop|log|info|send` (वर्तमान सत्र के लिए sub-agent रन का निरीक्षण, रोकें, लॉग देखें, या संदेश भेजें)
- `/config show|get|set|unset` (कॉन्फ़िग को डिस्क पर स्थायी करें, owner-only; `commands.config: true` आवश्यक)
- `/debug show|set|unset|reset` (रनटाइम ओवरराइड, owner-only; `commands.debug: true` आवश्यक)
- `/usage off|tokens|full|cost` (प्रति-उत्तर उपयोग फ़ुटर या स्थानीय लागत सारांश)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS नियंत्रित करें; देखें [/tts](/tts))
  - Discord: नेटिव कमांड `/voice` है (Discord `/tts` आरक्षित करता है); टेक्स्ट `/tts` अब भी काम करता है।
- `/stop`
- `/restart`
- `/dock-telegram` (उपनाम: `/dock_telegram`) (उत्तर Telegram पर स्विच करें)
- `/dock-discord` (उपनाम: `/dock_discord`) (उत्तर Discord पर स्विच करें)
- `/dock-slack` (उपनाम: `/dock_slack`) (उत्तर Slack पर स्विच करें)
- `/activation mention|always` (केवल समूह)
- `/send on|off|inherit` (owner-only)
- `/reset` या `/new [model]` (वैकल्पिक मॉडल संकेत; शेष पाठ आगे भेजा जाता है)
- `/think <off|minimal|low|medium|high|xhigh>` (मॉडल/प्रदाता के अनुसार डायनेमिक विकल्प; उपनाम: `/thinking`, `/t`)
- `/verbose on|full|off` (उपनाम: `/v`)
- `/reasoning on|off|stream` (उपनाम: `/reason`; चालू होने पर `Reasoning:` से प्रीफ़िक्स किया हुआ अलग संदेश भेजता है; `stream` = केवल Telegram ड्राफ्ट)
- `/elevated on|off|ask|full` (उपनाम: `/elev`; `full` exec अनुमोदन छोड़ देता है)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (वर्तमान दिखाने के लिए `/exec` भेजें)
- `/model <name>` (उपनाम: `/models`; या `agents.defaults.models.*.alias` से `/<alias>`)
- `/queue <mode>` (जैसे `debounce:2s cap:25 drop:summarize` जैसे विकल्प; वर्तमान सेटिंग देखने के लिए `/queue` भेजें)
- `/bash <command>` (host-only; alias for `! <command>`; requires `commands.bash: true` + `tools.elevated` allowlists)

केवल टेक्स्ट:

- `/compact [instructions]` (देखें [/concepts/compaction](/concepts/compaction))
- `! <command>` (host-only; one at a time; use `!poll` + `!stop` for long-running jobs)
- `!poll` (आउटपुट/स्थिति जाँचें; वैकल्पिक `sessionId` स्वीकार करता है; `/bash poll` भी काम करता है)
- `!stop` (चल रहे bash जॉब को रोकें; वैकल्पिक `sessionId` स्वीकार करता है; `/bash stop` भी काम करता है)

Notes:

- Commands accept an optional `:` between the command and args (e.g. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` एक मॉडल उपनाम, `provider/model`, या प्रदाता नाम (फ़ज़ी मैच) स्वीकार करता है; यदि कोई मैच न मिले, तो पाठ को संदेश बॉडी माना जाता है।
- पूर्ण प्रदाता उपयोग विवरण के लिए `openclaw status --usage` का उपयोग करें।
- `/allowlist add|remove` के लिए `commands.config=true` आवश्यक है और यह चैनल `configWrites` का सम्मान करता है।
- `/usage` प्रति-उत्तर उपयोग फ़ुटर नियंत्रित करता है; `/usage cost` OpenClaw सत्र लॉग से स्थानीय लागत सारांश प्रिंट करता है।
- `/restart` डिफ़ॉल्ट रूप से अक्षम है; इसे सक्षम करने के लिए `commands.restart: true` सेट करें।
- `/verbose` डीबगिंग और अतिरिक्त दृश्यता के लिए है; सामान्य उपयोग में इसे **बंद** रखें।
- `/reasoning` (and `/verbose`) are risky in group settings: they may reveal internal reasoning or tool output you did not intend to expose. Prefer leaving them off, especially in group chats.
- **Fast path:** allowlisted प्रेषकों से केवल-कमांड संदेश तुरंत संभाले जाते हैं (क्यू + मॉडल को बायपास करते हैं)।
- **Group mention gating:** allowlisted प्रेषकों से केवल-कमांड संदेश में मेंशन आवश्यकताओं को बायपास किया जाता है।
- **Inline shortcuts (केवल allowlisted senders):** कुछ कमांड सामान्य संदेश में एम्बेड होने पर भी काम करते हैं और मॉडल के शेष पाठ देखने से पहले हटा दिए जाते हैं।
  - उदाहरण: `hey /status` एक स्टेटस उत्तर ट्रिगर करता है, और शेष पाठ सामान्य प्रवाह से गुजरता रहता है।
- वर्तमान में: `/help`, `/commands`, `/status`, `/whoami` (`/id`)।
- अनधिकृत केवल-कमांड संदेश चुपचाप अनदेखा कर दिए जाते हैं, और inline `/...` टोकन साधारण पाठ की तरह माने जाते हैं।
- **Skill commands:** `user-invocable` skills are exposed as slash commands. Names are sanitized to `a-z0-9_` (max 32 chars); collisions get numeric suffixes (e.g. `_2`).
  - `/skill <name> [input]` नाम से एक skill चलाता है (जब नेटिव कमांड सीमाएँ प्रति-skill कमांड को रोकती हों, तब उपयोगी)।
  - डिफ़ॉल्ट रूप से, skill कमांड मॉडल को एक सामान्य अनुरोध के रूप में फ़ॉरवर्ड किए जाते हैं।
  - Skills वैकल्पिक रूप से `command-dispatch: tool` घोषित कर सकती हैं ताकि कमांड सीधे किसी टूल पर रूट हो (निर्धारित, बिना मॉडल)।
  - उदाहरण: `/prose` (OpenProse प्लगइन) — देखें [OpenProse](/prose)।
- **Native command arguments:** Discord uses autocomplete for dynamic options (and button menus when you omit required args). Telegram and Slack show a button menu when a command supports choices and you omit the arg.

## Usage surfaces (क्या कहाँ दिखता है)

- **Provider usage/quota** (उदा.: “Claude 80% left”) `/status` में वर्तमान मॉडल प्रदाता के लिए दिखता है, जब उपयोग ट्रैकिंग सक्षम हो।
- **Per-response tokens/cost** को `/usage off|tokens|full` नियंत्रित करता है (सामान्य उत्तरों में जोड़ा जाता है)।
- `/model status` **models/auth/endpoints** के बारे में है, उपयोग के बारे में नहीं।

## Model selection (`/model`)

`/model` को एक directive के रूप में लागू किया गया है।

Examples:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notes:

- `/model` और `/model list` एक संक्षिप्त, क्रमांकित picker दिखाते हैं (मॉडल परिवार + उपलब्ध प्रदाता)।
- `/model <#>` उसी picker से चयन करता है (और संभव होने पर वर्तमान प्रदाता को प्राथमिकता देता है)।
- `/model status` विस्तृत दृश्य दिखाता है, जिसमें विन्यस्त प्रदाता endpoint (`baseUrl`) और API मोड (`api`) शामिल हैं, जब उपलब्ध हों।

## Debug overrides

`/debug` lets you set **runtime-only** config overrides (memory, not disk). Owner-only. Disabled by default; enable with `commands.debug: true`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:

- Overrides नए config reads पर तुरंत लागू होते हैं, लेकिन `openclaw.json` में **लिखे नहीं** जाते।
- सभी overrides साफ़ करने और डिस्क पर मौजूद config पर लौटने के लिए `/debug reset` का उपयोग करें।

## Config updates

`/config` writes to your on-disk config (`openclaw.json`). Owner-only. Disabled by default; enable with `commands.config: true`.

Examples:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notes:

- लिखने से पहले config का सत्यापन किया जाता है; अमान्य बदलाव अस्वीकार कर दिए जाते हैं।
- `/config` अपडेट्स रीस्टार्ट के बाद भी बने रहते हैं।

## Surface notes

- **Text commands** सामान्य चैट सत्र में चलते हैं (DMs `main` साझा करते हैं; समूहों के अपने सत्र होते हैं)।
- **Native commands** अलग-थलग सत्रों का उपयोग करते हैं:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (प्रिफ़िक्स `channels.slack.slashCommand.sessionPrefix` के माध्यम से कॉन्फ़िगर करने योग्य)
  - Telegram: `telegram:slash:<userId>` (`CommandTargetSessionKey` के माध्यम से चैट सत्र को लक्षित करता है)
- **`/stop`** सक्रिय चैट सत्र को लक्षित करता है ताकि वर्तमान रन को abort किया जा सके।
- **Slack:** `channels.slack.slashCommand` is still supported for a single `/openclaw`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`). Command argument menus for Slack are delivered as ephemeral Block Kit buttons.
