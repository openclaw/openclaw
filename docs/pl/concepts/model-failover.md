---
summary: "Jak OpenClaw rotuje profile uwierzytelniania i wykonuje przełączanie awaryjne między modelami"
read_when:
  - Diagnozowanie rotacji profili uwierzytelniania, czasów odnowienia (cooldown) lub zachowania przełączania awaryjnego modeli
  - Aktualizowanie reguł przełączania awaryjnego dla profili uwierzytelniania lub modeli
title: "Model nieudany"
---

# Modelowe przechwytywanie awarii

OpenClaw obsługuje awarie w dwóch etapach:

1. **Rotacja profili uwierzytelniania** w ramach bieżącego dostawcy.
2. **Przełączanie awaryjne modelu** do następnego modelu w `agents.defaults.model.fallbacks`.

Ten dokument wyjaśnia reguły czasu wykonywania oraz dane, które je wspierają.

## Przechowywanie uwierzytelniania (klucze + OAuth)

OpenClaw używa **profili uwierzytelniania** zarówno dla kluczy API, jak i tokenów OAuth.

- Sekrety są przechowywane w `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Konfiguracje `auth.profiles` / `auth.order` to **wyłącznie metadane i routowanie** (bez sekretów).
- Plik OAuth tylko do importu (legacy): `~/.openclaw/credentials/oauth.json` (importowany do `auth-profiles.json` przy pierwszym użyciu).

Więcej szczegółów: [/concepts/oauth](/concepts/oauth)

Typy poświadczeń:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` dla niektórych dostawców)

## Identyfikatory profili

Logowania OAuth tworzą odrębne profile, dzięki czemu może współistnieć wiele kont.

- Domyślnie: `provider:default`, gdy nie ma dostępnego adresu e-mail.
- OAuth z e-mailem: `provider:<email>` (na przykład `google-antigravity:user@gmail.com`).

Profile znajdują się w `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` pod `profiles`.

## Kolejność rotacji

Gdy dostawca ma wiele profili, OpenClaw wybiera kolejność w następujący sposób:

1. **Jawna konfiguracja**: `auth.order[provider]` (jeśli ustawiona).
2. **Profile skonfigurowane**: `auth.profiles` przefiltrowane według dostawcy.
3. **Profile zapisane**: wpisy w `auth-profiles.json` dla dostawcy.

Jeśli nie skonfigurowano jawnej kolejności, OpenClaw stosuje kolejność round‑robin:

- **Klucz główny:** typ profilu (**OAuth przed kluczami API**).
- **Klucz pomocniczy:** `usageStats.lastUsed` (najstarsze najpierw, w obrębie każdego typu).
- **Profile w cooldown/wyłączone** są przenoszone na koniec, uporządkowane według najszybszego wygaśnięcia.

### Przywiązanie do sesji (przyjazne dla cache)

OpenClaw **przypina wybrany profil uwierzytelniania do sesji**, aby utrzymać ciepłe cache dostawcy.
Nie wykonuje rotacji przy każdym żądaniu. Przypięty profil jest używany ponownie do momentu, gdy:

- sesja zostanie zresetowana (`/new` / `/reset`)
- zakończy się kompaktowanie (inkrementuje się licznik kompaktowania)
- profil trafi do cooldown lub zostanie wyłączony

Ręczny wybór przez `/model …@<profileId>` ustawia **nadpisanie użytkownika** dla tej sesji
i nie podlega automatycznej rotacji do rozpoczęcia nowej sesji.

Profile przypięte automatycznie (wybrane przez router sesji) są traktowane jako **preferencja**:
są próbowane w pierwszej kolejności, ale OpenClaw może przełączyć się na inny profil
przy limitach szybkości lub timeoutach.
Profile przypięte przez użytkownika pozostają
zablokowane na tym profilu; jeśli zawiedzie i skonfigurowano przełączanie awaryjne modeli,
OpenClaw przechodzi do następnego modelu zamiast zmieniać profil.

### Dlaczego OAuth może „wyglądać na zagubiony”

Jeśli masz zarówno profil OAuth, jak i profil klucza API dla tego samego dostawcy,
round‑robin może przełączać się między nimi pomiędzy wiadomościami, o ile nie są przypięte. Aby wymusić pojedynczy profil:

- Przypnij za pomocą `auth.order[provider] = ["provider:profileId"]`, lub
- Użyj nadpisania per sesja przez `/model …` z nadpisaniem profilu
  (jeśli jest obsługiwane przez Twoje UI/powierzchnię czatu).

## Cooldowny

Gdy profil zawiedzie z powodu błędów uwierzytelniania/limitów szybkości
(lub timeoutu, który wygląda jak limit szybkości), OpenClaw oznacza go jako
będący w cooldown i przechodzi do następnego profilu.
Błędy formatu/nieprawidłowych
żądań (na przykład błędy walidacji identyfikatora wywołania narzędzia Cloud Code Assist)
są traktowane jako kwalifikujące się do przełączania awaryjnego i używają tych samych cooldownów.

Cooldowny używają wykładniczego backoffu:

- 1 minuta
- 5 minut
- 25 minut
- 1 godzina (limit)

Stan jest przechowywany w `auth-profiles.json` pod `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Wyłączenia rozliczeń

Awarie rozliczeń/kredytów (na przykład „niewystarczające kredyty” / „zbyt niski stan kredytów”)
są traktowane jako kwalifikujące się do przełączania awaryjnego, ale zwykle nie są przejściowe. Zamiast krótkiego cooldownu OpenClaw oznacza profil jako **wyłączony** (z dłuższym backoffem)
i przełącza się na następny profil/dostawcę.

Stan jest przechowywany w `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Ustawienia domyślne:

- Backoff rozliczeń zaczyna się od **5 godzin**, podwaja się przy każdej awarii rozliczeń i ma limit **24 godzin**.
- Liczniki backoffu resetują się, jeśli profil nie zawiódł przez **24 godziny** (konfigurowalne).

## Model rezerwowy

Jeśli wszystkie profile dla dostawcy zawiodą, OpenClaw przechodzi do następnego modelu w
`agents.defaults.model.fallbacks`. Dotyczy to awarii uwierzytelniania, limitów szybkości oraz
timeoutów, które wyczerpały rotację profili (inne błędy nie powodują przejścia dalej).

Gdy uruchomienie zaczyna się z nadpisaniem modelu (hooki lub CLI), przełączanie awaryjne
i tak kończy się na `agents.defaults.model.primary` po wypróbowaniu wszystkich skonfigurowanych fallbacków.

## Powiązana konfiguracja

Zobacz [Konfiguracja Gateway](/gateway/configuration) w zakresie:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- routowanie `agents.defaults.imageModel`

Zobacz [Modele](/concepts/models), aby poznać szerszy przegląd wyboru modeli i przełączania awaryjnego.
