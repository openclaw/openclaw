---
summary: "Status obsługi bota Microsoft Teams, możliwości i konfiguracja"
read_when:
  - Praca nad funkcjami kanału MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (wtyczka)

> „Porzućcie wszelką nadzieję, wy, którzy tu wchodzicie”.

Aktualizacja: 2026-01-21

Status: obsługiwane są wiadomości tekstowe oraz załączniki w DM-ach; wysyłanie plików w kanałach/grupach wymaga `sharePointSiteId` oraz uprawnień Graph (zob. [Wysyłanie plików w czatach grupowych](#sending-files-in-group-chats)). Ankiety są wysyłane za pomocą kart Adaptive Cards.

## Wymagana wtyczka

Microsoft Teams jest dostarczany jako wtyczka i nie jest dołączony do instalacji rdzenia.

**Zmiana niekompatybilna (2026.1.15):** MS Teams został wyłączony z rdzenia. Jeśli z niego korzystasz, musisz zainstalować wtyczkę.

Uzasadnienie: pozwala to utrzymać lżejsze instalacje rdzenia i umożliwia niezależne aktualizacje zależności MS Teams.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/msteams
```

Lokalne źródła (gdy uruchamiasz z repozytorium git):

```bash
openclaw plugins install ./extensions/msteams
```

Jeśli podczas konfiguracji/onboardingu wybierzesz Teams i wykryte zostanie repozytorium git,
OpenClaw automatycznie zaproponuje ścieżkę instalacji lokalnej.

Szczegóły: [Plugins](/tools/plugin)

## Szybka konfiguracja (dla początkujących)

1. Zainstaluj wtyczkę Microsoft Teams.
2. Utwórz **Azure Bot** (App ID + client secret + tenant ID).
3. Skonfiguruj OpenClaw, używając tych poświadczeń.
4. Wystaw `/api/messages` (domyślnie port 3978) przez publiczny URL lub tunel.
5. Zainstaluj pakiet aplikacji Teams i uruchom gateway.

Minimalna konfiguracja:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Uwaga: czaty grupowe są domyślnie zablokowane (`channels.msteams.groupPolicy: "allowlist"`). Aby zezwolić na odpowiedzi w grupach, ustaw `channels.msteams.groupAllowFrom` (lub użyj `groupPolicy: "open"`, aby zezwolić każdemu członkowi, z wymogiem wzmianki).

## Cele

- Komunikacja z OpenClaw przez DM-y Teams, czaty grupowe lub kanały.
- Deterministyczne routowanie: odpowiedzi zawsze wracają do kanału, z którego przyszły.
- Domyślnie bezpieczne zachowanie kanałów (wymagane wzmianki, chyba że skonfigurowano inaczej).

## Zapisy konfiguracji

Domyślnie Microsoft Teams ma prawo zapisywać aktualizacje konfiguracji wyzwalane przez `/config set|unset` (wymaga `commands.config: true`).

Wyłącz:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Kontrola dostępu (DM-y + grupy)

**Dostęp do DM-ów**

- Domyślnie: `channels.msteams.dmPolicy = "pairing"`. Nieznani nadawcy są ignorowani do czasu zatwierdzenia.
- `channels.msteams.allowFrom` akceptuje identyfikatory obiektów AAD, UPN-y lub nazwy wyświetlane. Kreator rozwiązuje nazwy do identyfikatorów przez Microsoft Graph, gdy pozwalają na to poświadczenia.

**Dostęp do grup**

- Domyślnie: `channels.msteams.groupPolicy = "allowlist"` (zablokowane, chyba że dodasz `groupAllowFrom`). Użyj `channels.defaults.groupPolicy`, aby nadpisać domyślne zachowanie, gdy nie jest ustawione.
- `channels.msteams.groupAllowFrom` kontroluje, którzy nadawcy mogą wyzwalać w czatach grupowych/kanałach (w razie braku używa `channels.msteams.allowFrom`).
- Ustaw `groupPolicy: "open"`, aby zezwolić każdemu członkowi (domyślnie nadal wymagane są wzmianki).
- Aby **zablokować wszystkie kanały**, ustaw `channels.msteams.groupPolicy: "disabled"`.

Przykład:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Allowlista zespołów + kanałów**

- Ogranicz odpowiedzi w grupach/kanałach, listując zespoły i kanały pod `channels.msteams.teams`.
- Kluczami mogą być identyfikatory zespołów lub nazwy; kluczami kanałów mogą być identyfikatory konwersacji lub nazwy.
- Gdy ustawione jest `groupPolicy="allowlist"` i istnieje allowlista zespołów, akceptowane są wyłącznie wymienione zespoły/kanały (z wymogiem wzmianki).
- Kreator konfiguracji akceptuje wpisy `Team/Channel` i zapisuje je za Ciebie.
- Przy starcie OpenClaw rozwiązuje nazwy zespołów/kanałów i użytkowników z allowlist do identyfikatorów (gdy pozwalają na to uprawnienia Graph)
  i loguje mapowanie; nierozwiązane wpisy są zachowywane w postaci wprowadzonej.

Przykład:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Jak to działa

1. Zainstaluj wtyczkę Microsoft Teams.
2. Utwórz **Azure Bot** (App ID + secret + tenant ID).
3. Zbuduj **pakiet aplikacji Teams**, który odwołuje się do bota i zawiera poniższe uprawnienia RSC.
4. Prześlij/zainstaluj aplikację Teams w zespole (lub w zakresie osobistym dla DM-ów).
5. Skonfiguruj `msteams` w `~/.openclaw/openclaw.json` (lub zmiennych środowiskowych) i uruchom gateway.
6. Gateway nasłuchuje ruchu webhook Bot Framework domyślnie na `/api/messages`.

## Konfiguracja Azure Bot (Wymagania wstępne)

Przed konfiguracją OpenClaw musisz utworzyć zasób Azure Bot.

### Krok 1: Utwórz Azure Bot

1. Przejdź do [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Wypełnij zakładkę **Basics**:

   | Pole               | Wartość                                                                                   |
   | ------------------ | ----------------------------------------------------------------------------------------- |
   | **Bot handle**     | Nazwa bota, np. `openclaw-msteams` (musi być unikalna) |
   | **Subscription**   | Wybierz subskrypcję Azure                                                                 |
   | **Resource group** | Utwórz nową lub użyj istniejącej                                                          |
   | **Pricing tier**   | **Free** dla dev/testów                                                                   |
   | **Type of App**    | **Single Tenant** (zalecane – zob. uwaga poniżej)      |
   | **Creation type**  | **Create new Microsoft App ID**                                                           |

> **Uwaga o wycofaniu:** Tworzenie nowych botów wielodostępnych (multi-tenant) zostało wycofane po 2025-07-31. Dla nowych botów używaj **Single Tenant**.

3. Kliknij **Review + create** → **Create** (poczekaj ~1–2 minuty)

### Krok 2: Pobierz poświadczenia

1. Przejdź do zasobu Azure Bot → **Configuration**
2. Skopiuj **Microsoft App ID** → to jest Twój `appId`
3. Kliknij **Manage Password** → przejdź do rejestracji aplikacji
4. W **Certificates & secrets** → **New client secret** → skopiuj **Value** → to jest Twój `appPassword`
5. Przejdź do **Overview** → skopiuj **Directory (tenant) ID** → to jest Twój `tenantId`

### Krok 3: Skonfiguruj punkt końcowy komunikacji

1. W Azure Bot → **Configuration**
2. Ustaw **Messaging endpoint** na URL webhooka:
   - Produkcja: `https://your-domain.com/api/messages`
   - Lokalny dev: użyj tunelu (zob. [Rozwój lokalny (tunelowanie)](#local-development-tunneling) poniżej)

### Krok 4: Włącz kanał Teams

1. W Azure Bot → **Channels**
2. Kliknij **Microsoft Teams** → Configure → Save
3. Zaakceptuj Warunki korzystania z usługi

## Rozwój lokalny (tunelowanie)

Teams nie może połączyć się z `localhost`. Do rozwoju lokalnego użyj tunelu:

**Opcja A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Opcja B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (alternatywa)

Zamiast ręcznie tworzyć ZIP manifestu, możesz użyć [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Kliknij **+ New app**
2. Uzupełnij podstawowe informacje (nazwa, opis, informacje o deweloperze)
3. Przejdź do **App features** → **Bot**
4. Wybierz **Enter a bot ID manually** i wklej App ID Azure Bot
5. Zaznacz zakresy: **Personal**, **Team**, **Group Chat**
6. Kliknij **Distribute** → **Download app package**
7. W Teams: **Apps** → **Manage your apps** → **Upload a custom app** → wybierz ZIP

Często jest to łatwiejsze niż ręczna edycja manifestów JSON.

## Testowanie bota

**Opcja A: Azure Web Chat (najpierw zweryfikuj webhook)**

1. W Azure Portal → zasób Azure Bot → **Test in Web Chat**
2. Wyślij wiadomość – powinna pojawić się odpowiedź
3. To potwierdza, że punkt końcowy webhooka działa przed konfiguracją Teams

**Opcja B: Teams (po instalacji aplikacji)**

1. Zainstaluj aplikację Teams (sideload lub katalog organizacji)
2. Znajdź bota w Teams i wyślij DM
3. Sprawdź logi gateway pod kątem przychodzącej aktywności

## Konfiguracja (minimalna, tylko tekst)

1. **Zainstaluj wtyczkę Microsoft Teams**
   - Z npm: `openclaw plugins install @openclaw/msteams`
   - Z lokalnych źródeł: `openclaw plugins install ./extensions/msteams`

2. **Rejestracja bota**
   - Utwórz Azure Bot (patrz wyżej) i zanotuj:
     - App ID
     - Client secret (hasło aplikacji)
     - Tenant ID (single-tenant)

3. **Manifest aplikacji Teams**
   - Dodaj wpis `bot` z `botId = <App ID>`.
   - Zakresy: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (wymagane do obsługi plików w zakresie osobistym).
   - Dodaj uprawnienia RSC (poniżej).
   - Utwórz ikony: `outline.png` (32x32) i `color.png` (192x192).
   - Spakuj wszystkie trzy pliki do ZIP: `manifest.json`, `outline.png`, `color.png`.

4. **Skonfiguruj OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Możesz też użyć zmiennych środowiskowych zamiast kluczy konfiguracji:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Punkt końcowy bota**
   - Ustaw Messaging Endpoint Azure Bot na:
     - `https://<host>:3978/api/messages` (lub wybraną ścieżkę/port).

6. **Uruchom gateway**
   - Kanał Teams uruchamia się automatycznie, gdy wtyczka jest zainstalowana i istnieje konfiguracja `msteams` z poświadczeniami.

## Kontekst historii

- `channels.msteams.historyLimit` kontroluje, ile ostatnich wiadomości kanału/grupy jest dołączanych do promptu.
- W razie braku używa `messages.groupChat.historyLimit`. Ustaw `0`, aby wyłączyć (domyślnie 50).
- Historię DM-ów można ograniczyć przez `channels.msteams.dmHistoryLimit` (liczba tur użytkownika). Nadpisania per użytkownik: `channels.msteams.dms["<user_id>"].historyLimit`.

## Aktualne uprawnienia RSC Teams (manifest)

Są to **istniejące uprawnienia resourceSpecific** w manifeście aplikacji Teams. Obowiązują wyłącznie w zespole/czacie, w którym aplikacja jest zainstalowana.

**Dla kanałów (zakres zespołu):**

- `ChannelMessage.Read.Group` (Application) – odbiór wszystkich wiadomości kanału bez @wzmianki
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Dla czatów grupowych:**

- `ChatMessage.Read.Chat` (Application) – odbiór wszystkich wiadomości czatu grupowego bez @wzmianki

## Przykładowy manifest Teams (zredagowany)

Minimalny, poprawny przykład z wymaganymi polami. Zastąp identyfikatory i URL-e.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Zastrzeżenia dotyczące manifestu (wymagane pola)

- `bots[].botId` **musi** odpowiadać App ID Azure Bot.
- `webApplicationInfo.id` **musi** odpowiadać App ID Azure Bot.
- `bots[].scopes` musi zawierać powierzchnie, z których planujesz korzystać (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` jest wymagane do obsługi plików w zakresie osobistym.
- `authorization.permissions.resourceSpecific` musi zawierać odczyt/wysyłanie kanałów, jeśli chcesz ruch kanałowy.

### Aktualizacja istniejącej aplikacji

Aby zaktualizować już zainstalowaną aplikację Teams (np. dodać uprawnienia RSC):

1. Zaktualizuj swój `manifest.json` o nowe ustawienia
2. **Zwiększ pole `version`** (np. `1.0.0` → `1.1.0`)
3. **Ponownie spakuj** manifest z ikonami (`manifest.json`, `outline.png`, `color.png`)
4. Prześlij nowy ZIP:
   - **Opcja A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → znajdź aplikację → Upload new version
   - **Opcja B (Sideload):** W Teams → Apps → Manage your apps → Upload a custom app
5. **Dla kanałów zespołu:** Zainstaluj ponownie aplikację w każdym zespole, aby nowe uprawnienia zaczęły obowiązywać
6. **Całkowicie zamknij i uruchom ponownie Teams** (nie tylko zamknij okno), aby wyczyścić pamięć podręczną metadanych aplikacji

## Możliwości: tylko RSC vs Graph

### Z **samym Teams RSC** (aplikacja zainstalowana, bez uprawnień Graph API)

Działa:

- Odczyt treści **tekstowej** wiadomości kanału.
- Wysyłanie **tekstowych** wiadomości kanału.
- Odbiór załączników plików w **czatach osobistych (DM)**.

Nie działa:

- **Obrazy lub zawartość plików** w kanałach/grupach (payload zawiera tylko atrapę HTML).
- Pobieranie załączników przechowywanych w SharePoint/OneDrive.
- Odczyt historii wiadomości (poza zdarzeniem webhook na żywo).

### Z **Teams RSC + uprawnieniami aplikacyjnymi Microsoft Graph**

Dodaje:

- Pobieranie treści hostowanych (obrazy wklejone do wiadomości).
- Pobieranie załączników plików z SharePoint/OneDrive.
- Odczyt historii wiadomości kanałów/czatów przez Graph.

### RSC vs Graph API

| Możliwość                            | Uprawnienia RSC                        | Graph API                                            |
| ------------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| **Wiadomości w czasie rzeczywistym** | Tak (przez webhook) | Nie (tylko odpytywanie)           |
| **Wiadomości historyczne**           | Nie                                    | Tak (można zapytać o historię)    |
| **Złożoność konfiguracji**           | Tylko manifest aplikacji               | Wymaga zgody administratora + przepływu tokenów      |
| **Działanie offline**                | Nie (musi działać)  | Tak (zapytania w dowolnym czasie) |

**Sedno:** RSC służy do nasłuchiwania w czasie rzeczywistym; Graph API do dostępu historycznego. Aby nadrobić pominięte wiadomości podczas offline, potrzebujesz Graph API z `ChannelMessage.Read.All` (wymaga zgody administratora).

## Media + historia z Graph (wymagane dla kanałów)

Jeśli potrzebujesz obrazów/plików w **kanałach** lub chcesz pobierać **historię wiadomości**, musisz włączyć uprawnienia Microsoft Graph i udzielić zgody administratora.

1. W Entra ID (Azure AD) **App Registration** dodaj **Application permissions** Microsoft Graph:
   - `ChannelMessage.Read.All` (załączniki kanałów + historia)
   - `Chat.Read.All` lub `ChatMessage.Read.All` (czaty grupowe)
2. **Udziel zgody administratora** dla dzierżawy.
3. Zwiększ **wersję manifestu** aplikacji Teams, prześlij ponownie i **zainstaluj aplikację ponownie w Teams**.
4. **Całkowicie zamknij i uruchom ponownie Teams**, aby wyczyścić pamięć podręczną metadanych aplikacji.

## Znane ograniczenia

### Limity czasu webhooka

Teams dostarcza wiadomości przez webhook HTTP. Jeśli przetwarzanie trwa zbyt długo (np. wolne odpowiedzi LLM), możesz zobaczyć:

- Przekroczenia czasu gateway
- Ponowne próby Teams (powodujące duplikaty)
- Utracone odpowiedzi

OpenClaw radzi sobie z tym, szybko zwracając odpowiedź i wysyłając odpowiedzi proaktywnie, ale bardzo wolne odpowiedzi nadal mogą powodować problemy.

### Formatowanie

Markdown Teams jest bardziej ograniczony niż w Slacku czy Discordzie:

- Podstawowe formatowanie działa: **pogrubienie**, _kursywa_, `code`, linki
- Złożony markdown (tabele, listy zagnieżdżone) może renderować się niepoprawnie
- Karty Adaptive Cards są obsługiwane dla ankiet i dowolnych kart (zob. poniżej)

## Konfiguracja

Kluczowe ustawienia (zob. `/gateway/configuration` dla wspólnych wzorców kanałów):

- `channels.msteams.enabled`: włącz/wyłącz kanał.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: poświadczenia bota.
- `channels.msteams.webhook.port` (domyślnie `3978`)
- `channels.msteams.webhook.path` (domyślnie `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (domyślnie: parowanie)
- `channels.msteams.allowFrom`: allowlista DM-ów (identyfikatory obiektów AAD, UPN-y lub nazwy wyświetlane). Kreator rozwiązuje nazwy do identyfikatorów podczas konfiguracji, gdy dostępny jest Graph.
- `channels.msteams.textChunkLimit`: rozmiar fragmentu tekstu wyjściowego.
- `channels.msteams.chunkMode`: `length` (domyślnie) lub `newline` do dzielenia po pustych liniach (granice akapitów) przed dzieleniem według długości.
- `channels.msteams.mediaAllowHosts`: allowlista hostów dla przychodzących załączników (domyślnie domeny Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: allowlista hostów do dołączania nagłówków Authorization przy ponownych próbach pobierania mediów (domyślnie Graph + Bot Framework).
- `channels.msteams.requireMention`: wymagaj @wzmianki w kanałach/grupach (domyślnie true).
- `channels.msteams.replyStyle`: `thread | top-level` (zob. [Styl odpowiedzi](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: nadpisanie per zespół.
- `channels.msteams.teams.<teamId>.requireMention`: nadpisanie per zespół.
- `channels.msteams.teams.<teamId>.tools`: domyślne nadpisania polityk narzędzi per zespół (`allow`/`deny`/`alsoAllow`), używane, gdy brakuje nadpisania kanału.
- `channels.msteams.teams.<teamId>.toolsBySender`: domyślne nadpisania polityk narzędzi per zespół i nadawcę (obsługiwany wildcard `"*"`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: nadpisanie per kanał.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: nadpisanie per kanał.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: nadpisania polityk narzędzi per kanał (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: nadpisania polityk narzędzi per kanał i nadawcę (obsługiwany wildcard `"*"`).
- `channels.msteams.sharePointSiteId`: identyfikator witryny SharePoint do wysyłania plików w czatach grupowych/kanałach (zob. [Wysyłanie plików w czatach grupowych](#sending-files-in-group-chats)).

## Routowanie i sesje

- Klucze sesji są zgodne ze standardowym formatem agenta (zob. [/concepts/session](/concepts/session)):
  - Wiadomości bezpośrednie współdzielą główną sesję (`agent:<agentId>:<mainKey>`).
  - Wiadomości kanału/grupy używają identyfikatora konwersacji:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Styl odpowiedzi: wątki vs posty

Teams niedawno wprowadził dwa style UI kanałów oparte na tym samym modelu danych:

| Styl                                       | Opis                                                     | Zalecane `replyStyle`                  |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------- |
| **Posts** (klasyczny)   | Wiadomości jako karty z odpowiedziami w wątku pod spodem | `thread` (domyślne) |
| **Threads** (jak Slack) | Wiadomości płyną liniowo, podobnie do Slacka             | `top-level`                            |

**Problem:** API Teams nie ujawnia, którego stylu UI używa kanał. Jeśli użyjesz niewłaściwego `replyStyle`:

- `thread` w kanale typu Threads → odpowiedzi zagnieżdżają się niezręcznie
- `top-level` w kanale typu Posts → odpowiedzi pojawiają się jako osobne posty najwyższego poziomu zamiast w wątku

**Rozwiązanie:** Skonfiguruj `replyStyle` per kanał w zależności od konfiguracji kanału:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Załączniki i obrazy

**Aktualne ograniczenia:**

- **DM-y:** Obrazy i załączniki plików działają przez API plików bota Teams.
- **Kanały/grupy:** Załączniki znajdują się w magazynie M365 (SharePoint/OneDrive). Payload webhooka zawiera tylko atrapę HTML, a nie rzeczywiste bajty pliku. **Do pobrania załączników kanałów wymagane są uprawnienia Graph API**.

Bez uprawnień Graph wiadomości kanałów z obrazami będą odbierane jako tylko tekst (zawartość obrazu nie jest dostępna dla bota).
Domyślnie OpenClaw pobiera media tylko z nazw hostów Microsoft/Teams. Nadpisz przez `channels.msteams.mediaAllowHosts` (użyj `["*"]`, aby zezwolić na dowolny host).
Nagłówki Authorization są dołączane tylko dla hostów z `channels.msteams.mediaAuthAllowHosts` (domyślnie Graph + Bot Framework). Utrzymuj tę listę restrykcyjną (unikaj sufiksów wielodostępnych).

## Wysyłanie plików w czatach grupowych

Boty mogą wysyłać pliki w DM-ach, korzystając z przepływu FileConsentCard (wbudowany). Jednak **wysyłanie plików w czatach grupowych/kanałach** wymaga dodatkowej konfiguracji:

| Kontekst                                         | Sposób wysyłania plików                               | Wymagana konfiguracja                       |
| ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------- |
| **DM-y**                                         | FileConsentCard → użytkownik akceptuje → bot przesyła | Dzieła poza ramką                           |
| **Czaty grupowe/kanały**                         | Przesłanie do SharePoint → link udostępniania         | Wymaga `sharePointSiteId` + uprawnień Graph |
| **Obrazy (dowolny kontekst)** | Inline zakodowane w Base64                            | Dzieła poza ramką                           |

### Dlaczego czaty grupowe wymagają SharePoint

Boty nie mają osobistego dysku OneDrive (punkt końcowy Graph API `/me/drive` nie działa dla tożsamości aplikacyjnych). Aby wysyłać pliki w czatach grupowych/kanałach, bot przesyła je do **witryny SharePoint** i tworzy link udostępniania.

### Konfiguracja

1. **Dodaj uprawnienia Graph API** w Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) – przesyłanie plików do SharePoint
   - `Chat.Read.All` (Application) – opcjonalne, umożliwia linki udostępniania per użytkownik

2. **Udziel zgody administratora** dla dzierżawy.

3. **Pobierz identyfikator witryny SharePoint:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Skonfiguruj OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Zachowanie udostępniania

| Uprawnienie                             | Zachowanie udostępniania                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tylko `Sites.ReadWrite.All`             | Link udostępniania dla całej organizacji (dostęp dla wszystkich w org) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Link udostępniania per użytkownik (dostęp tylko dla uczestników czatu) |

Udostępnianie per użytkownik jest bezpieczniejsze, ponieważ tylko uczestnicy czatu mają dostęp do pliku. Jeśli brakuje uprawnienia `Chat.Read.All`, bot przechodzi na udostępnianie dla całej organizacji.

### Zachowanie Fallback

| Scenariusz                                              | Wynik                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Czat grupowy + plik + skonfigurowane `sharePointSiteId` | Przesłanie do SharePoint, wysłanie linku                                                   |
| Czat grupowy + plik + brak `sharePointSiteId`           | Próba przesłania do OneDrive (może się nie udać), wysłanie tylko tekstu |
| Czat osobisty + plik                                    | Przepływ FileConsentCard (działa bez SharePoint)                        |
| Dowolny kontekst + obraz                                | Inline zakodowane w Base64 (działa bez SharePoint)                      |

### Lokalizacja przechowywania plików

Przesłane pliki są przechowywane w folderze `/OpenClawShared/` w domyślnej bibliotece dokumentów skonfigurowanej witryny SharePoint.

## Ankiety (Adaptive Cards)

OpenClaw wysyła ankiety Teams jako karty Adaptive Cards (brak natywnego API ankiet Teams).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Głosy są zapisywane przez gateway w `~/.openclaw/msteams-polls.json`.
- Gateway musi pozostać online, aby rejestrować głosy.
- Ankiety nie publikują jeszcze automatycznych podsumowań wyników (w razie potrzeby sprawdź plik magazynu).

## Adaptive Cards (dowolne)

Wysyłaj dowolny JSON kart Adaptive Cards do użytkowników Teams lub konwersacji, używając narzędzia `message` lub CLI.

Parametr `card` akceptuje obiekt JSON karty Adaptive Card. Gdy podano `card`, tekst wiadomości jest opcjonalny.

**Narzędzie agenta:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Zobacz [dokumentację Adaptive Cards](https://adaptivecards.io/) w celu poznania schematu i przykładów. Szczegóły formatu docelowego: [Formaty docelowe](#target-formats) poniżej.

## Formaty docelowe

Cele MSTeams używają prefiksów do rozróżniania użytkowników i konwersacji:

| Typ celu                              | Format                           | Przykład                                                                 |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Użytkownik (ID)    | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                              |
| Użytkownik (nazwa) | `user:<display-name>`            | `user:John Smith` (wymaga Graph API)                  |
| Grupa/kanał                           | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                 |
| Grupa/kanał (raw)  | `<conversation-id>`              | `19:abc123...@thread.tacv2` (jeśli zawiera `@thread`) |

**Przykłady CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Przykłady narzędzia agenta:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Uwaga: bez prefiksu `user:` nazwy domyślnie są rozwiązywane jako grupy/zespoły. Zawsze używaj `user:`, gdy celujesz w osoby po nazwie wyświetlanej.

## Wiadomości proaktywne

- Wiadomości proaktywne są możliwe **dopiero po** interakcji użytkownika, ponieważ wtedy zapisujemy referencje konwersacji.
- Zobacz `/gateway/configuration` dla `dmPolicy` i kontroli przez allowlistę.

## Identyfikatory zespołów i kanałów (częsta pułapka)

Parametr zapytania `groupId` w URL-ach Teams **NIE** jest identyfikatorem zespołu używanym w konfiguracji. Wyodrębnij identyfikatory z ścieżki URL:

**URL zespołu:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL kanału:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Do konfiguracji:**

- ID zespołu = segment ścieżki po `/team/` (zdekodowany URL, np. `19:Bk4j...@thread.tacv2`)
- ID kanału = segment ścieżki po `/channel/` (zdekodowany URL)
- **Ignoruj** parametr zapytania `groupId`

## Kanały prywatne

Boty mają ograniczone wsparcie w kanałach prywatnych:

| Funkcja                                                       | Kanały standardowe | Kanały prywatne                          |
| ------------------------------------------------------------- | ------------------ | ---------------------------------------- |
| Instalacja bota                                               | Tak                | Ograniczona                              |
| Wiadomości w czasie rzeczywistym (webhook) | Tak                | Może nie działać                         |
| Uprawnienia RSC                                               | Tak                | Mogą działać inaczej                     |
| @wzmianki                                        | Tak                | Jeśli bot jest dostępny                  |
| Historia Graph API                                            | Tak                | Tak (z uprawnieniami) |

**Obejścia, jeśli kanały prywatne nie działają:**

1. Używaj kanałów standardowych do interakcji z botem
2. Używaj DM-ów – użytkownicy zawsze mogą pisać do bota bezpośrednio
3. Używaj Graph API do dostępu historycznego (wymaga `ChannelMessage.Read.All`)

## Rozwiązywanie problemów

### Częste problemy

- **Obrazy nie wyświetlają się w kanałach:** Brak uprawnień Graph lub zgody administratora. Zainstaluj ponownie aplikację Teams i całkowicie zamknij/uruchom Teams.
- **Brak odpowiedzi w kanale:** Domyślnie wymagane są wzmianki; ustaw `channels.msteams.requireMention=false` lub skonfiguruj per zespół/kanał.
- **Niezgodność wersji (Teams nadal pokazuje stary manifest):** Usuń i dodaj aplikację ponownie oraz całkowicie zamknij Teams, aby odświeżyć.
- **401 Unauthorized z webhooka:** Oczekiwane przy ręcznym testowaniu bez JWT Azure – oznacza, że punkt końcowy jest osiągalny, ale uwierzytelnianie nie powiodło się. Do testów użyj Azure Web Chat.

### Błędy przesyłania manifestu

- **„Icon file cannot be empty”:** Manifest odwołuje się do plików ikon o rozmiarze 0 bajtów. Utwórz poprawne ikony PNG (32x32 dla `outline.png`, 192x192 dla `color.png`).
- **„webApplicationInfo.Id already in use”:** Aplikacja jest nadal zainstalowana w innym zespole/czacie. Znajdź ją i odinstaluj lub odczekaj 5–10 minut na propagację.
- **„Something went wrong” przy przesyłaniu:** Prześlij przez [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), otwórz narzędzia deweloperskie przeglądarki (F12) → zakładka Network i sprawdź treść odpowiedzi z właściwym błędem.
- **Problemy z sideloadem:** Spróbuj „Upload an app to your org's app catalog” zamiast „Upload a custom app” – często omija to ograniczenia sideloadu.

### Uprawnienia RSC nie działają

1. Sprawdź, czy `webApplicationInfo.id` dokładnie odpowiada App ID Twojego bota
2. Prześlij aplikację ponownie i zainstaluj ją ponownie w zespole/czacie
3. Sprawdź, czy administrator organizacji nie zablokował uprawnień RSC
4. Upewnij się, że używasz właściwego zakresu: `ChannelMessage.Read.Group` dla zespołów, `ChatMessage.Read.Chat` dla czatów grupowych

## Odniesienia

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) – przewodnik konfiguracji Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) – tworzenie/zarządzanie aplikacjami Teams
- [Schemat manifestu aplikacji Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Odbiór wiadomości kanałów z RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [Referencja uprawnień RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Obsługa plików botów Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kanały/grupy wymagają Graph)
- [Wiadomości proaktywne](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
