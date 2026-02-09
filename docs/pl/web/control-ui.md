---
summary: "Przeglądarkowy interfejs sterowania dla Gateway (czat, węzły, konfiguracja)"
read_when:
  - Chcesz obsługiwać Gateway z poziomu przeglądarki
  - Chcesz mieć dostęp do Tailnet bez tuneli SSH
title: "Control UI"
---

# Control UI (przeglądarka)

Control UI to niewielka aplikacja jednostronicowa **Vite + Lit**, serwowana przez Gateway:

- domyślnie: `http://<host>:18789/`
- opcjonalny prefiks: ustaw `gateway.controlUi.basePath` (np. `/openclaw`)

Łączy się **bezpośrednio z WebSocket Gateway** na tym samym porcie.

## Szybkie otwarcie (lokalnie)

Jeśli Gateway działa na tym samym komputerze, otwórz:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (lub [http://localhost:18789/](http://localhost:18789/))

Jeśli strona się nie wczyta, najpierw uruchom Gateway: `openclaw gateway`.

Uwierzytelnianie jest dostarczane podczas handshake WebSocket poprzez:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Panel ustawień pulpitu pozwala zapisać token; hasła nie są utrwalane.
  Kreator wdrożenia domyślnie generuje token gateway, więc wklej go tutaj przy pierwszym połączeniu.

## Parowanie urządzenia (pierwsze połączenie)

Gdy łączysz się z Control UI z nowej przeglądarki lub urządzenia, Gateway
wymaga **jednorazowego zatwierdzenia parowania** — nawet jeśli jesteś w tym samym Tailnet
z `gateway.auth.allowTailscale: true`. To środek bezpieczeństwa zapobiegający
nieautoryzowanemu dostępowi.

**Co zobaczysz:** „disconnected (1008): pairing required”

**Aby zatwierdzić urządzenie:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Po zatwierdzeniu urządzenie jest zapamiętane i nie będzie wymagało ponownej akceptacji,
chyba że cof­niesz ją za pomocą `openclaw devices revoke --device <id> --role <role>`. Zobacz
[Devices CLI](/cli/devices) w kontekście rotacji tokenów i cofania uprawnień.

**Uwagi:**

- Połączenia lokalne (`127.0.0.1`) są zatwierdzane automatycznie.
- Połączenia zdalne (LAN, Tailnet itd.) wymagają jawnego zatwierdzenia.
- Każdy profil przeglądarki generuje unikalny identyfikator urządzenia, więc zmiana przeglądarki lub
  wyczyszczenie danych przeglądarki będzie wymagać ponownego parowania.

## Co potrafi (na dziś)

- Czat z modelem przez Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Strumieniowanie wywołań narzędzi + karty wyników narzędzi na żywo w czacie (zdarzenia agenta)
- Kanały: status WhatsApp/Telegram/Discord/Slack + kanały wtyczek (Mattermost itd.) + logowanie QR + konfiguracja per kanał (`channels.status`, `web.login.*`, `config.patch`)
- Instancje: lista obecności + odświeżanie (`system-presence`)
- Sesje: lista + nadpisania „thinking/verbose” per sesja (`sessions.list`, `sessions.patch`)
- Zadania cron: lista/dodawanie/uruchamianie/włączanie/wyłączanie + historia uruchomień (`cron.*`)
- Skills: status, włączanie/wyłączanie, instalacja, aktualizacje kluczy API (`skills.*`)
- Węzły: lista + możliwości (`node.list`)
- Zatwierdzanie exec: edycja list dozwolonych gateway lub węzła + polityka zapytań dla `exec host=gateway/node` (`exec.approvals.*`)
- Konfiguracja: podgląd/edycja `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Konfiguracja: zastosowanie + restart z walidacją (`config.apply`) oraz wybudzenie ostatniej aktywnej sesji
- Zapisy konfiguracji obejmują ochronę base-hash, aby zapobiec nadpisaniu równoległych edycji
- Schemat konfiguracji + renderowanie formularzy (`config.schema`, w tym schematy wtyczek i kanałów); edytor Raw JSON pozostaje dostępny
- Debug: migawki status/zdrowie/modele + dziennik zdarzeń + ręczne wywołania RPC (`status`, `health`, `models.list`)
- Logi: podgląd na żywo plików logów gateway z filtrowaniem/eksportem (`logs.tail`)
- Aktualizacja: uruchomienie aktualizacji pakietów/git + restart (`update.run`) z raportem restartu

Uwagi do panelu zadań cron:

- Dla zadań izolowanych dostarczenie domyślnie ogłasza podsumowanie. Możesz przełączyć na brak, jeśli chcesz uruchomienia wyłącznie wewnętrzne.
- Pola kanał/cel pojawiają się, gdy wybrano ogłaszanie.

## Zachowanie czatu

- `chat.send` jest **nieblokujące**: natychmiast potwierdza `{ runId, status: "started" }`, a odpowiedź strumieniuje się przez zdarzenia `chat`.
- Ponowne wysłanie z tym samym `idempotencyKey` zwraca `{ status: "in_flight" }` w trakcie działania oraz `{ status: "ok" }` po zakończeniu.
- `chat.inject` dołącza notatkę asystenta do transkryptu sesji i rozgłasza zdarzenie `chat` wyłącznie do aktualizacji UI (bez uruchamiania agenta, bez dostarczania do kanałów).
- Zatrzymanie:
  - Kliknij **Stop** (wywołuje `chat.abort`)
  - Wpisz `/stop` (lub `stop|esc|abort|wait|exit|interrupt`), aby przerwać poza pasmem
  - `chat.abort` obsługuje `{ sessionKey }` (bez `runId`), aby przerwać wszystkie aktywne uruchomienia dla tej sesji

## Dostęp przez Tailnet (zalecane)

### Zintegrowane Tailscale Serve (preferowane)

Zachowaj Gateway na loopback i pozwól, aby Tailscale Serve pośredniczył z HTTPS:

```bash
openclaw gateway --tailscale serve
```

Otwórz:

- `https://<magicdns>/` (lub skonfigurowany `gateway.controlUi.basePath`)

Domyślnie żądania Serve mogą uwierzytelniać się przez nagłówki tożsamości Tailscale
(`tailscale-user-login`), gdy `gateway.auth.allowTailscale` ma wartość `true`. OpenClaw
weryfikuje tożsamość, rozwiązując adres `x-forwarded-for` za pomocą
`tailscale whois` i dopasowując go do nagłówka, oraz akceptuje je wyłącznie wtedy, gdy
żądanie trafia na loopback z nagłówkami `x-forwarded-*` Tailscale. Ustaw
`gateway.auth.allowTailscale: false` (lub wymuś `gateway.auth.mode: "password"`),
jeśli chcesz wymagać tokenu/hasła nawet dla ruchu Serve.

### Dowiązanie do tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Następnie otwórz:

- `http://<tailscale-ip>:18789/` (lub skonfigurowany `gateway.controlUi.basePath`)

Wklej token w ustawieniach UI (wysyłany jako `connect.params.auth.token`).

## Niezabezpieczony HTTP

Jeśli otworzysz pulpit przez zwykły HTTP (`http://<lan-ip>` lub `http://<tailscale-ip>`),
przeglądarka działa w **kontekście niezabezpieczonym** i blokuje WebCrypto. Domyślnie
OpenClaw **blokuje** połączenia Control UI bez tożsamości urządzenia.

**Zalecane rozwiązanie:** użyj HTTPS (Tailscale Serve) lub otwórz UI lokalnie:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (na hoście gateway)

**Przykład obniżenia zabezpieczeń (tylko token przez HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

To wyłącza tożsamość urządzenia i parowanie dla Control UI (nawet przy HTTPS). Używaj
tylko, jeśli ufasz sieci.

Zobacz [Tailscale](/gateway/tailscale) — wskazówki dotyczące konfiguracji HTTPS.

## Budowanie UI

Gateway serwuje pliki statyczne z `dist/control-ui`. Zbuduj je poleceniem:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Opcjonalna absolutna baza (gdy chcesz stałe adresy zasobów):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Do lokalnego rozwoju (oddzielny serwer deweloperski):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Następnie wskaż UI adres WS Gateway (np. `ws://127.0.0.1:18789`).

## Debugowanie/testy: serwer dev + zdalny Gateway

Control UI to pliki statyczne; cel WebSocket jest konfigurowalny i może różnić się
od pochodzenia HTTP. To przydatne, gdy chcesz mieć serwer Vite lokalnie,
a Gateway działa gdzie indziej.

1. Uruchom serwer dev UI: `pnpm ui:dev`
2. Otwórz adres URL w rodzaju:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Opcjonalne jednorazowe uwierzytelnienie (jeśli potrzebne):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Uwagi:

- `gatewayUrl` jest zapisywany w localStorage po załadowaniu i usuwany z URL.
- `token` jest zapisywany w localStorage; `password` jest przechowywany wyłącznie w pamięci.
- Gdy ustawione jest `gatewayUrl`, UI nie korzysta z konfiguracji ani poświadczeń środowiskowych.
  Dostarcz `token` (lub `password`) jawnie. Brak jawnych poświadczeń jest błędem.
- Użyj `wss://`, gdy Gateway jest za TLS (Tailscale Serve, proxy HTTPS itd.).
- `gatewayUrl` jest akceptowane tylko w oknie najwyższego poziomu (nie osadzonym), aby zapobiec clickjackingowi.
- Dla konfiguracji deweloperskich między różnymi originami (np. `pnpm ui:dev` do zdalnego Gateway), dodaj origin UI do `gateway.controlUi.allowedOrigins`.

Przykład:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Szczegóły konfiguracji dostępu zdalnego: [Remote access](/gateway/remote).
