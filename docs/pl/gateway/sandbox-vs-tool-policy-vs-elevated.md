---
title: Sandbox vs Tool Policy vs Elevated
summary: "„Dlaczego narzędzie jest zablokowane: środowisko wykonawcze sandbox, polityka dozwalania/blokowania narzędzi oraz bramki elevated exec”"
read_when: "„Gdy trafisz do „sandbox jail” lub zobaczysz odmowę narzędzia/elevated i chcesz znać dokładny klucz konfiguracji do zmiany.”"
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw ma trzy powiązane (ale różne) mechanizmy kontroli:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) decyduje, **gdzie uruchamiane są narzędzia** (Docker vs host).
2. **Polityka narzędzi** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) decyduje, **które narzędzia są dostępne/dozwolone**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) to **wyłącznie dla exec „wyjście awaryjne”**, pozwalające uruchamiać na hoście, gdy jesteś w sandboxie.

## Szybkie debugowanie

Użyj inspektora, aby zobaczyć, co OpenClaw _faktycznie_ robi:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Wypisz:

- efektywny tryb/zakres sandboxa/dostęp do obszaru roboczego
- czy sesja jest obecnie sandboxowana (main vs non-main)
- efektywne allow/deny narzędzi w sandboxie (oraz czy pochodzi z agenta/globalnych/dom yślnych)
- bramki elevated oraz ścieżki kluczy „fix-it”

## Sandbox: gdzie uruchamiane są narzędzia

Sandboxing jest kontrolowany przez `agents.defaults.sandbox.mode`:

- `"off"`: wszystko działa na hoście.
- `"non-main"`: tylko sesje non-main są sandboxowane (częsta „niespodzianka” dla grup/kanałów).
- `"all"`: wszystko jest sandboxowane.

Zobacz [Sandboxing](/gateway/sandboxing), aby poznać pełną macierz (zakres, montowania obszaru roboczego, obrazy).

### Montowania bind (szybka kontrola bezpieczeństwa)

- `docker.binds` _przebija_ system plików sandboxa: wszystko, co zamontujesz, jest widoczne wewnątrz kontenera z ustawionym trybem (`:ro` lub `:rw`).
- Domyślnie jest tryb odczyt-zapis, jeśli pominiesz tryb; preferuj `:ro` dla źródeł/tajemnic.
- `scope: "shared"` ignoruje bindy per-agent (obowiązują tylko bindy globalne).
- Bindowanie `/var/run/docker.sock` w praktyce oddaje kontrolę hosta sandboxowi; rób to tylko świadomie.
- Dostęp do obszaru roboczego (`workspaceAccess: "ro"`/`"rw"`) jest niezależny od trybów bind.

## Polityka narzędzi: które narzędzia istnieją/są wywoływalne

Znaczenie mają dwie warstwy:

- **Profil narzędzi**: `tools.profile` i `agents.list[].tools.profile` (bazowa lista dozwolonych)
- **Profil narzędzi dostawcy**: `tools.byProvider[provider].profile` i `agents.list[].tools.byProvider[provider].profile`
- **Globalna/per-agent polityka narzędzi**: `tools.allow`/`tools.deny` oraz `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Polityka narzędzi dostawcy**: `tools.byProvider[provider].allow/deny` i `agents.list[].tools.byProvider[provider].allow/deny`
- **Polityka narzędzi sandboxa** (obowiązuje tylko w sandboxie): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` oraz `agents.list[].tools.sandbox.tools.*`

Zasady ogólne:

- `deny` zawsze wygrywa.
- Jeśli `allow` jest niepuste, wszystko inne jest traktowane jako zablokowane.
- Polityka narzędzi to twarda bariera: `/exec` nie może nadpisać odmowy narzędzia `exec`.
- `/exec` zmienia tylko domyślne ustawienia sesji dla autoryzowanych nadawców; nie przyznaje dostępu do narzędzi.
  Klucze narzędzi dostawcy akceptują albo `provider` (np. `google-antigravity`), albo `provider/model` (np. `openai/gpt-5.2`).

### Grupy narzędzi (skróty)

Polityki narzędzi (globalne, per-agent, sandbox) obsługują wpisy `group:*`, które rozwijają się do wielu narzędzi:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Dostępne grupy:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: wszystkie wbudowane narzędzia OpenClaw (z wyłączeniem wtyczek dostawców)

## Elevated: exec-only „uruchom na hoście”

Elevated **nie** przyznaje dodatkowych narzędzi; wpływa wyłącznie na `exec`.

- Jeśli jesteś w sandboxie, `/elevated on` (lub `exec` z `elevated: true`) uruchamia się na hoście (zatwierdzenia mogą nadal obowiązywać).
- Użyj `/elevated full`, aby pominąć zatwierdzenia exec dla sesji.
- Jeśli już działasz bezpośrednio, elevated jest w praktyce no-op (nadal objęte bramkami).
- Elevated **nie** jest ograniczone zakresem Skills i **nie** nadpisuje allow/deny narzędzi.
- `/exec` jest niezależne od elevated. Koryguje jedynie domyślne ustawienia exec per sesję dla autoryzowanych nadawców.

Bramki:

- Włączenie: `tools.elevated.enabled` (i opcjonalnie `agents.list[].tools.elevated.enabled`)
- Listy dozwolonych nadawców: `tools.elevated.allowFrom.<provider>` (i opcjonalnie `agents.list[].tools.elevated.allowFrom.<provider>`)

Zobacz [Elevated Mode](/tools/elevated).

## Typowe poprawki „sandbox jail”

### „Narzędzie X zablokowane przez politykę narzędzi sandboxa”

Klucze naprawcze (wybierz jeden):

- Wyłącz sandbox: `agents.defaults.sandbox.mode=off` (lub per-agent `agents.list[].sandbox.mode=off`)
- Zezwól na narzędzie w sandboxie:
  - usuń je z `tools.sandbox.tools.deny` (lub per-agent `agents.list[].tools.sandbox.tools.deny`)
  - albo dodaj je do `tools.sandbox.tools.allow` (lub per-agent allow)

### „Myślałem, że to main — dlaczego jest sandboxowane?”

W trybie `"non-main"` klucze grup/kanałów _nie_ są main. Użyj klucza sesji main (pokazanego przez `sandbox explain`) albo przełącz tryb na `"off"`.
