---
summary: "Testkit: unit-/e2e-/live-sviter, Docker-runners och vad varje test täcker"
read_when:
  - När du kör tester lokalt eller i CI
  - När du lägger till regressioner för modell-/leverantörsbuggar
  - Vid felsökning av gateway- och agentbeteende
title: "Testning"
---

# Testning

OpenClaw har tre Vitest-sviter (unit/integration, e2e, live) och en liten uppsättning Docker-runners.

Detta dokument är en ”så testar vi”-guide:

- Vad varje svit täcker (och vad den medvetet _inte_ täcker)
- Vilka kommandon som ska köras för vanliga arbetsflöden (lokalt, före push, felsökning)
- Hur live-tester hittar autentiseringsuppgifter och väljer modeller/leverantörer
- Hur du lägger till regressioner för verkliga modell-/leverantörsproblem

## Snabbstart

De flesta dagar:

- Full grind (förväntas före push): `pnpm build && pnpm check && pnpm test`

När du rör tester eller vill ha extra säkerhet:

- Täckningsgrind: `pnpm test:coverage`
- E2E-svit: `pnpm test:e2e`

Vid felsökning av verkliga leverantörer/modeller (kräver riktiga uppgifter):

- Live-svit (modeller + gateway-verktygs-/bildprober): `pnpm test:live`

Tips: när du bara behöver ett enda fall som fallerar, föredra att snäva in live-tester via allowlist‑miljövariablerna som beskrivs nedan.

## Testsviter (vad körs var)

Se sviterna som ”ökande realism” (och ökande flakighet/kostnad):

### Unit / integration (standard)

- Kommando: `pnpm test`
- Konfig: `vitest.config.ts`
- Filer: `src/**/*.test.ts`
- Omfattning:
  - Rena unit‑tester
  - Integrations­tester i processen (gateway‑auth, routning, verktyg, parsning, konfig)
  - Deterministiska regressioner för kända buggar
- Förväntningar:
  - Körs i CI
  - Inga riktiga nycklar krävs
  - Ska vara snabba och stabila

### E2E (gateway‑smoke)

- Kommando: `pnpm test:e2e`
- Konfig: `vitest.e2e.config.ts`
- Filer: `src/**/*.e2e.test.ts`
- Omfattning:
  - End‑to‑end‑beteende för gateway med flera instanser
  - WebSocket/HTTP‑ytor, nodparning och tyngre nätverk
- Förväntningar:
  - Körs i CI (när aktiverat i pipelinen)
  - Inga riktiga nycklar krävs
  - Fler rörliga delar än unit‑tester (kan vara långsammare)

### Live (riktiga leverantörer + riktiga modeller)

- Kommando: `pnpm test:live`
- Konfig: `vitest.live.config.ts`
- Filer: `src/**/*.live.test.ts`
- Standard: **aktiverad** av `pnpm test:live` (sätter `OPENCLAW_LIVE_TEST=1`)
- Omfattning:
  - ”Fungerar den här leverantören/modellen faktiskt _idag_ med riktiga uppgifter?”
  - Fångar formatändringar hos leverantörer, egenheter i verktygsanrop, auth‑problem och rate‑limit‑beteende
- Förväntningar:
  - Inte CI‑stabil per design (riktiga nätverk, riktiga policyer, kvoter, avbrott)
  - Kostar pengar / använder rate limits
  - Föredra att köra snäva delmängder i stället för ”allt”
  - Live‑körningar hämtar `~/.profile` för att plocka upp saknade API‑nycklar
  - Anthropic‑nyckelrotation: sätt `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (eller `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) eller flera `ANTHROPIC_API_KEY*`‑variabler; testerna försöker igen vid rate limits

## Vilken svit ska jag köra?

Använd denna beslutstabell:

- Redigerar logik/tester: kör `pnpm test` (och `pnpm test:coverage` om du ändrade mycket)
- Rör gateway‑nätverk / WS‑protokoll / parning: lägg till `pnpm test:e2e`
- Felsöker ”min bot är nere” / leverantörsspecifika fel / verktygsanrop: kör en snäv `pnpm test:live`

## Live: modell‑smoke (profilnycklar)

Live‑tester är uppdelade i två lager så att vi kan isolera fel:

- ”Direkt modell” säger oss att leverantören/modellen kan svara över huvud taget med given nyckel.
- ”Gateway‑smoke” säger oss att hela gateway+agent‑pipen fungerar för den modellen (sessioner, historik, verktyg, sandbox‑policy osv.).

### Lager 1: Direkt modell‑completion (ingen gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Mål:
  - Lista upptäckta modeller
  - Använd `getApiKeyForModel` för att välja modeller du har uppgifter för
  - Kör en liten completion per modell (och riktade regressioner vid behov)
- Så aktiverar du:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` om du anropar Vitest direkt)
- Sätt `OPENCLAW_LIVE_MODELS=modern` (eller `all`, alias för modern) för att faktiskt köra denna svit; annars hoppas den över för att hålla `pnpm test:live` fokuserad på gateway‑smoke
- Hur du väljer modeller:
  - `OPENCLAW_LIVE_MODELS=modern` för att köra den moderna allowlisten (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` är ett alias för den moderna allowlisten
  - eller `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (komma‑allowlist)
- Hur du väljer leverantörer:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (komma‑allowlist)
- Var nycklar kommer ifrån:
  - Som standard: profil­store och env‑fallbacks
  - Sätt `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` för att tvinga **endast profil­store**
- Varför detta finns:
  - Separera ”leverantörs‑API är trasigt / nyckeln är ogiltig” från ”gateway‑agent‑pipen är trasig”
  - Innehåller små, isolerade regressioner (exempel: OpenAI Responses/Codex Responses‑resonemangs‑replay + verktygsanropsflöden)

### Lager 2: Gateway + dev‑agent‑smoke (det ”@openclaw” faktiskt gör)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Mål:
  - Starta en gateway i processen
  - Skapa/patcha en `agent:dev:*`‑session (modellöverskuggning per körning)
  - Iterera modeller‑med‑nycklar och verifiera:
    - ”meningsfullt” svar (inga verktyg)
    - att ett riktigt verktygsanrop fungerar (read‑probe)
    - valfria extra verktygsprober (exec+read‑probe)
    - OpenAI‑regressionsvägar (endast verktygsanrop → uppföljning) fortsätter fungera
- ProbdetaIjer (så att du snabbt kan förklara fel):
  - `read`‑probe: testet skriver en nonce‑fil i arbetsytan och ber agenten att `read` den och eko‑returnera noncen.
  - `exec+read`‑probe: testet ber agenten att `exec`‑skriva en nonce till en tempfil och sedan `read` den tillbaka.
  - bild‑probe: testet bifogar en genererad PNG (katt + randomiserad kod) och förväntar sig att modellen returnerar `cat <CODE>`.
  - Implementationsreferens: `src/gateway/gateway-models.profiles.live.test.ts` och `src/gateway/live-image-probe.ts`.
- Så aktiverar du:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` om du anropar Vitest direkt)
- Hur du väljer modeller:
  - Standard: modern allowlist (Opus/Sonnet/Haiku 4.5, GPT‑5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` är ett alias för den moderna allowlisten
  - Eller sätt `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (eller kommaseparerad lista) för att snäva in
- Hur du väljer leverantörer (undvik ”OpenRouter allt”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (komma‑allowlist)
- Verktygs‑ och bildprober är alltid på i detta live‑test:
  - `read`‑probe + `exec+read`‑probe (verktygsstress)
  - bild‑probe körs när modellen annonserar stöd för bildindata
  - Flöde (översikt):
    - Testet genererar en liten PNG med ”CAT” + slumpkod (`src/gateway/live-image-probe.ts`)
    - Skickar den via `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parsar bilagor till `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Inbäddad agent vidarebefordrar ett multimodalt användarmeddelande till modellen
    - Assertion: svaret innehåller `cat` + koden (OCR‑tolerans: mindre misstag tillåtna)

Tips: för att se vad du kan testa på din maskin (och exakta `provider/model`‑ID:n), kör:

```bash
openclaw models list
openclaw models list --json
```

## Live: Anthropic setup‑token‑smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Mål: verifiera att Claude Code CLI setup‑token (eller en inklistrad setup‑token‑profil) kan slutföra en Anthropic‑prompt.
- Aktivera:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` om du anropar Vitest direkt)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Tokenkällor (välj en):
  - Profil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Rå token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Modellöverskuggning (valfritt):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Exempel på setup:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI‑backend‑smoke (Claude Code CLI eller andra lokala CLI:er)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Mål: validera Gateway + agent‑pipen med en lokal CLI‑backend, utan att röra din standardkonfig.
- Aktivera:
  - `pnpm test:live` (eller `OPENCLAW_LIVE_TEST=1` om du anropar Vitest direkt)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Standardvärden:
  - Modell: `claude-cli/claude-sonnet-4-5`
  - Kommando: `claude`
  - Argument: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Överskuggningar (valfritt):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` för att skicka en riktig bildbilaga (sökvägar injiceras i prompten).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` för att skicka bildfilsökvägar som CLI‑argument i stället för prompt‑injektion.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (eller `"list"`) för att styra hur bildargument skickas när `IMAGE_ARG` är satt.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` för att skicka en andra tur och validera återupptagningsflöde.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` för att behålla Claude Code CLI MCP‑konfig aktiverad (standard inaktiverar MCP‑konfig med en temporär tom fil).

Exempel:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Rekommenderade live‑recept

Smala, explicita allowlists är snabbast och minst flakiga:

- Enskild modell, direkt (ingen gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Enskild modell, gateway‑smoke:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Verktygsanrop över flera leverantörer:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google‑fokus (Gemini API‑nyckel + Antigravity):
  - Gemini (API‑nyckel): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Noteringar:

- `google/...` använder Gemini API (API‑nyckel).
- `google-antigravity/...` använder Antigravity OAuth‑bryggan (Cloud Code Assist‑liknande agent‑endpoint).
- `google-gemini-cli/...` använder den lokala Gemini CLI på din maskin (separat auth + verktygsegenheter).
- Gemini API vs Gemini CLI:
  - API: OpenClaw anropar Googles hostade Gemini API över HTTP (API‑nyckel / profil‑auth); detta är vad de flesta menar med ”Gemini”.
  - CLI: OpenClaw shellar ut till en lokal `gemini`‑binär; den har egen auth och kan bete sig annorlunda (streaming/verktygsstöd/versionsskillnader).

## Live: modellmatris (vad vi täcker)

Det finns ingen fast ”CI‑modellista” (live är opt‑in), men detta är de **rekommenderade** modellerna att täcka regelbundet på en dev‑maskin med nycklar.

### Modern smoke‑uppsättning (verktygsanrop + bild)

Detta är ”vanliga modeller”‑körningen som vi förväntar oss ska fortsätta fungera:

- OpenAI (icke‑Codex): `openai/gpt-5.2` (valfritt: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (valfritt: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (eller `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` och `google/gemini-3-flash-preview` (undvik äldre Gemini 2.x‑modeller)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` och `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Kör gateway‑smoke med verktyg + bild:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Baslinje: verktygsanrop (Read + valfri Exec)

Välj minst en per leverantörsfamilj:

- OpenAI: `openai/gpt-5.2` (eller `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (eller `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (eller `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Valfri extra täckning (trevligt att ha):

- xAI: `xai/grok-4` (eller senaste tillgängliga)
- Mistral: `mistral/`… (välj en “verktyg” kapabel modell som du har aktiverat)
- Cerebras: `cerebra/`… (om du har tillgång)
- LM Studio: `lmstudio/`… (lokalt; verktygssamtal beror på API-läge)

### Vision: skicka bild (bilaga → multimodalt meddelande)

Inkludera minst en bildkapabel modell i `OPENCLAW_LIVE_GATEWAY_MODELS` (Claude/Gemini/OpenAI visionkapabla varianter, etc.) att utöva bilden sonden.

### Aggregatorer / alternativa gateways

Om du har nycklar aktiverade stöder vi även testning via:

- OpenRouter: `openrouter/...` (hundratals modeller; använd `openclaw models scan` för att hitta kandidater med verktyg+bild)
- OpenCode Zen: `opencode/...` (auth via `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Fler leverantörer du kan inkludera i live‑matrisen (om du har uppgifter/konfig):

- Inbyggda: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Via `models.providers` (anpassade endpoints): `minimax` (moln/API), plus valfri OpenAI-/Anthropic‑kompatibel proxy (LM Studio, vLLM, LiteLLM, m.fl.)

Tips: Försök inte att hardcode “alla modeller” i dokument. Den auktoritativa listan är vad `discoverModels(...)` returnerar på din maskin + vad som helst nycklar är tillgängliga.

## Autentiseringsuppgifter (committa aldrig)

Livetester upptäcker referenser på samma sätt som CLI gör. Praktiska konsekvenser:

- Om CLI:t fungerar bör live‑tester hitta samma nycklar.

- Om ett live‑test säger ”inga uppgifter”, felsök på samma sätt som du skulle felsöka `openclaw models list` / modellval.

- Profil‑store: `~/.openclaw/credentials/` (föredras; det som ”profilnycklar” betyder i testerna)

- Konfig: `~/.openclaw/openclaw.json` (eller `OPENCLAW_CONFIG_PATH`)

Om du vill förlita dig på env‑nycklar (t.ex. exporterade i din `~/.profile`), kör lokala tester efter `source ~/.profile`, eller använd Docker‑runners nedan (de kan montera `~/.profile` i containern).

## Deepgram live (ljudtranskribering)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Aktivera: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker‑runners (valfria ”fungerar i Linux”‑kontroller)

Dessa kör `pnpm test:live` inuti repo‑Docker‑imagen och monterar din lokala konfig‑katalog och arbetsyta (och sourcar `~/.profile` om monterad):

- Direkta modeller: `pnpm test:docker:live-models` (skript: `scripts/test-live-models-docker.sh`)
- Gateway + dev‑agent: `pnpm test:docker:live-gateway` (skript: `scripts/test-live-gateway-models-docker.sh`)
- Introduktionsguide (TTY, full scaffold): `pnpm test:docker:onboard` (skript: `scripts/e2e/onboard-docker.sh`)
- Gateway‑nätverk (två containrar, WS‑auth + hälsa): `pnpm test:docker:gateway-network` (skript: `scripts/e2e/gateway-network-docker.sh`)
- Plugins (laddning av anpassad extension + registry‑smoke): `pnpm test:docker:plugins` (skript: `scripts/e2e/plugins-docker.sh`)

Användbara miljövariabler:

- `OPENCLAW_CONFIG_DIR=...` (standard: `~/.openclaw`) monterad till `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (standard: `~/.openclaw/workspace`) monterad till `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (standard: `~/.profile`) monterad till `/home/node/.profile` och sourcad före testkörning
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` för att snäva in körningen
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` för att säkerställa att uppgifter kommer från profil‑store (inte env)

## Dokumentations‑sanity

Kör dokumentationskontroller efter doc‑ändringar: `pnpm docs:list`.

## Offline‑regression (CI‑säker)

Detta är ”verklig pipeline”‑regressioner utan riktiga leverantörer:

- Gateway‑verktygsanrop (mockad OpenAI, riktig gateway + agent‑loop): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway‑guide (WS `wizard.start`/`wizard.next`, skriver konfig + auth framtvingas): `src/gateway/gateway.wizard.e2e.test.ts`

## Agenttillförlitlighets‑evals (skills)

Vi har redan några CI‑säkra tester som beter sig som ”agenttillförlitlighets‑evals”:

- Mockade verktygsanrop genom den riktiga gateway + agent‑loopen (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- End‑to‑end‑guideflöden som validerar sessionskoppling och konfigeffekter (`src/gateway/gateway.wizard.e2e.test.ts`).

Vad som fortfarande saknas för skills (se [Skills](/tools/skills)):

- **Beslutsfattande:** när skills listas i prompten, väljer agenten rätt skill (eller undviker irrelevanta)?
- **Efterlevnad:** läser agenten `SKILL.md` före användning och följer nödvändiga steg/argument?
- **Arbetsflödeskontrakt:** fler‑turs‑scenarier som verifierar verktygsordning, överföring av sessionshistorik och sandbox‑gränser.

Framtida evals bör först vara deterministiska:

- En scenariokörare som använder mockade leverantörer för att verifiera verktygsanrop + ordning, läsning av skill‑filer och sessionskoppling.
- En liten svit med skill‑fokuserade scenarier (använd vs undvik, gating, prompt‑injektion).
- Valfria live‑evals (opt‑in, env‑styrda) först efter att den CI‑säkra sviten finns på plats.

## Lägga till regressioner (vägledning)

När du fixar ett leverantörs-/modellproblem som upptäckts i live:

- Lägg till en CI‑säker regression om möjligt (mocka/stubba leverantören, eller fånga exakt request‑transformering)
- Om det är inneboende live‑endast (rate limits, auth‑policyer), håll live‑testet smalt och opt‑in via env‑variabler
- Föredra att rikta in dig på det minsta lagret som fångar buggen:
  - bug i leverantörsrequest‑konvertering/återspelning → direkt‑modell‑test
  - bug i gateway‑session/historik/verktygs‑pipeline → gateway‑live‑smoke eller CI‑säker gateway‑mocktest
