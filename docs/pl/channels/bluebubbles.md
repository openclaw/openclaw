---
summary: "„iMessage przez serwer BlueBubbles na macOS (REST wysyłanie/odbieranie, pisanie, reakcje, parowanie, akcje zaawansowane).”"
read_when:
  - Konfigurowanie kanału BlueBubbles
  - Rozwiązywanie problemów z parowaniem webhooków
  - Konfigurowanie iMessage na macOS
title: "„BlueBubbles”"
---

# BlueBubbles (macOS REST)

Status: dołączona wtyczka komunikująca się z serwerem BlueBubbles na macOS przez HTTP. **Zalecane do integracji z iMessage** ze względu na bogatsze API i łatwiejszą konfigurację w porównaniu ze starszym kanałem imsg.

## Przegląd

- Działa na macOS za pośrednictwem aplikacji pomocniczej BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Zalecane/testowane: macOS Sequoia (15). macOS Tahoe (26) działa; edycja jest obecnie uszkodzona na Tahoe, a aktualizacje ikon grup mogą zgłaszać powodzenie, ale nie synchronizować się.
- OpenClaw komunikuje się z nim przez REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Wiadomości przychodzące docierają przez webhooki; odpowiedzi wychodzące, wskaźniki pisania, potwierdzenia odczytu i reakcje tapback są wywołaniami REST.
- Załączniki i naklejki są przetwarzane jako media przychodzące (i, gdy to możliwe, udostępniane agentowi).
- Parowanie/lista dozwolonych działa tak samo jak w innych kanałach (`/channels/pairing` itd.) z użyciem `channels.bluebubbles.allowFrom` + kodów parowania.
- Reakcje są prezentowane jako zdarzenia systemowe, tak jak w Slack/Telegram, dzięki czemu agenci mogą je „wzmiankować” przed odpowiedzią.
- Funkcje zaawansowane: edycja, cofanie wysłania, wątki odpowiedzi, efekty wiadomości, zarządzanie grupami.

## Szybki start

1. Zainstaluj serwer BlueBubbles na Macu (postępuj zgodnie z instrukcjami na [bluebubbles.app/install](https://bluebubbles.app/install)).

2. W konfiguracji BlueBubbles włącz web API i ustaw hasło.

3. Uruchom `openclaw onboard` i wybierz BlueBubbles albo skonfiguruj ręcznie:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Skieruj webhooki BlueBubbles do swojej bramy (przykład: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Uruchom bramę; zarejestruje ona obsługę webhooków i rozpocznie parowanie.

## Utrzymywanie Messages.app przy życiu (VM / konfiguracje bez ekranu)

Niektóre konfiguracje VM macOS / always‑on mogą powodować, że Messages.app przechodzi w stan „idle” (zdarzenia przychodzące przestają napływać, dopóki aplikacja nie zostanie otwarta/przeniesiona na pierwszy plan). Prostym obejściem jest **„szturchanie” Messages co 5 minut** przy użyciu AppleScript + LaunchAgent.

### 1. Zapisz AppleScript

Zapisz jako:

- `~/Scripts/poke-messages.scpt`

Przykładowy skrypt (nieinteraktywny; nie kradnie fokusu):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Zainstaluj LaunchAgent

Zapisz jako:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Uwagi:

- Uruchamia się **co 300 sekund** oraz **przy logowaniu**.
- Pierwsze uruchomienie może wywołać monity macOS **Automation** (`osascript` → Messages). Zatwierdź je w tej samej sesji użytkownika, w której działa LaunchAgent.

Załaduj:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles jest dostępny w interaktywnym kreatorze konfiguracji:

```
openclaw onboard
```

Kreator prosi dla:

- **Server URL** (wymagane): adres serwera BlueBubbles (np. `http://192.168.1.100:1234`)
- **Password** (wymagane): hasło API z ustawień serwera BlueBubbles
- **Webhook path** (opcjonalne): domyślnie `/bluebubbles-webhook`
- **DM policy**: parowanie, lista dozwolonych, otwarte lub wyłączone
- **Allow list**: numery telefonów, adresy e‑mail lub cele czatu

BlueBubbles można także dodać przez CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Kontrola dostępu (DM-y + grupy)

DM-y:

- Domyślnie: `channels.bluebubbles.dmPolicy = "pairing"`.
- Nieznani nadawcy otrzymują kod parowania; wiadomości są ignorowane do czasu zatwierdzenia (kody wygasają po 1 godzinie).
- Zatwierdzanie przez:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Parowanie jest domyślną wymianą tokenów. Szczegóły: [Pairing](/channels/pairing)

Grupy:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (domyślnie: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` kontroluje, kto może wyzwalać w grupach, gdy ustawione jest `allowlist`.

### Bramka wzmianek (grupy)

BlueBubbles obsługuje bramkowanie oparte na wzmiankach dla czatów grupowych, zgodnie z zachowaniem iMessage/WhatsApp:

- Wykorzystuje `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`) do wykrywania wzmianek.
- Gdy `requireMention` jest włączone dla grupy, agent odpowiada tylko wtedy, gdy zostanie wspomniany.
- Polecenia kontrolne od autoryzowanych nadawców omijają bramkę wzmianek.

Konfiguracja per‑grupa:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Brama poleceń

- Polecenia kontrolne (np. `/config`, `/model`) wymagają autoryzacji.
- Wykorzystuje `allowFrom` oraz `groupAllowFrom` do określenia autoryzacji poleceń.
- Autoryzowani nadawcy mogą uruchamiać polecenia kontrolne nawet bez wzmianki w grupach.

## Pisanie + potwierdzenia odczytu

- **Wskaźniki pisania**: wysyłane automatycznie przed i w trakcie generowania odpowiedzi.
- **Potwierdzenia odczytu**: kontrolowane przez `channels.bluebubbles.sendReadReceipts` (domyślnie: `true`).
- **Wskaźniki pisania**: OpenClaw wysyła zdarzenia rozpoczęcia pisania; BlueBubbles czyści stan pisania automatycznie przy wysłaniu lub po przekroczeniu limitu czasu (ręczne zatrzymanie przez DELETE jest zawodne).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Akcje zaawansowane

BlueBubbles obsługuje zaawansowane akcje wiadomości po włączeniu w konfiguracji:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Dostępne akcje:

- **react**: dodawanie/usuwanie reakcji tapback (`messageId`, `emoji`, `remove`)
- **edit**: edycja wysłanej wiadomości (`messageId`, `text`)
- **unsend**: cofnięcie wysłania wiadomości (`messageId`)
- **reply**: odpowiedź na konkretną wiadomość (`messageId`, `text`, `to`)
- **sendWithEffect**: wysyłanie z efektem iMessage (`text`, `to`, `effectId`)
- **renameGroup**: zmiana nazwy czatu grupowego (`chatGuid`, `displayName`)
- **setGroupIcon**: ustawienie ikony/zdjęcia czatu grupowego (`chatGuid`, `media`) — niestabilne na macOS 26 Tahoe (API może zwrócić sukces, ale ikona się nie zsynchronizuje).
- **addParticipant**: dodanie osoby do grupy (`chatGuid`, `address`)
- **removeParticipant**: usunięcie osoby z grupy (`chatGuid`, `address`)
- **leaveGroup**: opuszczenie czatu grupowego (`chatGuid`)
- **sendAttachment**: wysyłanie mediów/plików (`to`, `buffer`, `filename`, `asVoice`)
  - Notatki głosowe: ustaw `asVoice: true` z dźwiękiem **MP3** lub **CAF**, aby wysłać jako wiadomość głosową iMessage. BlueBubbles konwertuje MP3 → CAF przy wysyłaniu notatek głosowych.

### Identyfikatory wiadomości (krótkie vs pełne)

OpenClaw może udostępniać _krótkie_ identyfikatory wiadomości (np. `1`, `2`), aby oszczędzać tokeny.

- `MessageSid` / `ReplyToId` mogą być krótkimi identyfikatorami.
- `MessageSidFull` / `ReplyToIdFull` zawierają pełne identyfikatory dostawcy.
- Krótkie identyfikatory są przechowywane w pamięci; mogą wygasnąć po restarcie lub usunięciu z cache.
- Akcje akceptują krótkie lub pełne `messageId`, jednak krótkie identyfikatory spowodują błąd, jeśli nie są już dostępne.

Do trwałych automatyzacji i przechowywania używaj pełnych identyfikatorów:

- Szablony: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Kontekst: `MessageSidFull` / `ReplyToIdFull` w ładunkach przychodzących

Zobacz [Configuration](/gateway/configuration) dla zmiennych szablonów.

## Strumieniowanie blokowe

Kontroluj, czy odpowiedzi są wysyłane jako pojedyncza wiadomość czy strumieniowane w blokach:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + limity

- Załączniki przychodzące są pobierane i zapisywane w pamięci podręcznej mediów.
- Limit mediów przez `channels.bluebubbles.mediaMaxMb` (domyślnie: 8 MB).
- Tekst wychodzący jest dzielony do `channels.bluebubbles.textChunkLimit` (domyślnie: 4000 znaków).

## Referencja konfiguracji

Pełna konfiguracja: [Configuration](/gateway/configuration)

Opcje dostawcy:

- `channels.bluebubbles.enabled`: włączenie/wyłączenie kanału.
- `channels.bluebubbles.serverUrl`: bazowy URL REST API BlueBubbles.
- `channels.bluebubbles.password`: hasło API.
- `channels.bluebubbles.webhookPath`: ścieżka punktu końcowego webhooka (domyślnie: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (domyślnie: `pairing`).
- `channels.bluebubbles.allowFrom`: lista dozwolonych DM (identyfikatory, e‑maile, numery E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (domyślnie: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: lista dozwolonych nadawców w grupach.
- `channels.bluebubbles.groups`: konfiguracja per‑grupa (`requireMention` itd.).
- `channels.bluebubbles.sendReadReceipts`: wysyłanie potwierdzeń odczytu (domyślnie: `true`).
- `channels.bluebubbles.blockStreaming`: włączenie strumieniowania blokowego (domyślnie: `false`; wymagane dla odpowiedzi strumieniowanych).
- `channels.bluebubbles.textChunkLimit`: rozmiar fragmentu wychodzącego w znakach (domyślnie: 4000).
- `channels.bluebubbles.chunkMode`: `length` (domyślnie) dzieli tylko po przekroczeniu `textChunkLimit`; `newline` dzieli na pustych liniach (granice akapitów) przed dzieleniem wg długości.
- `channels.bluebubbles.mediaMaxMb`: limit mediów przychodzących w MB (domyślnie: 8).
- `channels.bluebubbles.historyLimit`: maks. liczba wiadomości grupowych dla kontekstu (0 wyłącza).
- `channels.bluebubbles.dmHistoryLimit`: limit historii DM.
- `channels.bluebubbles.actions`: włączenie/wyłączenie konkretnych akcji.
- `channels.bluebubbles.accounts`: konfiguracja wielu kont.

Powiązane opcje globalne:

- `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adresowanie / cele dostarczania

Preferuj `chat_guid` dla stabilnego routingu:

- `chat_guid:iMessage;-;+15555550123` (preferowane dla grup)
- `chat_id:123`
- `chat_identifier:...`
- Bezpośrednie identyfikatory: `+15555550123`, `user@example.com`
  - Jeśli bezpośredni identyfikator nie ma istniejącego czatu DM, OpenClaw utworzy go przez `POST /api/v1/chat/new`. Wymaga to włączenia prywatnego API BlueBubbles.

## Bezpieczeństwo

- Żądania webhooków są uwierzytelniane przez porównanie parametrów zapytania lub nagłówków `guid`/`password` z `channels.bluebubbles.password`. Akceptowane są także żądania z `localhost`.
- Chroń hasło API i punkt końcowy webhooka (traktuj je jak poświadczenia).
- Zaufanie do localhost oznacza, że odwrotny proxy na tym samym hoście może nieumyślnie ominąć hasło. Jeśli stosujesz proxy dla bramy, wymagaj uwierzytelniania na proxy i skonfiguruj `gateway.trustedProxies`. Zobacz [Gateway security](/gateway/security#reverse-proxy-configuration).
- Włącz HTTPS + reguły zapory na serwerze BlueBubbles, jeśli wystawiasz go poza LAN.

## Rozwiązywanie problemów

- Jeśli zdarzenia pisania/odczytu przestaną działać, sprawdź logi webhooków BlueBubbles i zweryfikuj, czy ścieżka bramy odpowiada `channels.bluebubbles.webhookPath`.
- Kody parowania wygasają po jednej godzinie; użyj `openclaw pairing list bluebubbles` oraz `openclaw pairing approve bluebubbles <code>`.
- Reakcje wymagają prywatnego API BlueBubbles (`POST /api/v1/message/react`); upewnij się, że wersja serwera je udostępnia.
- Edycja/cofanie wysłania wymagają macOS 13+ oraz zgodnej wersji serwera BlueBubbles. Na macOS 26 (Tahoe) edycja jest obecnie uszkodzona z powodu zmian w prywatnym API.
- Aktualizacje ikon grup mogą być niestabilne na macOS 26 (Tahoe): API może zwrócić sukces, ale nowa ikona się nie zsynchronizuje.
- OpenClaw automatycznie ukrywa znane uszkodzone akcje na podstawie wersji macOS serwera BlueBubbles. Jeśli edycja nadal pojawia się na macOS 26 (Tahoe), wyłącz ją ręcznie przez `channels.bluebubbles.actions.edit=false`.
- Informacje o stanie/zdrowiu: `openclaw status --all` lub `openclaw status --deep`.

Aby zapoznać się z ogólnym przepływem pracy kanałów, zobacz [Channels](/channels) oraz przewodnik [Plugins](/tools/plugin).
