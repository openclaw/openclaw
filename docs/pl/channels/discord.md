---
summary: "„Status wsparcia bota Discord, możliwości i konfiguracja”"
read_when:
  - Prace nad funkcjami kanału Discord
title: "Discord"
---

# Discord (Bot API)

Status: gotowy do DM-ów i tekstowych kanałów gildii przez oficjalną bramę bota Discord.

## Szybka konfiguracja (dla początkujących)

1. Utwórz bota Discord i skopiuj token bota.
2. W ustawieniach aplikacji Discord włącz **Message Content Intent** (oraz **Server Members Intent**, jeśli planujesz używać list dozwolonych lub wyszukiwania nazw).
3. Ustaw token dla OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Lub konfiguracja: `channels.discord.token: "..."`.
   - Jeśli ustawione są oba, konfiguracja ma pierwszeństwo (env jako zapas dotyczy tylko konta domyślnego).
4. Zaproś bota na swój serwer z uprawnieniami do wiadomości (utwórz prywatny serwer, jeśli chcesz tylko DM-y).
5. Uruchom gateway.
6. Dostęp do DM-ów jest domyślnie parowany; zatwierdź kod parowania przy pierwszym kontakcie.

Minimalna konfiguracja:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Cele

- Rozmawiać z OpenClaw przez DM-y Discord lub kanały gildii.
- Czat bezpośredni zwija się do głównej sesji agenta (domyślnie `agent:main:main`); kanały gildii pozostają odizolowane jako `agent:<agentId>:discord:channel:<channelId>` (nazwy wyświetlane używają `discord:<guildSlug>#<channelSlug>`).
- Grupowe DM-y są domyślnie ignorowane; włącz przez `channels.discord.dm.groupEnabled` i opcjonalnie ogranicz przez `channels.discord.dm.groupChannels`.
- Zachować deterministyczne trasowanie: odpowiedzi zawsze wracają do kanału, z którego przyszły.

## Jak to działa

1. Utwórz aplikację Discord → Bot, włącz potrzebne intenty (DM-y + wiadomości gildii + treść wiadomości) i pobierz token bota.
2. Zaproś bota na swój serwer z uprawnieniami wymaganymi do odczytu/wysyłania wiadomości tam, gdzie chcesz go używać.
3. Skonfiguruj OpenClaw za pomocą `channels.discord.token` (lub `DISCORD_BOT_TOKEN` jako zapas).
4. Uruchom gateway; automatycznie uruchamia kanał Discord, gdy dostępny jest token (najpierw konfiguracja, potem env jako zapas) i `channels.discord.enabled` nie jest `false`.
   - Jeśli wolisz zmienne środowiskowe, ustaw `DISCORD_BOT_TOKEN` (blok konfiguracji jest opcjonalny).
5. Czat bezpośredni: użyj `user:<id>` (lub wzmianki `<@id>`) przy dostarczaniu; wszystkie tury trafiają do współdzielonej sesji `main`. Same identyfikatory numeryczne są niejednoznaczne i odrzucane.
6. Kanały gildii: użyj `channel:<channelId>` do dostarczania. Wzmianki są domyślnie wymagane i można je ustawić per gildia lub per kanał.
7. Czat bezpośredni: domyślnie zabezpieczony przez `channels.discord.dm.policy` (domyślnie: `"pairing"`). Nieznani nadawcy otrzymują kod parowania (wygasa po 1 godzinie); zatwierdź przez `openclaw pairing approve discord <code>`.
   - Aby zachować stare zachowanie „otwarte dla wszystkich”: ustaw `channels.discord.dm.policy="open"` i `channels.discord.dm.allowFrom=["*"]`.
   - Aby zastosować twardą listę dozwolonych: ustaw `channels.discord.dm.policy="allowlist"` i wypisz nadawców w `channels.discord.dm.allowFrom`.
   - Aby ignorować wszystkie DM-y: ustaw `channels.discord.dm.enabled=false` lub `channels.discord.dm.policy="disabled"`.
8. Grupowe DM-y są domyślnie ignorowane; włącz przez `channels.discord.dm.groupEnabled` i opcjonalnie ogranicz przez `channels.discord.dm.groupChannels`.
9. Opcjonalne reguły gildii: ustaw `channels.discord.guilds` z kluczami według id gildii (preferowane) lub sluga, z regułami per kanał.
10. Opcjonalne komendy natywne: `commands.native` domyślnie `"auto"` (włączone dla Discord/Telegram, wyłączone dla Slack). Nadpisz przez `channels.discord.commands.native: true|false|"auto"`; `false` czyści wcześniej zarejestrowane komendy. Komendy tekstowe są kontrolowane przez `commands.text` i muszą być wysyłane jako samodzielne wiadomości `/...`. Użyj `commands.useAccessGroups: false`, aby pominąć sprawdzanie grup dostępu dla komend.
    - Pełna lista komend + konfiguracja: [Slash commands](/tools/slash-commands)
11. Opcjonalna historia kontekstu gildii: ustaw `channels.discord.historyLimit` (domyślnie 20, z zapasem do `messages.groupChat.historyLimit`), aby dołączyć ostatnie N wiadomości gildii jako kontekst przy odpowiedzi na wzmiankę. Ustaw `0`, aby wyłączyć.
12. Reakcje: agent może wyzwalać reakcje przez narzędzie `discord` (kontrolowane przez `channels.discord.actions.*`).
    - Semantyka usuwania reakcji: zobacz [/tools/reactions](/tools/reactions).
    - Narzędzie `discord` jest udostępniane tylko, gdy bieżący kanał to Discord.
13. Komendy natywne używają izolowanych kluczy sesji (`agent:<agentId>:discord:slash:<userId>`) zamiast współdzielonej sesji `main`.

Uwaga: Rozwiązywanie nazwa → id używa wyszukiwania członków gildii i wymaga Server Members Intent; jeśli bot nie może wyszukiwać członków, użyj id lub wzmianek `<@id>`.
Uwaga: Slugi są pisane małymi literami, a spacje zastępowane przez `-`. Nazwy kanałów są slugowane bez wiodącego `#`.
Uwaga: Linie kontekstu gildii `[from:]` zawierają `author.tag` + `id`, aby ułatwić odpowiedzi gotowe do pingowania.

## Zapisy konfiguracji

Domyślnie Discord ma prawo zapisywać aktualizacje konfiguracji wyzwalane przez `/config set|unset` (wymaga `commands.config: true`).

Wyłącz przez:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Jak utworzyć własnego bota

To jest konfiguracja „Discord Developer Portal” do uruchamiania OpenClaw w kanale serwera (gildii), takim jak `#help`.

### 1. Utwórz aplikację Discord + użytkownika bota

1. Discord Developer Portal → **Applications** → **New Application**
2. W aplikacji:
   - **Bot** → **Add Bot**
   - Skopiuj **Bot Token** (to trafia do `DISCORD_BOT_TOKEN`)

### 2) Włącz intenty bramy wymagane przez OpenClaw

Discord blokuje „uprzywilejowane intenty”, jeśli nie włączysz ich jawnie.

W **Bot** → **Privileged Gateway Intents** włącz:

- **Message Content Intent** (wymagany do odczytu treści wiadomości w większości gildii; bez niego zobaczysz „Used disallowed intents” lub bot połączy się, ale nie zareaguje na wiadomości)
- **Server Members Intent** (zalecany; wymagany do niektórych wyszukiwań członków/użytkowników i dopasowań list dozwolonych w gildiach)

Zazwyczaj **nie** potrzebujesz **Presence Intent**. Ustawianie własnej obecności bota (akcja `setPresence`) używa OP3 bramy i nie wymaga tego intentu; jest on potrzebny tylko, jeśli chcesz otrzymywać aktualizacje obecności innych członków gildii.

### 3. Wygeneruj URL zaproszenia (OAuth2 URL Generator)

W aplikacji: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (wymagane dla komend natywnych)

**Uprawnienia bota** (minimalna baza)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (opcjonalne, ale zalecane)
- ✅ Use External Emojis / Stickers (opcjonalne; tylko jeśli chcesz)

Unikaj **Administrator**, chyba że debugujesz i w pełni ufasz botowi.

Skopiuj wygenerowany URL, otwórz go, wybierz serwer i zainstaluj bota.

### 4. Pobierz identyfikatory (gildia/użytkownik/kanał)

Discord używa wszędzie identyfikatorów numerycznych; konfiguracja OpenClaw preferuje id.

1. Discord (desktop/web) → **User Settings** → **Advanced** → włącz **Developer Mode**
2. Kliknij prawym przyciskiem:
   - Nazwa serwera → **Copy Server ID** (id gildii)
   - Kanał (np. `#help`) → **Copy Channel ID**
   - Twój użytkownik → **Copy User ID**

### 5) Skonfiguruj OpenClaw

#### Token

Ustaw token bota przez zmienną środowiskową (zalecane na serwerach):

- `DISCORD_BOT_TOKEN=...`

Lub przez konfigurację:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Wsparcie wielu kont: użyj `channels.discord.accounts` z tokenami per konto i opcjonalnym `name`. Zobacz [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) dla wspólnego wzorca.

#### Lista dozwolonych + trasowanie kanałów

Przykład „jeden serwer, tylko ja, tylko #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Uwagi:

- `requireMention: true` oznacza, że bot odpowiada tylko na wzmianki (zalecane dla kanałów współdzielonych).
- `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`) również liczą się jako wzmianki dla wiadomości gildii.
- Nadpisanie wieloagentowe: ustaw wzorce per agent w `agents.list[].groupChat.mentionPatterns`.
- Jeśli obecne jest `channels`, każdy niewymieniony kanał jest domyślnie odrzucany.
- Użyj wpisu kanału `"*"`, aby zastosować domyślne ustawienia dla wszystkich kanałów; jawne wpisy kanałów nadpisują wildcard.
- Wątki dziedziczą konfigurację kanału nadrzędnego (lista dozwolonych, `requireMention`, skills, prompty itd.), chyba że jawnie dodasz id kanału wątku. chyba że dodasz wyraźnie identyfikator kanału wątków.
- Wskazówka właściciela: gdy per-gildia lub per-kanał lista dozwolonych `users` dopasuje nadawcę, OpenClaw traktuje go jako właściciela w systemowym promptcie. Dla globalnego właściciela między kanałami ustaw `commands.ownerAllowFrom`.
- Wiadomości autorstwa bota są domyślnie ignorowane; ustaw `channels.discord.allowBots=true`, aby je dopuścić (własne wiadomości pozostają filtrowane).
- Ostrzeżenie: jeśli zezwolisz na odpowiedzi do innych botów (`channels.discord.allowBots=true`), zapobiegaj pętlom bot–bot za pomocą list dozwolonych `requireMention`, `channels.discord.guilds.*.channels.<id>.users` i/lub wyczyść zabezpieczenia w `AGENTS.md` i `SOUL.md`.

### 6. Sprawdź, czy działa

1. Uruchom gateway.
2. Na kanale serwera wyślij: `@Krill hello` (lub nazwę swojego bota).
3. Jeśli nic się nie dzieje: sprawdź **Rozwiązywanie problemów** poniżej.

### Rozwiązywanie problemów

- Najpierw: uruchom `openclaw doctor` i `openclaw channels status --probe` (ostrzeżenia możliwe do działania + szybkie audyty).
- **„Used disallowed intents”**: włącz **Message Content Intent** (i prawdopodobnie **Server Members Intent**) w Developer Portal, następnie zrestartuj gateway.
- **Bot łączy się, ale nigdy nie odpowiada na kanale gildii**:
  - Brak **Message Content Intent**, lub
  - Bot nie ma uprawnień kanału (View/Send/Read History), lub
  - Konfiguracja wymaga wzmianek, a nie wspomniałeś bota, lub
  - Lista dozwolonych gildii/kanału odrzuca kanał/użytkownika.
- **`requireMention: false`, ale nadal brak odpowiedzi**:
- `channels.discord.groupPolicy` domyślnie to **allowlist**; ustaw na `"open"` lub dodaj wpis gildii pod `channels.discord.guilds` (opcjonalnie wypisz kanały pod `channels.discord.guilds.<id>.channels`, aby ograniczyć).
  - Jeśli ustawisz tylko `DISCORD_BOT_TOKEN` i nigdy nie utworzysz sekcji `channels.discord`, środowisko wykonawcze
    domyślnie ustawi `groupPolicy` na `open`. Dodaj `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` lub listę dozwolonych gildii/kanału, aby to zablokować.
- `requireMention` musi znajdować się pod `channels.discord.guilds` (lub konkretnym kanałem). `channels.discord.requireMention` na najwyższym poziomie jest ignorowane.
- **Audyty uprawnień** (`channels status --probe`) sprawdzają tylko numeryczne identyfikatory kanałów. Jeśli używasz slugów/nazw jako kluczy `channels.discord.guilds.*.channels`, audyt nie może zweryfikować uprawnień.
- **DM-y nie działają**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"` lub nie zostałeś jeszcze zatwierdzony (`channels.discord.dm.policy="pairing"`).
- **Zatwierdzanie exec w Discord**: Discord obsługuje **interfejs przycisków** dla zatwierdzeń exec w DM-ach (Allow once / Always allow / Deny). `/approve <id> ...` dotyczy tylko przekazywanych zatwierdzeń i nie rozwiąże promptów przycisków Discord. Jeśli widzisz `❌ Failed to submit approval: Error: unknown approval id` lub UI nigdy się nie pojawia, sprawdź:
  - `channels.discord.execApprovals.enabled: true` w konfiguracji.
  - Czy Twój Discord user ID jest na liście `channels.discord.execApprovals.approvers` (UI jest wysyłane tylko do zatwierdzających).
  - Użyj przycisków w DM (**Allow once**, **Always allow**, **Deny**).
  - Zobacz [Exec approvals](/tools/exec-approvals) i [Slash commands](/tools/slash-commands) dla szerszego przepływu zatwierdzeń i komend.

## Możliwości i limity

- DM-y i tekstowe kanały gildii (wątki są traktowane jako osobne kanały; głos nie jest obsługiwany).
- Wskaźniki pisania wysyłane w trybie best-effort; dzielenie wiadomości używa `channels.discord.textChunkLimit` (domyślnie 2000) i rozcina długie odpowiedzi według liczby linii (`channels.discord.maxLinesPerMessage`, domyślnie 17).
- Opcjonalne dzielenie po nowych liniach: ustaw `channels.discord.chunkMode="newline"`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem długości.
- Wysyłanie plików obsługiwane do skonfigurowanego `channels.discord.mediaMaxMb` (domyślnie 8 MB).
- Odpowiedzi w gildii domyślnie wymagają wzmianki, aby uniknąć hałaśliwych botów.
- Kontekst odpowiedzi jest wstrzykiwany, gdy wiadomość odwołuje się do innej wiadomości (cytowana treść + id).
- Natywne wątki odpowiedzi są **domyślnie wyłączone**; włącz przez `channels.discord.replyToMode` i tagi odpowiedzi.

## Polityka ponowień

Wychodzące wywołania API Discord ponawiają przy limitach (429) z użyciem Discord `retry_after`, gdy dostępne, z wykładniczym opóźnieniem i jitterem. Konfiguruj przez `channels.discord.retry`. Zobacz [Retry policy](/concepts/retry).

## Konfiguracja

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Reakcje potwierdzeń są kontrolowane globalnie przez `messages.ackReaction` +
`messages.ackReactionScope`. Użyj `messages.removeAckAfterReply`, aby usunąć
reakcję potwierdzenia po odpowiedzi bota.

- `dm.enabled`: ustaw `false`, aby ignorować wszystkie DM-y (domyślnie `true`).
- `dm.policy`: kontrola dostępu DM (`pairing` zalecane). `"open"` wymaga `dm.allowFrom=["*"]`.
- `dm.allowFrom`: lista dozwolonych DM (id użytkowników lub nazwy). Używana przez `dm.policy="allowlist"` i do walidacji `dm.policy="open"`. Kreator akceptuje nazwy użytkowników i rozwiązuje je do id, gdy bot może wyszukiwać członków.
- `dm.groupEnabled`: włącz grupowe DM-y (domyślnie `false`).
- `dm.groupChannels`: opcjonalna lista dozwolonych id kanałów grupowych DM lub slugów.
- `groupPolicy`: kontroluje obsługę kanałów gildii (`open|disabled|allowlist`); `allowlist` wymaga list dozwolonych kanałów.
- `guilds`: reguły per-gildia z kluczami id gildii (preferowane) lub slug.
- `guilds."*"`: domyślne ustawienia per-gildia stosowane, gdy brak jawnego wpisu.
- `guilds.<id>.slug`: opcjonalny przyjazny slug używany w nazwach wyświetlanych.
- `guilds.<id>.users`: opcjonalna per-gildia lista dozwolonych użytkowników (id lub nazwy).
- `guilds.<id>.tools`: opcjonalne per-gildia nadpisania polityki narzędzi (`allow`/`deny`/`alsoAllow`) używane, gdy brak nadpisania kanału.
- `guilds.<id>.toolsBySender`: opcjonalne per-nadawca nadpisania polityki narzędzi na poziomie gildii (stosowane, gdy brak nadpisania kanału; obsługiwany wildcard `"*"`).
- `guilds.<id>.channels.<channel>.allow`: zezwól/zabroń kanału, gdy `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: bramkowanie wzmianek dla kanału.
- `guilds.<id>.channels.<channel>.tools`: opcjonalne per-kanał nadpisania polityki narzędzi (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: opcjonalne per-nadawca nadpisania polityki narzędzi w kanale (obsługiwany wildcard `"*"`).
- `guilds.<id>.channels.<channel>.users`: opcjonalna per-kanał lista dozwolonych użytkowników.
- `guilds.<id>.channels.<channel>.skills`: filtr skills (pominięcie = wszystkie skills, puste = brak).
- `guilds.<id>.channels.<channel>.systemPrompt`: dodatkowy systemowy prompt dla kanału. Tematy kanałów Discord są wstrzykiwane jako kontekst **niezaufany** (nie systemowy prompt).
- `guilds.<id>.channels.<channel>.enabled`: ustaw `false`, aby wyłączyć kanał.
- `guilds.<id>.channels`: reguły kanałów (klucze to slugi lub id kanałów).
- `guilds.<id>.requireMention`: wymaganie wzmianek per-gildia (możliwe do nadpisania per kanał).
- `guilds.<id>.reactionNotifications`: tryb zdarzeń systemu reakcji (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: rozmiar fragmentów tekstu wychodzącego (znaki). Domyślnie: 2000.
- `chunkMode`: `length` (domyślnie) dzieli tylko po przekroczeniu `textChunkLimit`; `newline` dzieli po pustych liniach (granice akapitów) przed dzieleniem długości.
- `maxLinesPerMessage`: miękki maks. liczby linii na wiadomość. Domyślnie: 17.
- `mediaMaxMb`: ogranicz zapisywane na dysku media przychodzące.
- `historyLimit`: liczba ostatnich wiadomości gildii dołącza jako kontekst przy odpowiedzi na wzmiankę (domyślnie 20; z zapasem do `messages.groupChat.historyLimit`; `0` wyłącza).
- `dmHistoryLimit`: limit historii DM w turach użytkownika. Nadpisania per użytkownik: `dms["<user_id>"].historyLimit`.
- `retry`: polityka ponowień dla wychodzących wywołań API Discord (próby, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: rozwiązywanie wiadomości proxy PluralKit, aby członkowie systemu byli widoczni jako odrębni nadawcy.
- `actions`: bramki narzędzi per akcja; pomiń, aby zezwolić na wszystkie (ustaw `false`, aby wyłączyć).
  - `reactions` (obejmuje reakcje + odczyt reakcji)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (tworzenie/edycja/usuwanie kanałów + kategorii + uprawnień)
  - `roles` (dodawanie/usuwanie ról, domyślnie `false`)
  - `moderation` (timeout/kick/ban, domyślnie `false`)
  - `presence` (status/aktywność bota, domyślnie `false`)
- `execApprovals`: zatwierdzenia exec tylko dla Discord (DM-y z UI przycisków). Obsługuje `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Powiadomienia o reakcjach używają `guilds.<id>.reactionNotifications`:

- `off`: brak zdarzeń reakcji.
- `own`: reakcje na własnych wiadomościach bota (domyślnie).
- `all`: wszystkie reakcje na wszystkich wiadomościach.
- `allowlist`: reakcje od `guilds.<id>.users` na wszystkich wiadomościach (pusta lista wyłącza).

### Wsparcie PluralKit (PK)

Włącz wyszukiwania PK, aby wiadomości proxy były rozwiązywane do bazowego systemu + członka.
Po włączeniu OpenClaw używa tożsamości członka do list dozwolonych i etykietuje
nadawcę jako `Member (PK:System)`, aby uniknąć przypadkowych pingów Discord.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Uwagi dotyczące list dozwolonych (z włączonym PK):

- Użyj `pk:<memberId>` w `dm.allowFrom`, `guilds.<id>.users` lub per-kanał `users`.
- Nazwy wyświetlane członków są również dopasowywane po nazwie/slug.
- Wyszukiwania używają **oryginalnego** ID wiadomości Discord (sprzed proxy), więc
  API PK rozwiązuje je tylko w swoim 30‑minutowym oknie.
- Jeśli wyszukiwania PK się nie powiodą (np. prywatny system bez tokena), wiadomości proxy
  są traktowane jako wiadomości bota i odrzucane, chyba że `channels.discord.allowBots=true`.

### Domyślne akcje narzędzi

| Grupa akcji    | Domyślne | Uwagi                                                  |
| -------------- | -------- | ------------------------------------------------------ |
| reactions      | enabled  | Reakcje + lista reakcji + emojiList                    |
| stickers       | enabled  | Wysyłanie naklejek                                     |
| emojiUploads   | enabled  | Wgrywanie emoji                                        |
| stickerUploads | enabled  | Wgrywanie naklejek                                     |
| polls          | enabled  | Tworzenie ankiet                                       |
| permissions    | enabled  | Migawka uprawnień kanału                               |
| messages       | enabled  | Odczyt/wysyłanie/edycja/usuwanie                       |
| threads        | enabled  | Tworzenie/listowanie/odpowiedzi                        |
| pins           | enabled  | Przypinanie/odpinanie/lista                            |
| search         | enabled  | Wyszukiwanie wiadomości (preview)   |
| memberInfo     | enabled  | Informacje o członku                                   |
| roleInfo       | enabled  | Lista ról                                              |
| channelInfo    | enabled  | Informacje o kanale + lista                            |
| channels       | enabled  | Zarządzanie kanałami/kategoriami                       |
| voiceStatus    | enabled  | Podgląd stanu głosu                                    |
| events         | enabled  | Lista/tworzenie wydarzeń                               |
| roles          | disabled | Dodawanie/usuwanie ról                                 |
| moderation     | disabled | Timeout/kick/ban                                       |
| presence       | disabled | Status/aktywność bota (setPresence) |

- `replyToMode`: `off` (domyślnie), `first` lub `all`. Stosowane tylko, gdy model zawiera tag odpowiedzi.

## Tagi odpowiedzi

Aby zażądać odpowiedzi w wątku, model może zawrzeć jeden tag w swoim wyjściu:

- `[[reply_to_current]]` — odpowiedz na wyzwalającą wiadomość Discord.
- `[[reply_to:<id>]]` — odpowiedz na konkretne id wiadomości z kontekstu/historii.
  Bieżące id wiadomości są dołączane do promptów jako `[message_id: …]`; wpisy historii już zawierają id.

Zachowanie jest kontrolowane przez `channels.discord.replyToMode`:

- `off`: ignoruj tagi.
- `first`: tylko pierwszy fragment/załącznik wychodzący jest odpowiedzią.
- `all`: każdy fragment/załącznik wychodzący jest odpowiedzią.

Uwagi dotyczące dopasowań list dozwolonych:

- `allowFrom`/`users`/`groupChannels` akceptują id, nazwy, tagi lub wzmianki, takie jak `<@id>`.
- Prefiksy takie jak `discord:`/`user:` (użytkownicy) oraz `channel:` (grupowe DM-y) są obsługiwane.
- Użyj `*`, aby dopuścić dowolnego nadawcę/kanał.
- Gdy obecne jest `guilds.<id>.channels`, niewymienione kanały są domyślnie odrzucane.
- Gdy `guilds.<id>.channels` jest pominięte, wszystkie kanały w dozwolonej gildii są dozwolone.
- Aby dopuścić **żadne kanały**, ustaw `channels.discord.groupPolicy: "disabled"` (lub pozostaw pustą listę dozwolonych).
- Kreator konfiguracji akceptuje nazwy `Guild/Channel` (publiczne + prywatne) i rozwiązuje je do ID, gdy to możliwe.
- Przy starcie OpenClaw rozwiązuje nazwy kanałów/użytkowników w listach dozwolonych do ID (gdy bot może wyszukiwać członków)
  i loguje mapowanie; nierozwiązane wpisy są zachowywane w oryginalnej postaci.

Natywne uwagi komendy:

- Zarejestrowane komendy odzwierciedlają komendy czatu OpenClaw.
- Komendy natywne respektują te same listy dozwolonych co DM-y/wiadomości gildii (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, reguły per kanał).
- Komendy slash mogą być nadal widoczne w UI Discord dla użytkowników spoza listy dozwolonych; OpenClaw egzekwuje listy przy wykonaniu i odpowiada „not authorized”.

## Akcje narzędzi

Agent może wywołać `discord` z akcjami takimi jak:

- `react` / `reactions` (dodawanie lub listowanie reakcji)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Ładunki narzędzi odczytu/wyszukiwania/przypinania zawierają znormalizowany `timestampMs` (UTC epoch ms) oraz `timestampUtc` obok surowego Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (aktywność bota i status online)

Id wiadomości Discord są udostępniane w wstrzykniętym kontekście (`[discord message id: …]` i linie historii), aby agent mógł je adresować.
Emoji mogą być unicode (np. `✅`) lub niestandardową składnią emoji, jak `<:party_blob:1234567890>`.

## Bezpieczeństwo i operacje

- Traktuj token bota jak hasło; preferuj zmienną środowiskową `DISCORD_BOT_TOKEN` na hostach nadzorowanych lub zablokuj uprawnienia pliku konfiguracyjnego.
- Przyznawaj botowi tylko potrzebne uprawnienia (zwykle Read/Send Messages).
- Jeśli bot utknął lub jest limitowany, zrestartuj gateway (`openclaw gateway --force`) po potwierdzeniu, że żadne inne procesy nie posiadają sesji Discord.
