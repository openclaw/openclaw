---
summary: "Plan refaktoryzacji: routing hosta exec, zatwierdzania węzłów i bezgłowy runner"
read_when:
  - Projektowanie routingu hosta exec lub zatwierdzeń exec
  - Implementacja runnera węzła + IPC interfejsu UI
  - Dodawanie trybów bezpieczeństwa hosta exec i poleceń slash
title: "Refaktoryzacja hosta exec"
---

# Plan refaktoryzacji hosta exec

## Cele

- Dodać `exec.host` + `exec.security` do routingu wykonania między **sandbox**, **gateway** i **node**.
- Zachować **bezpieczne** domyślne ustawienia: brak wykonywania między hostami, o ile nie zostanie to jawnie włączone.
- Rozdzielić wykonanie na **bezgłową usługę runnera** z opcjonalnym UI (aplikacja na macOS) przez lokalne IPC.
- Zapewnić politykę **na agenta**, listę dozwolonych, tryb zapytań oraz wiązanie węzła.
- Obsłużyć **tryby zapytań**, które działają _z_ lub _bez_ list dozwolonych.
- Wieloplatformowość: gniazdo Unix + uwierzytelnianie tokenem (parytet macOS/Linux/Windows).

## Inne cele

- Brak migracji starszych list dozwolonych ani wsparcia dla starszego schematu.
- Brak PTY/strumieniowania dla exec węzła (tylko zagregowane wyjście).
- Brak nowej warstwy sieciowej poza istniejącymi Bridge + Gateway.

## Decyzje (zablokowane)

- **Klucze konfiguracji:** `exec.host` + `exec.security` (dozwolone nadpisanie na agenta).
- **Podniesienie uprawnień:** zachować `/elevated` jako alias pełnego dostępu gateway.
- **Domyślny tryb zapytań:** `on-miss`.
- **Magazyn zatwierdzeń:** `~/.openclaw/exec-approvals.json` (JSON, bez migracji starszych danych).
- **Runner:** bezgłowa usługa systemowa; aplikacja UI hostuje gniazdo Unix do zatwierdzeń.
- **Tożsamość węzła:** użyć istniejącego `nodeId`.
- **Uwierzytelnianie gniazda:** gniazdo Unix + token (wieloplatformowo); ewentualny podział później.
- **Stan hosta węzła:** `~/.openclaw/node.json` (id węzła + token parowania).
- **Host exec na macOS:** uruchamiać `system.run` wewnątrz aplikacji na macOS; usługa hosta węzła przekazuje żądania przez lokalne IPC.
- **Brak pomocnika XPC:** pozostać przy gnieździe Unix + token + sprawdzeniach peerów.

## Kluczowe pojęcia

### Host

- `sandbox`: exec Dockera (obecne zachowanie).
- `gateway`: exec na hoście gateway.
- `node`: exec na runnerze węzła przez Bridge (`system.run`).

### Tryb bezpieczeństwa

- `deny`: zawsze blokuj.
- `allowlist`: zezwalaj tylko na dopasowania.
- `full`: zezwalaj na wszystko (równoważne podniesionym uprawnieniom).

### Tryb zapytań

- `off`: nigdy nie pytaj.
- `on-miss`: pytaj tylko, gdy lista dozwolonych nie pasuje.
- `always`: pytaj za każdym razem.

Tryb zapytań jest **niezależny** od listy dozwolonych; listy dozwolonych można używać z `always` lub `on-miss`.

### Rozwiązywanie polityki (na każde exec)

1. Rozwiąż `exec.host` (parametr narzędzia → nadpisanie agenta → domyślne globalne).
2. Rozwiąż `exec.security` i `exec.ask` (ta sama kolejność).
3. Jeśli host to `sandbox`, kontynuuj lokalne exec w sandbox.
4. Jeśli host to `gateway` lub `node`, zastosuj politykę bezpieczeństwa + zapytań na tym hoście.

## Domyślne bezpieczeństwo

- Domyślnie `exec.host = sandbox`.
- Domyślnie `exec.security = deny` dla `gateway` i `node`.
- Domyślnie `exec.ask = on-miss` (istotne tylko, jeśli bezpieczeństwo na to pozwala).
- Jeśli nie ustawiono wiązania węzła, **agent może wskazać dowolny węzeł**, ale tylko jeśli polityka na to pozwala.

## Powierzchnia konfiguracji

### Parametry narzędzia

- `exec.host` (opcjonalne): `sandbox | gateway | node`.
- `exec.security` (opcjonalne): `deny | allowlist | full`.
- `exec.ask` (opcjonalne): `off | on-miss | always`.
- `exec.node` (opcjonalne): id/nazwa węzła do użycia, gdy `host=node`.

### Klucze konfiguracji (globalne)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (domyślne wiązanie węzła)

### Klucze konfiguracji (na agenta)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = ustaw `tools.exec.host=gateway`, `tools.exec.security=full` dla sesji agenta.
- `/elevated off` = przywróć poprzednie ustawienia exec dla sesji agenta.

## Magazyn zatwierdzeń (JSON)

Ścieżka: `~/.openclaw/exec-approvals.json`

Cel:

- Lokalna polityka + listy dozwolonych dla **hosta wykonawczego** (gateway lub runner węzła).
- Zapasowy tryb zapytań, gdy UI jest niedostępne.
- Poświadczenia IPC dla klientów UI.

Proponowany schemat (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Uwagi:

- Brak starszych formatów list dozwolonych.
- `askFallback` obowiązuje tylko, gdy wymagane jest `ask` i nie można połączyć się z UI.
- Uprawnienia pliku: `0600`.

## Usługa runnera (bezgłowa)

### Rola

- Lokalnie egzekwować `exec.security` + `exec.ask`.
- Wykonywać polecenia systemowe i zwracać wyjście.
- Emitować zdarzenia Bridge dla cyklu życia exec (opcjonalne, ale zalecane).

### Cykl życia usługi

- Launchd/daemon na macOS; usługa systemowa na Linux/Windows.
- JSON zatwierdzeń jest lokalny dla hosta wykonawczego.
- UI hostuje lokalne gniazdo Unix; runnerzy łączą się na żądanie.

## Integracja UI (aplikacja na macOS)

### IPC

- Gniazdo Unix pod `~/.openclaw/exec-approvals.sock` (0600).
- Token przechowywany w `exec-approvals.json` (0600).
- Sprawdzenia peerów: tylko ten sam UID.
- Wyzwanie/odpowiedź: nonce + HMAC(token, request-hash) w celu zapobiegania replay.
- Krótki TTL (np. 10 s) + maksymalny rozmiar payloadu + limitowanie szybkości.

### Przepływ zapytań (host exec aplikacji na macOS)

1. Usługa węzła otrzymuje `system.run` z gateway.
2. Usługa węzła łączy się z lokalnym gniazdem i wysyła prompt/żądanie exec.
3. Aplikacja weryfikuje peer + token + HMAC + TTL, a następnie w razie potrzeby pokazuje okno dialogowe.
4. Aplikacja wykonuje polecenie w kontekście UI i zwraca wyjście.
5. Usługa węzła zwraca wyjście do gateway.

Jeśli UI jest niedostępne:

- Zastosuj `askFallback` (`deny|allowlist|full`).

### Diagram (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Tożsamość węzła + wiązanie

- Użyć istniejącego `nodeId` z parowania Bridge.
- Model wiązania:
  - `tools.exec.node` ogranicza agenta do konkretnego węzła.
  - Jeśli nieustawione, agent może wybrać dowolny węzeł (polityka nadal egzekwuje domyślne zasady).
- Rozwiązywanie wyboru węzła:
  - `nodeId` dokładne dopasowanie
  - `displayName` (znormalizowane)
  - `remoteIp`
  - prefiks `nodeId` (>= 6 znaków)

## Zdarzenia

### Kto widzi zdarzenia

- Zdarzenia systemowe są **na sesję** i są pokazywane agentowi przy następnym promptcie.
- Przechowywane w kolejce w pamięci gateway (`enqueueSystemEvent`).

### Treść zdarzeń

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + opcjonalny ogon wyjścia
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

Opcja A (zalecana):

- Runner wysyła ramki Bridge `event` `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` mapuje je na `enqueueSystemEvent`.

Opcja B:

- Narzędzie gateway `exec` obsługuje cykl życia bezpośrednio (tylko synchronicznie).

## Przepływy exec

### Host sandbox

- Istniejące zachowanie `exec` (Docker lub host, gdy bez sandbox).
- PTY obsługiwane tylko w trybie bez sandbox.

### Host gateway

- Proces gateway wykonuje się na własnej maszynie.
- Egzekwuje lokalne `exec-approvals.json` (bezpieczeństwo/zapytania/lista dozwolonych).

### Host węzła

- Gateway wywołuje `node.invoke` z `system.run`.
- Runner egzekwuje lokalne zatwierdzenia.
- Runner zwraca zagregowane stdout/stderr.
- Opcjonalne zdarzenia Bridge dla startu/zakończenia/odmowy.

## Limity wyjścia

- Ograniczyć łączny stdout+stderr do **200k**; zachować **ogon 20k** dla zdarzeń.
- Ucinać z czytelnym sufiksem (np. `"… (truncated)"`).

## Polecenia slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Nadpisania na agenta i na sesję; nietrwałe, chyba że zapisane przez konfigurację.
- `/elevated on|off|ask|full` pozostaje skrótem do `host=gateway security=full` (z `full` pomijającym zatwierdzenia).

## Wieloplatformowa historia

- Usługa runnera jest przenośnym celem wykonawczym.
- UI jest opcjonalne; jeśli go brakuje, obowiązuje `askFallback`.
- Windows/Linux obsługują ten sam JSON zatwierdzeń + protokół gniazda.

## Fazy implementacji

### Faza 1: konfiguracja + routing exec

- Dodać schemat konfiguracji dla `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Zaktualizować okablowanie narzędzia, aby respektowało `exec.host`.
- Dodać polecenie slash `/exec` i zachować alias `/elevated`.

### Faza 2: magazyn zatwierdzeń + egzekwowanie w gateway

- Zaimplementować czytnik/zapis `exec-approvals.json`.
- Egzekwować listę dozwolonych + tryby zapytań dla hosta `gateway`.
- Dodać limity wyjścia.

### Faza 3: egzekwowanie w runnerze węzła

- Zaktualizować runner węzła, aby egzekwował listę dozwolonych + zapytania.
- Dodać most promptów przez gniazdo Unix do UI aplikacji na macOS.
- Podłączyć `askFallback`.

### Faza 4: zdarzenia

- Dodać zdarzenia Bridge węzeł → gateway dla cyklu życia exec.
- Zmapować do `enqueueSystemEvent` dla promptów agenta.

### Faza 5: dopracowanie UI

- Aplikacja na macOS: edytor list dozwolonych, przełącznik per-agent, UI polityki zapytań.
- Kontrolki wiązania węzła (opcjonalne).

## Plan testów

- Testy jednostkowe: dopasowanie list dozwolonych (glob + bez rozróżniania wielkości liter).
- Testy jednostkowe: pierwszeństwo rozwiązywania polityki (parametr narzędzia → nadpisanie agenta → globalne).
- Testy integracyjne: przepływy odmowy/zezwolenia/zapytań w runnerze węzła.
- Testy zdarzeń Bridge: węzeł → zdarzenie systemowe routing.

## Otwarte ryzyka

- Niedostępność UI: upewnić się, że respektowane jest `askFallback`.
- Długotrwałe polecenia: polegać na timeoutach + limitach wyjścia.
- Wielowęzłowa niejednoznaczność: błąd, chyba że ustawiono wiązanie węzła lub jawny parametr węzła.

## Powiązana dokumentacja

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
