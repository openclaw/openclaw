---
summary: "Jak działa sandboxing w OpenClaw: tryby, zakresy, dostęp do obszaru roboczego i obrazy"
title: Sandboxing
read_when: "Chcesz uzyskać dedykowane wyjaśnienie sandboxingu lub musisz dostroić agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw może uruchamiać **narzędzia wewnątrz kontenerów Docker**, aby zmniejszyć promień rażenia.
Jest to **opcjonalne** i kontrolowane przez konfigurację (`agents.defaults.sandbox` lub
`agents.list[].sandbox`). Jeśli sandboxing jest wyłączony, narzędzia działają na hoście.
Gateway pozostaje na hoście; wykonywanie narzędzi odbywa się w izolowanym sandboxie,
gdy jest włączone.

Nie jest to idealna granica bezpieczeństwa, ale w istotny sposób ogranicza dostęp
do systemu plików i procesów, gdy model zrobi coś nierozsądnego.

## Co jest objęte sandboxingiem

- Wykonywanie narzędzi (`exec`, `read`, `write`, `edit`, `apply_patch`, `process` itd.).
- Opcjonalna przeglądarka w sandboxie (`agents.defaults.sandbox.browser`).
  - Domyślnie przeglądarka w sandboxie uruchamia się automatycznie (zapewnia dostępność CDP), gdy narzędzie przeglądarki jej potrzebuje.
    Konfiguracja przez `agents.defaults.sandbox.browser.autoStart` i `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` pozwala sesjom w sandboxie jawnie kierować ruch do przeglądarki na hoście.
  - Opcjonalne listy dozwolonych ograniczają `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Nieobjęte sandboxingiem:

- Sam proces Gateway.
- Każde narzędzie jawnie dopuszczone do uruchamiania na hoście (np. `tools.elevated`).
  - **Podwyższone wykonanie (elevated exec) działa na hoście i omija sandboxing.**
  - Jeśli sandboxing jest wyłączony, `tools.elevated` nie zmienia sposobu wykonania (już działa na hoście). Zobacz [Elevated Mode](/tools/elevated).

## Mody

`agents.defaults.sandbox.mode` kontroluje **kiedy** używany jest sandboxing:

- `"off"`: brak sandboxingu.
- `"non-main"`: sandbox tylko dla sesji **niegłównych** (domyślne, jeśli chcesz, aby zwykłe czaty działały na hoście).
- `"all"`: każda sesja działa w sandboxie.
  Uwaga: `"non-main"` opiera się na `session.mainKey` (domyślnie `"main"`), a nie na identyfikatorze agenta.
  Sesje grupowe/kanałowe używają własnych kluczy, więc są traktowane jako niegłówne i będą sandboxowane.

## Zakres

`agents.defaults.sandbox.scope` kontroluje **ile kontenerów** jest tworzonych:

- `"session"` (domyślne): jeden kontener na sesję.
- `"agent"`: jeden kontener na agenta.
- `"shared"`: jeden kontener współdzielony przez wszystkie sesje w sandboxie.

## Dostęp do obszaru roboczego

`agents.defaults.sandbox.workspaceAccess` kontroluje **co sandbox może widzieć**:

- `"none"` (domyślne): narzędzia widzą obszar roboczy sandboxa w `~/.openclaw/sandboxes`.
- `"ro"`: montuje obszar roboczy agenta tylko do odczytu w `/agent` (wyłącza `write`/`edit`/`apply_patch`).
- `"rw"`: montuje obszar roboczy agenta do odczytu i zapisu w `/workspace`.

Media przychodzące są kopiowane do aktywnego obszaru roboczego sandboxa (`media/inbound/*`).
Uwaga dotycząca Skills: narzędzie `read` jest zakorzenione w sandboxie. Przy `workspaceAccess: "none"`
OpenClaw kopiuje kwalifikujące się skills do obszaru roboczego sandboxa (`.../skills`),
aby mogły być odczytywane. Przy `"rw"` skills obszaru roboczego są czytelne z
`/workspace/skills`.

## Niestandardowe montowania bind

`agents.defaults.sandbox.docker.binds` montuje dodatkowe katalogi hosta do kontenera.
Format: `host:container:mode` (np. `"/home/user/source:/source:rw"`).

Powiązania globalne i per-agent są **łączone** (nie zastępowane). Przy `scope: "shared"` powiązania per-agent są ignorowane.

Przykład (źródło tylko do odczytu + gniazdo Dockera):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Uwagi dotyczące bezpieczeństwa:

- Powiązania omijają system plików sandboxa: ujawniają ścieżki hosta z trybem, który ustawisz (`:ro` lub `:rw`).
- Wrażliwe montowania (np. `docker.sock`, sekrety, klucze SSH) powinny być `:ro`, chyba że są absolutnie wymagane.
- Połącz z `workspaceAccess: "ro"`, jeśli potrzebujesz tylko dostępu do odczytu do obszaru roboczego; tryby bindów pozostają niezależne.
- Zobacz [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated), aby zrozumieć, jak bindy wchodzą w interakcję z polityką narzędzi i podwyższonym wykonaniem.

## Obrazy + konfiguracja

Domyślny obraz: `openclaw-sandbox:bookworm-slim`

Zbuduj go jednorazowo:

```bash
scripts/sandbox-setup.sh
```

Uwaga: domyślny obraz **nie** zawiera Node. Jeśli skill wymaga Node (lub
innych środowisk uruchomieniowych), albo przygotuj niestandardowy obraz, albo zainstaluj przez
`sandbox.docker.setupCommand` (wymaga wyjścia do sieci + zapisywalnego root +
użytkownika root).

Obraz przeglądarki w sandboxie:

```bash
scripts/sandbox-browser-setup.sh
```

Domyślnie kontenery sandboxa działają **bez sieci**.
Nadpisz to przez `agents.defaults.sandbox.docker.network`.

Instalacje Dockera i skonteneryzowany gateway znajdują się tutaj:
[Docker](/install/docker)

## setupCommand (jednorazowa konfiguracja kontenera)

`setupCommand` uruchamia się **raz** po utworzeniu kontenera sandboxa (nie przy każdym uruchomieniu).
Wykonywany jest wewnątrz kontenera przez `sh -lc`.

Ścieżki:

- Globalnie: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

Często plamy:

- Domyślne `docker.network` to `"none"` (brak wyjścia do sieci), więc instalacje pakietów się nie powiodą.
- `readOnlyRoot: true` uniemożliwia zapisy; ustaw `readOnlyRoot: false` lub przygotuj niestandardowy obraz.
- `user` musi być rootem do instalacji pakietów (pomiń `user` lub ustaw `user: "0:0"`).
- Wykonanie w sandboxie **nie** dziedziczy hostowych `process.env`. Użyj
  `agents.defaults.sandbox.docker.env` (lub niestandardowego obrazu) dla kluczy API skills.

## Polityka narzędzi + furtki awaryjne

Polityki zezwalania/odmawiania narzędzi nadal obowiązują przed regułami sandboxa. Jeśli narzędzie jest zabronione
globalnie lub per-agent, sandboxing go nie przywróci.

`tools.elevated` to jawna furtka, która uruchamia `exec` na hoście.
Dyrektywy `/exec` mają zastosowanie tylko dla autoryzowanych nadawców i utrzymują się per sesję; aby trwale wyłączyć
`exec`, użyj odmowy w polityce narzędzi (zobacz [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugowanie:

- Użyj `openclaw sandbox explain`, aby sprawdzić efektywny tryb sandboxa, politykę narzędzi i klucze konfiguracji napraw.
- Zobacz [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated), aby zrozumieć model myślowy „dlaczego to jest zablokowane?”.
  Zachowaj ścisłe ograniczenia.

## Nadpisania wieloagentowe

Każdy agent może nadpisać sandbox + narzędzia:
`agents.list[].sandbox` i `agents.list[].tools` (oraz `agents.list[].tools.sandbox.tools` dla polityki narzędzi sandboxa).
Zobacz [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) w kwestii priorytetów.

## Minimalny przykład włączenia

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Powiązana dokumentacja

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
