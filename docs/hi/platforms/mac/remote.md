---
summary: "SSH के माध्यम से दूरस्थ OpenClaw Gateway को नियंत्रित करने के लिए macOS ऐप प्रवाह"
read_when:
  - दूरस्थ mac नियंत्रण सेटअप या डिबग करते समय
title: "दूरस्थ नियंत्रण"
---

# Remote OpenClaw (macOS ⇄ दूरस्थ होस्ट)

This flow lets the macOS app act as a full remote control for a OpenClaw gateway running on another host (desktop/server). It’s the app’s **Remote over SSH** (remote run) feature. All features—health checks, Voice Wake forwarding, and Web Chat—reuse the same remote SSH configuration from _Settings → General_.

## Modes

- **Local (this Mac)**: Everything runs on the laptop. No SSH involved.
- **Remote over SSH (default)**: OpenClaw commands are executed on the remote host. The mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key and a local port-forward.
- **Remote direct (ws/wss)**: No SSH tunnel. The mac app connects to the gateway URL directly (for example, via Tailscale Serve or a public HTTPS reverse proxy).

## Remote transports

Remote मोड दो ट्रांसपोर्ट का समर्थन करता है:

- **SSH tunnel** (default): Uses `ssh -N -L ...` to forward the gateway port to localhost. The gateway will see the node’s IP as `127.0.0.1` because the tunnel is loopback.
- **Direct (ws/wss)**: Connects straight to the gateway URL. The gateway sees the real client IP.

## Prereqs on the remote host

1. Node + pnpm इंस्टॉल करें और OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`) को बिल्ड/इंस्टॉल करें।
2. सुनिश्चित करें कि `openclaw` non-interactive shells के लिए PATH पर है (आवश्यक होने पर `/usr/local/bin` या `/opt/homebrew/bin` में symlink करें)।
3. Open SSH with key auth. We recommend **Tailscale** IPs for stable reachability off-LAN.

## macOS app setup

1. _Settings → General_ खोलें।
2. **OpenClaw runs** के अंतर्गत **Remote over SSH** चुनें और सेट करें:
   - **Transport**: **SSH tunnel** या **Direct (ws/wss)**।
   - **SSH target**: `user@host` (वैकल्पिक `:port`)।
     - यदि Gateway उसी LAN पर है और Bonjour का विज्ञापन करता है, तो इस फ़ील्ड को स्वतः भरने के लिए खोजी गई सूची से उसे चुनें।
   - **Gateway URL** (केवल Direct): `wss://gateway.example.ts.net` (या local/LAN के लिए `ws://...`)।
   - **Identity file** (advanced): आपकी कुंजी का पथ।
   - **Project root** (advanced): कमांड्स के लिए उपयोग किया जाने वाला दूरस्थ checkout पथ।
   - **CLI path** (advanced): वैकल्पिक रूप से चलाने योग्य `openclaw` entrypoint/binary का पथ (विज्ञापित होने पर स्वतः भरा जाता है)।
3. Hit **Test remote**. Success indicates the remote `openclaw status --json` runs correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.
4. स्वास्थ्य जाँच और Web Chat अब इस SSH टनल के माध्यम से स्वतः चलेंगे।

## Web Chat

- **SSH tunnel**: Web Chat फ़ॉरवर्ड किए गए WebSocket कंट्रोल पोर्ट (default 18789) के माध्यम से Gateway से कनेक्ट करता है।
- **Direct (ws/wss)**: Web Chat सीधे कॉन्फ़िगर किए गए Gateway URL से कनेक्ट करता है।
- अब कोई अलग WebChat HTTP सर्वर नहीं है।

## Permissions

- The remote host needs the same TCC approvals as local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Run onboarding on that machine to grant them once.
- नोड्स अपनी अनुमति स्थिति `node.list` / `node.describe` के माध्यम से विज्ञापित करते हैं ताकि एजेंट जान सकें कि क्या उपलब्ध है।

## Security notes

- दूरस्थ होस्ट पर loopback binds को प्राथमिकता दें और SSH या Tailscale के माध्यम से कनेक्ट करें।
- यदि आप Gateway को non-loopback इंटरफ़ेस से bind करते हैं, तो token/password प्रमाणीकरण आवश्यक करें।
- [Security](/gateway/security) और [Tailscale](/gateway/tailscale) देखें।

## WhatsApp login flow (remote)

- Run `openclaw channels login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Re-run login on that host if auth expires. Health check will surface link problems.

## Troubleshooting

- **exit 127 / not found**: `openclaw` isn’t on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: SSH पहुँच, PATH, और यह कि Baileys लॉग इन है (`openclaw status --json`)—इनकी जाँच करें।
- **Web Chat stuck**: पुष्टि करें कि Gateway दूरस्थ होस्ट पर चल रहा है और फ़ॉरवर्ड किया गया पोर्ट Gateway WS पोर्ट से मेल खाता है; UI को स्वस्थ WS कनेक्शन चाहिए।
- **Node IP shows 127.0.0.1**: expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.
- **Voice Wake**: remote मोड में ट्रिगर वाक्यांश स्वतः फ़ॉरवर्ड हो जाते हैं; अलग फ़ॉरवर्डर की आवश्यकता नहीं।

## Notification sounds

स्क्रिप्ट्स से प्रति नोटिफ़िकेशन ध्वनियाँ `openclaw` और `node.invoke` के साथ चुनें, उदाहरण के लिए:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

अब ऐप में कोई वैश्विक “default sound” टॉगल नहीं है; कॉलर प्रत्येक अनुरोध के लिए एक ध्वनि (या कोई नहीं) चुनते हैं।
