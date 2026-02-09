---
summary: "Testkit: unit-/e2e-/live-suiter, Docker-runners og hvad hver test dækker"
read_when:
  - Når du kører tests lokalt eller i CI
  - Når du tilføjer regressioner for model-/udbyderfejl
  - Når du debugger gateway- og agentadfærd
title: "Test"
---

# Test

OpenClaw har tre Vitest-suiter (unit/integration, e2e, live) og et lille sæt Docker-runners.

Dette dokument er en “sådan tester vi”-guide:

- Hvad hver suite dækker (og hvad den bevidst _ikke_ dækker)
- Hvilke kommandoer du skal køre for almindelige workflows (lokalt, før push, debugging)
- Hvordan live-tests finder credentials og vælger modeller/udbydere
- Hvordan du tilføjer regressioner for virkelige model-/udbyderproblemer

## Hurtig start

De fleste dage:

- Fuld gate (forventet før push): `pnpm build && pnpm check && pnpm test`

Når du rører tests eller vil have ekstra sikkerhed:

- Coverage-gate: `pnpm test:coverage`
- E2E-suite: `pnpm test:e2e`

Når du debugger rigtige udbydere/modeller (kræver rigtige credentials):

- Live-suite (modeller + gateway-værktøj/billede-prober): `pnpm test:live`

Tip: når du kun har brug for ét fejlslagent tilfælde, så foretræk at indsnævre live-tests via allowlist-miljøvariablerne beskrevet nedenfor.

## Test-suiter (hvad kører hvor)

Tænk på suiterne som “stigende realisme” (og stigende flakiness/omkostning):

### Unit / integration (standard)

- Kommando: `pnpm test`
- Konfiguration: `vitest.config.ts`
- Filer: `src/**/*.test.ts`
- Omfang:
  - Rene unit-tests
  - In-process integrationstests (gateway-autentificering, routing, tooling, parsing, konfiguration)
  - Deterministiske regressioner for kendte bugs
- Forventninger:
  - Kører i CI
  - Ingen rigtige nøgler krævet
  - Skal være hurtig og stabil

### E2E (gateway smoke)

- Kommando: `pnpm test:e2e`
- Konfiguration: `vitest.e2e.config.ts`
- Filer: `src/**/*.e2e.test.ts`
- Omfang:
  - End-to-end-adfærd for gateway med flere instanser
  - WebSocket/HTTP-overflader, node-parring og tungere netværk
- Forventninger:
  - Kører i CI (når aktiveret i pipelinen)
  - Ingen rigtige nøgler krævet
  - Flere bevægelige dele end unit-tests (kan være langsommere)

### Live (rigtige udbydere + rigtige modeller)

- Kommando: `pnpm test:live`
- Konfiguration: `vitest.live.config.ts`
- Filer: `src/**/*.live.test.ts`
- Standard: **aktiveret** af `pnpm test:live` (sætter `OPENCLAW_LIVE_TEST=1`)
- Omfang:
  - “Virker denne udbyder/model faktisk _i dag_ med rigtige credentials?”
  - Fanger formatændringer hos udbydere, særheder ved tool-calling, autentificeringsproblemer og rate limit-adfærd
- Forventninger:
  - Ikke CI-stabil af design (rigtige netværk, rigtige udbyderpolitikker, kvoter, udfald)
  - Koster penge / bruger rate limits
  - Foretræk at køre indsnævrede delmængder frem for “alt”
  - Live-kørsler vil source `~/.profile` for at samle manglende API-nøgler op
  - Anthropic-nøglerotation: sæt `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (eller `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) eller flere `ANTHROPIC_API_KEY*`-variabler; tests vil retry ved rate limits

## Hvilken suite skal jeg køre?

Brug denne beslutningstabel:

- Redigerer logik/tests: kør `pnpm test` (og `pnpm test:coverage` hvis du ændrede meget)
- Rører gateway-netværk / WS-protokol / parring: tilføj `pnpm test:e2e`
- Debugger “min bot er nede” / udbyderspecifikke fejl / tool calling: kør en indsnævret `pnpm test:live`

## Live: model-smoke (profilnøgler)

Live-tests er opdelt i to lag, så vi kan isolere fejl:

- “Direkte model” fortæller os, om udbyderen/modellen overhovedet kan svare med den givne nøgle.
- “Gateway smoke” fortæller os, om hele gateway+agent-pipelinen virker for den model (sessioner, historik, værktøjer, sandbox-policy osv.).

### Lag 1: Direkte model-completion (ingen gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Mål:
  - Enumerere opdagede modeller
  - Bruge `getApiKeyForModel` til at vælge modeller, du har credentials til
  - Køre en lille completion pr. model (og målrettede regressioner hvor nødvendigt)
- Sådan aktiveres:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` hvis du kalder Vitest direkte)
- Sæt `OPENCLAW_LIVE_MODELS=modern` (eller `all`, alias for modern) for faktisk at køre denne suite; ellers springer den over for at holde `pnpm test:live` fokuseret på gateway smoke
- Sådan vælges modeller:
  - `OPENCLAW_LIVE_MODELS=modern` for at køre den moderne allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` er et alias for den moderne allowlist
  - eller `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (komma-allowlist)
- Sådan vælges udbydere:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (komma-allowlist)
- Hvor nøgler kommer fra:
  - Som standard: profil-store og env-fallbacks
  - Sæt `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` for at håndhæve **kun profil-store**
- Hvorfor dette findes:
  - Adskiller “udbyder-API er i stykker / nøgle er ugyldig” fra “gateway-agent-pipeline er i stykker”
  - Indeholder små, isolerede regressioner (eksempel: OpenAI Responses/Codex Responses reasoning replay + tool-call-flows)

### Lag 2: Gateway + dev-agent smoke (det “@openclaw” faktisk gør)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Mål:
  - Starte en in-process gateway
  - Oprette/patch’e en `agent:dev:*`-session (model-override pr. kørsel)
  - Iterere modeller-med-nøgler og verificere:
    - “meningsfuldt” svar (ingen værktøjer)
    - at et rigtigt værktøjs-kald virker (read-probe)
    - valgfrie ekstra værktøjs-prober (exec+read-probe)
    - OpenAI-regressionsstier (kun tool-call → opfølgning) fortsætter med at virke
- Probe-detaljer (så du hurtigt kan forklare fejl):
  - `read`-probe: testen skriver en nonce-fil i workspace og beder agenten om at `read` den og ekko nonce’en tilbage.
  - `exec+read`-probe: testen beder agenten om at `exec`-skrive en nonce i en temp-fil og derefter `read` den tilbage.
  - image-probe: testen vedhæfter en genereret PNG (kat + randomiseret kode) og forventer, at modellen returnerer `cat <CODE>`.
  - Implementationsreference: `src/gateway/gateway-models.profiles.live.test.ts` og `src/gateway/live-image-probe.ts`.
- Sådan aktiveres:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` hvis du kalder Vitest direkte)
- Sådan vælges modeller:
  - Standard: moderne allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` er et alias for den moderne allowlist
  - Eller sæt `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (eller kommasepareret liste) for at indsnævre
- Sådan vælges udbydere (undgå “OpenRouter alt”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (komma-allowlist)
- Værktøjs- + image-prober er altid slået til i denne live-test:
  - `read`-probe + `exec+read`-probe (værktøjs-stresstest)
  - image-probe kører, når modellen annoncerer understøttelse af billedinput
  - Flow (overordnet):
    - Testen genererer en lille PNG med “CAT” + random kode (`src/gateway/live-image-probe.ts`)
    - Sender den via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parser vedhæftninger til `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Indlejret agent videresender en multimodal brugermeddelelse til modellen
    - Assertion: svaret indeholder `cat` + koden (OCR-tolerance: mindre fejl tilladt)

Tip: for at se, hvad du kan teste på din maskine (og de præcise `provider/model`-id’er), kør:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Mål: verificere at Claude Code CLI setup-token (eller en indsat setup-token-profil) kan gennemføre en Anthropic-prompt.
- Aktiver:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` hvis du kalder Vitest direkte)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Token-kilder (vælg én):
  - Profil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Rå token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Model-override (valgfrit):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Opsætnings-eksempel:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI-backend smoke (Claude Code CLI eller andre lokale CLI’er)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Mål: validere Gateway + agent-pipelinen ved brug af en lokal CLI-backend uden at røre din standardkonfiguration.
- Aktiver:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` hvis du kalder Vitest direkte)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Standarder:
  - Model: `claude-cli/claude-sonnet-4-5`
  - Kommando: `claude`
  - Argumenter: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (valgfrit):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` for at sende en rigtig billedvedhæftning (stier injiceres i prompten).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` for at sende billedfilstier som CLI-argumenter i stedet for prompt-injektion.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (eller `"list"`) for at styre, hvordan billedargumenter sendes, når `IMAGE_ARG` er sat.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` for at sende en anden tur og validere resume-flow.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` for at beholde Claude Code CLI MCP-konfiguration aktiveret (standard deaktiverer MCP-konfiguration med en midlertidig tom fil).

Eksempel:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Anbefalede live-opskrifter

Indsnævrede, eksplicitte allowlists er hurtigst og mindst flaky:

- Enkelt model, direkte (ingen gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Enkelt model, gateway smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Tool calling på tværs af flere udbydere:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google-fokus (Gemini API-nøgle + Antigravity):
  - Gemini (API-nøgle): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Noter:

- `google/...` bruger Gemini API (API-nøgle).
- `google-antigravity/...` bruger Antigravity OAuth-bridge (Cloud Code Assist-lignende agent-endpoint).
- `google-gemini-cli/...` bruger den lokale Gemini CLI på din maskine (separat auth + tooling-særheder).
- Gemini API vs Gemini CLI:
  - API: OpenClaw kalder Googles hostede Gemini API over HTTP (API-nøgle / profil-auth); det er, hvad de fleste brugere mener med “Gemini”.
  - CLI: OpenClaw sheller ud til en lokal `gemini`-binær; den har sin egen auth og kan opføre sig anderledes (streaming/tool-understøttelse/versionsskævhed).

## Live: model-matrix (hvad vi dækker)

Der er ingen fast “CI-model-liste” (live er opt-in), men dette er de **anbefalede** modeller at dække regelmæssigt på en udviklermaskine med nøgler.

### Moderne smoke-sæt (tool calling + image)

Dette er den “almindelige modeller”-kørsel, vi forventer at holde kørende:

- OpenAI (ikke-Codex): `openai/gpt-5.2` (valgfrit: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (valgfrit: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (eller `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` og `google/gemini-3-flash-preview` (undgå ældre Gemini 2.x-modeller)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` og `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Kør gateway smoke med værktøjer + image:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baseline: tool calling (Read + valgfri Exec)

Vælg mindst én pr. udbyderfamilie:

- OpenAI: `openai/gpt-5.2` (eller `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (eller `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (eller `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Valgfri ekstra dækning (nice to have):

- xAI: `xai/grok-4` (eller seneste tilgængelige)
- Mistral: `mistral/`… (Vælg et “værktøjer” i stand model, du har aktiveret)
- Korn: »cerebras/«… (hvis du har adgang)
- LM Studio: `lmstudio/`… (lokal; værktøjskalering afhænger af API-tilstand)

### Vision: billedsend (vedhæftning → multimodal besked)

Inkludér mindst én model i 'OPENCLAW_LIVE_GATEWAY_MODELS' (Claude/Gemini/OpenAI varianter, der kan vision-capable etc.) at udøve billedsonden.

### Aggregatorer / alternative gateways

Hvis du har nøgler aktiveret, understøtter vi også test via:

- OpenRouter: `openrouter/...` (hundredvis af modeller; brug `openclaw models scan` til at finde tool+image-kapable kandidater)
- OpenCode Zen: `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Flere udbydere, du kan inkludere i live-matrixen (hvis du har creds/konfiguration):

- Indbyggede: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (custom endpoints): `minimax` (cloud/API) samt enhver OpenAI-/Anthropic-kompatibel proxy (LM Studio, vLLM, LiteLLM osv.)

Tip: prøv ikke at hardcode “alle modeller” i docs. Den autoritative liste er hvad `opdagelsesmodeller (...)` returnerer på din maskine + uanset nøgler er tilgængelige.

## Credentials (commit aldrig)

Live tests opdage legitimationsoplysninger på samme måde CLI gør. Praktiske konsekvenser:

- Hvis CLI’en virker, bør live-tests finde de samme nøgler.

- Hvis en live-test siger “ingen creds”, så debug på samme måde, som du ville debugge `openclaw models list` / modelvalg.

- Profil-store: `~/.openclaw/credentials/` (foretrukken; hvad “profilnøgler” betyder i tests)

- Konfiguration: `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`)

Hvis du vil stole på env-nøgler (fx eksporteret i din `~/.profile`), så kør lokale tests efter `source ~/.profile`, eller brug Docker-runners nedenfor (de kan mounte `~/.profile` ind i containeren).

## Deepgram live (lydtransskription)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Aktiver: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker-runners (valgfri “virker i Linux”-checks)

Disse kører `pnpm test:live` inde i repoets Docker-image, med mounting af din lokale config-mappe og workspace (og sourcing af `~/.profile` hvis mountet):

- Direkte modeller: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev-agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding-opsætningsguide (TTY, fuld scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway-netværk (to containere, WS-auth + health): `pnpm test:docker:gateway-network` (script: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (custom extension load + registry smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Nyttige miljøvariabler:

- `OPENCLAW_CONFIG_DIR=...` (standard: `~/.openclaw`) mountet til `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (standard: `~/.openclaw/workspace`) mountet til `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (standard: `~/.profile`) mountet til `/home/node/.profile` og sourced før tests kører
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` for at indsnævre kørslen
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` for at sikre, at creds kommer fra profil-store (ikke env)

## Docs-sanity

Kør docs-checks efter redigering af docs: `pnpm docs:list`.

## Offline regression (CI-sikker)

Disse er “rigtig pipeline”-regressioner uden rigtige udbydere:

- Gateway tool calling (mock OpenAI, rigtig gateway + agent-loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway-opsætningsguide (WS `wizard.start`/`wizard.next`, skriver konfiguration + auth håndhæves): `src/gateway/gateway.wizard.e2e.test.ts`

## Agent-pålideligheds-evalueringer (Skills)

Vi har allerede nogle CI-sikre tests, der opfører sig som “agent reliability evals”:

- Mock tool-calling gennem den rigtige gateway + agent-loop (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End-to-end opsætningsguide-flows, der validerer session-wiring og konfigurationseffekter (`src/gateway/gateway.wizard.e2e.test.ts`).

Hvad der stadig mangler for skills (se [Skills](/tools/skills)):

- **Decisioning:** når skills er listet i prompten, vælger agenten så den rigtige skill (eller undgår irrelevante)?
- **Compliance:** læser agenten `SKILL.md` før brug og følger de krævede trin/argumenter?
- **Workflow-kontrakter:** multi-turn-scenarier, der verificerer værktøjsrækkefølge, session-historik-overførsel og sandbox-grænser.

Fremtidige evals bør forblive deterministiske først:

- En scenario-runner, der bruger mock-udbydere til at verificere tool-calls + rækkefølge, skill-fil-læsninger og session-wiring.
- Et lille sæt skill-fokuserede scenarier (brug vs. undgå, gating, prompt injection).
- Valgfrie live-evals (opt-in, env-gated) først efter den CI-sikre suite er på plads.

## Tilføjelse af regressioner (vejledning)

Når du retter et udbyder-/modelproblem opdaget i live:

- Tilføj en CI-sikker regression, hvis muligt (mock/stub udbyder, eller fang den præcise request-shape-transformation)
- Hvis det i sagens natur er live-only (rate limits, auth-politikker), så hold live-testen snæver og opt-in via env-variabler
- Foretræk at målrette det mindste lag, der fanger bug’en:
  - fejl i udbyder-request-konvertering/replay → direkte model-tests
  - fejl i gateway-session/historik/tool-pipeline → gateway live-smoke eller CI-sikker gateway-mock-test
