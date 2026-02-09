---
summary: "Status for understøttelse af Google Chat-app, funktioner og konfiguration"
read_when:
  - Arbejder på funktioner til Google Chat-kanalen
title: "Google Chat"
---

# Google Chat (Chat API)

Status: klar til DM’er + spaces via Google Chat API-webhooks (kun HTTP).

## Hurtig opsætning (begynder)

1. Opret et Google Cloud-projekt, og aktivér **Google Chat API**.
   - Gå til: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Aktivér API’et, hvis det ikke allerede er aktiveret.
2. Opret en **Service Account**:
   - Tryk på **Create Credentials** > **Service Account**.
   - Giv den et valgfrit navn (fx `openclaw-chat`).
   - Lad tilladelser være tomme (tryk **Continue**).
   - Lad principals med adgang være tomme (tryk **Done**).
3. Opret og download **JSON-nøglen**:
   - Klik på den service account, du netop har oprettet, i listen.
   - Gå til fanen **Keys**.
   - Klik **Add Key** > **Create new key**.
   - Vælg **JSON**, og tryk **Create**.
4. Gem den downloadede JSON-fil på din gateway-vært (fx `~/.openclaw/googlechat-service-account.json`).
5. Opret en Google Chat-app i [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Udfyld **Application info**:
     - **App name**: (fx `OpenClaw`)
     - **Avatar URL**: (fx `https://openclaw.ai/logo.png`)
     - **Description**: (fx `Personal AI Assistant`)
   - Aktivér **Interactive features**.
   - Under **Functionality** skal du markere **Join spaces and group conversations**.
   - Under **Connection settings** skal du vælge **HTTP endpoint URL**.
   - Under **Triggers** skal du vælge **Use a common HTTP endpoint URL for all triggers** og sætte den til din gateways offentlige URL efterfulgt af `/googlechat`.
     - _Tip: Kør `openclaw status` for at finde din gateways offentlige URL._
   - Under **Visibility** skal du markere **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Indtast din e-mailadresse (fx `user@example.com`) i tekstfeltet.
   - Klik **Save** nederst.
6. **Aktivér app-status**:
   - Efter du har gemt, skal du **genindlæse siden**.
   - Find sektionen **App status** (typisk nær toppen eller bunden efter gemning).
   - Skift status til **Live - available to users**.
   - Klik **Save** igen.
7. Konfigurér OpenClaw med stien til service account + webhook-audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Eller konfiguration: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Angiv webhook-audience-type + værdi (matcher din Chat-app-konfiguration).
9. Start gatewayen. Google Chat vil POST til din webhook sti.

## Tilføj til Google Chat

Når gatewayen kører, og din e-mail er tilføjet til synlighedslisten:

1. Gå til [Google Chat](https://chat.google.com/).
2. Klik på **+** (plus)-ikonet ved siden af **Direct Messages**.
3. I søgefeltet (hvor du normalt tilføjer personer) skal du skrive det **App name**, du konfigurerede i Google Cloud Console.
   - **Bemærk**: Botten vil _not_ vises i "Marketplace" browse-listen, fordi det er en privat app. Du skal søge efter det ved navn.
4. Vælg din bot fra resultaterne.
5. Klik **Add** eller **Chat** for at starte en 1:1-samtale.
6. Send “Hello” for at udløse assistenten!

## Offentlig URL (kun webhook)

Google Chat webhooks kræver et offentligt HTTPS-endepunkt. For sikkerhed, \*\*udsæt kun stien `/googlechat` til internettet. Hold OpenClaw dashboard og andre følsomme endpoints på dit private netværk.

### Mulighed A: Tailscale Funnel (anbefalet)

Brug Tailscale Serve til det private dashboard og Tragt til den offentlige webhook sti. Dette holder `/` privat, mens kun udsætter `/googlechat`.

1. **Tjek hvilken adresse din gateway er bundet til:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Notér IP-adressen (fx `127.0.0.1`, `0.0.0.0` eller din Tailscale-IP som `100.x.x.x`).

2. **Eksponér dashboardet kun til tailnettet (port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Eksponér kun webhook-stien offentligt:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Godkend noden til Funnel-adgang:**
   Hvis du bliver bedt om det, skal du besøge autorisations-URL’en, der vises i outputtet, for at aktivere Funnel for denne node i din tailnet-politik.

5. **Verificér konfigurationen:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Din offentlige webhook URL vil være:
\`https://<node-name>.<tailnet>.ts.net/googlechat«

Dit private betjeningspanel forbliver kun skræddernet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Brug den offentlige URL (uden `:8443`) i Google Chat-app-konfigurationen.

> Bemærk: Denne konfiguration fortsætter på tværs af genstarter. For at fjerne det senere, køre `skræddersy tragt nulstilling` og `skræddersy tjene nulstilling`.

### Mulighed B: Reverse proxy (Caddy)

Hvis du bruger en reverse proxy som Caddy, skal du kun proxy den specifikke sti:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Med denne konfiguration vil enhver anmodning til `your-domain.com/` blive ignoreret eller returneret som 404, mens `your-domain.com/googlechat` sikkert routes til OpenClaw.

### Mulighed C: Cloudflare Tunnel

Konfigurér din tunnels ingress-regler til kun at route webhook-stien:

- **Sti**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Standardregel**: HTTP 404 (Not Found)

## Sådan virker det

1. Google Chat sender webhook POST'er til gatewayen. Hver anmodning omfatter en `Authorization: Bearer <token>` header.
2. OpenClaw verificerer tokenet mod den konfigurerede `audienceType` + `audience`:
   - `audienceType: "app-url"` → audience er din HTTPS-webhook-URL.
   - `audienceType: "project-number"` → audience er Cloud-projektnummeret.
3. Beskeder routes efter space:
   - DM’er bruger sessionsnøglen `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces bruger sessionsnøglen `agent:<agentId>:googlechat:group:<spaceId>`.
4. DM adgang er parring som standard. Ukendt afsendere modtager en parringskode; godkender med:
   - `openclaw pairing approve googlechat <code>`
5. Gruppemellemrum kræver som standard @-omtale. Brug `botUser` hvis detektering af oplysninger skal bruges i appens brugernavn.

## Mål

Brug disse identifikatorer til levering og tilladelseslister:

- Direkte beskeder: `users/<userId>` eller `users/<email>` (e-mailadresser accepteres).
- Spaces: `spaces/<spaceId>`.

## Konfigurationshøjdepunkter

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

Noter:

- Service account-legitimationsoplysninger kan også angives inline med `serviceAccount` (JSON-streng).
- Standard webhook-sti er `/googlechat`, hvis `webhookPath` ikke er angivet.
- Reaktioner er tilgængelige via værktøjet `reactions` og `channels action`, når `actions.reactions` er aktiveret.
- `typingIndicator` understøtter `none`, `message` (standard) og `reaction` (reaktion kræver bruger-OAuth).
- Vedhæftninger downloades via Chat API’et og gemmes i medie-pipelinen (størrelse begrænset af `mediaMaxMb`).

## Fejlfinding

### 405 Method Not Allowed

Hvis Google Cloud Logs Explorer viser fejl som:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Det betyder, at webhook handleren ikke er registreret. Almindelige årsager:

1. **Kanal ikke konfigureret**: Afsnittet `channels.googlechat` mangler i din konfiguration. Verificér med:

   ```bash
   openclaw config get channels.googlechat
   ```

   Hvis den returnerer “Config path not found”, skal du tilføje konfigurationen (se [Konfigurationshøjdepunkter](#konfigurationshøjdepunkter)).

2. **Plugin ikke aktiveret**: Tjek plugin-status:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Hvis den viser “disabled”, skal du tilføje `plugins.entries.googlechat.enabled: true` til din konfiguration.

3. **Gateway ikke genstartet**: Efter tilføjelse af konfiguration skal du genstarte gatewayen:

   ```bash
   openclaw gateway restart
   ```

Verificér, at kanalen kører:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Andre problemer

- Tjek `openclaw channels status --probe` for auth-fejl eller manglende audience-konfiguration.
- Hvis der ikke ankommer beskeder, skal du bekræfte Chat-appens webhook-URL + event-abonnementer.
- Hvis mention-gating blokerer svar, skal du sætte `botUser` til appens user resource name og verificere `requireMention`.
- Brug `openclaw logs --follow`, mens du sender en testbesked, for at se om anmodninger når gatewayen.

Relaterede dokumenter:

- [Gateway-konfiguration](/gateway/configuration)
- [Sikkerhed](/gateway/security)
- [Reaktioner](/tools/reactions)
