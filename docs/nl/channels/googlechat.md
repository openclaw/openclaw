---
summary: "Status van ondersteuning voor Google Chat-apps, mogelijkheden en configuratie"
read_when:
  - Werken aan Google Chat-kanaalfuncties
title: "Google Chat"
---

# Google Chat (Chat API)

Status: gereed voor DM's + spaces via Google Chat API-webhooks (alleen HTTP).

## Snelle installatie (beginner)

1. Maak een Google Cloud-project aan en schakel de **Google Chat API** in.
   - Ga naar: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Schakel de API in als deze nog niet is ingeschakeld.
2. Maak een **Service Account** aan:
   - Klik op **Create Credentials** > **Service Account**.
   - Geef het een naam naar keuze (bijv. `openclaw-chat`).
   - Laat rechten leeg (klik op **Continue**).
   - Laat principals met toegang leeg (klik op **Done**).
3. Maak de **JSON-sleutel** aan en download deze:
   - Klik in de lijst met serviceaccounts op degene die je zojuist hebt aangemaakt.
   - Ga naar het tabblad **Keys**.
   - Klik op **Add Key** > **Create new key**.
   - Selecteer **JSON** en klik op **Create**.
4. Sla het gedownloade JSON-bestand op de Gateway-host op (bijv. `~/.openclaw/googlechat-service-account.json`).
5. Maak een Google Chat-app aan in de [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Vul de **Application info** in:
     - **App name**: (bijv. `OpenClaw`)
     - **Avatar URL**: (bijv. `https://openclaw.ai/logo.png`)
     - **Description**: (bijv. `Personal AI Assistant`)
   - Schakel **Interactive features** in.
   - Vink onder **Functionality** **Join spaces and group conversations** aan.
   - Selecteer onder **Connection settings** **HTTP endpoint URL**.
   - Selecteer onder **Triggers** **Use a common HTTP endpoint URL for all triggers** en stel deze in op de publieke URL van je Gateway gevolgd door `/googlechat`.
     - _Tip: Voer `openclaw status` uit om de publieke URL van je Gateway te vinden._
   - Vink onder **Visibility** **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;** aan.
   - Voer je e-mailadres in (bijv. `user@example.com`) in het tekstvak.
   - Klik onderaan op **Save**.
6. **Schakel de appstatus in**:
   - **Ververs de pagina** na het opslaan.
   - Zoek de sectie **App status** (meestal boven- of onderaan na het opslaan).
   - Zet de status op **Live - available to users**.
   - Klik opnieuw op **Save**.
7. Configureer OpenClaw met het pad naar het serviceaccount + webhook-audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Of config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Stel het webhook-audience-type + de waarde in (komt overeen met je Chat-appconfiguratie).
9. Start de Gateway. Google Chat zal POST-verzoeken naar je webhookpad sturen.

## Toevoegen aan Google Chat

Zodra de Gateway draait en je e-mailadres is toegevoegd aan de zichtbaarheidslijst:

1. Ga naar [Google Chat](https://chat.google.com/).
2. Klik op het **+**-pictogram naast **Direct Messages**.
3. Typ in de zoekbalk (waar je normaal personen toevoegt) de **App name** die je in de Google Cloud Console hebt geconfigureerd.
   - **Let op**: De bot verschijnt _niet_ in de browse-lijst van de "Marketplace" omdat het een privé-app is. Je moet ernaar zoeken op naam.
4. Selecteer je bot uit de resultaten.
5. Klik op **Add** of **Chat** om een 1:1-gesprek te starten.
6. Stuur "Hello" om de assistent te activeren!

## Publieke URL (alleen webhook)

Google Chat-webhooks vereisen een publiek HTTPS-eindpunt. Voor de beveiliging: **stel alleen het pad `/googlechat` bloot** aan internet. Houd het OpenClaw-dashboard en andere gevoelige eindpunten op je privé-netwerk.

### Optie A: Tailscale Funnel (Aanbevolen)

Gebruik Tailscale Serve voor het privé-dashboard en Funnel voor het publieke webhookpad. Dit houdt `/` privé terwijl alleen `/googlechat` wordt blootgesteld.

1. **Controleer op welk adres je Gateway is gebonden:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Noteer het IP-adres (bijv. `127.0.0.1`, `0.0.0.0` of je Tailscale-IP zoals `100.x.x.x`).

2. **Stel het dashboard alleen beschikbaar voor de tailnet (poort 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Stel alleen het webhookpad publiek beschikbaar:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autoriseer de node voor Funnel-toegang:**
   Bezoek indien gevraagd de autorisatie-URL die in de uitvoer wordt getoond om Funnel voor deze node in je tailnet-beleid in te schakelen.

5. **Verifieer de configuratie:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Je publieke webhook-URL wordt:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Je privé-dashboard blijft alleen voor de tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Gebruik de publieke URL (zonder `:8443`) in de Google Chat-appconfiguratie.

> Let op: Deze configuratie blijft behouden na herstarts. Om dit later te verwijderen, voer `tailscale funnel reset` en `tailscale serve reset` uit.

### Optie B: Reverse proxy (Caddy)

Als je een reverse proxy zoals Caddy gebruikt, proxy dan alleen het specifieke pad:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Met deze configuratie wordt elk verzoek naar `your-domain.com/` genegeerd of beantwoord met 404, terwijl `your-domain.com/googlechat` veilig naar OpenClaw wordt gerouteerd.

### Optie C: Cloudflare Tunnel

Configureer de ingress-regels van je tunnel om alleen het webhookpad te routeren:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Hoe het werkt

1. Google Chat stuurt webhook-POSTs naar de Gateway. Elk verzoek bevat een `Authorization: Bearer <token>`-header.
2. OpenClaw verifieert het token tegen de geconfigureerde `audienceType` + `audience`:
   - `audienceType: "app-url"` → audience is je HTTPS-webhook-URL.
   - `audienceType: "project-number"` → audience is het Cloud-projectnummer.
3. Berichten worden per space gerouteerd:
   - DM's gebruiken sessiesleutel `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces gebruiken sessiesleutel `agent:<agentId>:googlechat:group:<spaceId>`.
4. DM-toegang is standaard gepaard. Onbekende afzenders ontvangen een koppelingscode; keur goed met:
   - `openclaw pairing approve googlechat <code>`
5. Groeps-spaces vereisen standaard een @-vermelding. Gebruik `botUser` als vermeldingdetectie de gebruikersnaam van de app nodig heeft.

## Doelen

Gebruik deze identificaties voor bezorging en toegestane lijsten:

- Directe berichten: `users/<userId>` of `users/<email>` (e-mailadressen worden geaccepteerd).
- Spaces: `spaces/<spaceId>`.

## Config-hoogtepunten

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

Notities:

- Serviceaccount-gegevens kunnen ook inline worden doorgegeven met `serviceAccount` (JSON-string).
- Het standaard webhookpad is `/googlechat` als `webhookPath` niet is ingesteld.
- Reacties zijn beschikbaar via de `reactions`-tool en `channels action` wanneer `actions.reactions` is ingeschakeld.
- `typingIndicator` ondersteunt `none`, `message` (standaard) en `reaction` (reactie vereist gebruikers-OAuth).
- Bijlagen worden via de Chat API gedownload en opgeslagen in de mediapijplijn (grootte beperkt door `mediaMaxMb`).

## Problemen oplossen

### 405 Method Not Allowed

Als Google Cloud Logs Explorer fouten toont zoals:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Dit betekent dat de webhook-handler niet is geregistreerd. Veelvoorkomende oorzaken:

1. **Kanaal niet geconfigureerd**: De sectie `channels.googlechat` ontbreekt in je config. Verifieer met:

   ```bash
   openclaw config get channels.googlechat
   ```

   Als dit "Config path not found" retourneert, voeg de configuratie toe (zie [Config-hoogtepunten](#config-highlights)).

2. **Plugin niet ingeschakeld**: Controleer de pluginstatus:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Als deze "disabled" toont, voeg `plugins.entries.googlechat.enabled: true` toe aan je config.

3. **Gateway niet herstart**: Herstart de Gateway na het toevoegen van de config:

   ```bash
   openclaw gateway restart
   ```

Verifieer dat het kanaal draait:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Overige problemen

- Controleer `openclaw channels status --probe` op authenticatiefouten of ontbrekende audience-configuratie.
- Als er geen berichten binnenkomen, bevestig de webhook-URL + event-abonnementen van de Chat-app.
- Als vermelding-gating antwoorden blokkeert, stel `botUser` in op de user resource name van de app en verifieer `requireMention`.
- Gebruik `openclaw logs --follow` terwijl je een testbericht verzendt om te zien of verzoeken de Gateway bereiken.

Gerelateerde documentatie:

- [Gateway-configuratie](/gateway/configuration)
- [Beveiliging](/gateway/security)
- [Reacties](/tools/reactions)
