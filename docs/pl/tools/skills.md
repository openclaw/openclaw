---
summary: "Skills: zarządzane vs obszar roboczy, reguły bramkowania oraz powiązania konfiguracji/środowiska"
read_when:
  - Dodawanie lub modyfikowanie skills
  - Zmiana bramkowania skills lub reguł ładowania
title: "Skills"
---

# Skills (OpenClaw)

OpenClaw używa folderów skills **zgodnych z [AgentSkills](https://agentskills.io)** do uczenia agenta korzystania z narzędzi. Każdy skill jest katalogiem zawierającym `SKILL.md` z frontmatterem YAML oraz instrukcjami. OpenClaw ładuje **dołączone skills** oraz opcjonalne lokalne nadpisania i filtruje je w czasie ładowania na podstawie środowiska, konfiguracji i obecności binariów.

## Lokalizacje i priorytety

Skills są ładowane z **trzech** miejsc:

1. **Dołączone skills**: dostarczane wraz z instalacją (pakiet npm lub OpenClaw.app)
2. **Zarządzane/lokalne skills**: `~/.openclaw/skills`
3. **Skills obszaru roboczego**: `<workspace>/skills`

Jeśli nazwa skilla koliduje, obowiązuje priorytet:

`<workspace>/skills` (najwyższy) → `~/.openclaw/skills` → dołączone skills (najniższy)

Dodatkowo możesz skonfigurować dodatkowe foldery skills (najniższy priorytet) przez
`skills.load.extraDirs` w `~/.openclaw/openclaw.json`.

## Skills per-agent vs współdzielone

W konfiguracjach **wieloagentowych** każdy agent ma własny obszar roboczy. Oznacza to:

- **Skills per-agent** znajdują się w `<workspace>/skills` wyłącznie dla tego agenta.
- **Skills współdzielone** znajdują się w `~/.openclaw/skills` (zarządzane/lokalne) i są widoczne
  dla **wszystkich agentów** na tej samej maszynie.
- **Współdzielone foldery** można też dodać przez `skills.load.extraDirs` (najniższy
  priorytet), jeśli chcesz używać wspólnego pakietu skills przez wielu agentów.

Jeśli ta sama nazwa skilla istnieje w więcej niż jednym miejscu, obowiązuje standardowy priorytet:
wygrywa obszar roboczy, następnie zarządzane/lokalne, a na końcu dołączone.

## Wtyczki + skills

Wtyczki mogą dostarczać własne skills, wskazując katalogi `skills` w
`openclaw.plugin.json` (ścieżki względne względem katalogu głównego wtyczki). Skills wtyczek są ładowane,
gdy wtyczka jest włączona, i podlegają standardowym regułom priorytetów skills.
Możesz je bramkować przez `metadata.openclaw.requires.config` w wpisie konfiguracji wtyczki. Zobacz [Plugins](/tools/plugin) w zakresie wykrywania/konfiguracji oraz [Tools](/tools) w zakresie
powierzchni narzędzi, których te skills uczą.

## ClawHub (instalacja + synchronizacja)

ClawHub to publiczny rejestr skills dla OpenClaw. Przeglądaj na
[https://clawhub.com](https://clawhub.com). Użyj go do odkrywania, instalowania, aktualizowania
i tworzenia kopii zapasowych skills.
Pełny przewodnik: [ClawHub](/tools/clawhub).

Wspólne przepływy:

- Instalacja skilla do obszaru roboczego:
  - `clawhub install <skill-slug>`
- Aktualizacja wszystkich zainstalowanych skills:
  - `clawhub update --all`
- Synchronizacja (skanowanie + publikowanie aktualizacji):
  - `clawhub sync --all`

Domyślnie `clawhub` instaluje do `./skills` w bieżącym katalogu roboczym
(lub używa skonfigurowanego obszaru roboczego OpenClaw). OpenClaw wykrywa to jako
`<workspace>/skills` w następnej sesji.

## Uwagi dotyczące bezpieczeństwa

- Traktuj skills firm trzecich jako **niezaufany kod**. Przeczytaj je przed włączeniem.
- Preferuj uruchomienia w sandbox dla niezaufanych danych wejściowych i ryzykownych narzędzi. Zobacz [Sandboxing](/gateway/sandboxing).
- `skills.entries.*.env` i `skills.entries.*.apiKey` wstrzykują sekrety do procesu **hosta**
  dla danej tury agenta (nie do sandboxa). Trzymaj sekrety poza promptami i logami.
- Aby zapoznać się z szerszym modelem zagrożeń i checklistami, zobacz [Security](/gateway/security).

## Format (AgentSkills + zgodny z Pi)

`SKILL.md` musi zawierać co najmniej:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Uwagi:

- Stosujemy specyfikację AgentSkills w zakresie układu i intencji.
- Parser używany przez osadzonego agenta obsługuje wyłącznie klucze frontmatteru **jednolinijkowe**.
- `metadata` powinno być **jednolinijkowym obiektem JSON**.
- Używaj `{baseDir}` w instrukcjach, aby odwoływać się do ścieżki folderu skilla.
- Opcjonalne klucze frontmatteru:
  - `homepage` — URL prezentowany jako „Website” w interfejsie Skills na macOS (obsługiwane również przez `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (domyślnie: `true`). Gdy `true`, skill jest udostępniany jako komenda ukośnikowa użytkownika.
  - `disable-model-invocation` — `true|false` (domyślnie: `false`). Gdy `true`, skill jest wykluczony z promptu modelu (nadal dostępny przez wywołanie użytkownika).
  - `command-dispatch` — `tool` (opcjonalne). Gdy ustawione na `tool`, komenda ukośnikowa omija model i jest bezpośrednio przekazywana do narzędzia.
  - `command-tool` — nazwa narzędzia do wywołania, gdy ustawiono `command-dispatch: tool`.
  - `command-arg-mode` — `raw` (domyślnie). Dla dyspozycji narzędzia przekazuje surowy ciąg argumentów do narzędzia (bez parsowania po stronie core).

    Narzędzie jest wywoływane z parametrami:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Bramkowanie (filtry czasu ładowania)

OpenClaw **filtruje skills w czasie ładowania** przy użyciu `metadata` (jednolinijkowy JSON):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Pola pod `metadata.openclaw`:

- `always: true` — zawsze uwzględnia skill (pomija inne bramki).
- `emoji` — opcjonalna emoji używana przez interfejs Skills na macOS.
- `homepage` — opcjonalny URL wyświetlany jako „Website” w interfejsie Skills na macOS.
- `os` — opcjonalna lista platform (`darwin`, `linux`, `win32`). Jeśli ustawiona, skill jest kwalifikowany wyłącznie na tych systemach operacyjnych.
- `requires.bins` — lista; każdy element musi istnieć na `PATH`.
- `requires.anyBins` — lista; co najmniej jeden element musi istnieć na `PATH`.
- `requires.env` — lista; zmienna środowiskowa musi istnieć **lub** być podana w konfiguracji.
- `requires.config` — lista ścieżek `openclaw.json`, które muszą być prawdziwe.
- `primaryEnv` — nazwa zmiennej środowiskowej powiązana z `skills.entries.<name>.apiKey`.
- `install` — opcjonalna tablica specyfikacji instalatorów używanych przez interfejs Skills na macOS (brew/node/go/uv/download).

Uwaga dotycząca sandboxingu:

- `requires.bins` jest sprawdzane na **hoście** w czasie ładowania skilla.
- Jeśli agent działa w sandboxie, binarium musi również istnieć **wewnątrz kontenera**.
  Zainstaluj je przez `agents.defaults.sandbox.docker.setupCommand` (lub niestandardowy obraz).
  `setupCommand` uruchamia się raz po utworzeniu kontenera.
  Instalacje pakietów wymagają także wyjścia sieciowego, zapisywalnego głównego systemu plików oraz użytkownika root w sandboxie.
  Przykład: skill `summarize` (`skills/summarize/SKILL.md`) wymaga CLI `summarize`
  w kontenerze sandboxa, aby działać w nim.

Przykład instalatora:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Uwagi:

- Jeśli podano wiele instalatorów, Gateway wybiera **jedną** preferowaną opcję (brew, gdy dostępny, w przeciwnym razie node).
- Jeśli wszystkie instalatory są `download`, OpenClaw wyświetla każdą pozycję, aby było widać dostępne artefakty.
- Specyfikacje instalatorów mogą zawierać `os: ["darwin"|"linux"|"win32"]`, aby filtrować opcje według platformy.
- Instalacje Node honorują `skills.install.nodeManager` w `openclaw.json` (domyślnie: npm; opcje: npm/pnpm/yarn/bun).
  Dotyczy to wyłącznie **instalacji skills**; środowisko uruchomieniowe Gateway nadal powinno być Node
  (Bun nie jest zalecany dla WhatsApp/Telegram).
- Instalacje Go: jeśli brakuje `go`, a `brew` jest dostępne, Gateway najpierw instaluje Go przez Homebrew i ustawia `GOBIN` na `bin` Homebrew, gdy to możliwe.
- Instalacje typu download: `url` (wymagane), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (domyślnie: auto, gdy wykryto archiwum), `stripComponents`, `targetDir` (domyślnie: `~/.openclaw/tools/<skillKey>`).

Jeśli nie ma `metadata.openclaw`, skill jest zawsze kwalifikowany (chyba że
wyłączony w konfiguracji lub zablokowany przez `skills.allowBundled` dla dołączonych skills).

## Nadpisania konfiguracji (`~/.openclaw/openclaw.json`)

Dołączone/zarządzane skills można przełączać oraz dostarczać im wartości środowiskowe:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Uwaga: jeśli nazwa skilla zawiera myślniki, ujmij klucz w cudzysłów (JSON5 pozwala na klucze w cudzysłowie).

Klucze konfiguracji domyślnie odpowiadają **nazwie skilla**. Jeśli skill definiuje
`metadata.openclaw.skillKey`, użyj tego klucza pod `skills.entries`.

Zasady:

- `enabled: false` wyłącza skill nawet jeśli jest dołączony/zainstalowany.
- `env`: wstrzykiwane **tylko jeśli** zmienna nie jest już ustawiona w procesie.
- `apiKey`: ułatwienie dla skills deklarujących `metadata.openclaw.primaryEnv`.
- `config`: opcjonalny worek na niestandardowe pola per-skill; niestandardowe klucze muszą się tu znajdować.
- `allowBundled`: opcjonalna lista dozwolonych wyłącznie dla **dołączonych** skills. Jeśli ustawiona, kwalifikują się tylko
  dołączone skills z listy (zarządzane/obszaru roboczego nie są dotknięte).

## Wstrzykiwanie środowiska (na uruchomienie agenta)

Gdy rozpoczyna się uruchomienie agenta, OpenClaw:

1. Odczytuje metadane skills.
2. Stosuje wszelkie `skills.entries.<key>.env` lub `skills.entries.<key>.apiKey` do
   `process.env`.
3. Buduje prompt systemowy z **kwalifikującymi się** skills.
4. Przywraca oryginalne środowisko po zakończeniu uruchomienia.

Jest to **ograniczone do uruchomienia agenta**, a nie globalnego środowiska powłoki.

## Migawka sesji (wydajność)

OpenClaw tworzy migawkę kwalifikujących się skills **w momencie startu sesji** i używa tej listy
dla kolejnych tur w tej samej sesji. Zmiany w skills lub konfiguracji zaczynają obowiązywać
od kolejnej nowej sesji.

Skills mogą również odświeżać się w trakcie sesji, gdy włączony jest watcher skills
lub gdy pojawi się nowy kwalifikujący się zdalny węzeł (zob. niżej). Traktuj to jako **hot reload**:
odświeżona lista jest używana przy następnej turze agenta.

## Zdalne węzły macOS (Gateway na Linuxie)

Jeśli Gateway działa na Linuxie, ale podłączony jest **węzeł macOS** **z dozwolonym `system.run`**
(zabezpieczenia Exec approvals nie ustawione na `deny`), OpenClaw może traktować
skills wyłącznie dla macOS jako kwalifikujące się, gdy wymagane binaria są obecne na tym węźle. Agent powinien wykonywać te skills przez narzędzie `nodes` (zwykle `nodes.run`).

Opiera się to na raportowaniu przez węzeł obsługi poleceń oraz na sondzie binariów przez `system.run`. Jeśli węzeł macOS później przejdzie offline, skills pozostają widoczne; wywołania mogą się nie powieść,
dopóki węzeł nie połączy się ponownie.

## Watcher skills (automatyczne odświeżanie)

Domyślnie OpenClaw obserwuje foldery skills i aktualizuje migawkę skills, gdy zmieniają się pliki
`SKILL.md`. Skonfiguruj to w `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Wpływ na tokeny (lista skills)

Gdy skills są kwalifikowane, OpenClaw wstrzykuje zwięzłą listę XML dostępnych skills do promptu
systemowego (przez `formatSkillsForPrompt` w `pi-coding-agent`). Koszt jest deterministyczny:

- **Bazowy narzut (tylko gdy ≥1 skill):** 195 znaków.
- **Na skill:** 97 znaków + długość wartości `<name>`, `<description>` oraz `<location>`
  po ucieczce XML.

Wzór (znaki):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Uwagi:

- Ucieczka XML rozszerza `& < > " '` do encji (`&amp;`, `&lt;` itd.), zwiększając długość.
- Liczba tokenów różni się w zależności od tokenizera modelu. Przybliżone oszacowanie w stylu OpenAI to ~4 znaki/token,
  więc **97 znaków ≈ 24 tokeny** na skill plus rzeczywiste długości pól.

## Cykl życia zarządzanych skills

OpenClaw dostarcza bazowy zestaw skills jako **dołączone skills** w ramach instalacji
(pakiet npm lub OpenClaw.app). `~/.openclaw/skills` istnieje dla lokalnych nadpisań
(np. przypinanie/łatanie skilla bez zmiany dołączonej kopii). Skills obszaru roboczego są
własnością użytkownika i nadpisują oba w przypadku konfliktu nazw.

## Referencja konfiguracji

Zobacz [Skills config](/tools/skills-config), aby zapoznać się z pełnym schematem konfiguracji.

## Szukasz więcej skills?

Przeglądaj [https://clawhub.com](https://clawhub.com).

---
