---
summary: "Powierzchnia narzędzi agenta dla OpenClaw (przeglądarka, canvas, węzły, wiadomości, cron), zastępująca starsze skills `openclaw-*`"
read_when:
  - Dodawanie lub modyfikowanie narzędzi agenta
  - Wycofywanie lub zmienianie skills `openclaw-*`
title: "Narzędzia"
---

# Narzędzia (OpenClaw)

OpenClaw udostępnia **natywne narzędzia agenta** dla przeglądarki, canvas, węzłów i cron.
Zastępują one stare skills `openclaw-*`: narzędzia są typowane, bez wywołań powłoki,
a agent powinien polegać na nich bezpośrednio.

## Wyłączanie narzędzi

Możesz globalnie zezwalać/odmawiać narzędzi za pomocą `tools.allow` / `tools.deny` w `openclaw.json`
(priorytet ma odmowa). Zapobiega to wysyłaniu niedozwolonych narzędzi do dostawców modeli.

```json5
{
  tools: { deny: ["browser"] },
}
```

Uwagi:

- Dopasowanie jest niewrażliwe na wielkość liter.
- Obsługiwane są symbole wieloznaczne `*` (`"*"` oznacza wszystkie narzędzia).
- Jeśli `tools.allow` odwołuje się wyłącznie do nieznanych lub niezaładowanych nazw narzędzi wtyczek, OpenClaw zapisuje ostrzeżenie i ignoruje listę dozwolonych, aby narzędzia rdzeniowe pozostały dostępne.

## Profile narzędzi (bazowa lista dozwolonych)

`tools.profile` ustawia **bazową listę dozwolonych narzędzi** przed `tools.allow`/`tools.deny`.
Nadpisanie per-agent: `agents.list[].tools.profile`.

Profile:

- `minimal`: tylko `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: brak ograniczeń (tak samo jak brak ustawienia)

Przykład (domyślnie tylko wiadomości, dodatkowo zezwól na narzędzia Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Przykład (profil programistyczny, ale zabroń exec/process wszędzie):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Przykład (globalny profil programistyczny, agent wsparcia tylko do wiadomości):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Polityka narzędzi specyficzna dla dostawcy

Użyj `tools.byProvider`, aby **dodatkowo zawęzić** narzędzia dla konkretnych dostawców
(lub pojedynczego `provider/model`) bez zmiany globalnych domyślnych ustawień.
Nadpisanie per-agent: `agents.list[].tools.byProvider`.

Jest to stosowane **po** bazowym profilu narzędzi i **przed** listami zezwalania/odmowy,
więc może jedynie zawężać zestaw narzędzi.
Klucze dostawców akceptują zarówno `provider` (np. `google-antigravity`), jak i
`provider/model` (np. `openai/gpt-5.2`).

Przykład (zachowaj globalny profil programistyczny, ale minimalne narzędzia dla Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Przykład (lista dozwolonych specyficzna dla dostawcy/modelu dla niestabilnego endpointu):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Przykład (nadpisanie per-agent dla jednego dostawcy):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Grupy narzędzi (skróty)

Polityki narzędzi (globalne, per-agent, sandbox) obsługują wpisy `group:*`, które rozwijają się do wielu narzędzi.
Używaj ich w `tools.allow` / `tools.deny`.

Dostępne grupy:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: wszystkie wbudowane narzędzia OpenClaw (z wyłączeniem wtyczek dostawców)

Przykład (zezwól tylko na narzędzia plikowe + przeglądarkę):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Wtyczki + narzędzia

Wtyczki mogą rejestrować **dodatkowe narzędzia** (oraz polecenia CLI) poza zestawem rdzeniowym.
Zobacz [Plugins](/tools/plugin) dla instalacji i konfiguracji oraz [Skills](/tools/skills), aby dowiedzieć się,
jak wskazówki użycia narzędzi są wstrzykiwane do promptów. Niektóre wtyczki dostarczają własne skills
obok narzędzi (na przykład wtyczka połączeń głosowych).

Opcjonalne narzędzia wtyczek:

- [Lobster](/tools/lobster): typowany runtime przepływów pracy z wznawialnymi zatwierdzeniami (wymaga Lobster CLI na hoście gateway).
- [LLM Task](/tools/llm-task): krok LLM wyłącznie JSON dla ustrukturyzowanego wyjścia przepływu pracy (opcjonalna walidacja schematu).

## Inwentarz narzędzi

### `apply_patch`

Stosuj ustrukturyzowane łatki do jednego lub wielu plików. Używaj do edycji wielohunkowych.
Eksperymentalne: włącz przez `tools.exec.applyPatch.enabled` (tylko modele OpenAI).

### `exec`

Uruchamiaj polecenia powłoki w obszarze roboczym.

Podstawowe parametry:

- `command` (wymagane)
- `yieldMs` (automatyczne tło po przekroczeniu limitu czasu, domyślnie 10000)
- `background` (natychmiastowe uruchomienie w tle)
- `timeout` (sekundy; zabija proces po przekroczeniu, domyślnie 1800)
- `elevated` (bool; uruchom na hoście, jeśli tryb podwyższony jest włączony/dozwolony; zmienia zachowanie tylko gdy agent jest w sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/nazwa węzła dla `host=node`)
- Potrzebny prawdziwy TTY? Ustaw `pty: true`.

Uwagi:

- Zwraca `status: "running"` z `sessionId` po uruchomieniu w tle.
- Użyj `process`, aby odpytywać/logować/zapisywać/zabijać/czyścić sesje w tle.
- Jeśli `process` jest niedozwolone, `exec` działa synchronicznie i ignoruje `yieldMs`/`background`.
- `elevated` jest ograniczone przez `tools.elevated` oraz ewentualne nadpisanie `agents.list[].tools.elevated` (oba muszą zezwalać) i jest aliasem dla `host=gateway` + `security=full`.
- `elevated` zmienia zachowanie tylko gdy agent jest w sandbox (w przeciwnym razie brak efektu).
- `host=node` może wskazywać aplikację towarzyszącą na macOS lub bezgłowy host węzła (`openclaw node run`).
- Zatwierdzanie gateway/węzłów i listy dozwolonych: [Exec approvals](/tools/exec-approvals).

### `process`

Zarządzaj sesjami exec w tle.

Podstawowe akcje:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Uwagi:

- `poll` zwraca nowe wyjście i status zakończenia po ukończeniu.
- `log` obsługuje liniowe `offset`/`limit` (pomiń `offset`, aby pobrać ostatnie N linii).
- `process` jest zakresowane per-agent; sesje innych agentów nie są widoczne.

### `web_search`

Wyszukuj w sieci za pomocą Brave Search API.

Podstawowe parametry:

- `query` (wymagane)
- `count` (1–10; domyślnie z `tools.web.search.maxResults`)

Uwagi:

- Wymaga klucza Brave API (zalecane: `openclaw configure --section web` lub ustaw `BRAVE_API_KEY`).
- Włącz przez `tools.web.search.enabled`.
- Odpowiedzi są buforowane (domyślnie 15 min).
- Zobacz [Web tools](/tools/web) dla konfiguracji.

### `web_fetch`

Pobieraj i wyodrębniaj czytelną treść z URL (HTML → markdown/tekst).

Podstawowe parametry:

- `url` (wymagane)
- `extractMode` (`markdown` | `text`)
- `maxChars` (przycinanie długich stron)

Uwagi:

- Włącz przez `tools.web.fetch.enabled`.
- `maxChars` jest ograniczane przez `tools.web.fetch.maxCharsCap` (domyślnie 50000).
- Odpowiedzi są buforowane (domyślnie 15 min).
- Dla stron intensywnie wykorzystujących JS preferuj narzędzie przeglądarki.
- Zobacz [Web tools](/tools/web) dla konfiguracji.
- Zobacz [Firecrawl](/tools/firecrawl) dla opcjonalnego obejścia anty-botów.

### `browser`

Steruj dedykowaną przeglądarką zarządzaną przez OpenClaw.

Podstawowe akcje:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (zwraca blok obrazu + `MEDIA:<path>`)
- `act` (akcje UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Zarządzanie profilami:

- `profiles` — lista wszystkich profili przeglądarki ze statusem
- `create-profile` — utwórz nowy profil z automatycznie przydzielonym portem (lub `cdpUrl`)
- `delete-profile` — zatrzymaj przeglądarkę, usuń dane użytkownika, usuń z konfiguracji (tylko lokalnie)
- `reset-profile` — zabij osierocony proces na porcie profilu (tylko lokalnie)

Wspólne parametry:

- `profile` (opcjonalne; domyślnie `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcjonalne; wybiera konkretny id/nazwę węzła)
  Uwagi:
- Wymaga `browser.enabled=true` (domyślnie `true`; ustaw `false`, aby wyłączyć).
- Wszystkie akcje akceptują opcjonalny parametr `profile` dla obsługi wielu instancji.
- Gdy `profile` jest pominięte, używany jest `browser.defaultProfile` (domyślnie „chrome”).
- Nazwy profili: tylko małe litery alfanumeryczne + myślniki (maks. 64 znaki).
- Zakres portów: 18800–18899 (~maks. 100 profili).
- Profile zdalne są tylko do podłączania (bez start/stop/reset).
- Jeśli podłączony jest węzeł z obsługą przeglądarki, narzędzie może automatycznie do niego kierować (chyba że przypniesz `target`).
- `snapshot` domyślnie używa `ai` gdy zainstalowany jest Playwright; użyj `aria` dla drzewa dostępności.
- `snapshot` obsługuje także opcje migawki ról (`interactive`, `compact`, `depth`, `selector`), które zwracają odwołania takie jak `e12`.
- `act` wymaga `ref` z `snapshot` (numeryczne `12` z migawek AI lub `e12` z migawek ról); użyj `evaluate` dla rzadkich potrzeb selektora CSS.
- Domyślnie unikaj `act` → `wait`; używaj tylko w wyjątkowych przypadkach (brak wiarygodnego stanu UI do oczekiwania).
- `upload` może opcjonalnie przekazać `ref` do automatycznego kliknięcia po uzbrojeniu.
- `upload` obsługuje także `inputRef` (ref aria) lub `element` (selektor CSS), aby ustawić `<input type="file">` bezpośrednio.

### `canvas`

Steruj Canvas węzła (present, eval, snapshot, A2UI).

Podstawowe akcje:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (zwraca blok obrazu + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Uwagi:

- Pod spodem używa `node.invoke` Gateway.
- Jeśli nie podano `node`, narzędzie wybiera domyślny (pojedynczy podłączony węzeł lub lokalny węzeł mac).
- A2UI jest tylko v0.8 (brak `createSurface`); CLI odrzuca JSONL v0.9 z błędami linii.
- Szybki test: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Wykrywaj i adresuj sparowane węzły; wysyłaj powiadomienia; przechwytuj kamerę/ekran.

Podstawowe akcje:

- `status`, `describe`
- `pending`, `approve`, `reject` (parowanie)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Uwagi:

- Polecenia kamery/ekranu wymagają, aby aplikacja węzła była na pierwszym planie.
- Obrazy zwracają bloki obrazu + `MEDIA:<path>`.
- Wideo zwraca `FILE:<path>` (mp4).
- Lokalizacja zwraca ładunek JSON (lat/lon/dokładność/znacznik czasu).
- Parametry `run`: tablica argv `command`; opcjonalne `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Przykład (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analizuj obraz za pomocą skonfigurowanego modelu obrazu.

Podstawowe parametry:

- `image` (wymagana ścieżka lub URL)
- `prompt` (opcjonalne; domyślnie „Describe the image.”)
- `model` (opcjonalne nadpisanie)
- `maxBytesMb` (opcjonalny limit rozmiaru)

Uwagi:

- Dostępne tylko gdy skonfigurowano `agents.defaults.imageModel` (główny lub zapasowe), albo gdy można wnioskować implicytny model obrazu z domyślnego modelu + skonfigurowanego uwierzytelniania (parowanie best-effort).
- Używa bezpośrednio modelu obrazu (niezależnie od głównego modelu czatu).

### `message`

Wysyłaj wiadomości i akcje kanałów w Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Podstawowe akcje:

- `send` (tekst + opcjonalne media; MS Teams obsługuje też `card` dla Adaptive Cards)
- `poll` (ankiety WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Uwagi:

- `send` kieruje WhatsApp przez Gateway; pozostałe kanały idą bezpośrednio.
- `poll` używa Gateway dla WhatsApp i MS Teams; ankiety Discord idą bezpośrednio.
- Gdy wywołanie narzędzia wiadomości jest powiązane z aktywną sesją czatu, wysyłki są ograniczone do celu tej sesji, aby uniknąć wycieków między kontekstami.

### `cron`

Zarządzaj zadaniami cron i wybudzeniami Gateway.

Podstawowe akcje:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (kolejkuj zdarzenie systemowe + opcjonalny natychmiastowy heartbeat)

Uwagi:

- `add` oczekuje pełnego obiektu zadania cron (ten sam schemat co RPC `cron.add`).
- `update` używa `{ jobId, patch }` (`id` akceptowane dla kompatybilności).

### `gateway`

Restartuj lub stosuj aktualizacje do działającego procesu Gateway (in-place).

Podstawowe akcje:

- `restart` (autoryzuje + wysyła `SIGUSR1` do restartu w procesie; `openclaw gateway` restart in-place)
- `config.get` / `config.schema`
- `config.apply` (waliduj + zapisz konfigurację + restart + wybudź)
- `config.patch` (scal częściową aktualizację + restart + wybudź)
- `update.run` (uruchom aktualizację + restart + wybudź)

Uwagi:

- Użyj `delayMs` (domyślnie 2000), aby nie przerywać odpowiedzi w toku.
- `restart` jest domyślnie wyłączone; włącz przez `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Wyświetl listę sesji, przejrzyj historię transkryptów lub wyślij do innej sesji.

Podstawowe parametry:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = brak)
- `sessions_history`: `sessionKey` (lub `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (lub `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (domyślnie bieżąca; akceptuje `sessionId`), `model?` (`default` czyści nadpisanie)

Uwagi:

- `main` jest kanonicznym kluczem czatu bezpośredniego; globalne/nieznane są ukryte.
- `messageLimit > 0` pobiera ostatnie N wiadomości na sesję (wiadomości narzędzi są filtrowane).
- `sessions_send` czeka na ostateczne zakończenie, gdy `timeoutSeconds > 0`.
- Dostarczenie/ogłoszenie następuje po zakończeniu i jest best-effort; `status: "ok"` potwierdza zakończenie uruchomienia agenta, a nie dostarczenie ogłoszenia.
- `sessions_spawn` uruchamia pod-agenta i publikuje odpowiedź-ogłoszenie z powrotem do czatu żądającego.
- `sessions_spawn` jest nieblokujące i natychmiast zwraca `status: "accepted"`.
- `sessions_send` uruchamia ping‑pong odpowiedzi (odpowiedz `REPLY_SKIP`, aby zatrzymać; maks. tury przez `session.agentToAgent.maxPingPongTurns`, 0–5).
- Po ping‑pongu agent docelowy wykonuje **krok ogłoszenia**; odpowiedz `ANNOUNCE_SKIP`, aby stłumić ogłoszenie.

### `agents_list`

Wyświetl listę identyfikatorów agentów, które bieżąca sesja może wskazać za pomocą `sessions_spawn`.

Uwagi:

- Wynik jest ograniczony do list dozwolonych per-agent (`agents.list[].subagents.allowAgents`).
- Gdy skonfigurowano `["*"]`, narzędzie uwzględnia wszystkich skonfigurowanych agentów i oznacza `allowAny: true`.

## Parametry (wspólne)

Narzędzia oparte o Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (domyślnie `ws://127.0.0.1:18789`)
- `gatewayToken` (jeśli uwierzytelnianie włączone)
- `timeoutMs`

Uwaga: gdy ustawiono `gatewayUrl`, dołącz `gatewayToken` jawnie. Narzędzia nie dziedziczą konfiguracji
ani poświadczeń środowiskowych dla nadpisań, a brak jawnych poświadczeń jest błędem.

Narzędzie przeglądarki:

- `profile` (opcjonalne; domyślnie `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcjonalne; przypnij konkretny id/nazwę węzła)

## Zalecane przepływy agenta

Automatyzacja przeglądarki:

1. `browser` → `status` / `start`
2. `snapshot` (ai lub aria)
3. `act` (click/type/press)
4. `screenshot`, jeśli potrzebujesz potwierdzenia wizualnego

Renderowanie canvas:

1. `canvas` → `present`
2. `a2ui_push` (opcjonalne)
3. `snapshot`

Targetowanie węzłów:

1. `nodes` → `status`
2. `describe` na wybranym węźle
3. `notify` / `run` / `camera_snap` / `screen_record`

## Bezpieczeństwo

- Unikaj bezpośredniego `system.run`; używaj `nodes` → `run` tylko za wyraźną zgodą użytkownika.
- Szanuj zgodę użytkownika na przechwytywanie kamery/ekranu.
- Użyj `status/describe`, aby upewnić się co do uprawnień przed wywołaniem poleceń multimediów.

## Jak narzędzia są prezentowane agentowi

Narzędzia są udostępniane w dwóch równoległych kanałach:

1. **Tekst promptu systemowego**: lista czytelna dla człowieka + wskazówki.
2. **Schemat narzędzi**: ustrukturyzowane definicje funkcji wysyłane do API modelu.

Oznacza to, że agent widzi zarówno „jakie narzędzia istnieją”, jak i „jak je wywoływać”. Jeśli narzędzie nie pojawia się w promptcie systemowym ani w schemacie, model nie może go wywołać.
