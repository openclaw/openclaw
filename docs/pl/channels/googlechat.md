---
summary: "Status wsparcia aplikacji Google Chat, możliwości i konfiguracja"
read_when:
  - Prace nad funkcjami kanału Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Status: gotowe dla DM-ów i przestrzeni (spaces) przez webhooki Google Chat API (tylko HTTP).

## Szybka konfiguracja (dla początkujących)

1. Utwórz projekt Google Cloud i włącz **Google Chat API**.
   - Przejdź do: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Włącz API, jeśli nie jest jeszcze włączone.
2. Utwórz **konto usługi (Service Account)**:
   - Kliknij **Create Credentials** > **Service Account**.
   - Nadaj dowolną nazwę (np. `openclaw-chat`).
   - Pozostaw uprawnienia puste (kliknij **Continue**).
   - Pozostaw podmioty z dostępem puste (kliknij **Done**).
3. Utwórz i pobierz **klucz JSON**:
   - Na liście kont usług kliknij to, które właśnie utworzyłeś(-aś).
   - Przejdź do karty **Keys**.
   - Kliknij **Add Key** > **Create new key**.
   - Wybierz **JSON** i kliknij **Create**.
4. Zapisz pobrany plik JSON na hoście gateway (np. `~/.openclaw/googlechat-service-account.json`).
5. Utwórz aplikację Google Chat w [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Wypełnij **Application info**:
     - **App name**: (np. `OpenClaw`)
     - **Avatar URL**: (np. `https://openclaw.ai/logo.png`)
     - **Description**: (np. `Personal AI Assistant`)
   - Włącz **Interactive features**.
   - W sekcji **Functionality** zaznacz **Join spaces and group conversations**.
   - W sekcji **Connection settings** wybierz **HTTP endpoint URL**.
   - W sekcji **Triggers** wybierz **Use a common HTTP endpoint URL for all triggers** i ustaw ją na publiczny URL gateway zakończony `/googlechat`.
     - _Wskazówka: Uruchom `openclaw status`, aby znaleźć publiczny URL gateway._
   - W sekcji **Visibility** zaznacz **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - W polu tekstowym wpisz swój adres e-mail (np. `user@example.com`).
   - Na dole kliknij **Save**.
6. **Włącz status aplikacji**:
   - Po zapisaniu **odśwież stronę**.
   - Znajdź sekcję **App status** (zwykle u góry lub na dole po zapisaniu).
   - Zmień status na **Live - available to users**.
   - Kliknij ponownie **Save**.
7. Skonfiguruj OpenClaw, podając ścieżkę do konta usługi + odbiorcę webhooka:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Lub konfiguracja: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Ustaw typ i wartość odbiorcy webhooka (zgodne z konfiguracją aplikacji Chat).
9. Uruchom gateway. Google Chat będzie wysyłać POST-y do ścieżki webhooka.

## Dodawanie do Google Chat

Gdy gateway działa, a Twój e-mail jest dodany do listy widoczności:

1. Przejdź do [Google Chat](https://chat.google.com/).
2. Kliknij ikonę **+** (plus) obok **Direct Messages**.
3. W pasku wyszukiwania (tam, gdzie zwykle dodajesz osoby) wpisz **App name** skonfigurowaną w Google Cloud Console.
   - **Uwaga**: Bot _nie_ pojawi się na liście przeglądania „Marketplace”, ponieważ jest aplikacją prywatną. Musisz wyszukać go po nazwie.
4. Wybierz bota z wyników.
5. Kliknij **Add** lub **Chat**, aby rozpocząć rozmowę 1:1.
6. Wyślij „Hello”, aby uruchomić asystenta!

## Publiczny URL (tylko webhook)

Webhooki Google Chat wymagają publicznego punktu końcowego HTTPS. Ze względów bezpieczeństwa **wystawiaj do internetu wyłącznie ścieżkę `/googlechat`**. Panel OpenClaw i inne wrażliwe endpointy trzymaj w sieci prywatnej.

### Opcja A: Tailscale Funnel (zalecane)

Użyj Tailscale Serve dla prywatnego panelu oraz Funnel dla publicznej ścieżki webhooka. Dzięki temu `/` pozostaje prywatne, a na zewnątrz wystawiona jest tylko `/googlechat`.

1. **Sprawdź, pod jakim adresem jest zbindowany gateway:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Zanotuj adres IP (np. `127.0.0.1`, `0.0.0.0` lub adres Tailscale, taki jak `100.x.x.x`).

2. **Wystaw panel tylko do tailnet (port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Wystaw publicznie tylko ścieżkę webhooka:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autoryzuj węzeł do dostępu Funnel:**
   Jeśli pojawi się monit, odwiedź URL autoryzacji pokazany w wyjściu, aby włączyć Funnel dla tego węzła w polityce tailnet.

5. **Zweryfikuj konfigurację:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Twój publiczny URL webhooka będzie:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Prywatny panel pozostaje dostępny tylko w tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Użyj publicznego URL (bez `:8443`) w konfiguracji aplikacji Google Chat.

> Uwaga: Ta konfiguracja utrzymuje się po restartach. Aby ją później usunąć, uruchom `tailscale funnel reset` oraz `tailscale serve reset`.

### Opcja B: Reverse Proxy (Caddy)

Jeśli używasz reverse proxy, takiego jak Caddy, proxy tylko dla konkretnej ścieżki:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Przy tej konfiguracji każde żądanie do `your-domain.com/` zostanie zignorowane lub zwrócone jako 404, natomiast `your-domain.com/googlechat` będzie bezpiecznie kierowane do OpenClaw.

### Opcja C: Cloudflare Tunnel

Skonfiguruj reguły ingress tunelu tak, aby routować wyłącznie ścieżkę webhooka:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Jak to działa

1. Google Chat wysyła webhookowe POST-y do gateway. Każde żądanie zawiera nagłówek `Authorization: Bearer <token>`.
2. OpenClaw weryfikuje token względem skonfigurowanych `audienceType` + `audience`:
   - `audienceType: "app-url"` → odbiorcą jest Twój HTTPS URL webhooka.
   - `audienceType: "project-number"` → odbiorcą jest numer projektu Cloud.
3. Wiadomości są routowane według przestrzeni:
   - DM-y używają klucza sesji `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Przestrzenie używają klucza sesji `agent:<agentId>:googlechat:group:<spaceId>`.
4. Dostęp do DM-ów jest domyślnie parowany. Nieznani nadawcy otrzymują kod parowania; zatwierdź poleceniem:
   - `openclaw pairing approve googlechat <code>`
5. Przestrzenie grupowe domyślnie wymagają wzmianki @. Użyj `botUser`, jeśli wykrywanie wzmianek wymaga nazwy użytkownika aplikacji.

## Cele (Targets)

Używaj tych identyfikatorów do dostarczania i list dozwolonych:

- Wiadomości bezpośrednie: `users/<userId>` lub `users/<email>` (akceptowane są adresy e-mail).
- Przestrzenie: `spaces/<spaceId>`.

## Najważniejsze elementy konfiguracji

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Uwagi:

- Poświadczenia konta usługi można również przekazać inline za pomocą `serviceAccount` (łańcuch JSON).
- Domyślna ścieżka webhooka to `/googlechat`, jeśli nie ustawiono `webhookPath`.
- Reakcje są dostępne przez narzędzie `reactions` oraz `channels action`, gdy włączone jest `actions.reactions`.
- `typingIndicator` obsługuje `none`, `message` (domyślnie) oraz `reaction` (reakcje wymagają OAuth użytkownika).
- Załączniki są pobierane przez Chat API i zapisywane w potoku mediów (rozmiar ograniczony przez `mediaMaxMb`).

## Rozwiązywanie problemów

### 405 Method Not Allowed

Jeśli Google Cloud Logs Explorer pokazuje błędy takie jak:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Oznacza to, że handler webhooka nie jest zarejestrowany. Typowe przyczyny:

1. **Kanał nie jest skonfigurowany**: Brakuje sekcji `channels.googlechat` w konfiguracji. Zweryfikuj poleceniem:

   ```bash
   openclaw config get channels.googlechat
   ```

   Jeśli zwraca „Config path not found”, dodaj konfigurację (zobacz [Najważniejsze elementy konfiguracji](#najważniejsze-elementy-konfiguracji)).

2. **Wtyczka nie jest włączona**: Sprawdź status wtyczki:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Jeśli pokazuje „disabled”, dodaj `plugins.entries.googlechat.enabled: true` do konfiguracji.

3. **Gateway nie został zrestartowany**: Po dodaniu konfiguracji zrestartuj gateway:

   ```bash
   openclaw gateway restart
   ```

Zweryfikuj, że kanał działa:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Inne problemy

- Sprawdź `openclaw channels status --probe` pod kątem błędów uwierzytelniania lub brakującej konfiguracji odbiorcy.
- Jeśli nie docierają żadne wiadomości, potwierdź URL webhooka aplikacji Chat oraz subskrypcje zdarzeń.
- Jeśli blokowanie przez wzmianki uniemożliwia odpowiedzi, ustaw `botUser` na nazwę zasobu użytkownika aplikacji i zweryfikuj `requireMention`.
- Użyj `openclaw logs --follow` podczas wysyłania wiadomości testowej, aby sprawdzić, czy żądania docierają do gateway.

Powiązana dokumentacja:

- [Konfiguracja Gateway](/gateway/configuration)
- [Bezpieczeństwo](/gateway/security)
- [Reakcje](/tools/reactions)
