---
summary: "Katayuan ng suporta ng Google Chat app, mga kakayahan, at konpigurasyon"
read_when:
  - Gumagawa sa mga feature ng Google Chat channel
title: "Google Chat"
---

# Google Chat (Chat API)

Status: handa para sa mga DM + spaces sa pamamagitan ng Google Chat API webhooks (HTTP lamang).

## Mabilis na setup (baguhan)

1. Gumawa ng Google Cloud project at i-enable ang **Google Chat API**.
   - Pumunta sa: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - I-enable ang API kung hindi pa ito naka-enable.
2. Gumawa ng **Service Account**:
   - Pindutin ang **Create Credentials** > **Service Account**.
   - Pangalanan ito ayon sa gusto mo (hal., `openclaw-chat`).
   - Iwanang blangko ang permissions (pindutin ang **Continue**).
   - Iwanang blangko ang principals with access (pindutin ang **Done**).
3. Gumawa at i-download ang **JSON Key**:
   - Sa listahan ng mga service account, i-click ang kakagawa mo lang.
   - Pumunta sa tab na **Keys**.
   - I-click ang **Add Key** > **Create new key**.
   - Piliin ang **JSON** at pindutin ang **Create**.
4. I-store ang na-download na JSON file sa iyong host ng Gateway (hal., `~/.openclaw/googlechat-service-account.json`).
5. Gumawa ng Google Chat app sa [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Punan ang **Application info**:
     - **App name**: (hal. `OpenClaw`)
     - **Avatar URL**: (hal. `https://openclaw.ai/logo.png`)
     - **Description**: (hal. `Personal AI Assistant`)
   - I-enable ang **Interactive features**.
   - Sa ilalim ng **Functionality**, i-check ang **Join spaces and group conversations**.
   - Sa ilalim ng **Connection settings**, piliin ang **HTTP endpoint URL**.
   - Sa ilalim ng **Triggers**, piliin ang **Use a common HTTP endpoint URL for all triggers** at itakda ito sa pampublikong URL ng iyong Gateway na sinusundan ng `/googlechat`.
     - _Tip: Patakbuhin ang `openclaw status` para mahanap ang pampublikong URL ng iyong Gateway._
   - Sa ilalim ng **Visibility**, i-check ang **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Ilagay ang iyong email address (hal. `user@example.com`) sa text box.
   - I-click ang **Save** sa ibaba.
6. **I-enable ang app status**:
   - Pagkatapos mag-save, **i-refresh ang page**.
   - Hanapin ang seksyong **App status** (karaniwang nasa itaas o ibaba pagkatapos mag-save).
   - Baguhin ang status sa **Live - available to users**.
   - I-click muli ang **Save**.
7. I-configure ang OpenClaw gamit ang path ng service account + webhook audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - O config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Itakda ang uri at value ng webhook audience (tugma sa config ng iyong Chat app).
9. Simulan ang Gateway. Magpo-POST ang Google Chat sa iyong webhook path.

## Idagdag sa Google Chat

Kapag tumatakbo na ang Gateway at naidagdag ang iyong email sa visibility list:

1. Pumunta sa [Google Chat](https://chat.google.com/).
2. I-click ang **+** (plus) icon sa tabi ng **Direct Messages**.
3. Sa search bar (kung saan ka karaniwang nagdadagdag ng mga tao), i-type ang **App name** na kinonpigura mo sa Google Cloud Console.
   - **Tandaan**: Ang bot ay _hindi_ lilitaw sa listahan ng "Marketplace" browse dahil ito ay isang private app. Kailangan mo itong hanapin ayon sa pangalan.
4. Piliin ang iyong bot mula sa mga resulta.
5. I-click ang **Add** o **Chat** para magsimula ng 1:1 na usapan.
6. Magpadala ng "Hello" para ma-trigger ang assistant!

## Pampublikong URL (Webhook-only)

Ang mga webhook ng Google Chat ay nangangailangan ng isang pampublikong HTTPS endpoint. Para sa seguridad, **ilantad lamang ang `/googlechat` path** sa internet. Panatilihin ang OpenClaw dashboard at iba pang sensitibong endpoint sa iyong pribadong network.

### Opsyon A: Tailscale Funnel (Inirerekomenda)

Gamitin ang Tailscale Serve para sa pribadong dashboard at ang Funnel para sa pampublikong webhook path. Pinananatiling pribado nito ang `/` habang inilalantad lamang ang `/googlechat`.

1. **Suriin kung saang address naka-bind ang iyong Gateway:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Itala ang IP address (hal., `127.0.0.1`, `0.0.0.0`, o ang iyong Tailscale IP tulad ng `100.x.x.x`).

2. **Ilantad ang dashboard sa tailnet lamang (port 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Ilantad lamang ang webhook path sa publiko:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **I-authorize ang node para sa Funnel access:**
   Kung ma-prompt, bisitahin ang authorization URL na ipinakita sa output para i-enable ang Funnel para sa node na ito sa iyong tailnet policy.

5. **I-verify ang konpigurasyon:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Ang iyong pampublikong webhook URL ay magiging:`https://<node-name>.<tailnet>`

`.ts.net/googlechat`Mananatiling tailnet-only ang iyong pribadong dashboard:

Gamitin ang pampublikong URL (walang `:8443`) sa config ng Google Chat app.

> `https://<node-name>.<tailnet>` `.ts.net:8443/`

### Opsyon B: Reverse Proxy (Caddy)

Kung gumagamit ka ng reverse proxy tulad ng Caddy, i-proxy lamang ang partikular na path:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Sa config na ito, anumang request sa `your-domain.com/` ay i-ignore o ibabalik bilang 404, habang ang `your-domain.com/googlechat` ay ligtas na iruruta papunta sa OpenClaw.

### Opsyon C: Cloudflare Tunnel

I-configure ang ingress rules ng iyong tunnel upang iruta lamang ang webhook path:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Paano ito gumagana

1. Tandaan: Ang konfigurasyong ito ay nananatili kahit mag-reboot. Upang alisin ito sa ibang pagkakataon, patakbuhin ang `tailscale funnel reset` at `tailscale serve reset`.
2. Vine-verify ng OpenClaw ang token laban sa naka-configure na `audienceType` + `audience`:
   - `audienceType: "app-url"` → ang audience ay ang iyong HTTPS webhook URL.
   - `audienceType: "project-number"` → ang audience ay ang Cloud project number.
3. Niruruta ang mga mensahe ayon sa space:
   - Gumagamit ang mga DM ng session key na `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Gumagamit ang mga space ng session key na `agent:<agentId>:googlechat:group:<spaceId>`.
4. Nagpapadala ang Google Chat ng mga webhook POST sa gateway. Ang bawat request ay may kasamang header na `Authorization: Bearer <token>`.
   - `openclaw pairing approve googlechat <code>`
5. Ang DM access ay pairing bilang default. Use `botUser` if mention detection needs the app’s user name.

## Mga target

Gamitin ang mga identifier na ito para sa delivery at allowlists:

- Direct messages: `users/<userId>` o `users/<email>` (tinatanggap ang mga email address).
- Spaces: `spaces/<spaceId>`.

## Mga highlight ng config

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

Mga tala:

- Maaari ring ipasa inline ang service account credentials gamit ang `serviceAccount` (JSON string).
- Ang default na webhook path ay `/googlechat` kung hindi naka-set ang `webhookPath`.
- Available ang reactions sa pamamagitan ng `reactions` tool at `channels action` kapag naka-enable ang `actions.reactions`.
- Sinusuportahan ng `typingIndicator` ang `none`, `message` (default), at `reaction` (nangangailangan ng user OAuth ang reaction).
- Ang mga attachment ay dina-download sa pamamagitan ng Chat API at iniimbak sa media pipeline (may limit sa laki na `mediaMaxMb`).

## Pag-troubleshoot

### 405 Method Not Allowed

Kung ang Google Cloud Logs Explorer ay nagpapakita ng mga error tulad ng:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

This means the webhook handler isn't registered. Common causes:

1. **Channel not configured**: The `channels.googlechat` section is missing from your config. I-verify gamit ang:

   ```bash
   openclaw config get channels.googlechat
   ```

   Kung ibinalik nito ang "Config path not found", idagdag ang konpigurasyon (tingnan ang [Mga highlight ng config](#config-highlights)).

2. **Hindi naka-enable ang plugin**: Suriin ang status ng plugin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Kung ipinapakita nitong "disabled", idagdag ang `plugins.entries.googlechat.enabled: true` sa iyong config.

3. **Hindi na-restart ang Gateway**: Pagkatapos magdagdag ng config, i-restart ang Gateway:

   ```bash
   openclaw gateway restart
   ```

I-verify na tumatakbo ang channel:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Iba pang isyu

- Suriin ang `openclaw channels status --probe` para sa mga error sa auth o nawawalang audience config.
- Kung walang dumarating na mensahe, kumpirmahin ang webhook URL + event subscriptions ng Chat app.
- Kung hinaharangan ng mention gating ang mga reply, itakda ang `botUser` sa user resource name ng app at i-verify ang `requireMention`.
- Gamitin ang `openclaw logs --follow` habang nagpapadala ng test message para makita kung umaabot ang mga request sa Gateway.

Kaugnay na docs:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
