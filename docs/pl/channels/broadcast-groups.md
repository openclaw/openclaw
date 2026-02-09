---
summary: "Wysyłanie wiadomości WhatsApp do wielu agentów"
read_when:
  - Konfigurowanie grup rozgłoszeniowych
  - Debugowanie odpowiedzi wielu agentów w WhatsApp
status: experimental
title: "Grupy rozgłoszeniowe"
---

# Grupy rozgłoszeniowe

**Status:** Eksperymentalne  
**Wersja:** Dodano w 2026.1.9

## Przegląd

Grupy rozgłoszeniowe umożliwiają wielu agentom jednoczesne przetwarzanie i odpowiadanie na tę samą wiadomość. Pozwala to tworzyć wyspecjalizowane zespoły agentów, które współpracują w jednej grupie WhatsApp lub DM — wszystko przy użyciu jednego numeru telefonu.

Aktualny zakres: **tylko WhatsApp** (kanał webowy).

Grupy rozgłoszeniowe są oceniane po listach dozwolonych kanału i regułach aktywacji grup. W grupach WhatsApp oznacza to, że rozgłoszenia zachodzą wtedy, gdy OpenClaw normalnie by odpowiedział (na przykład po wzmiance, w zależności od ustawień grupy).

## Przypadki użycia

### 1. Wyspecjalizowane zespoły agentów

Wdrażaj wielu agentów z atomowymi, ściśle ukierunkowanymi odpowiedzialnościami:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Każdy agent przetwarza tę samą wiadomość i dostarcza swoją wyspecjalizowaną perspektywę.

### 2. Obsługa wielu języków

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Przepływy pracy zapewnienia jakości

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Automatyzacja zadań

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Konfiguracja

### Podstawowa konfiguracja

Dodaj sekcję najwyższego poziomu `broadcast` (obok `bindings`). Kluczami są identyfikatory peer WhatsApp:

- czaty grupowe: JID grupy (np. `120363403215116621@g.us`)
- DM-y: numer telefonu w formacie E.164 (np. `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Rezultat:** Gdy OpenClaw miałby odpowiedzieć w tym czacie, uruchomi wszystkich trzech agentów.

### Strategia przetwarzania

Kontroluj sposób przetwarzania wiadomości przez agentów:

#### Równolegle (domyślnie)

Wszyscy agenci przetwarzają jednocześnie:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sekwencyjne

Agenci przetwarzają po kolei (jeden czeka, aż poprzedni zakończy):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Kompletny przykład

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## Jak to działa

### Przepływ wiadomości

1. **Wiadomość przychodząca** trafia do grupy WhatsApp
2. **Sprawdzenie rozgłoszenia**: system sprawdza, czy identyfikator peer znajduje się w `broadcast`
3. **Jeśli jest na liście rozgłoszeń**:
   - Wszyscy wymienieni agenci przetwarzają wiadomość
   - Każdy agent ma własny klucz sesji i odizolowany kontekst
   - Agenci przetwarzają równolegle (domyślnie) lub sekwencyjnie
4. **Jeśli nie jest na liście rozgłoszeń**:
   - Obowiązuje normalne trasowanie (pierwsze pasujące powiązanie)

Uwaga: grupy rozgłoszeniowe nie omijają list dozwolonych kanału ani reguł aktywacji grup (wzmianki/polecenia itp.). Zmieniają jedynie to, _którzy agenci są uruchamiani_, gdy wiadomość kwalifikuje się do przetwarzania.

### Izolacja sesji

Każdy agent w grupie rozgłoszeniowej utrzymuje całkowicie odrębne:

- **Klucze sesji** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Historię konwersacji** (agent nie widzi wiadomości innych agentów)
- **Obszar roboczy** (oddzielne sandboxy, jeśli skonfigurowano)
- **Dostęp do narzędzi** (różne listy dozwolone/zabronione)
- **Pamięć/kontekst** (oddzielne IDENTITY.md, SOUL.md itp.)
- **Bufor kontekstu grupy** (ostatnie wiadomości grupowe używane jako kontekst) jest współdzielony per peer, więc wszyscy agenci rozgłoszeniowi widzą ten sam kontekst po wyzwoleniu

Pozwala to, aby każdy agent miał:

- Różne osobowości
- Różny dostęp do narzędzi (np. tylko do odczytu vs. odczyt-zapis)
- Różne modele (np. opus vs. sonnet)
- Różne zainstalowane umiejętności

### Przykład: izolowane sesje

W grupie `120363403215116621@g.us` z agentami `["alfred", "baerbel"]`:

**Kontekst Alfreda:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Kontekst Bärbel:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Najlepsze praktyki

### 1. Utrzymuj wąski zakres agentów

Projektuj każdego agenta z jedną, jasno określoną odpowiedzialnością:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Dobrze:** Każdy agent ma jedno zadanie  
❌ **Źle:** Jeden ogólny agent „dev-helper”

### 2. Używaj opisowych nazw

Niech będzie jasne, co robi każdy agent:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Skonfiguruj różny dostęp do narzędzi

Daj agentom tylko te narzędzia, których potrzebują:

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. Monitoruj wydajność

Przy wielu agentach rozważ:

- Używanie `"strategy": "parallel"` (domyślnie) dla szybkości
- Ograniczenie grup rozgłoszeniowych do 5–10 agentów
- Używanie szybszych modeli dla prostszych agentów

### 5. Obsługuj awarie w sposób łagodny

Agenci zawodzą niezależnie. Błąd jednego agenta nie blokuje pozostałych:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Zgodność

### Dostawcy

Grupy rozgłoszeniowe obecnie działają z:

- ✅ WhatsApp (zaimplementowane)
- 🚧 Telegram (planowane)
- 🚧 Discord (planowane)
- 🚧 Slack (planowane)

### Trasowanie

Grupy rozgłoszeniowe działają obok istniejącego trasowania:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: Odpowiada tylko alfred (normalne trasowanie)
- `GROUP_B`: Odpowiadają agent1 ORAZ agent2 (rozgłoszenie)

**Priorytet:** `broadcast` ma pierwszeństwo przed `bindings`.

## Rozwiązywanie problemów

### Agenci nie odpowiadają

**Sprawdź:**

1. Identyfikatory agentów istnieją w `agents.list`
2. Format identyfikatora peer jest poprawny (np. `120363403215116621@g.us`)
3. Agenci nie znajdują się na listach zabronionych

**Debugowanie:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Odpowiada tylko jeden agent

**Przyczyna:** Identyfikator peer może znajdować się w `bindings`, ale nie w `broadcast`.

**Naprawa:** Dodaj do konfiguracji rozgłoszeń lub usuń z powiązań.

### Problemy z wydajnością

**Jeśli jest wolno przy wielu agentach:**

- Zmniejsz liczbę agentów na grupę
- Użyj lżejszych modeli (sonnet zamiast opus)
- Sprawdź czas uruchamiania sandboxa

## Przykłady

### Przykład 1: Zespół do przeglądu kodu

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**Użytkownik wysyła:** Fragment kodu  
**Odpowiedzi:**

- code-formatter: „Poprawiono wcięcia i dodano podpowiedzi typów”
- security-scanner: „⚠️ Podatność na SQL injection w linii 12”
- test-coverage: „Pokrycie wynosi 45%, brakuje testów dla przypadków błędów”
- docs-checker: „Brak docstringa dla funkcji `process_data`”

### Przykład 2: Obsługa wielu języków

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## Referencja API

### Schemat konfiguracji

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Pola

- `strategy` (opcjonalne): Sposób przetwarzania agentów
  - `"parallel"` (domyślne): Wszyscy agenci przetwarzają jednocześnie
  - `"sequential"`: Agenci przetwarzają w kolejności tablicy
- `[peerId]`: JID grupy WhatsApp, numer E.164 lub inny identyfikator peer
  - Wartość: Tablica identyfikatorów agentów, które powinny przetwarzać wiadomości

## Ograniczenia

1. **Maks. liczba agentów:** Brak twardego limitu, ale 10+ agentów może być wolne
2. **Współdzielony kontekst:** Agenci nie widzą odpowiedzi innych agentów (celowo)
3. **Kolejność wiadomości:** Odpowiedzi równoległe mogą docierać w dowolnej kolejności
4. **Limity szybkości:** Wszyscy agenci wliczają się do limitów WhatsApp

## Przyszłe ulepszenia

Planowane funkcje:

- [ ] Tryb współdzielonego kontekstu (agenci widzą odpowiedzi innych)
- [ ] Koordynacja agentów (agenci mogą sygnalizować sobie nawzajem)
- [ ] Dynamiczny dobór agentów (wybór agentów na podstawie treści wiadomości)
- [ ] Priorytety agentów (niektórzy agenci odpowiadają przed innymi)

## Zobacz także

- [Konfiguracja wielu agentów](/tools/multi-agent-sandbox-tools)
- [Konfiguracja trasowania](/channels/channel-routing)
- [Zarządzanie sesjami](/concepts/sessions)
