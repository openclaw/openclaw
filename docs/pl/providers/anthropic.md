---
summary: "„Użyj Anthropic Claude przez klucze API lub setup-token w OpenClaw”"
read_when:
  - Chcesz używać modeli Anthropic w OpenClaw
  - Chcesz używać setup-token zamiast kluczy API
title: "„Anthropic”"
---

# Anthropic (Claude)

Anthropic tworzy rodzinę modeli **Claude** i udostępnia do nich dostęp przez API.
W OpenClaw możesz uwierzytelniać się za pomocą klucza API lub **setup-token**.

## Opcja A: klucz API Anthropic

**Najlepsze dla:** standardowego dostępu do API i rozliczania opartego na użyciu.
Utwórz klucz API w konsoli Anthropic.

### Konfiguracja CLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Fragment konfiguracji

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Buforowanie promptów (API Anthropic)

OpenClaw obsługuje funkcję buforowania promptów Anthropic. Jest to **wyłącznie API**; uwierzytelnianie subskrypcyjne nie respektuje ustawień cache.

### Konfiguracja

Użyj parametru `cacheRetention` w konfiguracji modelu:

| Wartość | Czas cache | Opis                                                     |
| ------- | ---------- | -------------------------------------------------------- |
| `none`  | Brak cache | Wyłącza buforowanie promptów                             |
| `short` | 5 minut    | Domyślne dla uwierzytelniania kluczem API                |
| `long`  | 1 godzina  | Rozszerzony cache (wymaga flagi beta) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Ustawienia domyślne

Podczas używania uwierzytelniania kluczem API Anthropic, OpenClaw automatycznie stosuje `cacheRetention: "short"` (cache 5‑minutowy) dla wszystkich modeli Anthropic. Możesz to nadpisać, jawnie ustawiając `cacheRetention` w konfiguracji.

### Parametr starszy

Starszy parametr `cacheControlTtl` jest nadal obsługiwany w celu zachowania zgodności wstecznej:

- `"5m"` mapuje się na `short`
- `"1h"` mapuje się na `long`

Zalecamy migrację do nowego parametru `cacheRetention`.

OpenClaw zawiera flagę beta `extended-cache-ttl-2025-04-11` dla żądań API Anthropic; zachowaj ją, jeśli nadpisujesz nagłówki dostawcy (zob. [/gateway/configuration](/gateway/configuration)).

## Opcja B: setup-token Claude

**Najlepsze dla:** korzystania z subskrypcji Claude.

### Gdzie uzyskać setup-token

Setup-tokeny są tworzone przez **Claude Code CLI**, a nie w konsoli Anthropic. Możesz uruchomić to na **dowolnej maszynie**:

```bash
claude setup-token
```

Wklej token do OpenClaw (kreator: **Anthropic token (paste setup-token)**) lub uruchom go na hoście Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Jeśli wygenerowałeś token na innej maszynie, wklej go:

```bash
openclaw models auth paste-token --provider anthropic
```

### Konfiguracja CLI (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Fragment konfiguracji (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Uwagi

- Wygeneruj setup-token za pomocą `claude setup-token` i wklej go albo uruchom `openclaw models auth setup-token` na hoście Gateway.
- Jeśli zobaczysz komunikat „OAuth token refresh failed …” przy subskrypcji Claude, ponownie uwierzytelnij się przy użyciu setup-token. Zobacz [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Szczegóły uwierzytelniania i zasady ponownego użycia znajdują się w [/concepts/oauth](/concepts/oauth).

## Rozwiązywanie problemów

**Błędy 401 / token nagle nieważny**

- Uwierzytelnianie subskrypcji Claude może wygasnąć lub zostać cofnięte. Uruchom ponownie `claude setup-token`
  i wklej je na **hoście Gateway**.
- Jeśli logowanie w Claude CLI znajduje się na innej maszynie, użyj
  `openclaw models auth paste-token --provider anthropic` na hoście Gateway.

**Nie znaleziono klucza API dla dostawcy „anthropic”**

- Uwierzytelnianie jest **na agenta**. Nowi agenci nie dziedziczą kluczy głównego agenta.
- Uruchom ponownie onboarding dla tego agenta lub wklej setup-token / klucz API na
  hoście Gateway, a następnie zweryfikuj za pomocą `openclaw models status`.

**Nie znaleziono poświadczeń dla profilu `anthropic:default`**

- Uruchom `openclaw models status`, aby sprawdzić, który profil uwierzytelniania jest aktywny.
- Uruchom ponownie onboarding lub wklej setup-token / klucz API dla tego profilu.

**Brak dostępnego profilu uwierzytelniania (wszystkie w cooldownie / niedostępne)**

- Sprawdź `openclaw models status --json` pod kątem `auth.unusableProfiles`.
- Dodaj kolejny profil Anthropic lub poczekaj na zakończenie cooldownu.

Więcej: [/gateway/troubleshooting](/gateway/troubleshooting) oraz [/help/faq](/help/faq).
