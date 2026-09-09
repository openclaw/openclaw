---
summary: "Let an owner operate a blocked managed browser tab from another device"
read_when:
  - A browser task needs live human verification
  - You want to complete a remote browser step from a phone
title: "Human Browser Intervention"
---

# Human browser intervention

Human browser intervention lets an agent pause a managed browser profile and send an **Open browser** link to the current direct chat. The link opens the exact remote tab in an authenticated, mobile-friendly Control UI page. The human performs the blocked step and selects **Done — continue agent**; OpenClaw then schedules a fresh turn in the original session and delivery route.

This is a manual-control path. OpenClaw does not solve or relay CAPTCHA answers through the model.

## Configure it

The phone must be able to reach the same HTTPS Gateway origin used by the Control UI. Configure that existing public origin, keep the Control UI enabled, and opt in to human intervention:

```json5
{
  gateway: {
    publicOrigin: "https://openclaw.example.com",
    controlUi: {
      enabled: true,
      // basePath: "/openclaw", // optional reverse-proxy path
    },
  },
  browser: {
    humanIntervention: {
      enabled: true,
    },
  },
}
```

`gateway.publicOrigin` must use HTTPS for handoff links. A loopback URL cannot reach a browser on another machine. If you use a private VPN, its HTTPS hostname is valid as long as the phone can resolve and reach it.

Sign in to the Control UI from the phone once before relying on handoffs. Both viewing and controlling a handoff require an authenticated Gateway administrator (`operator.admin`). The handoff ID in the chat link is not a credential.

This follows the Gateway's single operator trust boundary: administrators share handoff access. The originating chat sender is recorded as provenance, but is not mapped to a separate web identity. Use separate Gateways for owners who must not access each other's browser sessions.

## Use it

When a managed browser tab reaches a live human-verification step, the browser tool can request a handoff. OpenClaw:

1. Waits for active managed-browser work on that profile to finish.
2. Reserves the profile and blocks new participating agent browser operations.
3. Sends the site hostname, short reason, and HTTPS link to the originating direct chat.
4. Keeps the browser process, profile, and tab alive while the task is paused.

Open the link and select **Take control**. The page supports taps, drags, page scrolling, local zoom, keyboard keys, and text entry into the focused remote field. It does not expose navigation, evaluation, cookies, files, shell access, or other browser profiles.

- **Done — continue agent** revokes human input and schedules the original session to inspect fresh page state before continuing.
- **Leave paused** releases the controller while preserving the handoff and browser reservation.
- **Cancel handoff** ends the handoff without resuming the task.

Closing or backgrounding the page leaves the task paused. A controller lease also expires after a disconnect, allowing the same or another authenticated owner device to claim it later. Handoffs expire after 30 minutes by default.

After completion, **waiting to be queued** means continuation admission is still pending. **Queued to continue** means the Gateway has durably accepted the continuation; it does not mean the agent has already started or finished. Watch the originating chat for the task result.

## Chat support

Telegram, iMessage, and WhatsApp use the same portable HTTPS text link and lifecycle. The mechanism uses OpenClaw's current delivery context, so completion returns to the same channel, account, conversation, and thread when applicable. Handoff creation is limited to owner-authorized direct conversations; group and channel sessions do not receive browser links.

Native iOS and Android presentation can use the same focus URL and Gateway methods. A dedicated in-app card or embedded native viewer is separate client work; the shared web page remains the baseline mobile flow.

## Test it

Start with a harmless form page that does not require credentials. In an owner-authorized direct chat, ask the agent to open the page in a managed browser profile and request human help before submitting it. Open the handoff link from another device, select **Take control**, enter a non-sensitive test value, and select **Done — continue agent**. The original chat should receive the resumed agent turn, and the agent should inspect the same tab before continuing.

## Limits

- The first version supports OpenClaw-managed host browser profiles. Existing-session, sandbox, and node-routed profiles do not advertise the handoff action.
- The reservation fences browser operations that participate in the Browser plugin gate. It cannot stop an unrelated process with direct OS or CDP access.
- Native browser dialogs, audio-only challenges, and a verification flow that switches to an unbound popup may require a different supported surface.
- The Gateway must remain running and the remote browser tab must remain alive.

If no handoff link appears, verify `browser.humanIntervention.enabled`, `gateway.publicOrigin`, direct-chat owner authorization, and managed-profile selection. If the page opens at the sign-in screen, authenticate that mobile browser to the Gateway and reopen the link.
