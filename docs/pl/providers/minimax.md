---
summary: "Używaj MiniMax M2.1 w OpenClaw"
read_when:
  - Chcesz korzystać z modeli MiniMax w OpenClaw
  - Potrzebujesz wskazówek dotyczących konfiguracji MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax to firma AI, która tworzy rodzinę modeli **M2/M2.1**. Aktualne wydanie
skoncentrowane na programowaniu to **MiniMax M2.1** (23 grudnia 2025 r.),
zaprojektowane do złożonych zadań w warunkach rzeczywistych.

Źródło: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Przegląd modelu (M2.1)

MiniMax wyróżnia następujące usprawnienia w M2.1:

- Silniejsze **programowanie wielojęzyczne** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Lepszy **rozwój web/aplikacji** oraz jakość estetyczna wyników (w tym aplikacje natywne na mobile).
- Ulepszone przetwarzanie **złożonych instrukcji** dla przepływów pracy w stylu biurowym, bazujące na przeplatanym rozumowaniu i zintegrowwanym wykonywaniu ograniczeń.
- **Bardziej zwięzłe odpowiedzi** z mniejszym zużyciem tokenów i szybszymi pętlami iteracji.
- Silniejsza kompatybilność z **frameworkami narzędzi/agentów** oraz zarządzaniem kontekstem (Claude Code, Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Wyższej jakości wyniki **dialogów i pisania technicznego**.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Szybkość:** Lightning to „szybka” odmiana w dokumentacji cenowej MiniMax.
- **Koszt:** Cennik pokazuje ten sam koszt wejścia, ale Lightning ma wyższy koszt wyjścia.
- **Routing planu Coding:** Backend Lightning nie jest bezpośrednio dostępny w planie MiniMax Coding. MiniMax automatycznie kieruje większość żądań do Lightning, ale w czasie skoków ruchu wraca do standardowego backendu M2.1.

## Wybierz konfigurację

### MiniMax OAuth (Coding Plan) — zalecane

**Najlepsze dla:** szybkiej konfiguracji z MiniMax Coding Plan przez OAuth, bez potrzeby klucza API.

Włącz dołączoną wtyczkę OAuth i uwierzytelnij się:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Zostaniesz poproszony o wybór punktu końcowego:

- **Global** – użytkownicy międzynarodowi (`api.minimax.io`)
- **CN** – użytkownicy w Chinach (`api.minimaxi.com`)

Szczegóły znajdziesz w [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth).

### MiniMax M2.1 (klucz API)

**Najlepsze dla:** hostowanego MiniMax z API kompatybilnym z Anthropic.

Skonfiguruj przez CLI:

- Uruchom `openclaw configure`
- Wybierz **Model/auth**
- Wybierz **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 jako zapasowy (Opus jako główny)

**Najlepsze dla:** zachowania Opus 4.6 jako głównego, z przełączeniem awaryjnym na MiniMax M2.1.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Opcjonalnie: Lokalnie przez LM Studio (ręcznie)

**Najlepsze dla:** lokalnej inferencji z LM Studio.
Zaobserwowaliśmy bardzo dobre wyniki MiniMax M2.1 na wydajnym sprzęcie (np.
komputer stacjonarny/serwer) z użyciem lokalnego serwera LM Studio.

Skonfiguruj ręcznie przez `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Konfiguracja przez `openclaw configure`

Użyj interaktywnego kreatora konfiguracji, aby ustawić MiniMax bez edycji JSON:

1. Uruchom `openclaw configure`.
2. Wybierz **Model/auth**.
3. Wybierz **MiniMax M2.1**.
4. Gdy zostaniesz poproszony, wybierz domyślny model.

## Opcje konfiguracji

- `models.providers.minimax.baseUrl`: preferuj `https://api.minimax.io/anthropic` (kompatybilne z Anthropic); `https://api.minimax.io/v1` jest opcjonalne dla ładunków kompatybilnych z OpenAI.
- `models.providers.minimax.api`: preferuj `anthropic-messages`; `openai-completions` jest opcjonalne dla ładunków kompatybilnych z OpenAI.
- `models.providers.minimax.apiKey`: klucz API MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: zdefiniuj `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: aliasuj modele, które chcesz umieścić na liście dozwolonych.
- `models.mode`: zachowaj `merge`, jeśli chcesz dodać MiniMax obok wbudowanych.

## Uwagi

- Odwołania do modeli to `minimax/<model>`.
- API użycia Coding Plan: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (wymaga klucza planu coding).
- Zaktualizuj wartości cen w `models.json`, jeśli potrzebujesz dokładnego śledzenia kosztów.
- Link polecający do MiniMax Coding Plan (10% zniżki): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Zobacz [/concepts/model-providers](/concepts/model-providers), aby poznać zasady dostawców.
- Użyj `openclaw models list` i `openclaw models set minimax/MiniMax-M2.1` do przełączania.

## Rozwiązywanie problemów

### „Unknown model: minimax/MiniMax-M2.1”

Zwykle oznacza to, że **dostawca MiniMax nie jest skonfigurowany** (brak wpisu dostawcy
oraz brak profilu uwierzytelniania MiniMax/klucza w zmiennych środowiskowych). Poprawka dla tego wykrywania jest w **2026.1.12** (niewydana w momencie pisania). Rozwiąż problem, wykonując jedną z poniższych czynności:

- Zaktualizuj do **2026.1.12** (lub uruchom ze źródeł `main`), a następnie zrestartuj gateway.
- Uruchom `openclaw configure` i wybierz **MiniMax M2.1**, lub
- Dodaj blok `models.providers.minimax` ręcznie, lub
- Ustaw `MINIMAX_API_KEY` (lub profil uwierzytelniania MiniMax), aby dostawca mógł zostać wstrzyknięty.

Upewnij się, że identyfikator modelu jest **wrażliwy na wielkość liter**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Następnie sprawdź ponownie za pomocą:

```bash
openclaw models list
```
