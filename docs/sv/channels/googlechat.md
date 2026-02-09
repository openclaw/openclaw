---
summary: "Status, funktioner och konfiguration för Google Chat-appen"
read_when:
  - Arbetar med funktioner för Google Chat-kanalen
title: "Google Chat"
---

# Google Chat (Chat API)

Status: redo för DM:er + Spaces via Google Chat API-webhooks (endast HTTP).

## Snabbstart (nybörjare)

1. Skapa ett Google Cloud-projekt och aktivera **Google Chat API**.
   - Gå till: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Aktivera API:t om det inte redan är aktiverat.
2. Skapa ett **Service Account**:
   - Klicka på **Create Credentials** > **Service Account**.
   - Namnge det vad du vill (t.ex., `openclaw-chat`).
   - Lämna behörigheter tomma (klicka **Continue**).
   - Lämna principer med åtkomst tomma (klicka **Done**).
3. Skapa och ladda ner **JSON-nyckeln**:
   - I listan över servicekonton, klicka på det du just skapade.
   - Gå till fliken **Keys**.
   - Klicka **Add Key** > **Create new key**.
   - Välj **JSON** och klicka **Create**.
4. Lagra den nedladdade JSON-filen på din gateway-värd (t.ex. `~/.openclaw/googlechat-service-accountt.json`).
5. Skapa en Google Chat-app i [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Fyll i **Application info**:
     - **Appnamn**: (t.ex. `OpenClaw`)
     - **Avatar URL**: (t.ex. `https://openclaw.ai/logo.png`)
     - **Beskrivning**: (t.ex. `Personal AI Assistant`)
   - Aktivera **Interactive features**.
   - Under **Functionality**, markera **Join spaces and group conversations**.
   - Under **Connection settings**, välj **HTTP endpoint URL**.
   - Under **Triggers**, välj **Use a common HTTP endpoint URL for all triggers** och sätt den till din gateways publika URL följt av `/googlechat`.
     - _Tips: Kör `openclaw status` för att hitta din gateways publika URL._
   - Under **Visibility**, markera **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Ange din e-postadress (t.ex. `user@example.com`) i textrutan.
   - Klicka **Save** längst ned.
6. **Aktivera appstatus**:
   - Efter att ha sparat, **uppdatera sidan**.
   - Leta efter avsnittet **App status** (vanligen nära toppen eller botten efter att ha sparat).
   - Ändra status till **Live - available to users**.
   - Klicka **Save** igen.
7. Konfigurera OpenClaw med sökvägen till servicekontot + webhook-audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Eller konfig: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Ställ in webhook-audience-typ + värde (matchar din Chat-appkonfiguration).
9. Starta gatewayn. Google Chat kommer att POST till din webhook-sökväg.

## Lägg till i Google Chat

När gatewayn kör och din e-postadress är tillagd i synlighetslistan:

1. Gå till [Google Chat](https://chat.google.com/).
2. Klicka på **+** (plus)-ikonen bredvid **Direct Messages**.
3. I sökfältet (där du vanligtvis lägger till personer), skriv **App name** som du konfigurerade i Google Cloud Console.
   - **Observera**: Botten kommer _inte_ att visas i browse list "Marketplace" eftersom det är en privat app. Du måste söka efter det med namn.
4. Välj din bot i resultaten.
5. Klicka **Add** eller **Chat** för att starta en 1:1-konversation.
6. Skicka ”Hello” för att trigga assistenten!

## Publik URL (endast webhook)

Google Chat webhooks kräver en offentlig HTTPS-slutpunkt. För säkerhets skull exponerar \*\*bara `/googlechat`-sökvägen \*\* till internet. Håll OpenClaw-instrumentpanelen och andra känsliga ändpunkter på ditt privata nätverk.

### Alternativ A: Tailscale Funnel (rekommenderat)

Använd Tailscale Serve för den privata instrumentpanelen och Funnel för den offentliga webhook-sökvägen. Detta håller `/` privat medan du endast exponerar `/googlechat`.

1. **Kontrollera vilken adress din gateway är bunden till:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Notera IP-adressen (t.ex., `127.0.0.1`, `0.0.0.0`, eller din Tailscale IP som `100.x.x.x`).

2. **Exponera dashboarden endast för tailnet (port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Exponera endast webhook-sökvägen publikt:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Auktorisera noden för Funnel-åtkomst:**
   Om du uppmanas, besök auktoriserings-URL:en som visas i utdata för att aktivera Funnel för denna nod i din tailnet-policy.

5. **Verifiera konfigurationen:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Din publika webhook-URL kommer att vara:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Din privata instrumentpanel förblir endast tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Använd den publika URL:en (utan `:8443`) i Google Chat-appens konfiguration.

> Obs: Denna konfiguration kvarstår över omstarter. För att ta bort det senare, kör `tailscale tratt återställ` och` tailscale serve reset`.

### Alternativ B: Reverse Proxy (Caddy)

Om du använder en reverse proxy som Caddy, proxya endast den specifika sökvägen:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Med denna konfiguration kommer alla förfrågningar till `your-domain.com/` att ignoreras eller returnera 404, medan `your-domain.com/googlechat` säkert routas till OpenClaw.

### Alternativ C: Cloudflare Tunnel

Konfigurera tunnelns ingress-regler för att endast routa webhook-sökvägen:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Hur det fungerar

1. Google Chat skickar webhook POST till gateway. Varje begäran innehåller en `Authorization: Bearer <token>` header.
2. OpenClaw verifierar token mot den konfigurerade `audienceType` + `audience`:
   - `audienceType: "app-url"` → audience är din HTTPS-webhook-URL.
   - `audienceType: "project-number"` → audience är Cloud-projektnumret.
3. Meddelanden routas per space:
   - DM:er använder sessionsnyckeln `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces använder sessionsnyckeln `agent:<agentId>:googlechat:group:<spaceId>`.
4. DM-åtkomst paras ihop som standard. Okända avsändare får en parningskod; godkänn med:
   - `openclaw pairing approve googlechat <code>`
5. Grupputrymmen kräver @-mention som standard. Använd `botUser` om omnämnande behöver appens användarnamn.

## Mål

Använd dessa identifierare för leverans och tillåtelselistor:

- Direktmeddelanden: `users/<userId>` eller `users/<email>` (e-postadresser accepteras).
- Spaces: `spaces/<spaceId>`.

## Konfig-höjdpunkter

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

Noteringar:

- Servicekontouppgifter kan också skickas inline med `serviceAccount` (JSON-sträng).
- Standard-sökvägen för webhook är `/googlechat` om `webhookPath` inte är satt.
- Reaktioner är tillgängliga via verktyget `reactions` och `channels action` när `actions.reactions` är aktiverat.
- `typingIndicator` stöder `none`, `message` (standard) och `reaction` (reaktion kräver användar-OAuth).
- Bilagor laddas ner via Chat API och lagras i mediapipelinen (storlek begränsad av `mediaMaxMb`).

## Felsökning

### 405 Method Not Allowed

Om Google Cloud Logs Explorer visar fel som:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Detta innebär att webhook-hanteraren inte är registrerad. Vanliga orsaker:

1. **Kanalen är inte konfigurerad**: sektionen `channels.googlechat` saknas i din konfiguration. Verifiera med:

   ```bash
   openclaw config get channels.googlechat
   ```

   Om det returnerar ”Config path not found”, lägg till konfigurationen (se [Konfig-höjdpunkter](#konfig-höjdpunkter)).

2. **Pluginen är inte aktiverad**: Kontrollera pluginstatus:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Om den visar ”disabled”, lägg till `plugins.entries.googlechat.enabled: true` i din konfig.

3. **Gatewayn har inte startats om**: Efter att ha lagt till konfig, starta om gatewayn:

   ```bash
   openclaw gateway restart
   ```

Verifiera att kanalen kör:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Andra problem

- Kontrollera `openclaw channels status --probe` för autentiseringsfel eller saknad audience-konfiguration.
- Om inga meddelanden kommer fram, bekräfta Chat-appens webhook-URL + event-prenumerationer.
- Om omnämnandespärren blockerar svar, sätt `botUser` till appens användarresursnamn och verifiera `requireMention`.
- Använd `openclaw logs --follow` medan du skickar ett testmeddelande för att se om förfrågningar når gatewayn.

Relaterad dokumentation:

- [Gateway-konfiguration](/gateway/configuration)
- [Säkerhet](/gateway/security)
- [Reaktioner](/tools/reactions)
