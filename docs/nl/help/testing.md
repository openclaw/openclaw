---
summary: "Testkit: unit/e2e/live-suites, Docker-runners en wat elke test dekt"
read_when:
  - Tests lokaal of in CI uitvoeren
  - Regressies toevoegen voor model/provider-bugs
  - Gateway- en agentgedrag debuggen
title: "Testen"
---

# Testen

OpenClaw heeft drie Vitest-suites (unit/integratie, e2e, live) en een kleine set Docker-runners.

Dit document is een gids “hoe we testen”:

- Wat elke suite dekt (en wat bewust _niet_)
- Welke opdrachten je uitvoert voor gangbare workflows (lokaal, pre-push, debuggen)
- Hoe live-tests credentials ontdekken en modellen/providers selecteren
- Hoe je regressies toevoegt voor echte model/provider-problemen

## Snelle start

Meestal:

- Volledige gate (verwacht vóór push): `pnpm build && pnpm check && pnpm test`

Wanneer je tests aanraakt of extra zekerheid wilt:

- Coverage-gate: `pnpm test:coverage`
- E2E-suite: `pnpm test:e2e`

Bij het debuggen van echte providers/modellen (vereist echte credentials):

- Live-suite (modellen + Gateway tool/image-probes): `pnpm test:live`

Tip: als je maar één falend geval nodig hebt, beperk live-tests liever via de allowlist-omgevingsvariabelen die hieronder worden beschreven.

## Test-suites (wat draait waar)

Zie de suites als “toenemende realiteit” (en toenemende instabiliteit/kosten):

### Unit / integratie (standaard)

- Opdracht: `pnpm test`
- Config: `vitest.config.ts`
- Bestanden: `src/**/*.test.ts`
- Scope:
  - Pure unit-tests
  - In-process integratietests (Gateway-authenticatie, routering, tooling, parsing, config)
  - Deterministische regressies voor bekende bugs
- Verwachtingen:
  - Draait in CI
  - Geen echte sleutels vereist
  - Snel en stabiel

### E2E (Gateway-smoke)

- Opdracht: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Bestanden: `src/**/*.e2e.test.ts`
- Scope:
  - End-to-end gedrag van Gateway met meerdere instanties
  - WebSocket/HTTP-oppervlakken, node-pairing en zwaardere netwerken
- Verwachtingen:
  - Draait in CI (wanneer ingeschakeld in de pipeline)
  - Geen echte sleutels vereist
  - Meer bewegende delen dan unit-tests (kan trager zijn)

### Live (echte providers + echte modellen)

- Opdracht: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Bestanden: `src/**/*.live.test.ts`
- Standaard: **ingeschakeld** door `pnpm test:live` (stelt `OPENCLAW_LIVE_TEST=1` in)
- Scope:
  - “Werkt deze provider/dit model _vandaag_ daadwerkelijk met echte credentials?”
  - Vangt provider-formaatwijzigingen, eigenaardigheden in tool-calling, auth-problemen en rate-limitgedrag
- Verwachtingen:
  - Niet CI-stabiel per ontwerp (echte netwerken, echte providerpolicies, quota’s, storingen)
  - Kost geld / gebruikt rate-limits
  - Bij voorkeur uitvoeren beperkt subsets in plaats van "alles"
  - Live-runs halen `~/.profile` op om ontbrekende API-sleutels te vinden
  - Anthropic key-rotatie: stel `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (of `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) in of meerdere `ANTHROPIC_API_KEY*`-variabelen; tests proberen opnieuw bij rate-limits

## Welke suite moet ik draaien?

Gebruik deze beslissingshulp:

- Logica/tests bewerken: draai `pnpm test` (en `pnpm test:coverage` als je veel hebt gewijzigd)
- Gateway-netwerken / WS-protocol / pairing aanpassen: voeg `pnpm test:e2e` toe
- Debuggen van “mijn bot is down” / provider-specifieke fouten / tool-calling: draai een beperkte `pnpm test:live`

## Live: model-smoke (profielsleutels)

Live-tests zijn opgesplitst in twee lagen om fouten te isoleren:

- “Direct model” laat zien dat de provider/het model überhaupt kan antwoorden met de gegeven sleutel.
- “Gateway smoke” laat zien dat de volledige Gateway+agent-pijplijn werkt voor dat model (sessies, geschiedenis, tools, sandboxbeleid, enz.).

### Laag 1: Directe model-completion (geen Gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Doel:
  - Ontdekte modellen enumereren
  - `getApiKeyForModel` gebruiken om modellen te selecteren waarvoor je credentials hebt
  - Een kleine completion per model draaien (en gerichte regressies waar nodig)
- Inschakelen:
  - `pnpm test:live` (of `OPENCLAW_LIVE_TEST=1` bij directe Vitest-aanroep)
- Stel `OPENCLAW_LIVE_MODELS=modern` (of `all`, alias voor modern) in om deze suite daadwerkelijk te draaien; anders wordt deze overgeslagen om `pnpm test:live` gefocust te houden op Gateway-smoke
- Modellen selecteren:
  - `OPENCLAW_LIVE_MODELS=modern` om de moderne allowlist te draaien (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` is een alias voor de moderne allowlist
  - of `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (komma-allowlist)
- Providers selecteren:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (komma-allowlist)
- Waar sleutels vandaan komen:
  - Standaard: profielstore en env-fallbacks
  - Stel `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` in om **alleen** de profielstore af te dwingen
- Waarom dit bestaat:
  - Scheidt “provider-API is kapot / sleutel is ongeldig” van “Gateway-agent-pijplijn is kapot”
  - Bevat kleine, geïsoleerde regressies (bijvoorbeeld: OpenAI Responses/Codex Responses reasoning-replay + tool-call-flows)

### Laag 2: Gateway + dev-agent smoke (wat “@openclaw” daadwerkelijk doet)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Doel:
  - Een in-process Gateway opstarten
  - Een `agent:dev:*`-sessie maken/patchen (model override per run)
  - Modellen-met-sleutels itereren en verifiëren:
    - “betekenisvolle” respons (geen tools)
    - een echte tool-invocation werkt (read-probe)
    - optionele extra tool-probes (exec+read-probe)
    - OpenAI-regressiepaden (alleen tool-call → follow-up) blijven werken
- Probe-details (zodat je fouten snel kunt uitleggen):
  - `read`-probe: de test schrijft een nonce-bestand in de werkruimte en vraagt de agent het te `read` en de nonce terug te echoën.
  - `exec+read`-probe: de test vraagt de agent om een nonce `exec`-weg te schrijven in een tempbestand en het daarna terug te `read`.
  - Image-probe: de test voegt een gegenereerde PNG toe (kat + willekeurige code) en verwacht dat het model `cat <CODE>` retourneert.
  - Implementatiereferentie: `src/gateway/gateway-models.profiles.live.test.ts` en `src/gateway/live-image-probe.ts`.
- Inschakelen:
  - `pnpm test:live` (of `OPENCLAW_LIVE_TEST=1` bij directe Vitest-aanroep)
- Modellen selecteren:
  - Standaard: moderne allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` is een alias voor de moderne allowlist
  - Of stel `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (of een kommagescheiden lijst) in om te beperken
- Providers selecteren (vermijd “OpenRouter alles”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (komma-allowlist)
- Tool- en image-probes staan altijd aan in deze live-test:
  - `read`-probe + `exec+read`-probe (tool-stress)
  - Image-probe draait wanneer het model image-input ondersteunt
  - Flow (hoog niveau):
    - Test genereert een kleine PNG met “CAT” + willekeurige code (`src/gateway/live-image-probe.ts`)
    - Verstuurt deze via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parseert bijlagen naar `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Embedded agent stuurt een multimodale gebruikersboodschap door naar het model
    - Assertie: antwoord bevat `cat` + de code (OCR-tolerantie: kleine fouten toegestaan)

Tip: om te zien wat je op jouw machine kunt testen (en de exacte `provider/model`-id’s), voer uit:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Doel: verifiëren dat de Claude Code CLI setup-token (of een geplakte setup-token in een profiel) een Anthropic-prompt kan voltooien.
- Inschakelen:
  - `pnpm test:live` (of `OPENCLAW_LIVE_TEST=1` bij directe Vitest-aanroep)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Tokenbronnen (kies er één):
  - Profiel: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Ruwe token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model-override (optioneel):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Installatievoorbeeld:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI-backend smoke (Claude Code CLI of andere lokale CLI’s)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Doel: de Gateway + agent-pijplijn valideren met een lokale CLI-backend, zonder je standaardconfig aan te raken.
- Inschakelen:
  - `pnpm test:live` (of `OPENCLAW_LIVE_TEST=1` bij directe Vitest-aanroep)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Standaardwaarden:
  - Model: `claude-cli/claude-sonnet-4-5`
  - Opdracht: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (optioneel):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` om een echte image-bijlage te sturen (paden worden in de prompt geïnjecteerd).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` om image-bestandspaden als CLI-args door te geven in plaats van prompt-injectie.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (of `"list"`) om te bepalen hoe image-args worden doorgegeven wanneer `IMAGE_ARG` is ingesteld.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` om een tweede beurt te sturen en de hervat-flow te valideren.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` om de Claude Code CLI MCP-config ingeschakeld te houden (standaard wordt MCP-config uitgeschakeld met een tijdelijk leeg bestand).

Voorbeeld:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Aanbevolen live-recepten

Beperkte, expliciete allowlists zijn het snelst en het minst instabiel:

- Enkel model, direct (geen Gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Enkel model, Gateway-smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool-calling over meerdere providers:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google-focus (Gemini API-sleutel + Antigravity):
  - Gemini (API-sleutel): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Notities:

- `google/...` gebruikt de Gemini API (API-sleutel).
- `google-antigravity/...` gebruikt de Antigravity OAuth-bridge (Cloud Code Assist-achtige agent-endpoint).
- `google-gemini-cli/...` gebruikt de lokale Gemini CLI op je machine (aparte authenticatie + tooling-eigenaardigheden).
- Gemini API vs Gemini CLI:
  - API: OpenClaw roept Google’s gehoste Gemini API aan via HTTP (API-sleutel / profielauth); dit is wat de meeste gebruikers bedoelen met “Gemini”.
  - CLI: OpenClaw roept een lokale `gemini`-binary aan; die heeft eigen auth en kan zich anders gedragen (streaming/tool-ondersteuning/versiescheefheid).

## Live: modelmatrix (wat we dekken)

Er is geen vaste “CI-modellenlijst” (live is opt-in), maar dit zijn de **aanbevolen** modellen om regelmatig te dekken op een dev-machine met sleutels.

### Moderne smoke-set (tool-calling + image)

Dit is de “gangbare modellen”-run die we werkend verwachten te houden:

- OpenAI (niet-Codex): `openai/gpt-5.2` (optioneel: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (optioneel: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (of `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` en `google/gemini-3-flash-preview` (vermijd oudere Gemini 2.x-modellen)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` en `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Draai Gateway-smoke met tools + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool-calling (Read + optionele Exec)

Kies er minimaal één per providerfamilie:

- OpenAI: `openai/gpt-5.2` (of `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (of `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (of `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Optionele extra dekking (nice-to-have):

- xAI: `xai/grok-4` (of de nieuwste beschikbare)
- Mistral: `mistral/`… (kies één “tools”-capabel model dat je hebt ingeschakeld)
- Cerebras: `cerebras/`… (als je toegang hebt)
- LM Studio: `lmstudio/`… (lokaal; tool-calling hangt af van API-modus)

### Vision: image verzenden (bijlage → multimodale boodschap)

Neem minimaal één image-capabel model op in `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI-varianten met vision, enz.) om de image-probe te testen.

### Aggregators / alternatieve gateways

Als je sleutels hebt ingeschakeld, ondersteunen we ook testen via:

- OpenRouter: `openrouter/...` (honderden modellen; gebruik `openclaw models scan` om kandidaten met tool+image-capaciteiten te vinden)
- OpenCode Zen: `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Meer providers die je in de live-matrix kunt opnemen (als je credentials/config hebt):

- Ingebouwd: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API), plus elke OpenAI-/Anthropic-compatibele proxy (LM Studio, vLLM, LiteLLM, enz.)

Tip: probeer niet “alle modellen” hard te coderen in docs. De gezaghebbende lijst is wat `discoverModels(...)` op jouw machine retourneert + welke sleutels beschikbaar zijn.

## Credentials (nooit committen)

Live-tests ontdekken credentials op dezelfde manier als de CLI. Praktische implicaties:

- Als de CLI werkt, zouden live-tests dezelfde sleutels moeten vinden.

- Als een live-test “geen creds” meldt, debug op dezelfde manier als `openclaw models list` / modelselectie.

- Profielstore: `~/.openclaw/credentials/` (voorkeur; dit is wat “profielsleutels” betekent in de tests)

- Config: `~/.openclaw/openclaw.json` (of `OPENCLAW_CONFIG_PATH`)

Als je op env-sleutels wilt vertrouwen (bijv. geëxporteerd in je `~/.profile`), draai lokale tests na `source ~/.profile`, of gebruik de Docker-runners hieronder (die kunnen `~/.profile` in de container mounten).

## Deepgram live (audiotranscriptie)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Inschakelen: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker-runners (optionele “werkt in Linux”-checks)

Deze draaien `pnpm test:live` binnen de repo-Docker-image, met je lokale configmap en werkruimte gemount (en `~/.profile` gesourced indien gemount):

- Directe modellen: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev-agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding-wizard (TTY, volledige scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway-netwerken (twee containers, WS-auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (custom extensie laden + registry-smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Nuttige env-vars:

- `OPENCLAW_CONFIG_DIR=...` (standaard: `~/.openclaw`) gemount naar `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (standaard: `~/.openclaw/workspace`) gemount naar `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (standaard: `~/.profile`) gemount naar `/home/node/.profile` en gesourced vóór het draaien van tests
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` om de run te beperken
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` om te garanderen dat creds uit de profielstore komen (niet uit env)

## Docs sanity

Draai docs-checks na doc-wijzigingen: `pnpm docs:list`.

## Offline regressie (CI-veilig)

Dit zijn “echte pijplijn”-regressies zonder echte providers:

- Gateway tool-calling (mock OpenAI, echte Gateway + agent-loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway-wizard (WS `wizard.start`/`wizard.next`, schrijft config + auth afgedwongen): `src/gateway/gateway.wizard.e2e.test.ts`

## Agentbetrouwbaarheid-evals (Skills)

We hebben al enkele CI-veilige tests die zich gedragen als “agentbetrouwbaarheid-evals”:

- Mock tool-calling via de echte Gateway + agent-loop (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End-to-end wizard-flows die sessiebedrading en config-effecten valideren (`src/gateway/gateway.wizard.e2e.test.ts`).

Wat nog ontbreekt voor skills (zie [Skills](/tools/skills)):

- **Besluitvorming:** wanneer skills in de prompt staan, kiest de agent de juiste skill (of vermijdt irrelevante)?
- **Naleving:** leest de agent `SKILL.md` vóór gebruik en volgt hij vereiste stappen/args?
- **Workflow-contracten:** meerbeurt-scenario’s die toolvolgorde, sessiegeschiedenis-overdracht en sandbox-grenzen afdwingen.

Toekomstige evals moeten eerst deterministisch blijven:

- Een scenario-runner met mock providers om tool-calls + volgorde, skill-bestandlezingen en sessiebedrading te valideren.
- Een kleine suite skill-gerichte scenario’s (gebruiken vs vermijden, gating, prompt-injectie).
- Optionele live-evals (opt-in, env-gated) pas nadat de CI-veilige suite aanwezig is.

## Regressies toevoegen (richtlijnen)

Wanneer je een provider/model-issue oplost dat in live is ontdekt:

- Voeg waar mogelijk een CI-veilige regressie toe (mock/stub provider, of leg exact de request-vormtransformatie vast)
- Als het inherent live-only is (rate-limits, auth-policies), houd de live-test beperkt en opt-in via env-variabelen
- Richt je bij voorkeur op de kleinste laag die de bug vangt:
  - provider request-conversie/replay-bug → direct models-test
  - Gateway sessie/geschiedenis/tool-pijplijn-bug → Gateway live-smoke of CI-veilige Gateway mock-test
