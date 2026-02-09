---
summary: "Testing kit: mga unit/e2e/live suite, Docker runners, at kung ano ang saklaw ng bawat test"
read_when:
  - Kapag nagpapatakbo ng mga test nang lokal o sa CI
  - Kapag nagdadagdag ng regressions para sa mga bug ng model/provider
  - Kapag nagde-debug ng gateway + agent na behavior
title: "Testing"
---

# Testing

May tatlong Vitest suite ang OpenClaw (unit/integration, e2e, live) at isang maliit na set ng mga Docker runner.

Ang doc na ito ay gabay sa “paano kami nagte-test”:

- Ano ang saklaw ng bawat suite (at kung ano ang sinasadya nitong _hindi_ saklawin)
- Aling mga command ang tatakbuhin para sa mga karaniwang workflow (lokal, pre-push, debugging)
- Paano nadidiskubre ng live tests ang mga credential at pumipili ng mga model/provider
- Paano magdagdag ng regressions para sa mga isyung nangyayari sa totoong mundo sa model/provider

## Mabilis na pagsisimula

Kadalasan:

- Full gate (inaasahan bago mag-push): `pnpm build && pnpm check && pnpm test`

Kapag may binago ka sa tests o gusto mo ng dagdag na kumpiyansa:

- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

Kapag nagde-debug ng mga totoong provider/model (kailangan ng totoong creds):

- Live suite (models + Gateway tool/image probes): `pnpm test:live`

Tip: kapag isang failing case lang ang kailangan, mas mainam na paliitin ang live tests gamit ang allowlist env vars na inilalarawan sa ibaba.

## Mga test suite (alin ang tumatakbo saan)

Isipin ang mga suite bilang “papataas ang realism” (at papataas din ang flakiness/gastos):

### Unit / integration (default)

- Command: `pnpm test`
- Config: `vitest.config.ts`
- Files: `src/**/*.test.ts`
- Saklaw:
  - Mga purong unit test
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Mga deterministic regression para sa mga kilalang bug
- Inaasahan:
  - Tumatakbo sa CI
  - Walang kailangang totoong key
  - Dapat mabilis at stable

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`
- Saklaw:
  - End-to-end na behavior ng multi-instance gateway
  - Mga WebSocket/HTTP surface, node pairing, at mas mabibigat na networking
- Inaasahan:
  - Tumatakbo sa CI (kapag naka-enable sa pipeline)
  - Walang kailangang totoong key
  - Mas maraming gumagalaw na bahagi kaysa unit tests (maaaring mas mabagal)

### Live (totoong provider + totoong model)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **enabled** ng `pnpm test:live` (nagse-set ng `OPENCLAW_LIVE_TEST=1`)
- Saklaw:
  - “Gumagana ba talaga ang provider/model na ito _ngayon_ gamit ang totoong creds?”
  - Mahuli ang mga pagbabago sa provider format, tool-calling quirks, auth issues, at rate limit behavior
- Inaasahan:
  - Hindi CI-stable by design (totoong network, totoong provider policy, quota, outage)
  - May gastos / gumagamit ng rate limits
  - Mas mainam na magpatakbo ng pinakikitid na subset kaysa “lahat”
  - Kukunin ng live runs ang `~/.profile` para makuha ang kulang na API keys
  - Anthropic key rotation: i-set ang `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (o `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) o maraming `ANTHROPIC_API_KEY*` vars; magre-retry ang tests kapag may rate limits

## Aling suite ang dapat kong patakbuhin?

Gamitin ang decision table na ito:

- Nag-eedit ng logic/tests: patakbuhin ang `pnpm test` (at `pnpm test:coverage` kung marami kang binago)
- May binago sa gateway networking / WS protocol / pairing: idagdag ang `pnpm test:e2e`
- Nagde-debug ng “down ang bot ko” / provider-specific failures / tool calling: magpatakbo ng pinakitid na `pnpm test:live`

## Live: model smoke (profile keys)

Hinahati ang live tests sa dalawang layer para ma-isolate ang mga failure:

- Ang “Direct model” ay nagsasabi kung nakakasagot man lang ang provider/model gamit ang ibinigay na key.
- Ang “Gateway smoke” ay nagsasabi kung gumagana ang buong gateway+agent pipeline para sa model na iyon (sessions, history, tools, sandbox policy, atbp.).

### Layer 1: Direct model completion (walang gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Layunin:
  - I-enumerate ang mga nadiskubreng model
  - Gamitin ang `getApiKeyForModel` para pumili ng mga model na may creds ka
  - Magpatakbo ng maliit na completion kada model (at mga targeted regression kung kailangan)
- Paano i-enable:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` kung diretsong tinatawag ang Vitest)
- I-set ang `OPENCLAW_LIVE_MODELS=modern` (o `all`, alias para sa modern) para talagang patakbuhin ang suite na ito; kung hindi, ise-skip ito para manatiling nakatuon ang `pnpm test:live` sa gateway smoke
- Paano pumili ng mga model:
  - `OPENCLAW_LIVE_MODELS=modern` para patakbuhin ang modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` ay alias para sa modern allowlist
  - o `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (comma allowlist)
- Paano pumili ng mga provider:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (comma allowlist)
- Saan nanggagaling ang mga key:
  - By default: profile store at env fallbacks
  - I-set ang `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para ipatupad ang **profile store** lang
- Bakit ito umiiral:
  - Inihihiwalay ang “sira ang provider API / invalid ang key” mula sa “sira ang gateway agent pipeline”
  - Naglalaman ng maliliit at isolated na regression (halimbawa: OpenAI Responses/Codex Responses reasoning replay + tool-call flows)

### Layer 2: Gateway + dev agent smoke (kung ano ang aktuwal na ginagawa ng “@openclaw”)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Layunin:
  - Mag-spin up ng in-process gateway
  - Gumawa/mag-patch ng `agent:dev:*` session (model override kada run)
  - I-iterate ang models-with-keys at mag-assert:
    - “makabuluhang” response (walang tools)
    - gumagana ang totoong tool invocation (read probe)
    - optional na dagdag na tool probes (exec+read probe)
    - gumagana pa rin ang mga OpenAI regression path (tool-call-only → follow-up)
- Mga detalye ng probe (para mabilis mong maipaliwanag ang failures):
  - `read` probe: nagsusulat ang test ng nonce file sa workspace at hinihiling sa agent na `read` ito at ibalik ang nonce.
  - `exec+read` probe: hinihiling ng test sa agent na `exec`-sumulat ng nonce sa temp file, pagkatapos ay `read` ito pabalik.
  - image probe: nag-a-attach ang test ng generated PNG (pusa + randomized na code) at inaasahan na ibabalik ng model ang `cat <CODE>`.
  - Reference ng implementasyon: `src/gateway/gateway-models.profiles.live.test.ts` at `src/gateway/live-image-probe.ts`.
- Paano i-enable:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` kung diretsong tinatawag ang Vitest)
- Paano pumili ng mga model:
  - Default: modern allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` ay alias para sa modern allowlist
  - O i-set ang `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (o comma list) para paliitin
- Paano pumili ng mga provider (iwasan ang “OpenRouter everything”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (comma allowlist)
- Laging naka-on ang tool + image probes sa live test na ito:
  - `read` probe + `exec+read` probe (tool stress)
  - tumatakbo ang image probe kapag ina-advertise ng model ang image input support
  - Daloy (high level):
    - Gumagawa ang test ng maliit na PNG na may “CAT” + random code (`src/gateway/live-image-probe.ts`)
    - Ipinapadala ito sa pamamagitan ng `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Ini-parse ng Gateway ang mga attachment papunta sa `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Ipinapasa ng embedded agent ang isang multimodal user message sa model
    - Assertion: naglalaman ang reply ng `cat` + ang code (OCR tolerance: pinapayagan ang maliliit na pagkakamali)

Tip: para makita kung ano ang puwede mong i-test sa makina mo (at ang eksaktong `provider/model` ids), patakbuhin ang:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Layunin: i-verify na ang Claude Code CLI setup-token (o isang pasted setup-token profile) ay kayang mag-complete ng Anthropic prompt.
- I-enable:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` kung diretsong tinatawag ang Vitest)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Mga pinagmumulan ng token (pumili ng isa):
  - Profile: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model override (opsyonal):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Halimbawa ng setup:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI backend smoke (Claude Code CLI o iba pang lokal na CLI)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Layunin: i-validate ang Gateway + agent pipeline gamit ang lokal na CLI backend, nang hindi ginagalaw ang default config mo.
- I-enable:
  - `pnpm test:live` (o `OPENCLAW_LIVE_TEST=1` kung diretsong tinatawag ang Vitest)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Mga default:
  - Model: `claude-cli/claude-sonnet-4-5`
  - Command: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Mga override (opsyonal):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` para magpadala ng totoong image attachment (ini-inject ang mga path sa prompt).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` para ipasa ang mga image file path bilang CLI args imbes na prompt injection.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (o `"list"`) para kontrolin kung paano ipinapasa ang image args kapag naka-set ang `IMAGE_ARG`.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` para magpadala ng pangalawang turn at i-validate ang resume flow.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` para panatilihing naka-enable ang Claude Code CLI MCP config (default ay dini-disable ang MCP config gamit ang pansamantalang empty file).

Halimbawa:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Mga inirerekomendang live recipe

Ang makikitid at tahasang allowlist ang pinakamabilis at pinaka-hindi flaky:

- Isang model, direct (walang gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Isang model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling sa ilang provider:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google focus (Gemini API key + Antigravity):
  - Gemini (API key): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Mga tala:

- Gumagamit ang `google/...` ng Gemini API (API key).
- Gumagamit ang `google-antigravity/...` ng Antigravity OAuth bridge (Cloud Code Assist-style agent endpoint).
- Gumagamit ang `google-gemini-cli/...` ng lokal na Gemini CLI sa iyong makina (hiwalay na auth + tooling quirks).
- Gemini API vs Gemini CLI:
  - API: tinatawag ng OpenClaw ang hosted Gemini API ng Google sa HTTP (API key / profile auth); ito ang karaniwang ibig sabihin ng mga user kapag sinasabi ang “Gemini”.
  - CLI: nagse-shell out ang OpenClaw sa lokal na `gemini` binary; may sarili itong auth at maaaring iba ang behavior (streaming/tool support/version skew).

## Live: model matrix (ano ang saklaw namin)

Walang nakapirming “CI model list” (opt-in ang live), pero ito ang **inirerekomendang** mga model na regular na saklawin sa dev machine na may keys.

### Modern smoke set (tool calling + image)

Ito ang “common models” run na inaasahan naming manatiling gumagana:

- OpenAI (non-Codex): `openai/gpt-5.2` (opsyonal: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (opsyonal: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (o `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` at `google/gemini-3-flash-preview` (iwasan ang mas lumang Gemini 2.x models)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` at `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Patakbuhin ang gateway smoke na may tools + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + opsyonal na Exec)

Pumili ng kahit isa bawat provider family:

- OpenAI: `openai/gpt-5.2` (o `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (o `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (o `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Opsyonal na dagdag na saklaw (magandang mayroon):

- xAI: `xai/grok-4` (o pinakabagong available)
- LM Studio: `lmstudio/`… (pick one “tools” capable model you have enabled)
- Cerebras: `cerebras/`… (if you have access)
- Isama ang hindi bababa sa isang image-capable na modelo sa `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI vision-capable variants, atbp.) (local; tool calling depends on API mode)

### Vision: image send (attachment → multimodal message)

upang subukan ang image probe. Tip: huwag subukang i-hardcode ang “all models” sa docs.

### Aggregators / alternate gateways

Kung may naka-enable kang keys, sinusuportahan din namin ang pag-test sa pamamagitan ng:

- OpenRouter: `openrouter/...` (daan-daang model; gamitin ang `openclaw models scan` para maghanap ng tool+image capable na kandidato)
- OpenCode Zen: `opencode/...` (auth sa pamamagitan ng `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Mas marami pang provider na puwede mong isama sa live matrix (kung may creds/config ka):

- Built-in: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Sa pamamagitan ng `models.providers` (custom endpoints): `minimax` (cloud/API), kasama ang anumang OpenAI/Anthropic-compatible proxy (LM Studio, vLLM, LiteLLM, atbp.)

Ang awtoritatibong listahan ay kung ano man ang ibinabalik ng `discoverModels(...)` sa iyong machine + kung anu-anong keys ang available. Mga praktikal na implikasyon:

## Mga credential (huwag kailanman i-commit)

Live tests discover credentials the same way the CLI does. DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts\`

- Kung gumagana ang CLI, dapat makita ng live tests ang parehong keys.

- Kung sinasabi ng live test na “no creds”, i-debug ito sa parehong paraan na pagde-debug mo ng `openclaw models list` / model selection.

- Profile store: `~/.openclaw/credentials/` (preferred; ito ang ibig sabihin ng “profile keys” sa tests)

- Config: `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`)

Kung gusto mong umasa sa env keys (hal. naka-export sa iyong `~/.profile`), magpatakbo ng local tests pagkatapos ng `source ~/.profile`, o gamitin ang mga Docker runner sa ibaba (maaari nilang i-mount ang `~/.profile` sa container).

## Deepgram live (audio transcription)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable: \`DEEPGRAM_API_KEY=... EXFOLIATE!"_ — Isang space lobster, marahil

## Docker runners (opsyonal na “gumagana sa Linux” checks)

Pinapatakbo ng mga ito ang `pnpm test:live` sa loob ng repo Docker image, habang mina-mount ang iyong lokal na config dir at workspace (at sine-source ang `~/.profile` kung naka-mount):

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking (dalawang container, WS auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (custom extension load + registry smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Mga kapaki-pakinabang na env vars:

- `OPENCLAW_CONFIG_DIR=...` (default: `~/.openclaw`) na naka-mount sa `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (default: `~/.openclaw/workspace`) na naka-mount sa `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (default: `~/.profile`) na naka-mount sa `/home/node/.profile` at sine-source bago patakbuhin ang tests
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` para paliitin ang run
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` para tiyaking sa profile store nanggagaling ang creds (hindi sa env)

## Docs sanity

Patakbuhin ang docs checks pagkatapos ng mga edit sa docs: `pnpm docs:list`.

## Offline regression (CI-safe)

Ito ang mga “real pipeline” regression na walang totoong provider:

- Gateway tool calling (mock OpenAI, totoong gateway + agent loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway wizard (WS `wizard.start`/`wizard.next`, nagsusulat ng config + ipinapatupad ang auth): `src/gateway/gateway.wizard.e2e.test.ts`

## Agent reliability evals (skills)

Mayroon na kaming ilang CI-safe tests na kumikilos na parang “agent reliability evals”:

- Mock tool-calling sa pamamagitan ng totoong gateway + agent loop (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End-to-end wizard flows na nagva-validate ng session wiring at config effects (`src/gateway/gateway.wizard.e2e.test.ts`).

Ano pa ang kulang para sa skills (tingnan ang [Skills](/tools/skills)):

- **Decisioning:** kapag nakalista ang skills sa prompt, pinipili ba ng agent ang tamang skill (o iniiwasan ang hindi kaugnay)?
- **Compliance:** binabasa ba ng agent ang `SKILL.md` bago gamitin at sinusunod ang mga kinakailangang hakbang/args?
- **Workflow contracts:** mga multi-turn na scenario na nag-a-assert ng pagkakasunod-sunod ng tool, carryover ng session history, at mga hangganan ng sandbox.

Ang mga future eval ay dapat manatiling deterministic muna:

- Isang scenario runner na gumagamit ng mock provider para mag-assert ng tool calls + order, pagbasa ng skill file, at session wiring.
- Isang maliit na suite ng skill-focused na scenario (use vs avoid, gating, prompt injection).
- Opsyonal na live evals (opt-in, env-gated) lamang pagkatapos maipatupad ang CI-safe suite.

## Pagdaragdag ng regressions (gabay)

Kapag nag-ayos ka ng isyu sa provider/model na nadiskubre sa live:

- Magdagdag ng CI-safe regression kung posible (mock/stub provider, o i-capture ang eksaktong request-shape transformation)
- Kung likas itong live-only (rate limits, auth policy), panatilihing makitid ang live test at opt-in sa pamamagitan ng env vars
- Mas mainam na i-target ang pinakamaliit na layer na huhuli sa bug:
  - bug sa provider request conversion/replay → direct models test
  - bug sa gateway session/history/tool pipeline → gateway live smoke o CI-safe gateway mock test
