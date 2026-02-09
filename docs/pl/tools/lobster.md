---
title: Lobster
summary: "„Typowany runtime przepływów pracy dla OpenClaw z wznawialnymi bramkami zatwierdzeń.”"
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Chcesz deterministycznych, wieloetapowych przepływów pracy z jawnymi zatwierdzeniami
  - Musisz wznowić przepływ pracy bez ponownego uruchamiania wcześniejszych kroków
---

# Lobster

Lobster to powłoka przepływów pracy, która pozwala OpenClaw uruchamiać wieloetapowe sekwencje narzędzi jako jedną, deterministyczną operację z jawnymi punktami kontrolnymi zatwierdzeń.

## Hook

Twój asystent może budować narzędzia, które same sobą zarządzają. Poproś o przepływ pracy, a po 30 minutach masz CLI oraz potoki uruchamiane jednym wywołaniem. Lobster to brakujący element: deterministyczne potoki, jawne zatwierdzenia i wznawialny stan.

## Dlaczego

Dziś złożone przepływy pracy wymagają wielu wywołań narzędzi w tę i z powrotem. Każde wywołanie kosztuje tokeny, a LLM musi orkiestrawać każdy krok. Lobster przenosi tę orkiestrację do typowanego runtime’u:

- **Jedno wywołanie zamiast wielu**: OpenClaw uruchamia jedno wywołanie narzędzia Lobster i otrzymuje ustrukturyzowany wynik.
- **Zatwierdzenia wbudowane**: Efekty uboczne (wysłanie e-maila, publikacja komentarza) wstrzymują przepływ pracy do momentu jawnego zatwierdzenia.
- **Wznawialność**: Wstrzymane przepływy pracy zwracają token; zatwierdź i wznów bez ponownego uruchamiania wszystkiego.

## Dlaczego DSL zamiast zwykłych programów?

Lobster jest celowo niewielki. Celem nie jest „nowy język”, lecz przewidywalna, przyjazna dla AI specyfikacja potoków z pierwszoklasowymi zatwierdzeniami i tokenami wznawiania.

- **Zatwierdzanie/wznawianie wbudowane**: Zwykły program może poprosić człowieka o decyzję, ale nie potrafi _zatrzymać się i wznowić_ z trwałym tokenem bez samodzielnego tworzenia takiego runtime’u.
- **Deterministyczność + audytowalność**: Potoki są danymi, więc łatwo je logować, porównywać (diff), odtwarzać i przeglądać.
- **Ograniczona powierzchnia dla AI**: Mała gramatyka + przesyłanie JSON ograniczają „kreatywne” ścieżki kodu i czynią walidację realistyczną.
- **Polityka bezpieczeństwa wbudowana**: Limity czasu, limity wyjścia, kontrole sandbox i listy dozwolonych są egzekwowane przez runtime, a nie przez każdy skrypt.
- **Wciąż programowalne**: Każdy krok może wywołać dowolne CLI lub skrypt. Jeśli chcesz JS/TS, generuj pliki `.lobster` z kodu.

## Jak to działa

OpenClaw uruchamia lokalne CLI `lobster` w **trybie narzędzia** i parsuje kopertę JSON ze stdout.
Jeśli potok zatrzyma się na zatwierdzeniu, narzędzie zwraca `resumeToken`, aby można było kontynuować później.

## Wzorzec: małe CLI + potoki JSON + zatwierdzenia

Buduj małe polecenia mówiące JSON-em, a następnie łącz je w jedno wywołanie Lobster. (Nazwy poleceń w przykładach poniżej — podmień na własne).

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Jeśli potok poprosi o zatwierdzenie, wznów przy użyciu tokenu:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI uruchamia przepływ pracy; Lobster wykonuje kroki. Bramki zatwierdzeń sprawiają, że efekty uboczne są jawne i możliwe do audytu.

Przykład: mapowanie elementów wejściowych na wywołania narzędzi:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Kroki LLM tylko z JSON (llm-task)

Dla przepływów pracy wymagających **ustrukturyzowanego kroku LLM** włącz opcjonalne narzędzie wtyczki
`llm-task` i wywołaj je z Lobster. Dzięki temu przepływ pozostaje
deterministyczny, a jednocześnie możesz klasyfikować/podsumowywać/tworzyć szkice z użyciem modelu.

Włącz narzędzie:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Użyj w potoku:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Zobacz [LLM Task](/tools/llm-task), aby poznać szczegóły i opcje konfiguracji.

## Pliki przepływów pracy (.lobster)

Lobster może uruchamiać pliki przepływów pracy YAML/JSON z polami `name`, `args`, `steps`, `env`, `condition` i `approval`. W wywołaniach narzędzi OpenClaw ustaw `pipeline` na ścieżkę do pliku.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Uwagi:

- `stdin: $step.stdout` i `stdin: $step.json` przekazują wyjście poprzedniego kroku.
- `condition` (lub `when`) mogą warunkować kroki na podstawie `$step.approved`.

## Instalacja Lobster

Zainstaluj CLI Lobster na **tym samym hoście**, na którym działa Gateway OpenClaw (zobacz [repozytorium Lobster](https://github.com/openclaw/lobster)), i upewnij się, że `lobster` znajduje się na `PATH`.
Jeśli chcesz użyć niestandardowej lokalizacji binarki, przekaż **bezwzględną** `lobsterPath` w wywołaniu narzędzia.

## Włącz narzędzie

Lobster jest **opcjonalnym** narzędziem wtyczki (domyślnie wyłączonym).

Zalecane (addytywne, bezpieczne):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Lub per-agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Unikaj używania `tools.allow: ["lobster"]`, chyba że zamierzasz działać w restrykcyjnym trybie listy dozwolonych.

Uwaga: listy dozwolonych są opcjonalne dla wtyczek opcjonalnych. Jeśli Twoja lista dozwolonych wymienia tylko
narzędzia wtyczek (takie jak `lobster`), OpenClaw pozostawia narzędzia rdzeniowe włączone. Aby ograniczyć narzędzia rdzeniowe,
uwzględnij na liście dozwolonych także narzędzia lub grupy rdzeniowe, które chcesz dopuścić.

## Przykład: triage e-maili

Bez Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Z Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Zwraca kopertę JSON (obciętą):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Użytkownik zatwierdza → wznów:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Jeden przepływ pracy. Deterministyczny. Bezpieczny.

## Parametry narzędzia

### `run`

Uruchom potok w trybie narzędzia.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Uruchom plik przepływu pracy z argumentami:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Kontynuuj wstrzymany przepływ pracy po zatwierdzeniu.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Opcjonalne wejścia

- `lobsterPath`: Bezwzględna ścieżka do binarki Lobster (pomiń, aby użyć `PATH`).
- `cwd`: Katalog roboczy dla potoku (domyślnie bieżący katalog roboczy procesu).
- `timeoutMs`: Zabij podproces, jeśli przekroczy ten czas (domyślnie: 20000).
- `maxStdoutBytes`: Zabij podproces, jeśli stdout przekroczy ten rozmiar (domyślnie: 512000).
- `argsJson`: Ciąg JSON przekazywany do `lobster run --args-json` (tylko pliki przepływów pracy).

## Koperta wyjściowa

Lobster zwraca kopertę JSON z jednym z trzech statusów:

- `ok` → zakończono pomyślnie
- `needs_approval` → wstrzymano; do wznowienia wymagane jest `requiresApproval.resumeToken`
- `cancelled` → jawnie odrzucono lub anulowano

Narzędzie udostępnia kopertę zarówno w `content` (ładnie sformatowany JSON), jak i `details` (surowy obiekt).

## Zatwierdzenia

Jeśli obecne jest `requiresApproval`, sprawdź komunikat i zdecyduj:

- `approve: true` → wznów i kontynuuj efekty uboczne
- `approve: false` → anuluj i sfinalizuj przepływ pracy

Użyj `approve --preview-from-stdin --limit N`, aby dołączać podgląd JSON do próśb o zatwierdzenie bez niestandardowego klejenia jq/heredoc. Tokeny wznawiania są teraz kompaktowe: Lobster przechowuje stan wznawiania przepływu pracy w swoim katalogu stanu i zwraca niewielki klucz tokenu.

## OpenProse

OpenProse dobrze współpracuje z Lobster: użyj `/prose` do orkiestracji przygotowań wieloagentowych, a następnie uruchom potok Lobster dla deterministycznych zatwierdzeń. Jeśli program Prose potrzebuje Lobster, zezwól narzędziu `lobster` dla subagentów przez `tools.subagents.tools`. Zobacz [OpenProse](/prose).

## Bezpieczeństwo

- **Tylko lokalne podprocesy** — brak wywołań sieciowych z samej wtyczki.
- **Brak sekretów** — Lobster nie zarządza OAuth; wywołuje narzędzia OpenClaw, które to robią.
- **Świadomy sandboxa** — wyłączony, gdy kontekst narzędzia jest sandboxowany.
- **Utwardzony** — jeśli podano, `lobsterPath` musi być bezwzględne; egzekwowane są limity czasu i limity wyjścia.

## Rozwiązywanie problemów

- **`lobster subprocess timed out`** → zwiększ `timeoutMs` lub podziel długi potok.
- **`lobster output exceeded maxStdoutBytes`** → podnieś `maxStdoutBytes` lub zmniejsz rozmiar wyjścia.
- **`lobster returned invalid JSON`** → upewnij się, że potok działa w trybie narzędzia i wypisuje wyłącznie JSON.
- **`lobster failed (code …)`** → uruchom ten sam potok w terminalu, aby sprawdzić stderr.

## Dowiedz się więcej

- [Plugins](/tools/plugin)
- [Tworzenie narzędzi wtyczek](/plugins/agent-tools)

## Studium przypadku: przepływy pracy społeczności

Jeden publiczny przykład: CLI „drugiego mózgu” + potoki Lobster, które zarządzają trzema magazynami Markdown (osobisty, partnera, współdzielony). CLI emituje JSON ze statystykami, listami skrzynki odbiorczej i skanami nieaktualnych elementów; Lobster łączy te polecenia w przepływy pracy takie jak `weekly-review`, `inbox-triage`, `memory-consolidation` i `shared-task-sync`, każdy z bramkami zatwierdzeń. AI obsługuje ocenę (kategoryzację), gdy jest dostępna, a w przeciwnym razie stosuje deterministyczne reguły.

- Wątek: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
