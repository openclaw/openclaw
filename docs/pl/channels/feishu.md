---
summary: "Przegląd bota Feishu, funkcje i konfiguracja"
read_when:
  - Chcesz podłączyć bota Feishu/Lark
  - Konfigurujesz kanał Feishu
title: Feishu
---

# Bot Feishu

Feishu (Lark) to zespołowa platforma czatu używana przez firmy do komunikacji i współpracy. Ta wtyczka łączy OpenClaw z botem Feishu/Lark, wykorzystując subskrypcję zdarzeń WebSocket platformy, dzięki czemu wiadomości mogą być odbierane bez wystawiania publicznego adresu URL webhooka.

---

## Wymagana wtyczka

Zainstaluj wtyczkę Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Lokalne repozytorium (gdy uruchamiasz z repozytorium git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Szybki start

Istnieją dwa sposoby dodania kanału Feishu:

### Metoda 1: kreator onboardingu (zalecane)

Jeśli właśnie zainstalowałeś OpenClaw, uruchom kreator:

```bash
openclaw onboard
```

Kreator przewodniczy Ci przez:

1. Utworzenie aplikacji Feishu i zebranie poświadczeń
2. Skonfigurowanie poświadczeń aplikacji w OpenClaw
3. Uruchomienie gateway

✅ **Po konfiguracji** sprawdź status gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Metoda 2: konfiguracja przez CLI

Jeśli masz już ukończoną instalację początkową, dodaj kanał przez CLI:

```bash
openclaw channels add
```

Wybierz **Feishu**, a następnie wprowadź App ID i App Secret.

✅ **Po konfiguracji** zarządzaj gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Krok 1: Utwórz aplikację Feishu

### 1. Otwórz Feishu Open Platform

Odwiedź [Feishu Open Platform](https://open.feishu.cn/app) i zaloguj się.

Tenanci Lark (globalni) powinni użyć [https://open.larksuite.com/app](https://open.larksuite.com/app) i ustawić `domain: "lark"` w konfiguracji Feishu.

### 2. Utwórz aplikację

1. Kliknij **Create enterprise app**
2. Uzupełnij nazwę aplikacji i opis
3. Wybierz ikonę aplikacji

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Skopiuj poświadczenia

W sekcji **Credentials & Basic Info** skopiuj:

- **App ID** (format: `cli_xxx`)
- **App Secret**

❗ **Ważne:** zachowaj App Secret w tajemnicy.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Skonfiguruj uprawnienia

W **Permissions** kliknij **Batch import** i wklej:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Włącz możliwości bota

W **App Capability** > **Bot**:

1. Włącz obsługę bota
2. Ustaw nazwę bota

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Skonfiguruj subskrypcję zdarzeń

⚠️ **Ważne:** przed skonfigurowaniem subskrypcji zdarzeń upewnij się, że:

1. Wykonałeś już `openclaw channels add` dla Feishu
2. Gateway jest uruchomiony (`openclaw gateway status`)

W **Event Subscription**:

1. Wybierz **Use long connection to receive events** (WebSocket)
2. Dodaj zdarzenie: `im.message.receive_v1`

⚠️ Jeśli gateway nie jest uruchomiony, konfiguracja długiego połączenia może nie zapisać się poprawnie.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Opublikuj aplikację

1. Utwórz wersję w **Version Management & Release**
2. Wyślij do przeglądu i opublikuj
3. Poczekaj na zatwierdzenie przez administratora (aplikacje enterprise zwykle są zatwierdzane automatycznie)

---

## Krok 2: Skonfiguruj OpenClaw

### Konfiguracja za pomocą kreatora (zalecane)

```bash
openclaw channels add
```

Wybierz **Feishu** i wklej App ID oraz App Secret.

### Konfiguracja przez plik konfiguracyjny

Edytuj `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Konfiguracja przez zmienne środowiskowe

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Domena Lark (globalna)

Jeśli Twój tenant korzysta z Lark (międzynarodowego), ustaw domenę na `lark` (lub pełny ciąg domeny). Możesz ustawić ją w `channels.feishu.domain` lub per konto (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Krok 3: Uruchomienie i test

### 1. Uruchom gateway

```bash
openclaw gateway
```

### 2. Wyślij wiadomość testową

W Feishu znajdź swojego bota i wyślij wiadomość.

### 3. Zatwierdź parowanie

Domyślnie bot odpowiada kodem parowania. Zatwierdź go:

```bash
openclaw pairing approve feishu <CODE>
```

Po zatwierdzeniu możesz normalnie prowadzić rozmowę.

---

## Przegląd

- **Kanał bota Feishu**: bot Feishu zarządzany przez gateway
- **Deterministyczne routowanie**: odpowiedzi zawsze wracają do Feishu
- **Izolacja sesji**: DM-y współdzielą główną sesję; grupy są izolowane
- **Połączenie WebSocket**: długie połączenie przez SDK Feishu, bez potrzeby publicznego URL-a

---

## Kontrola dostępu

### Wiadomości bezpośrednie

- **Domyślnie**: `dmPolicy: "pairing"` (nieznani użytkownicy otrzymują kod parowania)

- **Zatwierdzanie parowania**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Tryb listy dozwolonych**: ustaw `channels.feishu.allowFrom` z dozwolonymi Open ID

### Czaty grupowe

**1. Polityka grup** (`channels.feishu.groupPolicy`):

- `"open"` = zezwól wszystkim w grupach (domyślnie)
- `"allowlist"` = zezwól tylko `groupAllowFrom`
- `"disabled"` = wyłącz wiadomości grupowe

**2. Wymóg wzmianki** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = wymagaj @wzmianki (domyślnie)
- `false` = odpowiadaj bez wzmianek

---

## Przykłady konfiguracji grup

### Zezwól na wszystkie grupy, wymagaj @wzmianki (domyślnie)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Zezwól na wszystkie grupy, bez wymogu @wzmianki

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Zezwól tylko określonym użytkownikom w grupach

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Uzyskiwanie identyfikatorów grup/użytkowników

### ID grup (chat_id)

Identyfikatory grup wyglądają jak `oc_xxx`.

**Metoda 1 (zalecana)**

1. Uruchom gateway i @wzmiankuj bota w grupie
2. Uruchom `openclaw logs --follow` i znajdź `chat_id`

**Metoda 2**

Użyj debuggera API Feishu do wylistowania czatów grupowych.

### ID użytkowników (open_id)

Identyfikatory użytkowników wyglądają jak `ou_xxx`.

**Metoda 1 (zalecana)**

1. Uruchom gateway i wyślij botowi DM
2. Uruchom `openclaw logs --follow` i znajdź `open_id`

**Metoda 2**

Sprawdź żądania parowania pod kątem Open ID użytkowników:

```bash
openclaw pairing list feishu
```

---

## Typowe polecenia

| Polecenie | Opis                 |
| --------- | -------------------- |
| `/status` | Pokaż status bota    |
| `/reset`  | Zresetuj sesję       |
| `/model`  | Pokaż/przełącz model |

> Uwaga: Feishu nie obsługuje jeszcze natywnych menu poleceń, dlatego polecenia muszą być wysyłane jako tekst.

## Polecenia zarządzania gateway

| Polecenie                  | Opis                              |
| -------------------------- | --------------------------------- |
| `openclaw gateway status`  | Pokaż status gateway              |
| `openclaw gateway install` | Zainstaluj/uruchom usługę gateway |
| `openclaw gateway stop`    | Zatrzymaj usługę gateway          |
| `openclaw gateway restart` | Zrestartuj usługę gateway         |
| `openclaw logs --follow`   | Śledź logi gateway                |

---

## Rozwiązywanie problemów

### Bot nie odpowiada w czatach grupowych

1. Upewnij się, że bot został dodany do grupy
2. Upewnij się, że @wzmiankujesz bota (zachowanie domyślne)
3. Sprawdź, czy `groupPolicy` nie jest ustawione na `"disabled"`
4. Sprawdź logi: `openclaw logs --follow`

### Bot nie odbiera wiadomości

1. Upewnij się, że aplikacja jest opublikowana i zatwierdzona
2. Upewnij się, że subskrypcja zdarzeń obejmuje `im.message.receive_v1`
3. Upewnij się, że włączone jest **długie połączenie**
4. Upewnij się, że uprawnienia aplikacji są kompletne
5. Upewnij się, że gateway jest uruchomiony: `openclaw gateway status`
6. Sprawdź logi: `openclaw logs --follow`

### Wyciek App Secret

1. Zresetuj App Secret w Feishu Open Platform
2. Zaktualizuj App Secret w konfiguracji
3. Zrestartuj gateway

### Błędy wysyłania wiadomości

1. Upewnij się, że aplikacja ma uprawnienie `im:message:send_as_bot`
2. Upewnij się, że aplikacja jest opublikowana
3. Sprawdź logi w poszukiwaniu szczegółowych błędów

---

## Konfiguracja zaawansowana

### Wiele kont

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Limity wiadomości

- `textChunkLimit`: rozmiar fragmentu tekstu wychodzącego (domyślnie: 2000 znaków)
- `mediaMaxMb`: limit wysyłania/pobierania mediów (domyślnie: 30 MB)

### Strumieniowanie

Feishu obsługuje strumieniowe odpowiedzi za pomocą kart interaktywnych. Po włączeniu bot aktualizuje kartę w miarę generowania tekstu.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Ustaw `streaming: false`, aby czekać na pełną odpowiedź przed wysłaniem.

### Routowanie wieloagentowe

Użyj `bindings` do kierowania DM-ów lub grup Feishu do różnych agentów.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Pola routowania:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` lub `"group"`
- `match.peer.id`: Open ID użytkownika (`ou_xxx`) lub ID grupy (`oc_xxx`)

Zobacz [Uzyskiwanie identyfikatorów grup/użytkowników](#get-groupuser-ids), aby uzyskać wskazówki.

---

## Referencja konfiguracji

Pełna konfiguracja: [Konfiguracja Gateway](/gateway/configuration)

Kluczowe opcje:

| Ustawienie                                        | Opis                                                                         | Domyślne  |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | Włącz/wyłącz kanał                                                           | `true`    |
| `channels.feishu.domain`                          | Domena API (`feishu` lub `lark`)                          | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                                       | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                                   | -         |
| `channels.feishu.accounts.<id>.domain`            | Nadpisanie domeny API per konto                                              | `feishu`  |
| `channels.feishu.dmPolicy`                        | Polityka DM                                                                  | `pairing` |
| `channels.feishu.allowFrom`                       | Lista dozwolonych DM (lista open_id) | -         |
| `channels.feishu.groupPolicy`                     | Polityka grup                                                                | `open`    |
| `channels.feishu.groupAllowFrom`                  | Lista dozwolonych grup                                                       | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Wymagaj @wzmianki                                               | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Włącz grupy                                                                  | `true`    |
| `channels.feishu.textChunkLimit`                  | Rozmiar fragmentu wiadomości                                                 | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Limit rozmiaru mediów                                                        | `30`      |
| `channels.feishu.streaming`                       | Włącz strumieniowe wyjście kart                                              | `true`    |
| `channels.feishu.blockStreaming`                  | Włącz strumieniowanie blokowe                                                | `true`    |

---

## Referencja dmPolicy

| Wartość       | Zachowanie                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `"pairing"`   | **Domyślne.** Nieznani użytkownicy otrzymują kod parowania; muszą zostać zatwierdzeni |
| `"allowlist"` | Tylko użytkownicy z `allowFrom` mogą prowadzić rozmowę                                                |
| `"open"`      | Zezwól wszystkim użytkownikom (wymaga `"*"` w allowFrom)                           |
| `"disabled"`  | Wyłącz DM-y                                                                                           |

---

## Obsługiwane typy wiadomości

### Odbiór

- ✅ Tekst
- ✅ Tekst sformatowany (post)
- ✅ Obrazy
- ✅ Pliki
- ✅ Audio
- ✅ Wideo
- ✅ Naklejki

### Wysyłanie

- ✅ Tekst
- ✅ Obrazy
- ✅ Pliki
- ✅ Audio
- ⚠️ Tekst sformatowany (częściowe wsparcie)
