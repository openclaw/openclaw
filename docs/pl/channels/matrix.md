---
summary: "„Status obsługi Matrix, możliwości i konfiguracja”"
read_when:
  - Prace nad funkcjami kanału Matrix
title: "„Matrix”"
---

# Matrix (wtyczka)

Matrix to otwarty, zdecentralizowany protokół komunikacyjny. OpenClaw łączy się jako **użytkownik** Matrix
na dowolnym homeserverze, więc potrzebujesz konta Matrix dla bota. Po zalogowaniu możesz
wysyłać botowi wiadomości DM lub zapraszać go do pokoi (matrixowe „grupy”). Beeper również jest
poprawną opcją klienta, ale wymaga włączonego E2EE.

Status: obsługiwany przez wtyczkę (@vector-im/matrix-bot-sdk). Wiadomości bezpośrednie, pokoje, wątki, media, reakcje,
ankiety (wysyłanie + poll-start jako tekst), lokalizacja oraz E2EE (z obsługą kryptografii).

## Wymagana wtyczka

Matrix jest dostarczany jako wtyczka i nie jest dołączony do instalacji rdzenia.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/matrix
```

Lokalne checkout (podczas uruchamiania z repozytorium git):

```bash
openclaw plugins install ./extensions/matrix
```

Jeśli wybierzesz Matrix podczas konfiguracji/onboardingu i zostanie wykryty checkout git,
OpenClaw automatycznie zaproponuje lokalną ścieżkę instalacji.

Szczegóły: [Plugins](/tools/plugin)

## Konfiguracja

1. Zainstaluj wtyczkę Matrix:
   - Z npm: `openclaw plugins install @openclaw/matrix`
   - Z lokalnego checkoutu: `openclaw plugins install ./extensions/matrix`

2. Utwórz konto Matrix na homeserverze:
   - Przeglądaj opcje hostingu na [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Lub hostuj samodzielnie.

3. Uzyskaj token dostępu dla konta bota:

   - Użyj API logowania Matrix z `curl` na swoim homeserverze:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Zastąp `matrix.example.org` adresem URL swojego homeservera.
   - Albo ustaw `channels.matrix.userId` + `channels.matrix.password`: OpenClaw wywołuje ten sam
     endpoint logowania, zapisuje token dostępu w `~/.openclaw/credentials/matrix/credentials.json`
     i ponownie używa go przy następnym uruchomieniu.

4. Skonfiguruj poświadczenia:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (lub `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Albo config: `channels.matrix.*`
   - Jeśli oba są ustawione, konfiguracja ma pierwszeństwo.
   - Przy użyciu tokenu dostępu: ID użytkownika jest pobierane automatycznie przez `/whoami`.
   - Gdy ustawione, `channels.matrix.userId` powinno być pełnym ID Matrix (przykład: `@bot:example.org`).

5. Zrestartuj gateway (lub zakończ onboarding).

6. Rozpocznij DM z botem lub zaproś go do pokoju z dowolnego klienta Matrix
   (Element, Beeper itd.; zob. [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper wymaga E2EE,
   więc ustaw `channels.matrix.encryption: true` i zweryfikuj urządzenie.

Minimalna konfiguracja (token dostępu, ID użytkownika pobierane automatycznie):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Konfiguracja E2EE (włączone szyfrowanie end-to-end):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Szyfrowanie (E2EE)

Szyfrowanie end-to-end jest **obsługiwane** przez rustowy SDK kryptograficzny.

Włącz za pomocą `channels.matrix.encryption: true`:

- Jeśli moduł crypto się załaduje, zaszyfrowane pokoje są odszyfrowywane automatycznie.
- Wychodzące media są szyfrowane przy wysyłaniu do zaszyfrowanych pokoi.
- Przy pierwszym połączeniu OpenClaw żąda weryfikacji urządzenia z innych sesji.
- Zweryfikuj urządzenie w innym kliencie Matrix (Element itd.), aby włączyć udostępnianie kluczy. aby włączyć udostępnianie kluczy.
- Jeśli moduł crypto nie może zostać załadowany, E2EE jest wyłączone, a zaszyfrowane pokoje nie będą odszyfrowywane;
  OpenClaw zapisze ostrzeżenie w logach.
- Jeśli pojawiają się błędy braku modułu crypto (np. `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  zezwól na skrypty budowania dla `@matrix-org/matrix-sdk-crypto-nodejs` i uruchom
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` lub pobierz binarium za pomocą
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Stan kryptografii jest przechowywany per konto + token dostępu w
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(baza SQLite). Stan synchronizacji znajduje się obok w `bot-storage.json`.
Jeśli token dostępu (urządzenie) ulegnie zmianie, tworzony jest nowy magazyn i bot musi
zostać ponownie zweryfikowany dla zaszyfrowanych pokoi.

**Weryfikacja urządzenia:**
Gdy E2EE jest włączone, bot przy starcie poprosi o weryfikację z innych sesji.
Otwórz Element (lub innego klienta) i zatwierdź żądanie weryfikacji, aby ustanowić zaufanie.
Po weryfikacji bot może odszyfrowywać wiadomości w zaszyfrowanych pokojach.

## Model routingu

- Odpowiedzi zawsze wracają do Matrix.
- DM-y współdzielą główną sesję agenta; pokoje mapują się na sesje grupowe.

## Kontrola dostępu (DM-y)

- Domyślnie: `channels.matrix.dm.policy = "pairing"`. Nieznani nadawcy otrzymują kod parowania.
- Zatwierdzanie przez:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Publiczne DM-y: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` akceptuje pełne ID użytkowników Matrix (przykład: `@user:server`). Kreator rozwiązuje nazwy wyświetlane do ID użytkowników, gdy wyszukiwanie w katalogu znajdzie jedno dokładne dopasowanie.

## Pokoje (grupy)

- Domyślnie: `channels.matrix.groupPolicy = "allowlist"` (wymagane wzmianki). Użyj `channels.defaults.groupPolicy`, aby nadpisać domyślne zachowanie, gdy nieustawione.
- Zezwalaj na pokoje przez listę dozwolonych za pomocą `channels.matrix.groups` (ID pokoi lub aliasy; nazwy są rozwiązywane do ID, gdy wyszukiwanie w katalogu znajdzie jedno dokładne dopasowanie):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` włącza automatyczną odpowiedź w danym pokoju.
- `groups."*"` może ustawić domyślne reguły wymagania wzmianek dla pokoi.
- `groupAllowFrom` ogranicza, którzy nadawcy mogą wyzwalać bota w pokojach (pełne ID użytkowników Matrix).
- Listy dozwolonych per pokój `users` mogą dodatkowo ograniczać nadawców w konkretnym pokoju (używaj pełnych ID użytkowników Matrix).
- Kreator konfiguracji pyta o listy dozwolonych pokoi (ID pokoi, aliasy lub nazwy) i rozwiązuje nazwy tylko przy dokładnym, unikalnym dopasowaniu.
- Przy starcie OpenClaw rozwiązuje nazwy pokoi/użytkowników na listach dozwolonych do ID i loguje mapowanie; nierozwiązane wpisy są ignorowane przy dopasowywaniu list dozwolonych.
- Zaproszenia są domyślnie automatycznie akceptowane; steruj za pomocą `channels.matrix.autoJoin` i `channels.matrix.autoJoinAllowlist`.
- Aby **nie zezwalać na żadne pokoje**, ustaw `channels.matrix.groupPolicy: "disabled"` (lub pozostaw pustą listę dozwolonych).
- Klucz legacy: `channels.matrix.rooms` (taki sam kształt jak `groups`).

## Wątki

- Odpowiedzi w wątkach są obsługiwane.
- `channels.matrix.threadReplies` kontroluje, czy odpowiedzi pozostają w wątkach:
  - `off`, `inbound` (domyślnie), `always`
- `channels.matrix.replyToMode` kontroluje metadane reply-to, gdy odpowiedź nie jest w wątku:
  - `off` (domyślnie), `first`, `all`

## Możliwości

| Funkcja                 | Status                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Wiadomości bezpośrednie | ✅ Obsługiwane                                                                                                                     |
| Pokoje                  | ✅ Obsługiwane                                                                                                                     |
| Wątki                   | ✅ Obsługiwane                                                                                                                     |
| Media                   | ✅ Obsługiwane                                                                                                                     |
| E2EE                    | ✅ Obsługiwane (wymagany moduł crypto)                                                                          |
| Reakcje                 | ✅ Obsługiwane (wysyłanie/odczyt przez narzędzia)                                                               |
| Ankiety                 | ✅ Wysyłanie obsługiwane; przychodzące starty ankiet konwertowane do tekstu (odpowiedzi/zakończenia ignorowane) |
| Lokalizacja             | ✅ Obsługiwane (URI geo; wysokość ignorowana)                                                                   |
| Polecenia natywne       | ✅ Obsługiwane                                                                                                                     |

## Rozwiązywanie problemów

Najpierw uruchom tę drabinę poleceń:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Następnie, w razie potrzeby, potwierdź stan parowania DM:

```bash
openclaw pairing list matrix
```

Częste awarie:

- Zalogowany, ale wiadomości z pokoi są ignorowane: pokój zablokowany przez `groupPolicy` lub listę dozwolonych pokoi.
- DM-y ignorowane: nadawca oczekuje na zatwierdzenie, gdy `channels.matrix.dm.policy="pairing"`.
- Problemy z zaszyfrowanymi pokojami: brak obsługi crypto lub niezgodność ustawień szyfrowania.

Schemat triage: [/channels/troubleshooting](/channels/troubleshooting).

## Referencja konfiguracji (Matrix)

Pełna konfiguracja: [Configuration](/gateway/configuration)

Opcje dostawcy:

- `channels.matrix.enabled`: włącz/wyłącz uruchamianie kanału.
- `channels.matrix.homeserver`: URL homeservera.
- `channels.matrix.userId`: ID użytkownika Matrix (opcjonalne przy tokenie dostępu).
- `channels.matrix.accessToken`: token dostępu.
- `channels.matrix.password`: hasło do logowania (token jest zapisywany).
- `channels.matrix.deviceName`: nazwa wyświetlana urządzenia.
- `channels.matrix.encryption`: włącz E2EE (domyślnie: false).
- `channels.matrix.initialSyncLimit`: limit początkowej synchronizacji.
- `channels.matrix.threadReplies`: `off | inbound | always` (domyślnie: inbound).
- `channels.matrix.textChunkLimit`: rozmiar fragmentów tekstu wychodzącego (znaki).
- `channels.matrix.chunkMode`: `length` (domyślnie) lub `newline` w celu dzielenia po pustych liniach (granice akapitów) przed dzieleniem według długości.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (domyślnie: parowanie).
- `channels.matrix.dm.allowFrom`: lista dozwolonych DM (pełne ID użytkowników Matrix). `open` wymaga `"*"`. Kreator rozwiązuje nazwy do ID, gdy to możliwe.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (domyślnie: lista dozwolonych).
- `channels.matrix.groupAllowFrom`: dozwoleni nadawcy dla wiadomości grupowych (pełne ID użytkowników Matrix).
- `channels.matrix.allowlistOnly`: wymuś reguły list dozwolonych dla DM-ów i pokoi.
- `channels.matrix.groups`: lista dozwolonych grup + mapa ustawień per pokój.
- `channels.matrix.rooms`: legacy lista dozwolonych grup/konfiguracja.
- `channels.matrix.replyToMode`: tryb reply-to dla wątków/tagów.
- `channels.matrix.mediaMaxMb`: limit mediów przychodzących/wychodzących (MB).
- `channels.matrix.autoJoin`: obsługa zaproszeń (`always | allowlist | off`, domyślnie: zawsze).
- `channels.matrix.autoJoinAllowlist`: dozwolone ID/aliasy pokoi dla automatycznego dołączania.
- `channels.matrix.actions`: bramkowanie narzędzi per akcja (reakcje/wiadomości/piny/memberInfo/channelInfo).
