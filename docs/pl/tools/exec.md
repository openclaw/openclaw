---
summary: "Użycie narzędzia exec, tryby stdin oraz obsługa TTY"
read_when:
  - Używanie lub modyfikowanie narzędzia exec
  - Debugowanie zachowania stdin lub TTY
title: "Narzędzie Exec"
---

# Narzędzie exec

Uruchamiaj polecenia powłoki w obszarze roboczym. Obsługuje wykonanie na pierwszym planie oraz w tle za pomocą `process`.
Jeśli `process` jest niedozwolone, `exec` działa synchronicznie i ignoruje `yieldMs`/`background`.
Sesje w tle są ograniczone do agenta; `process` widzi tylko sesje z tego samego agenta.

## Parametry

- `command` (wymagane)
- `workdir` (domyślnie cwd)
- `env` (nadpisania klucz/wartość)
- `yieldMs` (domyślnie 10000): automatyczne przejście w tło po opóźnieniu
- `background` (bool): natychmiast w tle
- `timeout` (sekundy, domyślnie 1800): zabicie po wygaśnięciu
- `pty` (bool): uruchom w pseudo-terminalu, gdy dostępny (CLI wymagające TTY, agenci kodujący, interfejsy terminalowe)
- `host` (`sandbox | gateway | node`): miejsce wykonania
- `security` (`deny | allowlist | full`): tryb egzekwowania dla `gateway`/`node`
- `ask` (`off | on-miss | always`): monity zatwierdzania dla `gateway`/`node`
- `node` (string): identyfikator/nazwa węzła dla `host=node`
- `elevated` (bool): żądanie trybu podwyższonego (host gateway); `security=full` jest wymuszane tylko wtedy, gdy podwyższenie rozwiązuje się do `full`

Uwagi:

- `host` domyślnie ma wartość `sandbox`.
- `elevated` jest ignorowane, gdy sandboxing jest wyłączony (exec już działa na hoście).
- Zatwierdzenia `gateway`/`node` są kontrolowane przez `~/.openclaw/exec-approvals.json`.
- `node` wymaga sparowanego węzła (aplikacja towarzysząca lub bezgłowy host węzła).
- Jeśli dostępnych jest wiele węzłów, ustaw `exec.node` lub `tools.exec.node`, aby wybrać jeden.
- Na hostach innych niż Windows exec używa `SHELL`, jeśli ustawione; jeśli `SHELL` to `fish`, preferuje `bash` (lub `sh`)
  z `PATH`, aby uniknąć skryptów niekompatybilnych z fish, a następnie wraca do `SHELL`, jeśli żaden nie istnieje.
- Wykonanie na hoście (`gateway`/`node`) odrzuca `env.PATH` oraz nadpisania loadera (`LD_*`/`DYLD_*`), aby
  zapobiec przechwyceniu binariów lub wstrzyknięciu kodu.
- Ważne: sandboxing jest **domyślnie wyłączony**. Jeśli sandboxing jest wyłączony, `host=sandbox` działa bezpośrednio na
  hoście gateway (bez kontenera) i **nie wymaga zatwierdzeń**. Aby wymagać zatwierdzeń, uruchom z
  `host=gateway` i skonfiguruj zatwierdzania exec (lub włącz sandboxing).

## Konfiguracja

- `tools.exec.notifyOnExit` (domyślnie: true): gdy true, sesje exec uruchomione w tle kolejkują zdarzenie systemowe i żądają heartbeat przy zakończeniu.
- `tools.exec.approvalRunningNoticeMs` (domyślnie: 10000): emituje pojedyncze powiadomienie „uruchomione”, gdy exec objęty zatwierdzaniem działa dłużej niż ta wartość (0 wyłącza).
- `tools.exec.host` (domyślnie: `sandbox`)
- `tools.exec.security` (domyślnie: `deny` dla sandbox, `allowlist` dla gateway + węzeł, gdy nieustawione)
- `tools.exec.ask` (domyślnie: `on-miss`)
- `tools.exec.node` (domyślnie: unset)
- `tools.exec.pathPrepend`: lista katalogów do dodania na początek `PATH` dla uruchomień exec.
- `tools.exec.safeBins`: bezpieczne binaria tylko-stdin, które mogą działać bez jawnych wpisów na liście dozwolonych.

Przykład:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Obsługa PATH

- `host=gateway`: scala `PATH` Twojej powłoki logowania ze środowiskiem exec. Nadpisania `env.PATH` są
  odrzucane dla wykonania na hoście. Sam demon nadal działa z minimalnym `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: uruchamia `sh -lc` (powłokę logowania) wewnątrz kontenera, więc `/etc/profile` może zresetować `PATH`.
  OpenClaw dodaje `env.PATH` po wczytaniu profilu przez wewnętrzną zmienną środowiskową (bez interpolacji powłoki);
  `tools.exec.pathPrepend` ma tu również zastosowanie.
- `host=node`: do węzła wysyłane są tylko nieblokowane nadpisania zmiennych środowiskowych, które przekażesz. Nadpisania `env.PATH` są
  odrzucane dla wykonania na hoście. Bezgłowe hosty węzłów akceptują `PATH` tylko wtedy, gdy dodaje on prefiks do PATH hosta węzła
  (bez zastępowania). Węzły macOS całkowicie odrzucają nadpisania `PATH`.

Powiązanie węzła per agent (użyj indeksu listy agentów w konfiguracji):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Interfejs sterowania: karta Węzły zawiera mały panel „Powiązanie węzła exec” dla tych samych ustawień.

## Zastąpienie sesji (`/exec`)

Użyj `/exec`, aby ustawić **domyślne wartości per sesję** dla `host`, `security`, `ask` i `node`.
Wyślij `/exec` bez argumentów, aby wyświetlić bieżące wartości.

Przykład:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Model autoryzacji

`/exec` jest honorowane wyłącznie dla **autoryzowanych nadawców** (listy dozwolonych kanałów/parowanie plus `commands.useAccessGroups`).
Aktualizuje wyłącznie **stan sesji** i nie zapisuje konfiguracji. Aby trwale wyłączyć exec, zablokuj go w polityce
narzędzi (`tools.deny: ["exec"]` lub per agent). Zatwierdzenia hosta nadal obowiązują, chyba że jawnie ustawisz
`security=full` i `ask=off`.

## Zatwierdzanie exec (aplikacja towarzysząca / host węzła)

Agenci w sandboxie mogą wymagać zatwierdzenia dla każdego żądania, zanim `exec` uruchomi się na hoście gateway lub węzła.
Zobacz [Exec approvals](/tools/exec-approvals), aby poznać politykę, listę dozwolonych i przebieg w interfejsie.

Gdy zatwierdzenia są wymagane, narzędzie exec zwraca natychmiast
`status: "approval-pending"` oraz identyfikator zatwierdzenia. Po zatwierdzeniu (lub odrzuceniu / przekroczeniu czasu)
Gateway emituje zdarzenia systemowe (`Exec finished` / `Exec denied`). Jeśli polecenie nadal
działa po `tools.exec.approvalRunningNoticeMs`, emitowane jest pojedyncze powiadomienie `Exec running`.

## Lista dozwolonych + bezpieczne binaria

Egzekwowanie listy dozwolonych dopasowuje **wyłącznie rozwiązywane ścieżki binariów** (bez dopasowań po nazwie). Gdy
`security=allowlist`, polecenia powłoki są automatycznie dozwolone tylko wtedy, gdy każdy segment potoku jest
na liście dozwolonych lub jest bezpiecznym binarium. Łączenie (`;`, `&&`, `||`) oraz przekierowania są odrzucane w
trybie listy dozwolonych.

## Przykłady

Pierwszy plan:

```json
{ "tool": "exec", "command": "ls -la" }
```

Tło + odpytywanie:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Wysyłanie klawiszy (w stylu tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Wyślij (tylko CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Wklejanie (domyślnie w nawiasach):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (eksperymentalne)

`apply_patch` jest podnarzędziem `exec` do ustrukturyzowanych edycji wielu plików.
Włącz je jawnie:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Uwagi:

- Dostępne wyłącznie dla modeli OpenAI/OpenAI Codex.
- Polityka narzędzi nadal obowiązuje; `allow: ["exec"]` domyślnie zezwala na `apply_patch`.
- Konfiguracja znajduje się pod `tools.exec.applyPatch`.
