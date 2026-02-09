---
summary: "OpenProse: przepływy pracy .prose, polecenia ukośne i stan w OpenClaw"
read_when:
  - Chcesz uruchamiać lub pisać przepływy pracy .prose
  - Chcesz włączyć wtyczkę OpenProse
  - Musisz zrozumieć przechowywanie stanu
title: "OpenProse"
---

# OpenProse

OpenProse to przenośny, zorientowany na Markdown format przepływów pracy do orkiestracji sesji AI. W OpenClaw jest dostarczany jako wtyczka, która instaluje pakiet Skills OpenProse oraz polecenie ukośne `/prose`. Programy znajdują się w plikach `.prose` i mogą uruchamiać wiele podagentów z jawną kontrolą przepływu.

Oficjalna strona: [https://www.prose.md](https://www.prose.md)

## Co potrafi

- Wieloagentowe badania i synteza z jawną równoległością.
- Powtarzalne, bezpieczne pod kątem zatwierdzeń przepływy pracy (przegląd kodu, triage incydentów, potoki treści).
- Wielokrotnego użytku programy `.prose`, które można uruchamiać w obsługiwanych środowiskach uruchomieniowych agentów.

## Instalacja i włączenie

Wtyczki dołączone są domyślnie wyłączone. Włącz OpenProse:

```bash
openclaw plugins enable open-prose
```

Po włączeniu wtyczki zrestartuj Gateway.

Checkout deweloperski/lokalny: `openclaw plugins install ./extensions/open-prose`

Powiązana dokumentacja: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Polecenie slash

OpenProse rejestruje `/prose` jako polecenie Skills wywoływane przez użytkownika. Kieruje ono do instrukcji VM OpenProse i pod spodem korzysta z narzędzi OpenClaw.

Typowe polecenia:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Przykład: prosty plik `.prose`

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Lokalizacje plików

OpenProse przechowuje stan w `.prose/` w obszarze roboczym:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Trwałe agenty na poziomie użytkownika znajdują się w:

```
~/.prose/agents/
```

## Tryby stanu

OpenProse obsługuje wiele backendów stanu:

- **filesystem** (domyślny): `.prose/runs/...`
- **in-context**: przejściowy, dla małych programów
- **sqlite** (eksperymentalny): wymaga binarki `sqlite3`
- **postgres** (eksperymentalny): wymaga `psql` oraz łańcucha połączenia

Uwagi:

- sqlite/postgres są opcjonalne i eksperymentalne.
- Dane uwierzytelniające postgres trafiają do logów podagentów; używaj dedykowanej bazy danych z minimalnymi uprawnieniami.

## Programy zdalne

`/prose run <handle/slug>` jest rozwiązywane do `https://p.prose.md/<handle>/<slug>`.
Bezpośrednie adresy URL są pobierane bez zmian. Wykorzystywane jest narzędzie `web_fetch` (lub `exec` dla POST).

## Mapowanie środowiska uruchomieniowego OpenClaw

Programy OpenProse mapują się na prymitywy OpenClaw:

| Pojęcie OpenProse                   | Narzędzie OpenClaw |
| ----------------------------------- | ------------------ |
| Uruchomienie sesji / narzędzie Task | `sessions_spawn`   |
| Odczyt/zapis plików                 | `read` / `write`   |
| Pobieranie strony internetowej      | `web_fetch`        |

Jeśli lista dozwolonych narzędzi blokuje te narzędzia, programy OpenProse zakończą się niepowodzeniem. Zobacz [Skills config](/tools/skills-config).

## Bezpieczeństwo i zatwierdzenia

Traktuj pliki `.prose` jak kod. Przeglądaj je przed uruchomieniem. Używaj list dozwolonych narzędzi OpenClaw oraz bramek zatwierdzeń, aby kontrolować skutki uboczne.

Dla deterministycznych przepływów pracy z bramkami zatwierdzeń porównaj z [Lobster](/tools/lobster).
