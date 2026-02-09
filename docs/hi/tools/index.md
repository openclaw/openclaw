---
summary: "OpenClaw के लिए एजेंट टूल सतह (browser, canvas, nodes, message, cron), जो पुराने `openclaw-*` skills का स्थान लेती है"
read_when:
  - एजेंट टूल जोड़ते या संशोधित करते समय
  - "`openclaw-*` skills को सेवानिवृत्त या बदलते समय"
title: "Tools"
---

# Tools (OpenClaw)

OpenClaw ब्राउज़र, कैनवास, नोड्स और क्रॉन के लिए **फर्स्ट-क्लास एजेंट टूल्स** प्रदान करता है।
ये पुराने `openclaw-*` स्किल्स को बदलते हैं: टूल्स टाइप्ड हैं, कोई शेलिंग नहीं है, और एजेंट को सीधे उन पर निर्भर होना चाहिए।

## Tools को अक्षम करना

आप `openclaw.json` में `tools.allow` / `tools.deny` के माध्यम से टूल्स को वैश्विक रूप से अनुमति/अस्वीकृत कर सकते हैं (deny को प्राथमिकता मिलती है)। यह अस्वीकृत टूल्स को मॉडल प्रदाताओं तक भेजे जाने से रोकता है।

```json5
{
  tools: { deny: ["browser"] },
}
```

टिप्पणियाँ:

- मिलान case-insensitive है।
- `*` wildcards समर्थित हैं (`"*"` का अर्थ सभी टूल्स)।
- यदि `tools.allow` केवल अज्ञात या अनलोडेड plugin टूल नामों को संदर्भित करता है, तो OpenClaw चेतावनी लॉग करता है और allowlist को अनदेखा करता है ताकि core tools उपलब्ध रहें।

## Tool profiles (base allowlist)

`tools.profile`, `tools.allow`/`tools.deny` से पहले एक **बेस टूल अलाउलिस्ट** सेट करता है।
प्रति-एजेंट ओवरराइड: `agents.list[].tools.profile`।

Profiles:

- `minimal`: केवल `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: कोई प्रतिबंध नहीं (unset के समान)

उदाहरण (डिफ़ॉल्ट रूप से केवल messaging, साथ में Slack + Discord टूल्स की अनुमति):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

उदाहरण (coding प्रोफ़ाइल, लेकिन exec/process को हर जगह deny):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

उदाहरण (वैश्विक coding प्रोफ़ाइल, messaging-only support एजेंट):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Provider-specific tool policy

अपने वैश्विक डिफ़ॉल्ट बदले बिना विशिष्ट प्रदाताओं (या किसी एक `provider/model`) के लिए टूल्स को **और अधिक सीमित** करने हेतु `tools.byProvider` का उपयोग करें।
प्रति-एजेंट ओवरराइड: `agents.list[].tools.byProvider`।

यह बेस टूल प्रोफ़ाइल के **बाद** और allow/deny सूचियों के **पहले** लागू होता है, इसलिए यह केवल टूल सेट को संकुचित कर सकता है।
प्रोवाइडर कीज़ `provider` (उदाहरण: `google-antigravity`) या `provider/model` (उदाहरण: `openai/gpt-5.2`) दोनों स्वीकार करती हैं।

उदाहरण (वैश्विक coding प्रोफ़ाइल रखें, लेकिन Google Antigravity के लिए न्यूनतम टूल्स):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

उदाहरण (अस्थिर endpoint के लिए provider/model-विशिष्ट allowlist):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

उदाहरण (एकल provider के लिए agent-विशिष्ट ओवरराइड):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Tool groups (shorthands)

टूल नीतियाँ (ग्लोबल, एजेंट, सैंडबॉक्स) `group:*` एंट्रीज़ का समर्थन करती हैं जो कई टूल्स में विस्तारित होती हैं।
इनका उपयोग `tools.allow` / `tools.deny` में करें।

उपलब्ध groups:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: सभी अंतर्निहित OpenClaw टूल्स (provider plugins को छोड़कर)

उदाहरण (केवल file tools + browser की अनुमति):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + tools

प्लगइन्स कोर सेट से आगे **अतिरिक्त टूल्स** (और CLI कमांड्स) रजिस्टर कर सकते हैं।
इंस्टॉल + कॉन्फ़िग के लिए [Plugins](/tools/plugin) देखें, और यह जानने के लिए कि टूल उपयोग मार्गदर्शन प्रॉम्प्ट्स में कैसे डाला जाता है, [Skills](/tools/skills) देखें। कुछ प्लगइन्स टूल्स के साथ-साथ अपनी स्वयं की स्किल्स भी प्रदान करते हैं (उदाहरण के लिए, वॉइस-कॉल प्लगइन)।

वैकल्पिक plugin tools:

- [Lobster](/tools/lobster): resumable approvals के साथ typed workflow runtime (Gateway होस्ट पर Lobster CLI आवश्यक)।
- [LLM Task](/tools/llm-task): structured workflow output के लिए JSON-only LLM step (वैकल्पिक schema validation)।

## Tool inventory

### `apply_patch`

एक या अधिक फ़ाइलों में संरचित पैच लागू करें। मल्टी-हंक एडिट्स के लिए उपयोग करें।
प्रायोगिक: `tools.exec.applyPatch.enabled` के माध्यम से सक्षम करें (केवल OpenAI मॉडल्स)।

### `exec`

workspace में shell commands चलाएँ।

Core parameters:

- `command` (required)
- `yieldMs` (timeout के बाद auto-background, default 10000)
- `background` (तुरंत background)
- `timeout` (seconds; सीमा पार होने पर process kill, default 1800)
- `elevated` (bool; यदि elevated mode सक्षम/अनुमत है तो host पर चलाएँ; केवल तब व्यवहार बदलता है जब एजेंट sandboxed हो)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (`host=node` के लिए node id/name)
- क्या आपको एक वास्तविक TTY चाहिए? `pty: true` सेट करें।

टिप्पणियाँ:

- background होने पर `sessionId` के साथ `status: "running"` लौटाता है।
- background sessions को poll/log/write/kill/clear करने के लिए `process` का उपयोग करें।
- यदि `process` निषिद्ध है, तो `exec` synchronous रूप से चलता है और `yieldMs`/`background` को अनदेखा करता है।
- `elevated` को `tools.elevated` और किसी भी `agents.list[].tools.elevated` override द्वारा gated किया जाता है (दोनों की अनुमति आवश्यक) और यह `host=gateway` + `security=full` का alias है।
- `elevated` केवल तब व्यवहार बदलता है जब एजेंट sandboxed हो (अन्यथा no-op)।
- `host=node` macOS companion app या headless node host (`openclaw node run`) को target कर सकता है।
- gateway/node approvals और allowlists: [Exec approvals](/tools/exec-approvals)।

### `process`

background exec sessions का प्रबंधन करें।

Core actions:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

टिप्पणियाँ:

- `poll` पूर्ण होने पर नया output और exit status लौटाता है।
- `log` line-based `offset`/`limit` का समर्थन करता है (अंतिम N lines लेने के लिए `offset` छोड़ दें)।
- `process` प्रति-एजेंट scoped है; अन्य एजेंट्स की sessions दिखाई नहीं देतीं।

### `web_search`

Brave Search API का उपयोग करके वेब खोजें।

Core parameters:

- `query` (required)
- `count` (1–10; default `tools.web.search.maxResults` से)

टिप्पणियाँ:

- Brave API key आवश्यक (अनुशंसित: `openclaw configure --section web`, या `BRAVE_API_KEY` सेट करें)।
- `tools.web.search.enabled` के माध्यम से सक्षम करें।
- Responses cached होती हैं (default 15 min)।
- सेटअप के लिए [Web tools](/tools/web) देखें।

### `web_fetch`

URL से पठनीय सामग्री fetch और extract करें (HTML → markdown/text)।

Core parameters:

- `url` (required)
- `extractMode` (`markdown` | `text`)
- `maxChars` (लंबे पृष्ठों को truncate करें)

टिप्पणियाँ:

- `tools.web.fetch.enabled` के माध्यम से सक्षम करें।
- `maxChars` को `tools.web.fetch.maxCharsCap` (default 50000) द्वारा clamp किया जाता है।
- Responses cached होती हैं (default 15 min)।
- JS-heavy साइट्स के लिए browser tool को प्राथमिकता दें।
- सेटअप के लिए [Web tools](/tools/web) देखें।
- वैकल्पिक anti-bot fallback के लिए [Firecrawl](/tools/firecrawl) देखें।

### `browser`

समर्पित OpenClaw-managed browser को नियंत्रित करें।

Core actions:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (image block + `MEDIA:<path>` लौटाता है)
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profile management:

- `profiles` — स्थिति सहित सभी browser profiles सूचीबद्ध करें
- `create-profile` — auto-allocated port के साथ नया profile बनाएँ (या `cdpUrl`)
- `delete-profile` — browser रोकें, user data हटाएँ, config से हटाएँ (केवल local)
- `reset-profile` — profile के port पर orphan process kill करें (केवल local)

Common parameters:

- `profile` (optional; default `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; विशिष्ट node id/name चुनता है)
  टिप्पणियाँ:
- `browser.enabled=true` आवश्यक (default `true`; अक्षम करने के लिए `false` सेट करें)।
- सभी actions multi-instance support के लिए वैकल्पिक `profile` स्वीकार करते हैं।
- जब `profile` छोड़ा जाता है, तो `browser.defaultProfile` का उपयोग होता है (default "chrome")।
- Profile नाम: केवल lowercase alphanumeric + hyphens (अधिकतम 64 chars)।
- Port range: 18800-18899 (लगभग 100 profiles अधिकतम)।
- Remote profiles केवल attach-only हैं (start/stop/reset नहीं)।
- यदि browser-capable node जुड़ा है, तो tool auto-route कर सकता है (जब तक आप `target` pin न करें)।
- Playwright स्थापित होने पर `snapshot` का default `ai` होता है; accessibility tree के लिए `aria` का उपयोग करें।
- `snapshot` role-snapshot options (`interactive`, `compact`, `depth`, `selector`) का भी समर्थन करता है, जो `e12` जैसे refs लौटाते हैं।
- `act` को `snapshot` से `ref` चाहिए (AI snapshots से numeric `12`, या role snapshots से `e12`); दुर्लभ CSS selector आवश्यकताओं के लिए `evaluate` का उपयोग करें।
- डिफ़ॉल्ट रूप से `act` → `wait` से बचें; केवल असाधारण मामलों में उपयोग करें (जब भरोसेमंद UI state उपलब्ध न हो)।
- `upload` arming के बाद auto-click के लिए वैकल्पिक `ref` पास कर सकता है।
- `upload` `inputRef` (aria ref) या `element` (CSS selector) का भी समर्थन करता है ताकि `<input type="file">` सीधे सेट किया जा सके।

### `canvas`

node Canvas को संचालित करें (present, eval, snapshot, A2UI)।

Core actions:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (image block + `MEDIA:<path>` लौटाता है)
- `a2ui_push`, `a2ui_reset`

टिप्पणियाँ:

- आंतरिक रूप से gateway `node.invoke` का उपयोग करता है।
- यदि `node` प्रदान नहीं किया गया है, तो tool default चुनता है (एकल connected node या local mac node)।
- A2UI केवल v0.8 है (कोई `createSurface` नहीं); CLI v0.9 JSONL को line errors के साथ अस्वीकार करता है।
- Quick smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`।

### `nodes`

paired nodes की खोज और targeting; notifications भेजें; camera/screen capture करें।

Core actions:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

टिप्पणियाँ:

- Camera/screen commands के लिए node app का foreground में होना आवश्यक है।
- Images image blocks + `MEDIA:<path>` लौटाती हैं।
- Videos `FILE:<path>` (mp4) लौटाते हैं।
- Location एक JSON payload (lat/lon/accuracy/timestamp) लौटाता है।
- `run` params: `command` argv array; वैकल्पिक `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`।

उदाहरण (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

configured image model के साथ किसी image का विश्लेषण करें।

Core parameters:

- `image` (required path या URL)
- `prompt` (optional; default "Describe the image.")
- `model` (optional override)
- `maxBytesMb` (optional size cap)

टिप्पणियाँ:

- केवल तब उपलब्ध जब `agents.defaults.imageModel` configured हो (primary या fallbacks), या जब default model + configured auth से implicit image model infer किया जा सके (best‑effort pairing)।
- image model का सीधे उपयोग करता है (मुख्य chat model से स्वतंत्र)।

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams के बीच संदेश और चैनल actions भेजें।

Core actions:

- `send` (text + वैकल्पिक media; MS Teams `card` के साथ Adaptive Cards भी समर्थित करता है)
- `poll` (WhatsApp/Discord/MS Teams polls)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

टिप्पणियाँ:

- `send` WhatsApp को Gateway के माध्यम से route करता है; अन्य चैनल सीधे जाते हैं।
- `poll` WhatsApp और MS Teams के लिए Gateway का उपयोग करता है; Discord polls सीधे जाते हैं।
- जब कोई message tool call सक्रिय chat session से बंधी होती है, तो cross‑context leaks से बचने के लिए sends उस session के target तक सीमित रहते हैं।

### `cron`

Gateway cron jobs और wakeups का प्रबंधन करें।

Core actions:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (system event enqueue करें + वैकल्पिक immediate heartbeat)

टिप्पणियाँ:

- `add` एक पूर्ण cron job object अपेक्षित करता है ( वही schema जो `cron.add` RPC का है)।
- `update` `{ jobId, patch }` का उपयोग करता है (`id` compatibility के लिए स्वीकार्य)।

### `gateway`

चल रहे Gateway process को restart करें या updates लागू करें (in‑place)।

Core actions:

- `restart` (authorizes + in‑process restart के लिए `SIGUSR1` भेजता है; `openclaw gateway` in‑place restart)
- `config.get` / `config.schema`
- `config.apply` (validate + write config + restart + wake)
- `config.patch` (partial update merge + restart + wake)
- `update.run` (update चलाएँ + restart + wake)

टिप्पणियाँ:

- in‑flight reply में बाधा से बचने के लिए `delayMs` (default 2000) का उपयोग करें।
- `restart` डिफ़ॉल्ट रूप से अक्षम है; `commands.restart: true` के साथ सक्षम करें।

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

sessions सूचीबद्ध करें, transcript history निरीक्षण करें, या किसी अन्य session को भेजें।

Core parameters:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = none)
- `sessions_history`: `sessionKey` (या `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (या `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (default current; `sessionId` स्वीकार करता है), `model?` (`default` override साफ़ करता है)

टिप्पणियाँ:

- `main` canonical direct-chat key है; global/unknown छिपे होते हैं।
- `messageLimit > 0` प्रति session अंतिम N messages fetch करता है (tool messages फ़िल्टर किए जाते हैं)।
- `sessions_send` `timeoutSeconds > 0` होने पर final completion का इंतज़ार करता है।
- Delivery/announce completion के बाद होता है और best‑effort है; `status: "ok"` पुष्टि करता है कि agent run समाप्त हुआ, न कि announce deliver हुआ।
- `sessions_spawn` एक sub‑agent run शुरू करता है और requester chat में announce reply पोस्ट करता है।
- `sessions_spawn` non‑blocking है और तुरंत `status: "accepted"` लौटाता है।
- `sessions_send` reply‑back ping‑pong चलाता है (रोकने के लिए `REPLY_SKIP` reply करें; max turns `session.agentToAgent.maxPingPongTurns`, 0–5)।
- ping‑pong के बाद, target agent एक **announce step** चलाता है; announcement दबाने के लिए `ANNOUNCE_SKIP` reply करें।

### `agents_list`

वर्तमान session जिन agent ids को `sessions_spawn` के साथ target कर सकता है, उन्हें सूचीबद्ध करें।

टिप्पणियाँ:

- परिणाम प्रति‑एजेंट allowlists (`agents.list[].subagents.allowAgents`) तक सीमित है।
- जब `["*"]` configured हो, tool सभी configured agents शामिल करता है और `allowAny: true` चिह्नित करता है।

## Parameters (common)

Gateway‑backed tools (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (default `ws://127.0.0.1:18789`)
- `gatewayToken` (यदि auth सक्षम हो)
- `timeoutMs`

नोट: जब `gatewayUrl` सेट हो, तो `gatewayToken` को स्पष्ट रूप से शामिल करें। टूल्स ओवरराइड्स के लिए कॉन्फ़िग या एनवायरनमेंट क्रेडेंशियल्स इनहेरिट नहीं करते, और स्पष्ट क्रेडेंशियल्स का अभाव एक त्रुटि है।

Browser tool:

- `profile` (optional; default `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; विशिष्ट node id/name pin करें)

## Recommended agent flows

Browser automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai या aria)
3. `act` (click/type/press)
4. दृश्य पुष्टि की आवश्यकता हो तो `screenshot`

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (optional)
3. `snapshot`

Node targeting:

1. `nodes` → `status`
2. चुने गए node पर `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## Safety

- प्रत्यक्ष `system.run` से बचें; केवल स्पष्ट user consent के साथ `nodes` → `run` का उपयोग करें।
- camera/screen capture के लिए user consent का सम्मान करें।
- media commands invoke करने से पहले permissions सुनिश्चित करने के लिए `status/describe` का उपयोग करें।

## एजेंट को tools कैसे प्रस्तुत किए जाते हैं

Tools दो समानांतर channels में उजागर किए जाते हैं:

1. **System prompt text**: मानव‑पठनीय सूची + मार्गदर्शन।
2. **Tool schema**: मॉडल API को भेजी जाने वाली structured function definitions।

इसका अर्थ है कि एजेंट दोनों देखता है: “कौन से टूल मौजूद हैं” और “उन्हें कैसे कॉल करना है।” यदि कोई टूल सिस्टम प्रॉम्प्ट या स्कीमा में दिखाई नहीं देता है, तो मॉडल उसे कॉल नहीं कर सकता।
