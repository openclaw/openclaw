---
summary: "Microsoft Teams live voice support: architecture, Windows worker deployment, and configuration"
read_when:
  - Working on Teams voice or real-time media features
  - Deploying a Teams Voice Worker
title: "Microsoft Teams Live Voice"
---

# Microsoft Teams Live Voice

<Warning>
Teams live voice requires a Windows Teams Voice Worker. Without it, OpenClaw falls back to text and post-meeting transcript capabilities.
</Warning>

## Overview

OpenClaw supports Microsoft Teams in three tiers:

- **Text bot** -- messaging, files, polls, adaptive cards. Works anywhere.
- **Transcript mode** -- post-meeting summaries via Graph transcripts. Works anywhere.
- **Live voice** -- real-time join, listen, and speak in meetings. Requires a Windows Teams Voice Worker.

OpenClaw itself runs anywhere (Docker, Linux, macOS). The text bot and transcript tiers have no platform requirements beyond what the gateway already supports.

Live voice is different. Microsoft's Real-Time Media SDK is a C#/.NET library that only runs on Windows. A separate Windows-based media worker handles the audio stream, while OpenClaw orchestrates the session over gRPC. This split lets you keep OpenClaw on your preferred platform while satisfying Microsoft's SDK constraint with a dedicated worker.

## Why a Windows Worker is Required

Microsoft's Real-Time Media Platform imposes platform constraints that cannot be worked around:

- **SDK is .NET only.** The media SDK is a Windows/.NET library. There is no cross-platform, Java, or Node equivalent.
- **Calls are pinned to the hosting instance.** Once a bot joins a call, the audio stream is bound to that specific process. The worker cannot be load-balanced or migrated mid-call.
- **`updateRecordingStatus` is mandatory.** The SDK requires the bot to signal recording/transcription status to Teams. Skipping this call results in compliance errors and rejected media sessions.
- **Windows Server is required.** The SDK depends on Windows media foundations that are not available on Linux or macOS.

This is a Microsoft-imposed constraint, not an OpenClaw limitation. OpenClaw runs on any platform; only the media worker requires Windows.

## Deployment Options

### Option A -- No Worker

Use text and transcript mode only. No live voice capabilities.

- Text messaging, files, polls, adaptive cards all work normally.
- Post-meeting transcript processing (summaries, action items) works via Graph transcripts.
- No additional infrastructure required beyond the standard OpenClaw gateway.

### Option B -- Bring Your Own Worker (BYOW)

Deploy a Windows VM in Azure. Install the .NET media worker. Point OpenClaw at it.

- Self-hosted and self-managed.
- Full live voice: join meetings, listen, speak, real-time transcription.
- You control the VM, networking, and scaling.
- See [Azure Worker Quick Start](#azure-worker-quick-start) below.

### Option C -- Managed Worker

A managed worker offering is planned but not yet available. Check back for updates.

## Azure Worker Quick Start

Follow these steps to deploy a Windows media worker and connect it to OpenClaw.

### 1. Create Azure App Registration

In the [Azure Portal](https://portal.azure.com), create a new App Registration (single tenant). Add the following **Application permissions** under Microsoft Graph:

| Permission                | Purpose                       |
| ------------------------- | ----------------------------- |
| `Calls.AccessMedia.All`   | Access media streams in calls |
| `Calls.JoinGroupCall.All` | Join group calls and meetings |
| `Calls.Initiate.All`      | Initiate outbound calls       |

### 2. Grant Admin Consent

In the App Registration, go to **API permissions** and click **Grant admin consent for [tenant]**. All three permissions must show "Granted" status.

### 3. Create Azure Bot Resource

1. Create an [Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) linked to the App Registration above.
2. In the bot's **Channels** settings, enable the **Microsoft Teams** channel.
3. Under the Teams channel configuration, enable **Calling** and set the calling webhook URL to your worker's callback endpoint (e.g., `https://your-worker-fqdn/api/calling`).

### 4. Deploy a Windows VM

1. Create a Windows Server VM in Azure. **Standard_D2s_v3** (2 vCPUs, 8 GB RAM) is recommended as a starting point.
2. Install .NET 6 SDK or runtime on the VM.
3. Ensure the VM has a **public IP address** and a registered FQDN with a valid SSL certificate. The Real-Time Media SDK requires HTTPS for signaling and a publicly reachable endpoint for media.

### 5. Build the Media Worker

Clone the media worker repository onto the VM and build it:

```bash
dotnet publish -c Release -o ./publish
```

### 6. Configure Networking

The worker requires two open ports:

| Port  | Protocol | Purpose                       |
| ----- | -------- | ----------------------------- |
| 9442  | TCP      | gRPC (OpenClaw communication) |
| 10000 | UDP      | Media (audio streams)         |

Configure the Azure NSG (Network Security Group) and Windows Firewall to allow inbound traffic on both ports. The VM must be reachable from both OpenClaw (gRPC) and Microsoft's media relay servers (UDP).

### 7. Run the Worker

Start the worker with the required parameters:

```bash
./MediaWorker.exe \
  --grpc-port 9442 \
  --media-port 10000 \
  --callback-url "https://your-worker-fqdn/api/calling" \
  --service-fqdn "your-worker-fqdn" \
  --app-id "<APP_ID>" \
  --app-secret "<APP_SECRET>" \
  --tenant-id "<TENANT_ID>"
```

Verify the worker is running by checking the health endpoint:

```bash
curl https://your-worker-fqdn:9442/health
```

## Connect OpenClaw to Your Worker

Add the voice worker configuration to your OpenClaw config:

```yaml
channels:
  msteams:
    enabled: true
    appId: "your-app-id"
    appPassword: "your-app-secret"
    tenantId: "your-tenant-id"
    voice:
      enabled: true
      workerAddress: "your-worker-ip:9442"
      sttProvider: "openai-realtime"
      transcriptFallback: "tenant-wide"
```

### Capability Negotiation

OpenClaw automatically detects what is available and negotiates the highest supported tier:

1. **Worker reachable** -- `live_voice` mode. Real-time join, listen, speak.
2. **Worker unreachable, Graph transcripts available** -- `transcript_mode`. Post-meeting summaries only.
3. **Neither available** -- `text_only`. Standard text bot functionality.

This negotiation happens at gateway startup and on each meeting join attempt. If the worker goes down mid-session, OpenClaw logs the failure and falls back gracefully.

## What Works Without a Worker

Everything except real-time voice works without a Windows worker:

- **Text messaging** -- DMs, group chats, channel messages, @mentions.
- **File handling** -- attachments in DMs, SharePoint-based file sharing in channels.
- **Polls** -- Adaptive Card-based polls with vote tracking.
- **Adaptive Cards** -- arbitrary card sends to any conversation.
- **Post-meeting transcript processing** -- summaries, action items, follow-ups generated from Graph meeting transcripts.

### Transcript Modes

Transcript processing supports two modes, depending on your permission model:

| Mode            | Scope                                          | Permissions Required                                                       |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| **RSC**         | Private-chat meetings (where app is installed) | RSC `OnlineMeeting.ReadBasic.Chat`                                         |
| **Tenant-wide** | All meetings and ad hoc calls                  | Application `OnlineMeetingTranscript.Read.All` + application access policy |

Tenant-wide mode requires an [application access policy](https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy) granting your app permission to access meeting transcripts.

## Security and Permissions

### Permission Modes

Three permission configurations are available, each with different scope and security tradeoffs:

**1. RSC Join + Admin Media (default)**

- RSC permissions handle meeting join (scoped to installed teams/chats).
- Tenant-wide `Calls.AccessMedia.All` for media access.
- Best balance of scoped access and functionality.

**2. Tenant-wide**

- Full organization-wide permissions for all call and media operations.
- Simplest to configure but broadest access scope.
- Required permissions: `Calls.AccessMedia.All`, `Calls.JoinGroupCall.All`, `Calls.Initiate.All`.

**3. RSC-only**

- All permissions scoped to RSC (no tenant-wide grants).
- Most restrictive but currently pending validation. Not yet recommended for production.

### Compliance

The Real-Time Media SDK requires `updateRecordingStatus` to be called when the bot is actively processing audio. This is not optional:

- A **recording indicator** appears in the Teams meeting UI for all participants.
- The tenant must have **Teams policy-based recording** configured to allow application-hosted media bots.
- Failure to call `updateRecordingStatus` results in the media session being rejected.

See [Microsoft's compliance recording documentation](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-policy) for policy configuration.

## Teams App Manifest

The manifest template at `extensions/msteams/manifest/manifest.template.json` must be updated for voice support. Key additions beyond the standard text bot manifest (see [Microsoft Teams](/channels/msteams#example-teams-manifest-redacted)):

- **`supportsCalling: true`** in the `bots` array entry.
- **`webApplicationInfo`** with the app ID for RSC token acquisition.
- **RSC permissions** in the `authorization` block for meeting and call access.

Replace the placeholders before building the manifest ZIP:

| Placeholder                  | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `{{APP_ID}}`                 | Your Azure App Registration application ID |
| `{{NGROK_SIGNALING_DOMAIN}}` | Signaling endpoint domain (HTTPS)          |
| `{{NGROK_CALLING_DOMAIN}}`   | Calling/media endpoint domain              |

Example manifest additions for voice:

```json5
{
  bots: [
    {
      botId: "{{APP_ID}}",
      scopes: ["personal", "team", "groupChat"],
      supportsCalling: true,
      supportsVideo: false,
      supportsFiles: true,
    },
  ],
  webApplicationInfo: {
    id: "{{APP_ID}}",
  },
  authorization: {
    permissions: {
      resourceSpecific: [
        // Existing RSC permissions...
        { name: "OnlineMeeting.ReadBasic.Chat", type: "Application" },
      ],
    },
  },
}
```

## Local Development

Development setup varies by platform:

**Windows developers:**

Full local end-to-end testing is possible. Use ngrok to expose both HTTP (signaling) and TCP (media) endpoints:

```bash
# HTTP tunnel for Bot Framework signaling
ngrok http 3978

# TCP tunnel for media (separate ngrok process)
ngrok tcp 10000
```

Update the Azure Bot messaging endpoint and the worker's callback URL to use the ngrok URLs.

**Mac/Linux developers:**

Run OpenClaw and the TypeScript codebase locally. Connect to a remote Azure Windows VM running the media worker. This gives you a fast local development loop for the orchestration layer while the worker handles the platform-specific media stack.

**Bot Framework Emulator:**

The Bot Framework Emulator does **not** support app-hosted media calls. It cannot simulate the Real-Time Media SDK. Use a real Teams client with a deployed worker for voice testing.

## Troubleshooting

**Worker unreachable:**

- Verify the gRPC address and port in `voice.workerAddress` match the running worker.
- Check Azure NSG rules and Windows Firewall for port 9442 (gRPC) and 10000 (media).
- Test the worker health endpoint: `curl https://worker-fqdn:9442/health`.

**Compliance denied:**

- Verify Teams policy-based recording is configured in the Teams admin center.
- Confirm `updateRecordingStatus` is being called (check worker logs).
- Ensure the app has `Calls.AccessMedia.All` with admin consent granted.

**Media SDK version:**

- The Real-Time Media SDK must be kept current. Microsoft deprecates SDK versions older than approximately 3 months.
- Older SDK versions stop working without warning. Update the worker regularly.

**No audio:**

- Confirm the worker is running in unmixed audio mode.
- Verify the compliance gate reached "active" status in worker logs.
- Check that the media port (UDP 10000) is reachable from Microsoft's media relay servers.

## FAQ

**Can I run Teams live voice on Mac or Linux?**

OpenClaw itself runs on any platform. The media worker must run on Windows. Deploy the worker on a Windows VM in Azure and connect OpenClaw to it from any OS.

**Can I self-host everything?**

Yes. Run OpenClaw on any platform you choose. Run the media worker on a Windows VM you control. No cloud dependency beyond Azure AD for Teams authentication.

**What happens without a worker?**

OpenClaw operates in text and transcript mode. You get full text messaging, file handling, polls, adaptive cards, and post-meeting transcript processing. Live voice (joining meetings to listen and speak in real time) is not available.

**Why is there a recording indicator in Teams?**

Microsoft requires all application-hosted media bots to call `updateRecordingStatus`. This triggers the recording indicator in the Teams meeting UI. It is a compliance requirement, not an OpenClaw design choice.
