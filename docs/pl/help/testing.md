---
summary: "Zestaw testów: pakiety unit/e2e/live, runner’y Docker oraz zakres każdego testu"
read_when:
  - Uruchamianie testów lokalnie lub w CI
  - Dodawanie regresji dla błędów modeli/dostawców
  - Debugowanie zachowania gateway + agenta
title: "Testowanie"
---

# Testowanie

OpenClaw ma trzy pakiety Vitest (unit/integration, e2e, live) oraz niewielki zestaw runnerów Docker.

Ten dokument to przewodnik „jak testujemy”:

- Co obejmuje każdy pakiet (i co celowo _nie_ obejmuje)
- Jakie polecenia uruchamiać w typowych workflowach (lokalnie, przed push, debugowanie)
- Jak testy live wykrywają poświadczenia oraz wybierają modele/dostawców
- Jak dodawać regresje dla rzeczywistych problemów modeli/dostawców

## Szybki start

Na co dzień:

- Pełna bramka (oczekiwana przed push): `pnpm build && pnpm check && pnpm test`

Gdy modyfikujesz testy lub chcesz większej pewności:

- Bramka pokrycia: `pnpm test:coverage`
- Pakiet E2E: `pnpm test:e2e`

Podczas debugowania rzeczywistych dostawców/modeli (wymaga prawdziwych poświadczeń):

- Pakiet live (modele + sondy narzędzi/obrazów gateway): `pnpm test:live`

Wskazówka: gdy potrzebujesz tylko jednego przypadku awarii, preferuj zawężanie testów live za pomocą zmiennych środowiskowych allowlist opisanych poniżej.

## Pakiety testów (co gdzie się uruchamia)

Myśl o pakietach jako o „rosnącym realizmie” (i rosnącej niestabilności/koszcie):

### Unit / integration (domyślny)

- Polecenie: `pnpm test`
- Konfiguracja: `vitest.config.ts`
- Pliki: `src/**/*.test.ts`
- Zakres:
  - Czyste testy jednostkowe
  - Integracyjne testy w procesie (uwierzytelnianie gateway, routowanie, narzędzia, parsowanie, konfiguracja)
  - Deterministyczne regresje dla znanych błędów
- Oczekiwania:
  - Uruchamiane w CI
  - Bez potrzeby prawdziwych kluczy
  - Powinny być szybkie i stabilne

### E2E (smoke gateway)

- Polecenie: `pnpm test:e2e`
- Konfiguracja: `vitest.e2e.config.ts`
- Pliki: `src/**/*.e2e.test.ts`
- Zakres:
  - Zachowanie end-to-end gateway w wielu instancjach
  - Powierzchnie WebSocket/HTTP, parowanie węzłów oraz cięższe aspekty sieciowe
- Oczekiwania:
  - Uruchamiane w CI (gdy włączone w pipeline)
  - Bez potrzeby prawdziwych kluczy
  - Więcej ruchomych części niż testy unit (mogą być wolniejsze)

### Live (prawdziwi dostawcy + prawdziwe modele)

- Polecenie: `pnpm test:live`
- Konfiguracja: `vitest.live.config.ts`
- Pliki: `src/**/*.live.test.ts`
- Domyślnie: **włączone** przez `pnpm test:live` (ustawia `OPENCLAW_LIVE_TEST=1`)
- Zakres:
  - „Czy ten dostawca/model faktycznie działa _dziś_ z prawdziwymi poświadczeniami?”
  - Wychwytywanie zmian formatów dostawców, osobliwości wywołań narzędzi, problemów z uwierzytelnianiem i zachowania limitów
- Oczekiwania:
  - Z założenia niestabilne w CI (prawdziwe sieci, polityki dostawców, limity, awarie)
  - Kosztują pieniądze / zużywają limity
  - Preferuj uruchamianie zawężonych podzbiorów zamiast „wszystkiego”
  - Uruchomienia live pobiorą `~/.profile` w celu uzupełnienia brakujących kluczy API
  - Rotacja kluczy Anthropic: ustaw `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."` (lub `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`) albo wiele zmiennych `ANTHROPIC_API_KEY*`; testy będą ponawiać próby przy limitach

## Który pakiet powinienem biegnąć?

Skorzystaj z tej tabeli decyzyjnej:

- Edycja logiki/testów: uruchom `pnpm test` (oraz `pnpm test:coverage`, jeśli zmieniłeś dużo)
- Zmiany w sieci gateway / protokole WS / parowaniu: dodaj `pnpm test:e2e`
- Debugowanie „mój bot nie działa” / awarie specyficzne dla dostawcy / wywołania narzędzi: uruchom zawężony `pnpm test:live`

## Live: smoke modeli (klucze profili)

Testy live są podzielone na dwie warstwy, aby izolować awarie:

- „Model bezpośredni” mówi nam, czy dostawca/model w ogóle odpowiada z danym kluczem.
- „Smoke gateway” mówi nam, czy cały pipeline gateway+agent działa dla tego modelu (sesje, historia, narzędzia, polityka sandbox, itd.).

### Warstwa 1: Bezpośrednie uzupełnienie modelu (bez gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Cel:
  - Enumeracja wykrytych modeli
  - Użycie `getApiKeyForModel` do wyboru modeli, do których masz poświadczenia
  - Uruchomienie małego uzupełnienia na model (oraz ukierunkowanych regresji tam, gdzie potrzeba)
- Jak włączyć:
  - `pnpm test:live` (lub `OPENCLAW_LIVE_TEST=1` przy bezpośrednim wywołaniu Vitest)
- Ustaw `OPENCLAW_LIVE_MODELS=modern` (lub `all`, alias nowoczesny), aby faktycznie uruchomić ten pakiet; w przeciwnym razie jest pomijany, by utrzymać `pnpm test:live` skupione na smoke gateway
- Jak wybierać modele:
  - `OPENCLAW_LIVE_MODELS=modern` aby uruchomić nowoczesną allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_MODELS=all` jest aliasem dla nowoczesnej allowlist
  - lub `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,..."` (allowlist rozdzielana przecinkami)
- Jak wybierać dostawców:
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"` (allowlist rozdzielana przecinkami)
- Skąd pochodzą klucze:
  - Domyślnie: magazyn profili oraz zapasowe zmienne środowiskowe
  - Ustaw `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`, aby wymusić **wyłącznie magazyn profili**
- Dlaczego to istnieje:
  - Rozdziela „API dostawcy jest zepsute / klucz jest nieprawidłowy” od „pipeline gateway agenta jest zepsuty”
  - Zawiera małe, izolowane regresje (przykład: OpenAI Responses/Codex Responses — odtwarzanie rozumowania + przepływy tool-call)

### Warstwa 2: Gateway + smoke agenta deweloperskiego (to, co faktycznie robi „@openclaw”)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Cel:
  - Uruchomienie gateway w procesie
  - Utworzenie/aktualizacja sesji `agent:dev:*` (nadpisanie modelu na uruchomienie)
  - Iteracja po modelach z kluczami i asercje:
    - „znacząca” odpowiedź (bez narzędzi)
    - działające rzeczywiste wywołanie narzędzia (sonda odczytu)
    - opcjonalne dodatkowe sondy narzędzi (sonda exec+read)
    - ścieżki regresji OpenAI (tylko tool-call → follow-up) nadal działają
- Szczegóły sond (aby szybko wyjaśniać awarie):
  - Sonda `read`: test zapisuje plik nonce w obszarze roboczym i prosi agenta, aby go `read` i zwrócił nonce.
  - Sonda `exec+read`: test prosi agenta o `exec`-zapis nonce do pliku tymczasowego, a następnie o jego `read`.
  - Sonda obrazu: test dołącza wygenerowany PNG (kot + losowy kod) i oczekuje, że model zwróci `cat <CODE>`.
  - Referencja implementacji: `src/gateway/gateway-models.profiles.live.test.ts` oraz `src/gateway/live-image-probe.ts`.
- Jak włączyć:
  - `pnpm test:live` (lub `OPENCLAW_LIVE_TEST=1` przy bezpośrednim wywołaniu Vitest)
- Jak wybierać modele:
  - Domyślnie: nowoczesna allowlist (Opus/Sonnet/Haiku 4.5, GPT-5.x + Codex, Gemini 3, GLM 4.7, MiniMax M2.1, Grok 4)
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` jest aliasem dla nowoczesnej allowlist
  - Albo ustaw `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"` (lub listę rozdzielaną przecinkami), aby zawęzić
- Jak wybierać dostawców (unikaj „OpenRouter wszystko”):
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"` (allowlist rozdzielana przecinkami)
- Sondy narzędzi i obrazów są zawsze włączone w tym teście live:
  - Sonda `read` + sonda `exec+read` (stress narzędzi)
  - Sonda obrazu działa, gdy model deklaruje obsługę wejścia obrazowego
  - Przepływ (wysoki poziom):
    - Test generuje mały PNG z napisem „CAT” + losowym kodem (`src/gateway/live-image-probe.ts`)
    - Wysyła go przez `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]`
    - Gateway parsuje załączniki do `images[]` (`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`)
    - Osadzony agent przekazuje multimodalną wiadomość użytkownika do modelu
    - Asercja: odpowiedź zawiera `cat` + kod (tolerancja OCR: drobne błędy dozwolone)

Wskazówka: aby zobaczyć, co możesz testować na swojej maszynie (oraz dokładne identyfikatory `provider/model`), uruchom:

```bash
openclaw models list
openclaw models list --json
```

## Live: smoke setup-token Anthropic

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Cel: zweryfikować, że setup-token Claude Code CLI (lub wklejony profil setup-token) potrafi ukończyć prompt Anthropic.
- Włączenie:
  - `pnpm test:live` (lub `OPENCLAW_LIVE_TEST=1` przy bezpośrednim wywołaniu Vitest)
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- Źródła tokenów (wybierz jedno):
  - Profil: `OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Surowy token: `OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- Nadpisanie modelu (opcjonalne):
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-6`

Przykład konfiguracji:

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: smoke backendu CLI (Claude Code CLI lub inne lokalne CLI)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Cel: zweryfikować pipeline Gateway + agent przy użyciu lokalnego backendu CLI, bez dotykania domyślnej konfiguracji.
- Włączenie:
  - `pnpm test:live` (lub `OPENCLAW_LIVE_TEST=1` przy bezpośrednim wywołaniu Vitest)
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- Domyślne:
  - Model: `claude-cli/claude-sonnet-4-5`
  - Polecenie: `claude`
  - Argumenty: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Nadpisania (opcjonalne):
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-6"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.3-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` aby wysłać prawdziwy załącznik obrazu (ścieżki są wstrzykiwane do promptu).
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` aby przekazywać ścieżki plików obrazów jako argumenty CLI zamiast wstrzyknięcia do promptu.
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` (lub `"list"`) do kontroli sposobu przekazywania argumentów obrazów, gdy ustawione jest `IMAGE_ARG`.
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` aby wysłać drugi krok i zweryfikować przepływ wznawiania.
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` aby zachować włączoną konfigurację MCP Claude Code CLI (domyślnie MCP jest wyłączane tymczasowym pustym plikiem).

Przykład:

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Zalecane recepty live

Wąskie, jawne allowlisty są najszybsze i najmniej podatne na flaki:

- Pojedynczy model, bezpośrednio (bez gateway):
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- Pojedynczy model, smoke gateway:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Wywołania narzędzi u kilku dostawców:
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-6,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Skupienie na Google (klucz API Gemini + Antigravity):
  - Gemini (klucz API): `OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity (OAuth): `OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

Uwagi:

- `google/...` używa API Gemini (klucz API).
- `google-antigravity/...` używa mostu OAuth Antigravity (endpoint agenta w stylu Cloud Code Assist).
- `google-gemini-cli/...` używa lokalnego Gemini CLI na Twojej maszynie (oddzielne uwierzytelnianie + osobliwości narzędzi).
- Gemini API vs Gemini CLI:
  - API: OpenClaw wywołuje hostowane API Gemini Google przez HTTP (klucz API / uwierzytelnianie profilu); to zwykle oznacza „Gemini” dla większości użytkowników.
  - CLI: OpenClaw wywołuje lokalny binarny `gemini`; ma własne uwierzytelnianie i może zachowywać się inaczej (strumieniowanie/obsługa narzędzi/rozjazd wersji).

## Live: macierz modeli (co obejmujemy)

Nie ma stałej „listy modeli CI” (live jest opt-in), ale poniżej znajdują się **zalecane** modele do regularnego testowania na maszynie deweloperskiej z kluczami.

### Nowoczesny zestaw smoke (wywołania narzędzi + obraz)

To „wspólne modele”, które spodziewamy się utrzymywać w działaniu:

- OpenAI (bez Codex): `openai/gpt-5.2` (opcjonalnie: `openai/gpt-5.1`)
- OpenAI Codex: `openai-codex/gpt-5.3-codex` (opcjonalnie: `openai-codex/gpt-5.3-codex-codex`)
- Anthropic: `anthropic/claude-opus-4-6` (lub `anthropic/claude-sonnet-4-5`)
- Google (Gemini API): `google/gemini-3-pro-preview` oraz `google/gemini-3-flash-preview` (unikaj starszych modeli Gemini 2.x)
- Google (Antigravity): `google-antigravity/claude-opus-4-6-thinking` oraz `google-antigravity/gemini-3-flash`
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Uruchom smoke gateway z narzędziami + obrazem:
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.3-codex,anthropic/claude-opus-4-6,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-6-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### Bazowe: wywołania narzędzi (Read + opcjonalnie Exec)

Wybierz co najmniej jeden z każdej rodziny dostawców:

- OpenAI: `openai/gpt-5.2` (lub `openai/gpt-5-mini`)
- Anthropic: `anthropic/claude-opus-4-6` (lub `anthropic/claude-sonnet-4-5`)
- Google: `google/gemini-3-flash-preview` (lub `google/gemini-3-pro-preview`)
- Z.AI (GLM): `zai/glm-4.7`
- MiniMax: `minimax/minimax-m2.1`

Opcjonalne dodatkowe pokrycie (mile widziane):

- xAI: `xai/grok-4` (lub najnowszy dostępny)
- Mistral: `mistral/`… (wybierz jeden model z obsługą „tools”, który masz włączony)
- Cerebras: `cerebras/`… (jeśli masz dostęp)
- LM Studio: `lmstudio/`… (lokalne; wywołania narzędzi zależą od trybu API)

### Wizja: wysyłanie obrazu (załącznik → wiadomość multimodalna)

Uwzględnij co najmniej jeden model z obsługą obrazów w `OPENCLAW_LIVE_GATEWAY_MODELS` (warianty Claude/Gemini/OpenAI z wizją itd.), aby uruchomić sondę obrazu. ćwiczenie sondy obrazu.

### Agregatory / alternatywne gateway

Jeśli masz włączone klucze, obsługujemy także testy przez:

- OpenRouter: `openrouter/...` (setki modeli; użyj `openclaw models scan`, aby znaleźć kandydatów z obsługą narzędzi+obrazu)
- OpenCode Zen: `opencode/...` (uwierzytelnianie przez `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)

Więcej dostawców, których możesz uwzględnić w macierzy live (jeśli masz poświadczenia/konfigurację):

- Wbudowane: `openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `zai`, `openrouter`, `opencode`, `xai`, `groq`, `cerebras`, `mistral`, `github-copilot`
- Przez `models.providers` (niestandardowe endpointy): `minimax` (chmura/API) oraz dowolny proxy kompatybilny z OpenAI/Anthropic (LM Studio, vLLM, LiteLLM itd.)

Wskazówka: nie próbuj na sztywno kodować „wszystkich modeli” w dokumentacji. Autorytatywna lista to to, co zwraca `discoverModels(...)` na Twojej maszynie + dostępne klucze.

## Poświadczenia (nigdy nie commituj)

Testy live wykrywają poświadczenia tak samo jak CLI. Praktyczne konsekwencje:

- Jeśli CLI działa, testy live powinny znaleźć te same klucze.

- Jeśli test live zgłasza „brak poświadczeń”, debuguj tak samo jak `openclaw models list` / wybór modelu.

- Magazyn profili: `~/.openclaw/credentials/` (preferowane; to oznacza „klucze profili” w testach)

- Konfiguracja: `~/.openclaw/openclaw.json` (lub `OPENCLAW_CONFIG_PATH`)

Jeśli chcesz polegać na kluczach z env (np. wyeksportowanych w Twoim `~/.profile`), uruchom testy lokalne po `source ~/.profile`, albo użyj runnerów Docker poniżej (mogą montować `~/.profile` do kontenera).

## Deepgram live (transkrypcja audio)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Włączenie: `DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Runnery Docker (opcjonalne sprawdzenia „działa w Linuxie”)

Uruchamiają `pnpm test:live` wewnątrz obrazu Docker repozytorium, montując lokalny katalog konfiguracji i obszar roboczy (oraz źródłując `~/.profile`, jeśli zamontowane):

- Modele bezpośrednie: `pnpm test:docker:live-models` (skrypt: `scripts/test-live-models-docker.sh`)
- Gateway + agent deweloperski: `pnpm test:docker:live-gateway` (skrypt: `scripts/test-live-gateway-models-docker.sh`)
- Kreator onboardingu (TTY, pełne scaffoldowanie): `pnpm test:docker:onboard` (skrypt: `scripts/e2e/onboard-docker.sh`)
- Sieciowanie gateway (dwa kontenery, uwierzytelnianie WS + health): `pnpm test:docker:gateway-network` (skrypt: `scripts/e2e/gateway-network-docker.sh`)
- Wtyczki (ładowanie niestandardowych rozszerzeń + smoke rejestru): `pnpm test:docker:plugins` (skrypt: `scripts/e2e/plugins-docker.sh`)

Przydatne zmienne środowiskowe:

- `OPENCLAW_CONFIG_DIR=...` (domyślnie: `~/.openclaw`) montowane do `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...` (domyślnie: `~/.openclaw/workspace`) montowane do `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...` (domyślnie: `~/.profile`) montowane do `/home/node/.profile` i źródłowane przed uruchomieniem testów
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` do zawężania uruchomienia
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` aby zapewnić, że poświadczenia pochodzą z magazynu profili (a nie z env)

## Dokumentacja sanitarna

Uruchom sprawdzanie dokumentów po edycjach: `pnpm docs:list`.

## Regresje offline (bezpieczne dla CI)

To regresje „prawdziwego pipeline’u” bez prawdziwych dostawców:

- Wywołania narzędzi gateway (mock OpenAI, rzeczywisty gateway + pętla agenta): `src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Kreator gateway (WS `wizard.start`/`wizard.next`, zapisuje konfigurację + wymuszone uwierzytelnianie): `src/gateway/gateway.wizard.e2e.test.ts`

## Ewalucje niezawodności agenta (skills)

Mamy już kilka bezpiecznych dla CI testów zachowujących się jak „ewaluacje niezawodności agenta”:

- Mockowane wywołania narzędzi przez rzeczywisty gateway + pętlę agenta (`src/gateway/gateway.tool-calling.mock-openai.test.ts`).
- Przepływy kreatora end-to-end, które weryfikują okablowanie sesji i efekty konfiguracji (`src/gateway/gateway.wizard.e2e.test.ts`).

Czego wciąż brakuje dla skills (zobacz [Skills](/tools/skills)):

- **Decyzyjność:** gdy skills są wymienione w prompcie, czy agent wybiera właściwą skill (lub unika nieistotnych)?
- **Zgodność:** czy agent czyta `SKILL.md` przed użyciem i stosuje wymagane kroki/argumenty?
- **Kontrakty workflow:** scenariusze wieloturowe, które asercyjnie sprawdzają kolejność narzędzi, przenoszenie historii sesji i granice sandbox.

Przyszłe ewaluacje powinny najpierw pozostać deterministyczne:

- Runner scenariuszy z mockowanymi dostawcami do asercji wywołań narzędzi + kolejności, odczytów plików skills i okablowania sesji.
- Mały zestaw scenariuszy skupionych na skills (użyj vs unikaj, bramkowanie, prompt injection).
- Opcjonalne ewaluacje live (opt-in, bramkowane env) dopiero po wdrożeniu pakietu bezpiecznego dla CI.

## Dodawanie regresji (wskazówki)

Gdy naprawiasz problem dostawcy/modelu wykryty w live:

- Dodaj regresję bezpieczną dla CI, jeśli to możliwe (mock/stub dostawcy lub przechwycenie dokładnej transformacji kształtu żądania)
- Jeśli to z natury tylko live (limity, polityki uwierzytelniania), utrzymuj test live wąski i opt-in przez zmienne env
- Preferuj celowanie w najmniejszą warstwę, która wychwytuje błąd:
  - błąd konwersji/odtwarzania żądania dostawcy → test modeli bezpośrednich
  - błąd pipeline’u sesji/historii/narzędzi gateway → smoke live gateway lub bezpieczny dla CI test mockowany gateway
