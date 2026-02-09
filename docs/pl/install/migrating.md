---
summary: "Przeniesienie (migracja) instalacji OpenClaw z jednej maszyny na inną"
read_when:
  - Przenosisz OpenClaw na nowy laptop/serwer
  - Chcesz zachować sesje, uwierzytelnianie i logowania do kanałów (WhatsApp itp.)
title: "Przewodnik migracji"
---

# Migracja OpenClaw na nową maszynę

Ten przewodnik opisuje migrację Gateway OpenClaw z jednej maszyny na inną **bez ponownego przechodzenia procesu onboardingu**.

Koncepcyjnie migracja jest prosta:

- Skopiuj **katalog stanu** (`$OPENCLAW_STATE_DIR`, domyślnie: `~/.openclaw/`) — zawiera on konfigurację, uwierzytelnianie, sesje oraz stan kanałów.
- Skopiuj swój **obszar roboczy** (domyślnie `~/.openclaw/workspace/`) — zawiera on pliki agentów (pamięć, prompty itd.).

Istnieją jednak typowe pułapki związane z **profilami**, **uprawnieniami** oraz **niepełnymi kopiami**.

## Zanim zaczniesz (co migrujesz)

### 1. Zidentyfikuj katalog stanu

Większość instalacji używa ustawienia domyślnego:

- **Katalog stanu:** `~/.openclaw/`

Może on jednak być inny, jeśli używasz:

- `--profile <name>` (często staje się `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Jeśli nie masz pewności, uruchom na **starej** maszynie:

```bash
openclaw status
```

W wyjściu poszukaj wzmianek o `OPENCLAW_STATE_DIR` / profilu. Jeśli uruchamiasz wiele gatewayów, powtórz to dla każdego profilu.

### 2. Zidentyfikuj swój obszar roboczy

Typowe wartości domyślne:

- `~/.openclaw/workspace/` (zalecany obszar roboczy)
- niestandardowy folder, który utworzyłeś

Obszar roboczy to miejsce, w którym znajdują się pliki takie jak `MEMORY.md`, `USER.md` i `memory/*.md`.

### 3. Zrozum, co zostanie zachowane

Jeśli skopiujesz **zarówno** katalog stanu, jak i obszar roboczy, zachowasz:

- konfigurację Gateway (`openclaw.json`)
- profile uwierzytelniania / klucze API / tokeny OAuth
- historię sesji + stan agentów
- stan kanałów (np. logowanie/sesję WhatsApp)
- pliki obszaru roboczego (pamięć, notatki Skills itd.)

Jeśli skopiujesz **tylko** obszar roboczy (np. przez Git), **nie** zachowasz:

- sessions
- poświadczeń
- logowań do kanałów

Znajdują się one w `$OPENCLAW_STATE_DIR`.

## Kroki migracji (zalecane)

### Krok 0 — Wykonaj kopię zapasową (stara maszyna)

Na **starej** maszynie najpierw zatrzymaj gateway, aby pliki nie zmieniały się w trakcie kopiowania:

```bash
openclaw gateway stop
```

(Opcjonalnie, ale zalecane) zarchiwizuj katalog stanu i obszar roboczy:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Jeśli masz wiele profili/katalogów stanu (np. `~/.openclaw-main`, `~/.openclaw-work`), zarchiwizuj każdy z nich.

### Krok 1 — Zainstaluj OpenClaw na nowej maszynie

Na **nowej** maszynie zainstaluj CLI (oraz Node, jeśli jest wymagany):

- Zobacz: [Install](/install)

Na tym etapie jest w porządku, jeśli onboarding utworzy świeży `~/.openclaw/` — w kolejnym kroku zostanie on nadpisany.

### Krok 2 — Skopiuj katalog stanu + obszar roboczy na nową maszynę

Skopiuj **oba**:

- `$OPENCLAW_STATE_DIR` (domyślnie `~/.openclaw/`)
- swój obszar roboczy (domyślnie `~/.openclaw/workspace/`)

Typowe podejścia:

- `scp` archiwów tar i ich rozpakowanie
- `rsync -a` przez SSH
- dysk zewnętrzny

Po skopiowaniu upewnij się, że:

- uwzględniono katalogi ukryte (np. `.openclaw/`)
- właściciel plików jest poprawny dla użytkownika uruchamiającego gateway

### Krok 3 — Uruchom Doctor (migracje + naprawa usług)

Na **nowej** maszynie:

```bash
openclaw doctor
```

Doctor to „bezpieczne i nudne” polecenie. Naprawia usługi, stosuje migracje konfiguracji i ostrzega o niezgodnościach.

Następnie:

```bash
openclaw gateway restart
openclaw status
```

## Typowe pułapki (i jak ich unikać)

### Pułapka: niezgodność profilu / katalogu stanu

Jeśli stary gateway był uruchamiany z profilem (lub `OPENCLAW_STATE_DIR`), a nowy gateway używa innego, zobaczysz objawy takie jak:

- zmiany konfiguracji nie wchodzą w życie
- brak kanałów / wylogowanie
- pusta historia sesji

Rozwiązanie: uruchom gateway/usługę z **tym samym** profilem/katalogiem stanu, który migrowałeś, a następnie ponownie uruchom:

```bash
openclaw doctor
```

### Pułapka: kopiowanie tylko `openclaw.json`

`openclaw.json` to za mało. Wielu dostawców przechowuje stan w:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Zawsze migruj cały folder `$OPENCLAW_STATE_DIR`.

### Pułapka: uprawnienia / własność plików

Jeśli kopiowałeś jako root lub zmieniłeś użytkownika, gateway może nie być w stanie odczytać poświadczeń/sesji.

Rozwiązanie: upewnij się, że katalog stanu i obszar roboczy należą do użytkownika uruchamiającego gateway.

### Pułapka: migracja między trybami zdalnym/lokalnym

- Jeśli interfejs użytkownika (WebUI/TUI) wskazuje na **zdalny** gateway, to zdalny host jest właścicielem magazynu sesji i obszaru roboczego.
- Migracja laptopa nie przeniesie stanu zdalnego gatewaya.

Jeśli pracujesz w trybie zdalnym, migruj **host Gateway**.

### Pułapka: sekrety w kopiach zapasowych

`$OPENCLAW_STATE_DIR` zawiera sekrety (klucze API, tokeny OAuth, poświadczenia WhatsApp). Traktuj kopie zapasowe jak sekrety produkcyjne:

- przechowuj je w formie zaszyfrowanej
- unikaj udostępniania przez niezabezpieczone kanały
- rotuj klucze, jeśli podejrzewasz ich ujawnienie

## Lista kontrolna weryfikacji

Na nowej maszynie potwierdź, że:

- `openclaw status` pokazuje działający gateway
- Twoje kanały są nadal połączone (np. WhatsApp nie wymaga ponownego parowania)
- panel otwiera się i pokazuje istniejące sesje
- pliki obszaru roboczego (pamięć, konfiguracje) są obecne

## Powiązane

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Where does OpenClaw store its data?](/help/faq#where-does-openclaw-store-its-data)
