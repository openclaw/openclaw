---
summary: "Zatwierdzanie wykonania (exec), listy dozwolonych i monity wyjścia z sandboxa"
read_when:
  - Konfigurowanie zatwierdzania wykonania (exec) lub list dozwolonych
  - Implementowanie UX zatwierdzania exec w aplikacji na macOS
  - Przeglądanie monitów wyjścia z sandboxa i ich konsekwencji
title: "Zatwierdzanie wykonania (Exec)"
---

# Zatwierdzanie wykonania (exec approvals)

Zatwierdzanie wykonania (exec) to **zabezpieczenie aplikacji towarzyszącej / hosta węzła**, które pozwala agentowi działającemu w sandboxie uruchamiać
polecenia na rzeczywistym hoście (`gateway` lub `node`). Traktuj to jak blokadę bezpieczeństwa:
polecenia są dozwolone tylko wtedy, gdy **polityka + lista dozwolonych + (opcjonalnie) zgoda użytkownika** są zgodne.
Zatwierdzanie exec działa **dodatkowo** względem polityki narzędzi i bramkowania podwyższonego (chyba że tryb podwyższony ma wartość `full`, co pomija zatwierdzanie).
Skuteczna polityka to **bardziej restrykcyjna** z `tools.exec.*` oraz domyślnych ustawień zatwierdzania; jeśli pole zatwierdzania zostanie pominięte, używana jest wartość `tools.exec`.

Jeśli interfejs aplikacji towarzyszącej **nie jest dostępny**, każde żądanie wymagające monitu
jest rozstrzygane przez **ask fallback** (domyślnie: odmowa).

## Gdzie ma zastosowanie

Zatwierdzanie exec jest egzekwowane lokalnie na hoście wykonawczym:

- **host gateway (bramy)** → proces `openclaw` na maszynie gateway
- **host węzła** → runner węzła (aplikacja towarzysząca na macOS lub bezgłowy host węzła)

Podział na macOS:

- **usługa hosta węzła** przekazuje `system.run` do **aplikacji na macOS** przez lokalne IPC.
- **aplikacja na macOS** egzekwuje zatwierdzanie + wykonuje polecenie w kontekście UI.

## Ustawienia i przechowywanie

Zatwierdzenia są przechowywane w lokalnym pliku JSON na hoście wykonawczym:

`~/.openclaw/exec-approvals.json`

Przykładowy schemat:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Pokrętła polityki

### Bezpieczeństwo (`exec.security`)

- **deny**: blokuje wszystkie żądania wykonania na hoście.
- **allowlist**: zezwala tylko na polecenia znajdujące się na liście dozwolonych.
- **full**: zezwala na wszystko (równoważne trybowi podwyższonemu).

### Pytaj (`exec.ask`)

- **off**: nigdy nie pytaj.
- **on-miss**: pytaj tylko wtedy, gdy lista dozwolonych nie pasuje.
- **always**: pytaj przy każdym poleceniu.

### Ask fallback (`askFallback`)

Jeśli wymagany jest monit, ale żaden interfejs UI nie jest osiągalny, decyzję podejmuje fallback:

- **deny**: blokuj.
- **allowlist**: zezwalaj tylko wtedy, gdy pasuje lista dozwolonych.
- **full**: zezwalaj.

## Lista dozwolonych (na agenta)

Listy dozwolonych są **per agent**. Jeśli istnieje wielu agentów, przełączaj, którego
edytujesz, w aplikacji na macOS. Wzorce są **dopasowaniami glob bez rozróżniania wielkości liter**.
Wzorce powinny rozwiązywać się do **ścieżek binariów** (wpisy tylko z nazwą pliku są ignorowane).
Starsze wpisy `agents.default` są migrowane do `agents.main` przy wczytywaniu.

Przykłady:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Każdy wpis listy dozwolonych śledzi:

- **id** — stabilny UUID używany do identyfikacji w UI (opcjonalne)
- **last used** — znacznik czasu ostatniego użycia
- **last used command**
- **last resolved path**

## Automatyczne zezwalanie na CLI Skills

Gdy **Auto-allow skill CLIs** jest włączone, pliki wykonywalne referencjonowane przez znane Skills
są traktowane jako dozwolone na węzłach (węzeł macOS lub bezgłowy host węzła). Wykorzystuje to
`skills.bins` przez RPC Gateway do pobrania listy binariów Skills. Wyłącz to, jeśli chcesz ściśle ręczne listy dozwolonych.

## Bezpieczne binaria (tylko stdin)

`tools.exec.safeBins` definiuje niewielką listę binariów **tylko stdin** (na przykład `jq`),
które mogą działać w trybie listy dozwolonych **bez** jawnych wpisów na liście. Bezpieczne binaria odrzucają
pozycyjne argumenty plików i tokeny przypominające ścieżki, więc mogą operować wyłącznie na strumieniu wejściowym.
Łączenie poleceń powłoki i przekierowania nie są automatycznie dozwolone w trybie listy dozwolonych.

Łączenie poleceń powłoki (`&&`, `||`, `;`) jest dozwolone, gdy każdy segment najwyższego poziomu spełnia listę dozwolonych
(w tym bezpieczne binaria lub automatyczne zezwolenia Skills). Przekierowania pozostają nieobsługiwane w trybie listy dozwolonych.
Podstawianie poleceń (`$()` / backticks) jest odrzucane podczas parsowania listy dozwolonych, także wewnątrz
podwójnych cudzysłowów; użyj pojedynczych cudzysłowów, jeśli potrzebujesz dosłownego tekstu `$()`.

Domyślne bezpieczne binaria: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Edycja w UI sterowania

Użyj karty **Control UI → Nodes → Exec approvals**, aby edytować ustawienia domyślne, nadpisania
per agent oraz listy dozwolonych. Wybierz zakres (Ustawienia domyślne lub agent), dostosuj politykę,
dodaj/usuń wzorce listy dozwolonych, a następnie **Zapisz**. UI pokazuje metadane **last used**
dla każdego wzorca, aby ułatwić utrzymanie porządku na liście.

Selektor celu wybiera **Gateway** (lokalne zatwierdzanie) lub **Węzeł**. Węzły
muszą reklamować `system.execApprovals.get/set` (aplikacja na macOS lub bezgłowy host węzła).
Jeśli węzeł nie reklamuje jeszcze zatwierdzania exec, edytuj jego lokalny
`~/.openclaw/exec-approvals.json` bezpośrednio.

CLI: `openclaw approvals` obsługuje edycję gateway lub węzła (zobacz [Approvals CLI](/cli/approvals)).

## Przebieg zatwierdzania

Gdy wymagany jest monit, gateway rozgłasza `exec.approval.requested` do klientów operatora.
Control UI oraz aplikacja na macOS rozstrzygają go przez `exec.approval.resolve`, po czym gateway przekazuje
zatwierdzone żądanie do hosta węzła.

Gdy zatwierdzanie jest wymagane, narzędzie exec natychmiast zwraca identyfikator zatwierdzenia. Użyj tego id, aby
skorelować późniejsze zdarzenia systemowe (`Exec finished` / `Exec denied`). Jeśli żadna decyzja nie nadejdzie przed
upływem limitu czasu, żądanie jest traktowane jako przekroczenie czasu zatwierdzania i prezentowane jako powód odmowy.

Okno potwierdzenia zawiera:

- polecenie + argumenty
- cwd
- id agenta
- rozwiązaną ścieżkę pliku wykonywalnego
- metadane hosta + polityki

Akcje:

- **Allow once** → uruchom teraz
- **Always allow** → dodaj do listy dozwolonych + uruchom
- **Deny** → zablokuj

## Przekazywanie zatwierdzeń do kanałów czatu

Możesz przekazywać monity zatwierdzania exec do dowolnego kanału czatu (w tym kanałów wtyczek) i zatwierdzać
je za pomocą `/approve`. Wykorzystuje to standardowy potok dostarczania wychodzącego.

Konfiguracja:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Odpowiedź na czacie:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Przepływ IPC na macOS

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Uwagi dotyczące bezpieczeństwa:

- Tryb gniazda Unix `0600`, token przechowywany w `exec-approvals.json`.
- Sprawdzanie równorzędne z Same-UID.
- Wyzwanie/odpowiedź (nonce + token HMAC + skrót żądania) + krótki TTL.

## Zdarzenia systemowe

Cykl życia exec jest prezentowany jako komunikaty systemowe:

- `Exec running` (tylko jeśli polecenie przekracza próg powiadomienia o uruchomieniu)
- `Exec finished`
- `Exec denied`

Są one publikowane do sesji agenta po tym, jak węzeł zgłosi zdarzenie.
Zatwierdzanie exec na hoście gateway emituje te same zdarzenia cyklu życia po zakończeniu polecenia (oraz opcjonalnie, gdy trwa dłużej niż próg).
Wykonania objęte zatwierdzaniem używają identyfikatora zatwierdzenia jako `runId` w tych komunikatach, co ułatwia korelację.

## Konsekwencje

- **full** jest potężne; gdy to możliwe, preferuj listy dozwolonych.
- **ask** pozwala zachować kontrolę, jednocześnie umożliwiając szybkie zatwierdzanie.
- Listy dozwolonych per agent zapobiegają przenikaniu zatwierdzeń jednego agenta do innych.
- Zatwierdzanie dotyczy tylko żądań exec na hoście od **autoryzowanych nadawców**. Nieautoryzowani nadawcy nie mogą wydawać `/exec`.
- `/exec security=full` to udogodnienie na poziomie sesji dla autoryzowanych operatorów i celowo pomija zatwierdzanie.
  Aby twardo zablokować exec na hoście, ustaw bezpieczeństwo zatwierdzania na `deny` lub zabroń narzędzia `exec` przez politykę narzędzi.

Powiązane:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
