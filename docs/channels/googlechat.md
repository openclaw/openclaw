---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Google Chat app support status, capabilities, and configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on Google Chat channel features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Google Chat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Google Chat (Chat API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: ready for DMs + spaces via Google Chat API webhooks (HTTP only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a Google Cloud project and enable the **Google Chat API**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Go to: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Enable the API if it is not already enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a **Service Account**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Press **Create Credentials** > **Service Account**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Name it whatever you want (e.g., `openclaw-chat`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Leave permissions blank (press **Continue**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Leave principals with access blank (press **Done**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Create and download the **JSON Key**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - In the list of service accounts, click on the one you just created.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Go to the **Keys** tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Click **Add Key** > **Create new key**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Select **JSON** and press **Create**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Store the downloaded JSON file on your gateway host (e.g., `~/.openclaw/googlechat-service-account.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Create a Google Chat app in the [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Fill in the **Application info**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - **App name**: (e.g. `OpenClaw`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - **Avatar URL**: (e.g. `https://openclaw.ai/logo.png`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - **Description**: (e.g. `Personal AI Assistant`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Enable **Interactive features**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Under **Functionality**, check **Join spaces and group conversations**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Under **Connection settings**, select **HTTP endpoint URL**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Under **Triggers**, select **Use a common HTTP endpoint URL for all triggers** and set it to your gateway's public URL followed by `/googlechat`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - _Tip: Run `openclaw status` to find your gateway's public URL._（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Under **Visibility**, check **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Enter your email address (e.g. `user@example.com`) in the text box.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Click **Save** at the bottom.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Enable the app status**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - After saving, **refresh the page**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Look for the **App status** section (usually near the top or bottom after saving).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Change the status to **Live - available to users**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Click **Save** again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Configure OpenClaw with the service account path + webhook audience:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. Set the webhook audience type + value (matches your Chat app config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. Start the gateway. Google Chat will POST to your webhook path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Add to Google Chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once the gateway is running and your email is added to the visibility list:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to [Google Chat](https://chat.google.com/).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Click the **+** (plus) icon next to **Direct Messages**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. In the search bar (where you usually add people), type the **App name** you configured in the Google Cloud Console.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Note**: The bot will _not_ appear in the "Marketplace" browse list because it is a private app. You must search for it by name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Select your bot from the results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Click **Add** or **Chat** to start a 1:1 conversation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Send "Hello" to trigger the assistant!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Public URL (Webhook-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Google Chat webhooks require a public HTTPS endpoint. For security, **only expose the `/googlechat` path** to the internet. Keep the OpenClaw dashboard and other sensitive endpoints on your private network.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option A: Tailscale Funnel (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use Tailscale Serve for the private dashboard and Funnel for the public webhook path. This keeps `/` private while exposing only `/googlechat`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Check what address your gateway is bound to:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ss -tlnp | grep 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Note the IP address (e.g., `127.0.0.1`, `0.0.0.0`, or your Tailscale IP like `100.x.x.x`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Expose the dashboard to the tailnet only (port 8443):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # If bound to localhost (127.0.0.1 or 0.0.0.0):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale serve --bg --https 8443 http://127.0.0.1:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # If bound to Tailscale IP only (e.g., 100.106.161.80):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale serve --bg --https 8443 http://100.106.161.80:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Expose only the webhook path publicly:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # If bound to localhost (127.0.0.1 or 0.0.0.0):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # If bound to Tailscale IP only (e.g., 100.106.161.80):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Authorize the node for Funnel access:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   If prompted, visit the authorization URL shown in the output to enable Funnel for this node in your tailnet policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Verify the configuration:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale serve status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   tailscale funnel status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your public webhook URL will be:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`https://<node-name>.<tailnet>.ts.net/googlechat`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your private dashboard stays tailnet-only:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`https://<node-name>.<tailnet>.ts.net:8443/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the public URL (without `:8443`) in the Google Chat app config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> Note: This configuration persists across reboots. To remove it later, run `tailscale funnel reset` and `tailscale serve reset`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option B: Reverse Proxy (Caddy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you use a reverse proxy like Caddy, only proxy the specific path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```caddy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your-domain.com {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reverse_proxy /googlechat* localhost:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With this config, any request to `your-domain.com/` will be ignored or returned as 404, while `your-domain.com/googlechat` is safely routed to OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option C: Cloudflare Tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure your tunnel's ingress rules to only route the webhook path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Default Rule**: HTTP 404 (Not Found)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Google Chat sends webhook POSTs to the gateway. Each request includes an `Authorization: Bearer <token>` header.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. OpenClaw verifies the token against the configured `audienceType` + `audience`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `audienceType: "app-url"` → audience is your HTTPS webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `audienceType: "project-number"` → audience is the Cloud project number.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Messages are routed by space:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - DMs use session key `agent:<agentId>:googlechat:dm:<spaceId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Spaces use session key `agent:<agentId>:googlechat:group:<spaceId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. DM access is pairing by default. Unknown senders receive a pairing code; approve with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `openclaw pairing approve googlechat <code>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Group spaces require @-mention by default. Use `botUser` if mention detection needs the app’s user name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these identifiers for delivery and allowlists:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct messages: `users/<userId>` or `users/<email>` (email addresses are accepted).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Spaces: `spaces/<spaceId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    googlechat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      serviceAccountFile: "/path/to/service-account.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audienceType: "app-url",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audience: "https://gateway.example.com/googlechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookPath: "/googlechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botUser: "users/1234567890", // optional; helps mention detection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        policy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowFrom: ["users/1234567890", "name@example.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "spaces/AAAA": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          users: ["users/1234567890"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPrompt: "Short answers only.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: { reactions: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      typingIndicator: "message",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 20,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Service account credentials can also be passed inline with `serviceAccount` (JSON string).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default webhook path is `/googlechat` if `webhookPath` isn’t set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reactions are available via the `reactions` tool and `channels action` when `actions.reactions` is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `typingIndicator` supports `none`, `message` (default), and `reaction` (reaction requires user OAuth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments are downloaded through the Chat API and stored in the media pipeline (size capped by `mediaMaxMb`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 405 Method Not Allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If Google Cloud Logs Explorer shows errors like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This means the webhook handler isn't registered. Common causes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Channel not configured**: The `channels.googlechat` section is missing from your config. Verify with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw config get channels.googlechat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   If it returns "Config path not found", add the configuration (see [Config highlights](#config-highlights)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Plugin not enabled**: Check plugin status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw plugins list | grep googlechat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   If it shows "disabled", add `plugins.entries.googlechat.enabled: true` to your config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Gateway not restarted**: After adding config, restart the gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify the channel is running:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Should show: Google Chat default: enabled, configured, ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Other issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check `openclaw channels status --probe` for auth errors or missing audience config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no messages arrive, confirm the Chat app's webhook URL + event subscriptions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If mention gating blocks replies, set `botUser` to the app's user resource name and verify `requireMention`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `openclaw logs --follow` while sending a test message to see if requests reach the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Reactions](/tools/reactions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
