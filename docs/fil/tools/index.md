---
summary: "Surface ng agent tool para sa OpenClaw (browser, canvas, nodes, message, cron) na pumapalit sa legacy na `openclaw-*` skills"
read_when:
  - Pagdaragdag o pagbabago ng mga agent tool
  - Pagretiro o pagbabago ng `openclaw-*` skills
title: "Mga Tool"
---

# Mga Tool (OpenClaw)

26. Naglalantad ang OpenClaw ng **first-class agent tools** para sa browser, canvas, nodes, at cron.
27. Pinapalitan ng mga ito ang lumang `openclaw-*` skills: ang mga tool ay typed, walang shelling,
    at dapat direktang umasa ang agent sa mga ito.

## Pag-disable ng mga tool

28. Maaari mong global na pahintulutan/tanggihan ang mga tool sa pamamagitan ng `tools.allow` / `tools.deny` sa `openclaw.json`
    (nanalo ang deny). This prevents disallowed tools from being sent to model providers.

```json5
{
  tools: { deny: ["browser"] },
}
```

Mga tala:

- Case-insensitive ang matching.
- Sinusuportahan ang `*` wildcards (`"*"` ay nangangahulugang lahat ng tool).
- Kung ang `tools.allow` ay tumutukoy lamang sa hindi kilala o hindi na-load na mga pangalan ng plugin tool, nagla-log ang OpenClaw ng babala at binabalewala ang allowlist para manatiling available ang mga core tool.

## Mga profile ng tool (base allowlist)

29. Itinatakda ng `tools.profile` ang isang **base tool allowlist** bago ang `tools.allow`/`tools.deny`.
    Per-agent override: `agents.list[].tools.profile`.

Mga profile:

- `minimal`: `session_status` lamang
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: walang restriksyon (katulad ng unset)

Halimbawa (messaging-only bilang default, payagan din ang Slack + Discord tools):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Halimbawa (coding profile, pero i-deny ang exec/process kahit saan):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Halimbawa (global coding profile, messaging-only na support agent):

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

## Provider-specific na patakaran ng tool

30. Gamitin ang `tools.byProvider` para **lalo pang higpitan** ang mga tool para sa mga partikular na provider
    (o isang `provider/model`) nang hindi binabago ang iyong global defaults.
31. Per-agent override: `agents.list[].tools.byProvider`.

This is applied **after** the base tool profile and **before** allow/deny lists,
so it can only narrow the tool set.
32. Tumatanggap ang mga provider key ng alinman sa `provider` (hal. `google-antigravity`) o
`provider/model` (hal. `openai/gpt-5.2`).

Halimbawa (panatilihin ang global coding profile, pero minimal na mga tool para sa Google Antigravity):

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

Halimbawa (provider/model-specific na allowlist para sa isang flaky endpoint):

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

Halimbawa (agent-specific na override para sa isang provider):

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

## Mga grupo ng tool (shorthands)

Sinusuportahan ng mga tool policy (global, agent, sandbox) ang mga `group:*` na entry na lumalawak sa maraming tool.
33. Gamitin ang mga ito sa `tools.allow` / `tools.deny`.

Mga available na grupo:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: lahat ng built-in na OpenClaw tool (hindi kasama ang provider plugins)

Halimbawa (payagan lamang ang mga file tool + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + mga tool

34. Maaaring magrehistro ang mga plugin ng **karagdagang mga tool** (at mga CLI command) lampas sa core set.
    See [Plugins](/tools/plugin) for install + config, and [Skills](/tools/skills) for how
    tool usage guidance is injected into prompts. 35. Ang ilang plugin ay may dalang sarili nilang skills
    kasama ng mga tool (halimbawa, ang voice-call plugin).

Opsyonal na mga plugin tool:

- [Lobster](/tools/lobster): typed na workflow runtime na may resumable approvals (nangangailangan ng Lobster CLI sa host ng Gateway).
- [LLM Task](/tools/llm-task): JSON-only na LLM step para sa structured workflow output (opsyonal na schema validation).

## Imbentaryo ng tool

### `apply_patch`

36. Mag-apply ng structured na mga patch sa isa o higit pang file. Use for multi-hunk edits.
    Experimental: enable via `tools.exec.applyPatch.enabled` (OpenAI models only).

### `exec`

Magpatakbo ng mga shell command sa workspace.

Mga core parameter:

- `command` (required)
- `yieldMs` (auto-background pagkatapos ng timeout, default 10000)
- `background` (agarang background)
- `timeout` (seconds; pinapatay ang proseso kapag lumampas, default 1800)
- `elevated` (bool; tumakbo sa host kung naka-enable/pinapayagan ang elevated mode; binabago lang ang behavior kapag naka-sandbox ang agent)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (node id/name para sa `host=node`)
- Need a real TTY? 37. Itakda ang `pty: true`.

Mga tala:

- Nagbabalik ng `status: "running"` na may `sessionId` kapag naka-background.
- Gamitin ang `process` para mag-poll/mag-log/magsulat/pumatay/mag-clear ng mga background session.
- Kapag hindi pinapayagan ang `process`, tumatakbo nang synchronous ang `exec` at binabalewala ang `yieldMs`/`background`.
- Ang `elevated` ay naka-gate ng `tools.elevated` kasama ang anumang `agents.list[].tools.elevated` override (parehong dapat payagan) at alias ito ng `host=gateway` + `security=full`.
- Ang `elevated` ay binabago lamang ang behavior kapag naka-sandbox ang agent (kung hindi, no-op).
- Maaaring i-target ng `host=node` ang isang macOS companion app o isang headless na host ng node (`openclaw node run`).
- Mga approval at allowlist ng gateway/node: [Exec approvals](/tools/exec-approvals).

### `process`

Pamahalaan ang mga background exec session.

Mga core action:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Mga tala:

- Ang `poll` ay nagbabalik ng bagong output at exit status kapag kumpleto na.
- Sinusuportahan ng `log` ang line-based na `offset`/`limit` (alisin ang `offset` para kunin ang huling N linya).
- Ang `process` ay scoped per agent; hindi nakikita ang mga session mula sa ibang agent.

### `web_search`

Maghanap sa web gamit ang Brave Search API.

Mga core parameter:

- `query` (required)
- `count` (1–10; default mula sa `tools.web.search.maxResults`)

Mga tala:

- Nangangailangan ng Brave API key (inirerekomenda: `openclaw configure --section web`, o itakda ang `BRAVE_API_KEY`).
- I-enable sa pamamagitan ng `tools.web.search.enabled`.
- Naka-cache ang mga response (default 15 min).
- Tingnan ang [Web tools](/tools/web) para sa setup.

### `web_fetch`

Kunin at i-extract ang nababasang content mula sa isang URL (HTML → markdown/text).

Mga core parameter:

- `url` (required)
- `extractMode` (`markdown` | `text`)
- `maxChars` (i-truncate ang mahahabang pahina)

Mga tala:

- I-enable sa pamamagitan ng `tools.web.fetch.enabled`.
- Ang `maxChars` ay naka-clamp ng `tools.web.fetch.maxCharsCap` (default 50000).
- Naka-cache ang mga response (default 15 min).
- Para sa mga site na mabigat sa JS, mas mainam ang browser tool.
- Tingnan ang [Web tools](/tools/web) para sa setup.
- Tingnan ang [Firecrawl](/tools/firecrawl) para sa opsyonal na anti-bot fallback.

### `browser`

Kontrolin ang dedikadong browser na pinamamahalaan ng OpenClaw.

Mga core action:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (nagbabalik ng image block + `MEDIA:<path>`)
- `act` (mga UI action: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Pamamahala ng profile:

- `profiles` — ilista ang lahat ng browser profile na may status
- `create-profile` — lumikha ng bagong profile na may auto-allocated port (o `cdpUrl`)
- `delete-profile` — ihinto ang browser, burahin ang user data, alisin sa config (local lamang)
- `reset-profile` — patayin ang orphan process sa port ng profile (local lamang)

Mga karaniwang parameter:

- `profile` (opsyonal; default sa `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opsyonal; pumipili ng partikular na node id/name)
  Mga tala:
- Nangangailangan ng `browser.enabled=true` (default ay `true`; itakda ang `false` para i-disable).
- Tumatanggap ang lahat ng action ng opsyonal na `profile` parameter para sa multi-instance support.
- Kapag hindi ibinigay ang `profile`, ginagamit ang `browser.defaultProfile` (default na "chrome").
- Mga pangalan ng profile: lowercase alphanumeric + hyphens lamang (max 64 chars).
- Saklaw ng port: 18800-18899 (~100 profile max).
- Ang mga remote profile ay attach-only (walang start/stop/reset).
- Kung may nakakonektang browser-capable na node, maaaring auto-route dito ang tool (maliban kung i-pin mo ang `target`).
- Ang `snapshot` ay default sa `ai` kapag naka-install ang Playwright; gamitin ang `aria` para sa accessibility tree.
- Sinusuportahan din ng `snapshot` ang mga role-snapshot option (`interactive`, `compact`, `depth`, `selector`) na nagbabalik ng mga ref tulad ng `e12`.
- Ang `act` ay nangangailangan ng `ref` mula sa `snapshot` (numeric na `12` mula sa AI snapshots, o `e12` mula sa role snapshots); gamitin ang `evaluate` para sa bihirang pangangailangan ng CSS selector.
- Iwasan ang `act` → `wait` bilang default; gamitin lamang sa mga eksepsiyonal na kaso (walang maaasahang UI state na mahihintayan).
- Ang `upload` ay maaaring magpasa ng `ref` para auto-click pagkatapos i-arm.
- Sinusuportahan din ng `upload` ang `inputRef` (aria ref) o `element` (CSS selector) para direktang itakda ang `<input type="file">`.

### `canvas`

Patakbuhin ang node Canvas (present, eval, snapshot, A2UI).

Mga core action:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (nagbabalik ng image block + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Mga tala:

- Ginagamit ang gateway `node.invoke` sa likod ng eksena.
- Kung walang ibinigay na `node`, pumipili ang tool ng default (isang nakakonektang node o lokal na mac node).
- Ang A2UI ay v0.8 lamang (walang `createSurface`); tinatanggihan ng CLI ang v0.9 JSONL na may mga error sa linya.
- Quick smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Tuklasin at i-target ang mga naka-pair na node; magpadala ng mga notification; kumuha ng camera/screen.

Mga core action:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Mga tala:

- Ang mga command ng camera/screen ay nangangailangan na naka-foreground ang node app.
- Nagbabalik ang mga image ng image blocks + `MEDIA:<path>`.
- Nagbabalik ang mga video ng `FILE:<path>` (mp4).
- Ang location ay nagbabalik ng JSON payload (lat/lon/accuracy/timestamp).
- Mga parameter ng `run`: `command` argv array; opsyonal na `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Halimbawa (`run`):

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

Suriin ang isang larawan gamit ang naka-configure na image model.

Mga core parameter:

- `image` (required na path o URL)
- `prompt` (opsyonal; default sa "Describe the image.")
- `model` (opsyonal na override)
- `maxBytesMb` (opsyonal na size cap)

Mga tala:

- Available lamang kapag naka-configure ang `agents.defaults.imageModel` (primary o fallbacks), o kapag maaaring ma-infer ang implicit image model mula sa iyong default model + naka-configure na auth (best-effort pairing).
- Direktang ginagamit ang image model (hiwalay sa pangunahing chat model).

### `message`

Magpadala ng mga mensahe at channel action sa Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Mga core action:

- `send` (text + opsyonal na media; sinusuportahan din ng MS Teams ang `card` para sa Adaptive Cards)
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

Mga tala:

- Ang `send` ay niruruta ang WhatsApp sa pamamagitan ng Gateway; ang ibang channel ay diretso.
- Ginagamit ng `poll` ang Gateway para sa WhatsApp at MS Teams; diretso ang Discord polls.
- Kapag ang message tool call ay naka-bind sa isang aktibong chat session, nililimitahan ang mga send sa target ng session na iyon upang maiwasan ang cross-context leaks.

### `cron`

Pamahalaan ang mga Gateway cron job at wakeup.

Mga core action:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (i-enqueue ang system event + opsyonal na agarang heartbeat)

Mga tala:

- Inaasahan ng `add` ang isang buong cron job object (kaparehong schema ng `cron.add` RPC).
- Ginagamit ng `update` ang `{ jobId, patch }` (tinanggap ang `id` para sa compatibility).

### `gateway`

I-restart o i-apply ang mga update sa tumatakbong Gateway process (in-place).

Mga core action:

- `restart` (ina-authorize + nagpapadala ng `SIGUSR1` para sa in-process restart; `openclaw gateway` restart in-place)
- `config.get` / `config.schema`
- `config.apply` (i-validate + isulat ang config + restart + wake)
- `config.patch` (i-merge ang partial update + restart + wake)
- `update.run` (patakbuhin ang update + restart + wake)

Mga tala:

- Gamitin ang `delayMs` (default 2000) upang maiwasang maantala ang isang in-flight na reply.
- Ang `restart` ay naka-disable bilang default; i-enable gamit ang `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Ilista ang mga session, siyasatin ang transcript history, o magpadala sa ibang session.

Mga core parameter:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = wala)
- `sessions_history`: `sessionKey` (o `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (o `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (default current; tumatanggap ng `sessionId`), `model?` (`default` naglilinis ng override)

Mga tala:

- Ang `main` ang canonical direct-chat key; nakatago ang global/unknown.
- Kinukuha ng `messageLimit > 0` ang huling N mensahe bawat session (naka-filter ang mga tool message).
- Naghihintay ang `sessions_send` ng final completion kapag `timeoutSeconds > 0`.
- Ang delivery/announce ay nangyayari pagkatapos ng completion at best-effort; kinukumpirma ng `status: "ok"` na natapos ang agent run, hindi naihatid ang announce.
- Nagsisimula ang `sessions_spawn` ng sub-agent run at nagpo-post ng announce reply pabalik sa requester chat.
- Ang `sessions_spawn` ay non-blocking at agad na nagbabalik ng `status: "accepted"`.
- Ang `sessions_send` ay nagpapatakbo ng reply‑back ping‑pong (mag-reply ng `REPLY_SKIP` para huminto; max turns sa pamamagitan ng `session.agentToAgent.maxPingPongTurns`, 0–5).
- Pagkatapos ng ping‑pong, nagpapatakbo ang target agent ng **announce step**; mag-reply ng `ANNOUNCE_SKIP` para pigilan ang announcement.

### `agents_list`

Ilista ang mga agent id na maaaring i-target ng kasalukuyang session gamit ang `sessions_spawn`.

Mga tala:

- Ang resulta ay limitado sa per-agent allowlists (`agents.list[].subagents.allowAgents`).
- Kapag naka-configure ang `["*"]`, isinasama ng tool ang lahat ng naka-configure na agent at minamarkahan ang `allowAny: true`.

## Mga parameter (karaniwan)

Mga tool na naka-back ng Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (default `ws://127.0.0.1:18789`)
- `gatewayToken` (kung naka-enable ang auth)
- `timeoutMs`

Note: when `gatewayUrl` is set, include `gatewayToken` explicitly. Tools do not inherit config
or environment credentials for overrides, and missing explicit credentials is an error.

Browser tool:

- `profile` (opsyonal; default sa `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opsyonal; i-pin ang isang partikular na node id/name)

## Inirerekomendang daloy ng agent

Browser automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai o aria)
3. `act` (click/type/press)
4. `screenshot` kung kailangan ng visual confirmation

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (opsyonal)
3. `snapshot`

Node targeting:

1. `nodes` → `status`
2. `describe` sa napiling node
3. `notify` / `run` / `camera_snap` / `screen_record`

## Kaligtasan

- Iwasan ang direktang `system.run`; gamitin ang `nodes` → `run` lamang na may tahasang pahintulot ng user.
- Igalang ang pahintulot ng user para sa pagkuha ng camera/screen.
- Gamitin ang `status/describe` upang matiyak ang mga permiso bago tumawag ng mga media command.

## Paano ipinapakita ang mga tool sa agent

Inilalantad ang mga tool sa dalawang magkatulad na channel:

1. **System prompt text**: isang human-readable na listahan + gabay.
2. **Tool schema**: ang structured function definitions na ipinapadala sa model API.

38) Ibig sabihin nito, nakikita ng agent ang parehong “kung anong mga tool ang umiiral” at “kung paano tawagin ang mga ito.” 39. Kung ang isang tool
    ay hindi lumalabas sa system prompt o sa schema, hindi ito maaaring tawagin ng modelo.
