---
summary: "Przestrzeń robocza agenta: lokalizacja, układ i strategia kopii zapasowych"
read_when:
  - Musisz wyjaśnić przestrzeń roboczą agenta lub jej układ plików
  - Chcesz wykonać kopię zapasową lub zmigrować przestrzeń roboczą agenta
title: "Przestrzeń robocza agenta"
---

# Przestrzeń robocza agenta

Przestrzeń robocza to dom agenta. Jest to jedyny katalog roboczy używany przez
narzędzia plikowe oraz dla kontekstu przestrzeni roboczej. Należy ją traktować
jako prywatną i uważać za pamięć.

Jest to oddzielne od `~/.openclaw/`, które przechowuje konfigurację,
poświadczenia i sesje.

**Ważne:** przestrzeń robocza jest **domyślnym cwd**, a nie twardym sandboxem. Narzędzia rozwiązują ścieżki względne względem przestrzeni roboczej, ale ścieżki
bezwzględne nadal mogą sięgać poza nią na hoście, chyba że włączone jest
sandboxing. Jeśli potrzebujesz izolacji, użyj
[`agents.defaults.sandbox`](/gateway/sandboxing) (i/lub konfiguracji sandbox na agenta).
Gdy sandboxing jest włączony i `workspaceAccess` nie jest `"rw"`,
narzędzia działają wewnątrz sandboxowej przestrzeni roboczej pod
`~/.openclaw/sandboxes`, a nie w przestrzeni roboczej hosta.

## Domyślna lokalizacja

- Domyślnie: `~/.openclaw/workspace`
- Jeśli `OPENCLAW_PROFILE` jest ustawione i nie jest `"default"`, domyślna
  lokalizacja staje się `~/.openclaw/workspace-<profile>`.
- Nadpisanie w `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` lub `openclaw setup` spowoduje utworzenie
przestrzeni roboczej i zasianie plików bootstrap, jeśli ich brakuje.

Jeśli samodzielnie zarządzasz plikami przestrzeni roboczej, możesz wyłączyć
tworzenie plików bootstrap:

```json5
{ agent: { skipBootstrap: true } }
```

## Dodatkowe foldery przestrzeni roboczej

Starsze instalacje mogły utworzyć `~/openclaw`. Przechowywanie wielu katalogów
przestrzeni roboczej może powodować mylące rozbieżności uwierzytelniania lub
stanu, ponieważ w danym momencie aktywna jest tylko jedna przestrzeń robocza.

**Zalecenie:** utrzymuj jedną aktywną przestrzeń roboczą. Jeśli nie używasz już
dodatkowych folderów, zarchiwizuj je lub przenieś do Kosza (na przykład
`trash ~/openclaw`).
Jeśli celowo utrzymujesz wiele przestrzeni roboczych, upewnij
się, że `agents.defaults.workspace` wskazuje na aktywną.

`openclaw doctor` ostrzega, gdy wykryje dodatkowe katalogi przestrzeni roboczej.

## Mapa plików przestrzeni roboczej (co oznacza każdy plik)

Są to standardowe pliki, których OpenClaw oczekuje w przestrzeni roboczej:

- `AGENTS.md`
  - Instrukcje operacyjne dla agenta oraz sposób korzystania z pamięci.
  - Ładowany na początku każdej sesji.
  - Dobre miejsce na reguły, priorytety i szczegóły „jak się zachowywać”.

- `SOUL.md`
  - Persona, ton i granice.
  - Ładowany w każdej sesji.

- `USER.md`
  - Kim jest użytkownik i jak się do niego zwracać.
  - Ładowany w każdej sesji.

- `IDENTITY.md`
  - Nazwa agenta, klimat i emoji.
  - Tworzony/aktualizowany podczas rytuału bootstrap.

- `TOOLS.md`
  - Notatki o lokalnych narzędziach i konwencjach.
  - Nie kontroluje dostępności narzędzi; to wyłącznie wskazówki.

- `HEARTBEAT.md`
  - Opcjonalna krótka lista kontrolna dla przebiegów heartbeat.
  - Należy ją utrzymywać krótką, aby unikać spalania tokenów.

- `BOOT.md`
  - Opcjonalna lista kontrolna uruchamiana przy starcie gateway, gdy włączone są
    wewnętrzne hooki.
  - Należy ją utrzymywać krótką; do wysyłek wychodzących używaj narzędzia message.

- `BOOTSTRAP.md`
  - Jednorazowy rytuał pierwszego uruchomienia.
  - Tworzony tylko dla zupełnie nowej przestrzeni roboczej.
  - Usuń go po zakończeniu rytuału.

- `memory/YYYY-MM-DD.md`
  - Dziennik pamięci dziennej (jeden plik na dzień).
  - Zalecane jest odczytywanie dzisiejszego i wczorajszego pliku na starcie sesji.

- `MEMORY.md` (opcjonalnie)
  - Kuratorowana pamięć długoterminowa.
  - Ładować tylko w głównej, prywatnej sesji (nie w kontekstach współdzielonych/grupowych).

Zobacz [Memory](/concepts/memory), aby poznać przepływ pracy i automatyczne
czyszczenie pamięci.

- `skills/` (opcjonalnie)
  - Skills specyficzne dla przestrzeni roboczej.
  - Nadpisują zarządzane/dołączone skills w przypadku kolizji nazw.

- `canvas/` (opcjonalnie)
  - Pliki interfejsu Canvas UI dla wyświetleń węzłów (na przykład `canvas/index.html`).

Jeśli brakuje jakiegokolwiek pliku bootstrap, OpenClaw wstrzykuje do sesji znacznik
„missing file” i kontynuuje. Duże pliki bootstrap są obcinane podczas
wstrzykiwania; limit można dostosować za pomocą `agents.defaults.bootstrapMaxChars`
(domyślnie: 20000).
`openclaw setup` może odtworzyć brakujące domyślne pliki bez
nadpisywania istniejących.

## Czego NIE ma w przestrzeni roboczej

Znajdują się one pod `~/.openclaw/` i NIE powinny być commitowane do repozytorium
przestrzeni roboczej:

- `~/.openclaw/openclaw.json` (konfiguracja)
- `~/.openclaw/credentials/` (tokeny OAuth, klucze API)
- `~/.openclaw/agents/<agentId>/sessions/` (transkrypcje sesji + metadane)
- `~/.openclaw/skills/` (zarządzane skills)

Jeśli musisz zmigrować sesje lub konfigurację, skopiuj je osobno i trzymaj poza
kontrolą wersji.

## Kopia zapasowa Git (zalecane, prywatne)

Traktuj przestrzeń roboczą jako prywatną pamięć. Umieść ją w **prywatnym**
repozytorium git, aby była archiwizowana i możliwa do odzyskania.

Wykonaj te kroki na maszynie, na której działa Gateway (tam znajduje się
przestrzeń robocza).

### 1. Inicjalizacja repozytorium

Jeśli git jest zainstalowany, zupełnie nowe przestrzenie robocze są inicjalizowane
automatycznie. Jeśli ta przestrzeń robocza nie jest jeszcze repozytorium, uruchom:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Dodanie prywatnego zdalnego repozytorium (opcje przyjazne dla początkujących)

Opcja A: interfejs webowy GitHub

1. Utwórz nowe **prywatne** repozytorium na GitHubie.
2. Nie inicjalizuj go plikiem README (pozwala uniknąć konfliktów scalania).
3. Skopiuj adres URL zdalnego repozytorium HTTPS.
4. Dodaj zdalny i naciśnięcie:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Opcja B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Opcja C: interfejs webowy GitLab

1. Utwórz nowe **prywatne** repozytorium na GitLabie.
2. Nie inicjalizuj go plikiem README (pozwala uniknąć konfliktów scalania).
3. Skopiuj adres URL zdalnego repozytorium HTTPS.
4. Dodaj zdalny i naciśnięcie:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Bieżące aktualizacje

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Nie commituj sekretów

Nawet w prywatnym repozytorium unikaj przechowywania sekretów w przestrzeni
roboczej:

- Kluczy API, tokenów OAuth, haseł lub prywatnych poświadczeń.
- Czegokolwiek pod `~/.openclaw/`.
- Surowych zrzutów czatów lub wrażliwych załączników.

Jeśli musisz przechowywać wrażliwe odwołania, używaj placeholderów i trzymaj
prawdziwy sekret gdzie indziej (menedżer haseł, zmienne środowiskowe lub
`~/.openclaw/`).

Sugerowany plik startowy `.gitignore`:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Przenoszenie przestrzeni roboczej na nową maszynę

1. Sklonuj repozytorium do docelowej ścieżki (domyślnie `~/.openclaw/workspace`).
2. Ustaw `agents.defaults.workspace` na tę ścieżkę w `~/.openclaw/openclaw.json`.
3. Uruchom `openclaw setup --workspace <path>`, aby zasiać brakujące pliki.
4. Jeśli potrzebujesz sesji, skopiuj `~/.openclaw/agents/<agentId>/sessions/` ze starej maszyny osobno.

## Zaawansowane uwagi

- Routing wieloagentowy może używać różnych przestrzeni roboczych dla każdego
  agenta. Zobacz [Channel routing](/channels/channel-routing), aby poznać
  konfigurację routingu.
- Jeśli `agents.defaults.sandbox` jest włączone, sesje inne niż główne mogą używać
  sandboxowych przestrzeni roboczych per sesja pod `agents.defaults.sandbox.workspaceRoot`.
