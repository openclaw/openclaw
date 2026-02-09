---
summary: "„Zintegrowana usługa sterowania przeglądarką + polecenia akcji”"
read_when:
  - Dodawanie automatyzacji przeglądarki sterowanej przez agenta
  - Diagnozowanie, dlaczego OpenClaw ingeruje w Twoją własną przeglądarkę Chrome
  - Implementacja ustawień przeglądarki i cyklu życia w aplikacji na macOS
title: "„Przeglądarka (zarządzana przez OpenClaw)”"
---

# Przeglądarka (zarządzana przez openclaw)

OpenClaw może uruchamiać **dedykowany profil Chrome/Brave/Edge/Chromium**, którym steruje agent.
Jest on odizolowany od Twojej osobistej przeglądarki i zarządzany przez niewielką lokalną
usługę sterującą wewnątrz Gateway (wyłącznie local loopback).

Widok dla początkujących:

- Traktuj to jako **oddzielną przeglądarkę tylko dla agenta**.
- Profil `openclaw` **nie** dotyka Twojego osobistego profilu przeglądarki.
- Agent może **otwierać karty, czytać strony, klikać i pisać** w bezpiecznym obszarze.
- Domyślny profil `chrome` używa **systemowej domyślnej przeglądarki Chromium** przez
  przekaźnik rozszerzenia; przełącz na `openclaw`, aby użyć izolowanej, zarządzanej przeglądarki.

## Co otrzymujesz

- Oddzielny profil przeglądarki o nazwie **openclaw** (domyślnie z pomarańczowym akcentem).
- Deterministyczne sterowanie kartami (lista/otwórz/aktywuj/zamknij).
- Akcje agenta (kliknięcie/pisanie/przeciąganie/zaznaczanie), migawki, zrzuty ekranu, pliki PDF.
- Opcjonalna obsługa wielu profili (`openclaw`, `work`, `remote`, ...).

Ta przeglądarka **nie** jest Twoją codzienną przeglądarką. To bezpieczna, izolowana powierzchnia
do automatyzacji i weryfikacji przez agenta.

## Szybki start

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

Jeśli pojawi się komunikat „Browser disabled”, włącz ją w konfiguracji (patrz niżej) i zrestartuj
Gateway.

## Profile: `openclaw` vs `chrome`

- `openclaw`: zarządzana, izolowana przeglądarka (bez wymaganego rozszerzenia).
- `chrome`: przekaźnik rozszerzenia do Twojej **systemowej przeglądarki**
  (wymaga podpięcia rozszerzenia OpenClaw do karty).

Ustaw `browser.defaultProfile: "openclaw"`, jeśli chcesz, aby tryb zarządzany był domyślny.

## Konfiguracja

Ustawienia przeglądarki znajdują się w `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    remoteCdpTimeoutMs: 1500, // remote CDP HTTP timeout (ms)
    remoteCdpHandshakeTimeoutMs: 3000, // remote CDP WebSocket handshake timeout (ms)
    defaultProfile: "chrome",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
  },
}
```

Uwagi:

- Usługa sterowania przeglądarką wiąże się z local loopback na porcie wyprowadzonym z `gateway.port`
  (domyślnie: `18791`, czyli gateway + 2). Przekaźnik używa kolejnego portu (`18792`).
- Jeśli nadpiszesz port Gateway (`gateway.port` lub `OPENCLAW_GATEWAY_PORT`),
  pochodne porty przeglądarki przesuwają się, aby pozostać w tej samej „rodzinie”.
- `cdpUrl` domyślnie przyjmuje port przekaźnika, gdy jest nieustawione.
- `remoteCdpTimeoutMs` dotyczy zdalnych sprawdzeń dostępności CDP (non-loopback).
- `remoteCdpHandshakeTimeoutMs` dotyczy zdalnych sprawdzeń dostępności WebSocket CDP.
- `attachOnly: true` oznacza „nigdy nie uruchamiaj lokalnej przeglądarki; tylko dołącz, jeśli już działa”.
- `color` + per-profilowe `color` barwią interfejs przeglądarki, aby było widać, który profil jest aktywny.
- Domyślny profil to `chrome` (przekaźnik rozszerzenia). Użyj `defaultProfile: "openclaw"` dla przeglądarki zarządzanej.
- Kolejność auto-wykrywania: systemowa domyślna przeglądarka, jeśli oparta na Chromium; w przeciwnym razie Chrome → Brave → Edge → Chromium → Chrome Canary.
- Lokalne profile `openclaw` automatycznie przypisują `cdpPort`/`cdpUrl` — ustawiaj je tylko dla zdalnego CDP.

## Użyj Brave (lub innej przeglądarki opartej na Chromium)

Jeśli **systemowa domyślna** przeglądarka jest oparta na Chromium (Chrome/Brave/Edge itp.),
OpenClaw użyje jej automatycznie. Ustaw `browser.executablePath`, aby nadpisać
auto-wykrywanie:

Przykład CLI:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
```

```json5
// macOS
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  }
}

// Windows
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  }
}

// Linux
{
  browser: {
    executablePath: "/usr/bin/brave-browser"
  }
}
```

## Sterowanie lokalne vs zdalne

- **Sterowanie lokalne (domyślne):** Gateway uruchamia usługę sterowania na loopback i może uruchomić lokalną przeglądarkę.
- **Sterowanie zdalne (host węzła):** uruchom host węzła na maszynie z przeglądarką; Gateway pośredniczy w akcjach przeglądarki.
- **Zdalne CDP:** ustaw `browser.profiles.<name>.cdpUrl` (lub `browser.cdpUrl`), aby
  dołączyć do zdalnej przeglądarki opartej na Chromium. W tym przypadku OpenClaw nie uruchomi lokalnej przeglądarki.

Adresy URL zdalnego CDP mogą zawierać uwierzytelnianie:

- Tokeny w zapytaniu (np. `https://provider.example?token=<token>`)
- Uwierzytelnianie HTTP Basic (np. `https://user:pass@provider.example`)

OpenClaw zachowuje uwierzytelnianie podczas wywołań endpointów `/json/*` oraz przy łączeniu
z WebSocket CDP. Zamiast zapisywać tokeny w plikach konfiguracyjnych, preferuj
zmienne środowiskowe lub menedżery sekretów.

## Proxy przeglądarki węzła (domyślnie zero-config)

Jeśli uruchomisz **host węzła** na maszynie z przeglądarką, OpenClaw może
automatycznie kierować wywołania narzędzi przeglądarki do tego węzła bez dodatkowej konfiguracji.
Jest to domyślna ścieżka dla zdalnych gatewayów.

Uwagi:

- Host węzła wystawia swoją lokalną usługę sterowania przeglądarką przez **polecenie proxy**.
- Profile pochodzą z własnej konfiguracji `browser.profiles` węzła (takiej samej jak lokalnie).
- Wyłącz, jeśli tego nie chcesz:
  - Na węźle: `nodeHost.browserProxy.enabled=false`
  - Na gatewayu: `gateway.nodes.browser.mode="off"`

## Browserless (hostowane zdalne CDP)

[Browserless](https://browserless.io) to hostowana usługa Chromium udostępniająca
endpointy CDP przez HTTPS. Możesz wskazać profil przeglądarki OpenClaw na
endpoint regionu Browserless i uwierzytelnić się kluczem API.

Przykład:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "browserless",
    remoteCdpTimeoutMs: 2000,
    remoteCdpHandshakeTimeoutMs: 4000,
    profiles: {
      browserless: {
        cdpUrl: "https://production-sfo.browserless.io?token=<BROWSERLESS_API_KEY>",
        color: "#00AA00",
      },
    },
  },
}
```

Uwagi:

- Zastąp `<BROWSERLESS_API_KEY>` swoim prawdziwym tokenem Browserless.
- Wybierz endpoint regionu odpowiadający Twojemu kontu Browserless (patrz ich dokumentacja).

## Bezpieczeństwo

Kluczowe idee:

- Sterowanie przeglądarką jest wyłącznie przez loopback; dostęp przechodzi przez uwierzytelnianie Gateway lub parowanie węzła.
- Utrzymuj Gateway i wszelkie hosty węzłów w prywatnej sieci (Tailscale); unikaj publicznej ekspozycji.
- Traktuj adresy URL/tokeny zdalnego CDP jako sekrety; preferuj zmienne środowiskowe lub menedżer sekretów.

Wskazówki dla zdalnego CDP:

- Preferuj endpointy HTTPS i krótkotrwałe tokeny, gdy to możliwe.
- Unikaj osadzania długowiecznych tokenów bezpośrednio w plikach konfiguracyjnych.

## Profile (wiele przeglądarek)

OpenClaw obsługuje wiele nazwanych profili (konfiguracje routingu). Profile mogą być:

- **openclaw-managed**: dedykowana instancja przeglądarki opartej na Chromium z własnym katalogiem danych użytkownika i portem CDP
- **remote**: jawny adres URL CDP (przeglądarka oparta na Chromium działająca gdzie indziej)
- **extension relay**: istniejące karty Chrome przez lokalny przekaźnik + rozszerzenie Chrome

Domyślne:

- Profil `openclaw` jest automatycznie tworzony, jeśli go brakuje.
- Profil `chrome` jest wbudowany dla przekaźnika rozszerzenia Chrome (domyślnie wskazuje na `http://127.0.0.1:18792`).
- Lokalne porty CDP są przydzielane domyślnie z zakresu **18800–18899**.
- Usunięcie profilu przenosi jego lokalny katalog danych do Kosza.

Wszystkie endpointy sterowania akceptują `?profile=<name>`; CLI używa `--browser-profile`.

## Przekaźnik rozszerzenia Chrome (użyj istniejącego Chrome)

OpenClaw może również sterować **Twoimi istniejącymi kartami Chrome** (bez oddzielnej instancji „openclaw”)
przez lokalny przekaźnik CDP + rozszerzenie Chrome.

Pełny przewodnik: [Rozszerzenie Chrome](/tools/chrome-extension)

Przebieg:

- Gateway działa lokalnie (ta sama maszyna) lub host węzła działa na maszynie z przeglądarką.
- Lokalny **serwer przekaźnika** nasłuchuje na loopback `cdpUrl` (domyślnie: `http://127.0.0.1:18792`).
- Klikasz ikonę rozszerzenia **OpenClaw Browser Relay** na karcie, aby dołączyć (nie dołącza się automatycznie).
- Agent steruje tą kartą przez standardowe narzędzie `browser`, wybierając właściwy profil.

Jeśli Gateway działa gdzie indziej, uruchom host węzła na maszynie z przeglądarką, aby Gateway mógł pośredniczyć w akcjach przeglądarki.

### Sesje sandboxed

Jeśli sesja agenta jest sandboxed, narzędzie `browser` może domyślnie używać `target="sandbox"` (przeglądarka sandbox).
Przejęcie przekaźnika rozszerzenia Chrome wymaga kontroli przeglądarki hosta, więc:

- uruchom sesję poza sandboxem, albo
- ustaw `agents.defaults.sandbox.browser.allowHostControl: true` i użyj `target="host"` podczas wywoływania narzędzia.

### Konfiguracja

1. Załaduj rozszerzenie (dev/unpacked):

```bash
openclaw browser extension install
```

- Chrome → `chrome://extensions` → włącz „Developer mode”
- „Load unpacked” → wybierz katalog wydrukowany przez `openclaw browser extension path`
- Przypnij rozszerzenie, a następnie kliknij je na karcie, którą chcesz kontrolować (znacznik pokazuje `ON`).

2. Użycie:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Narzędzie agenta: `browser` z `profile="chrome"`

Opcjonalnie: jeśli chcesz inną nazwę lub port przekaźnika, utwórz własny profil:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

Uwagi:

- Ten tryb opiera się na Playwright-on-CDP dla większości operacji (zrzuty ekranu/migawki/akcje).
- Odłączanie następuje po ponownym kliknięciu ikony rozszerzenia.

## Gwarancje izolacji

- **Dedykowany katalog danych użytkownika**: nigdy nie dotyka Twojego osobistego profilu przeglądarki.
- **Dedykowane porty**: unika `9222`, aby zapobiec kolizjom z przepływami developerskimi.
- **Deterministyczne sterowanie kartami**: celuj w karty przez `targetId`, a nie „ostatnią kartę”.

## Wybór przeglądarki

Przy uruchamianiu lokalnym OpenClaw wybiera pierwszą dostępną:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

Możesz to nadpisać przez `browser.executablePath`.

Platformy:

- macOS: sprawdza `/Applications` i `~/Applications`.
- Linux: szuka `google-chrome`, `brave`, `microsoft-edge`, `chromium` itd.
- Windows: sprawdza typowe lokalizacje instalacji.

## API sterowania (opcjonalne)

Wyłącznie dla lokalnych integracji Gateway udostępnia niewielkie HTTP API na loopback:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Karty: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Migawka/zrzut ekranu: `GET /snapshot`, `POST /screenshot`
- Akcje: `POST /navigate`, `POST /act`
- Hooki: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Pobieranie: `POST /download`, `POST /wait/download`
- Debugowanie: `GET /console`, `POST /pdf`
- Debugowanie: `GET /errors`, `GET /requests`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Sieć: `POST /response/body`
- Stan: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- Stan: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Ustawienia: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

Wszystkie endpointy akceptują `?profile=<name>`.

### Wymaganie Playwright

Niektóre funkcje (nawigacja/akcje/migawki AI/migawki ról, zrzuty elementów, PDF)
wymagają Playwright. Jeśli Playwright nie jest zainstalowany, te endpointy zwracają
czytelny błąd 501. Migawki ARIA i podstawowe zrzuty ekranu nadal działają dla przeglądarki zarządzanej openclaw.
Dla sterownika przekaźnika rozszerzenia Chrome migawki ARIA i zrzuty ekranu również wymagają Playwright.

Jeśli zobaczysz `Playwright is not available in this gateway build`, zainstaluj pełny
pakiet Playwright (nie `playwright-core`) i zrestartuj gateway albo przeinstaluj
OpenClaw z obsługą przeglądarki.

#### Instalacja Playwright w Dockerze

Jeśli Gateway działa w Dockerze, unikaj `npx playwright` (konflikty nadpisywania npm).
Użyj dołączonego CLI:

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Aby zachować pobrania przeglądarki, ustaw `PLAYWRIGHT_BROWSERS_PATH` (na przykład
`/home/node/.cache/ms-playwright`) i upewnij się, że `/home/node` jest utrwalone przez
`OPENCLAW_HOME_VOLUME` lub bind mount. Zobacz [Docker](/install/docker).

## Jak to działa (wewnętrznie)

Przepływ wysokiego poziomu:

- Niewielki **serwer sterujący** przyjmuje żądania HTTP.
- Łączy się z przeglądarkami opartymi na Chromium (Chrome/Brave/Edge/Chromium) przez **CDP**.
- Do zaawansowanych akcji (kliknięcie/pisanie/migawka/PDF) używa **Playwright** nad CDP.
- Gdy Playwright jest niedostępny, dostępne są tylko operacje niezależne od Playwright.

Ten projekt zapewnia agentowi stabilny, deterministyczny interfejs, jednocześnie
umożliwiając wymianę lokalnych/zdalnych przeglądarek i profili.

## Szybkie odwołanie do CLI

Wszystkie polecenia akceptują `--browser-profile <name>` do wskazania konkretnego profilu.
Wszystkie polecenia akceptują także `--json` dla wyjścia czytelnego maszynowo (stabilne payloady).

Podstawa:

- `openclaw browser status`
- `openclaw browser start`
- `openclaw browser stop`
- `openclaw browser tabs`
- `openclaw browser tab`
- `openclaw browser tab new`
- `openclaw browser tab select 2`
- `openclaw browser tab close 2`
- `openclaw browser open https://example.com`
- `openclaw browser focus abcd1234`
- `openclaw browser close abcd1234`

Inspekcja:

- `openclaw browser screenshot`
- `openclaw browser screenshot --full-page`
- `openclaw browser screenshot --ref 12`
- `openclaw browser screenshot --ref e12`
- `openclaw browser snapshot`
- `openclaw browser snapshot --format aria --limit 200`
- `openclaw browser snapshot --interactive --compact --depth 6`
- `openclaw browser snapshot --efficient`
- `openclaw browser snapshot --labels`
- `openclaw browser snapshot --selector "#main" --interactive`
- `openclaw browser snapshot --frame "iframe#main" --interactive`
- `openclaw browser console --level error`
- `openclaw browser errors --clear`
- `openclaw browser requests --filter api --clear`
- `openclaw browser pdf`
- `openclaw browser responsebody "**/api" --max-chars 5000`

Akcje:

- `openclaw browser navigate https://example.com`
- `openclaw browser resize 1280 720`
- `openclaw browser click 12 --double`
- `openclaw browser click e12 --double`
- `openclaw browser type 23 "hello" --submit`
- `openclaw browser press Enter`
- `openclaw browser hover 44`
- `openclaw browser scrollintoview e12`
- `openclaw browser drag 10 11`
- `openclaw browser select 9 OptionA OptionB`
- `openclaw browser download e12 /tmp/report.pdf`
- `openclaw browser waitfordownload /tmp/report.pdf`
- `openclaw browser upload /tmp/file.pdf`
- `openclaw browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `openclaw browser dialog --accept`
- `openclaw browser wait --text "Done"`
- `openclaw browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"`
- `openclaw browser evaluate --fn '(el) => el.textContent' --ref 7`
- `openclaw browser highlight e12`
- `openclaw browser trace start`
- `openclaw browser trace stop`

Stan:

- `openclaw browser cookies`
- `openclaw browser cookies set session abc123 --url "https://example.com"`
- `openclaw browser cookies clear`
- `openclaw browser storage local get`
- `openclaw browser storage local set theme dark`
- `openclaw browser storage session clear`
- `openclaw browser set offline on`
- `openclaw browser set headers --json '{"X-Debug":"1"}'`
- `openclaw browser set credentials user pass`
- `openclaw browser set credentials --clear`
- `openclaw browser set geo 37.7749 -122.4194 --origin "https://example.com"`
- `openclaw browser set geo --clear`
- `openclaw browser set media dark`
- `openclaw browser set timezone America/New_York`
- `openclaw browser set locale en-US`
- `openclaw browser set device "iPhone 14"`

Uwagi:

- `upload` i `dialog` to wywołania **uzbrajające**; uruchom je przed kliknięciem/naciśnięciem,
  które wyzwala selektor/okno dialogowe.
- `upload` może także ustawiać pola plików bezpośrednio przez `--input-ref` lub `--element`.
- `snapshot`:
  - `--format ai` (domyślne, gdy Playwright jest zainstalowany): zwraca migawkę AI z numerycznymi referencjami (`aria-ref="<n>"`).
  - `--format aria`: zwraca drzewo dostępności (bez referencji; tylko do inspekcji).
  - `--efficient` (lub `--mode efficient`): kompaktowy preset migawki ról (interaktywny + kompaktowy + głębokość + niższe maxChars).
  - Domyślna konfiguracja (tylko narzędzie/CLI): ustaw `browser.snapshotDefaults.mode: "efficient"`, aby używać wydajnych migawek, gdy wywołujący nie poda trybu (zobacz [Konfiguracja Gateway](/gateway/configuration#browser-openclaw-managed-browser)).
  - Opcje migawki ról (`--interactive`, `--compact`, `--depth`, `--selector`) wymuszają migawkę opartą na rolach z referencjami jak `ref=e12`.
  - `--frame "<iframe selector>"` ogranicza migawki ról do iframe (w parze z referencjami ról jak `e12`).
  - `--interactive` generuje płaską, łatwą do wyboru listę elementów interaktywnych (najlepsze do sterowania akcjami).
  - `--labels` dodaje zrzut ekranu tylko obszaru widoku z nałożonymi etykietami referencji (drukuje `MEDIA:<path>`).
- `click`/`type`/itd. wymagają `ref` z `snapshot` (numerycznego `12` lub referencji roli `e12`).
  Selektory CSS są celowo nieobsługiwane dla akcji.

## Zrzuty stanu i referencje

OpenClaw obsługuje dwa style „migawek”:

- **Migawka AI (numeryczne referencje)**: `openclaw browser snapshot` (domyślna; `--format ai`)
  - Wyjście: tekstowa migawka zawierająca numeryczne referencje.
  - Akcje: `openclaw browser click 12`, `openclaw browser type 23 "hello"`.
  - Wewnętrznie referencja jest rozwiązywana przez `aria-ref` Playwright.

- **Migawka ról (referencje ról jak `e12`)**: `openclaw browser snapshot --interactive` (lub `--compact`, `--depth`, `--selector`, `--frame`)
  - Wyjście: lista/drzewo oparte na rolach z `[ref=e12]` (i opcjonalnie `[nth=1]`).
  - Akcje: `openclaw browser click e12`, `openclaw browser highlight e12`.
  - Wewnętrznie referencja jest rozwiązywana przez `getByRole(...)` (plus `nth()` dla duplikatów).
  - Dodaj `--labels`, aby dołączyć zrzut obszaru widoku z nałożonymi etykietami `e12`.

Ref zachowanie:

- Referencje **nie są stabilne między nawigacjami**; jeśli coś się nie powiedzie, ponownie uruchom `snapshot` i użyj świeżej referencji.
- Jeśli migawka ról została wykonana z `--frame`, referencje ról są ograniczone do tego iframe do następnej migawki ról.

## Wzmocnienia oczekiwania

Możesz czekać na więcej niż tylko czas/tekst:

- Oczekiwanie na URL (obsługa globów przez Playwright):
  - `openclaw browser wait --url "**/dash"`
- Oczekiwanie na stan ładowania:
  - `openclaw browser wait --load networkidle`
- Oczekiwanie na predykat JS:
  - `openclaw browser wait --fn "window.ready===true"`
- Oczekiwanie na selektor, aż stanie się widoczny:
  - `openclaw browser wait "#main"`

Można je łączyć:

```bash
openclaw browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Przepływy debugowania

Gdy akcja się nie powiedzie (np. „not visible”, „strict mode violation”, „covered”):

1. `openclaw browser snapshot --interactive`
2. Użyj `click <ref>` / `type <ref>` (preferuj referencje ról w trybie interaktywnym)
3. Jeśli nadal się nie powiedzie: `openclaw browser highlight <ref>`, aby zobaczyć, co Playwright wskazuje
4. Jeśli strona zachowuje się dziwnie:
   - `openclaw browser errors --clear`
   - `openclaw browser requests --filter api --clear`
5. Do głębokiego debugowania: nagraj ślad:
   - `openclaw browser trace start`
   - odtwórz problem
   - `openclaw browser trace stop` (drukuje `TRACE:<path>`)

## Wyjście JSON

`--json` jest przeznaczone do skryptów i narzędzi strukturalnych.

Przykłady:

```bash
openclaw browser status --json
openclaw browser snapshot --interactive --json
openclaw browser requests --filter api --json
openclaw browser cookies --json
```

Migawki ról w JSON zawierają `refs` oraz mały blok `stats` (linie/znaki/referencje/interaktywność),
aby narzędzia mogły oceniać rozmiar i gęstość payloadu.

## Stan i pokrętła środowiska

Przydatne w przepływach „spraw, aby strona zachowywała się jak X”:

- Ciasteczka: `cookies`, `cookies set`, `cookies clear`
- Pamięć: `storage local|session get|set|clear`
- Tryb offline: `set offline on|off`
- Nagłówki: `set headers --json '{"X-Debug":"1"}'` (lub `--clear`)
- Uwierzytelnianie HTTP basic: `set credentials user pass` (lub `--clear`)
- Geolokalizacja: `set geo <lat> <lon> --origin "https://example.com"` (lub `--clear`)
- Media: `set media dark|light|no-preference|none`
- Strefa czasowa / lokalizacja: `set timezone ...`, `set locale ...`
- Urządzenie / viewport:
  - `set device "iPhone 14"` (presety urządzeń Playwright)
  - `set viewport 1280 720`

## Bezpieczeństwo i prywatność

- Profil przeglądarki openclaw może zawierać zalogowane sesje; traktuj go jako wrażliwy.
- `browser act kind=evaluate` / `openclaw browser evaluate` oraz `wait --fn`
  wykonują dowolny JavaScript w kontekście strony. Prompt injection może tym sterować. Wyłącz to przez `browser.evaluateEnabled=false`, jeśli nie jest potrzebne.
- W sprawie logowań i uwag antybotowych (X/Twitter itp.) zobacz [Logowanie do przeglądarki + publikowanie na X/Twitter](/tools/browser-login).
- Utrzymuj Gateway/host węzła jako prywatne (loopback lub tylko tailnet).
- Endpointy zdalnego CDP są potężne; tuneluj je i zabezpieczaj.

## Rozwiązywanie problemów

W przypadku problemów specyficznych dla Linuksa (zwłaszcza snap Chromium) zobacz
[Rozwiązywanie problemów z przeglądarką](/tools/browser-linux-troubleshooting).

## Narzędzia agenta + jak działa sterowanie

Agent otrzymuje **jedno narzędzie** do automatyzacji przeglądarki:

- `browser` — status/start/stop/karty/otwórz/aktywuj/zamknij/migawka/zrzut/nawiguj/akcja

Mapowanie:

- `browser snapshot` zwraca stabilne drzewo UI (AI lub ARIA).
- `browser act` używa identyfikatorów `ref` z migawki do klikania/pisania/przeciągania/zaznaczania.
- `browser screenshot` przechwytuje piksele (cała strona lub element).
- `browser` akceptuje:
  - `profile` do wyboru nazwanego profilu przeglądarki (openclaw, chrome lub zdalne CDP).
  - `target` (`sandbox` | `host` | `node`) do wyboru miejsca, gdzie działa przeglądarka.
  - W sesjach sandboxed `target: "host"` wymaga `agents.defaults.sandbox.browser.allowHostControl=true`.
  - Jeśli `target` jest pominięte: sesje sandboxed domyślnie używają `sandbox`, a sesje bez sandboxa domyślnie używają `host`.
  - Jeśli podłączony jest węzeł z obsługą przeglądarki, narzędzie może automatycznie kierować do niego, chyba że przypniesz `target="host"` lub `target="node"`.

Zapewnia to deterministykę agenta i unika kruchych selektorów.
