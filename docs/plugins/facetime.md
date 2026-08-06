---
summary: "Experimental FaceTime voice carrier for private calls with an OpenClaw agent on a dedicated Mac"
read_when:
  - You want to call an OpenClaw agent through FaceTime
  - You are installing or testing the experimental FaceTime plugin
  - You need the FaceTime plugin SIP, audio-driver, or allowlist requirements
title: "FaceTime plugin"
sidebarTitle: "FaceTime (experimental)"
---

The experimental FaceTime plugin turns a signed-in Apple Silicon Mac into a
private voice carrier for an OpenClaw agent:

```text
caller -> FaceTime or Phone -> Core Audio process tap -> OpenAI Realtime
caller <- FaceTime or Phone <- OpenClaw-Mic <- OpenClaw-Feed <- OpenAI Realtime
```

It can answer allowlisted incoming calls, place approved outgoing calls, carry
full-duplex realtime audio, consult the configured OpenClaw agent with its
workspace and tools, and hang up. FaceTime video calls use the FaceTime app. On
the tested macOS 26.4 route, FaceTime Audio calls use the Phone app.

<Warning>
This plugin uses private Apple APIs and injects a helper into protected Apple
apps. It requires a deliberate reduction in System Integrity Protection. Use a
dedicated, patched, physically controlled Mac and read the SIP section before
enabling it.
</Warning>

## Status and requirements

The plugin is external to the OpenClaw core package, disabled by default, and
currently supports only Apple Silicon Macs.

| Requirement       | Supported or tested state                        |
| ----------------- | ------------------------------------------------ |
| Hardware          | Apple Silicon                                    |
| macOS API floor   | macOS 14.4 or later                              |
| Live-tested host  | macOS 26.4                                       |
| OpenClaw          | `>=2026.7.2-beta.8`                              |
| Build tools       | Full Xcode at `/Applications/Xcode.app`          |
| Runtime tools     | SoX                                              |
| Apple services    | FaceTime signed in for the logged-in macOS user  |
| Realtime provider | OpenAI Platform API key with Realtime API access |

The host floor is security-sensitive. Earlier OpenClaw betas do not export the
owner-authorization contract needed by realtime agent consultations. The
plugin refuses to start on those hosts instead of running calls with reduced or
ambiguous privileges.

## Install

Install SoX and the official plugin package, then enable it explicitly:

```bash
brew install sox
openclaw plugins install @openclaw/facetime
openclaw plugins enable facetime
```

Installation does not change SIP, grant macOS permissions, install the audio
driver, or accept calls. The plugin builds its signed native capture and helper
artifacts from packaged source on first activation. Full Xcode must remain
installed on the Gateway Mac.

## Configure owner access

Add every authenticated FaceTime handle that may call the agent. Use the exact
email addresses and E.164 phone numbers FaceTime reports:

```json5
{
  plugins: {
    allow: ["facetime"],
    entries: {
      facetime: {
        enabled: true,
        config: {
          whitelistHandles: ["owner@example.com", "+12065550123"],
          realtime: {
            provider: "openai",
            model: "gpt-realtime-2.1",
            voice: "marin",
            sessionKey: "main",
            toolPolicy: "owner",
          },
        },
      },
    },
  },
}
```

Every `whitelistHandles` entry is an owner identity, not a guest allowlist.
Accepted calls are marked `senderIsOwner: true`; unknown callers are rejected
before a Realtime or delegated-agent session starts. Outbound calls are limited
to the same list and require a trusted one-shot OpenClaw plugin approval.

The voice layer derives identity and persona from the configured agent's
`IDENTITY.md`, `USER.md`, and `SOUL.md`. Delegated turns use that agent's
workspace context, memory, tools, approval policies, and configured session.
The plugin does not define a separate assistant persona.

OpenAI Realtime uses Platform API billing. ChatGPT subscriptions and Codex
OAuth do not replace a Platform API key. Configure the credential through
OpenClaw's supported secret path with `openclaw configure`. The plugin resolves
the key from its plugin-scoped `apiKey` SecretRef, the configured OpenAI model
provider, or `OPENAI_API_KEY`.

## System Integrity Protection requirement

The helper needs debugger attachment to FaceTime and Phone. The verified setup
does not require fully disabling SIP. It disables only debugging restrictions:

1. Shut down the Apple Silicon Mac.
2. Hold the power button until startup options appear.
3. Choose **Options**, authenticate, and open Terminal from the Utilities menu.
4. Run:

   ```bash
   csrutil enable --without debug
   ```

5. Reboot and verify:

   ```bash
   csrutil status
   ```

The output must report `Debugging Restrictions: disabled`. The successful
macOS 26.4 setup did not require a full `csrutil disable`, a Library Validation
override, or custom boot arguments. Do not weaken additional protections to
work around an injection failure.

Enable Developer Tools access once from an interactive Terminal:

```bash
sudo /usr/sbin/DevToolsSecurity -enable
```

macOS can also ask the OpenClaw host for permission to control developer tools
when the helper first attaches. Grant that prompt once.

If this security tradeoff is unacceptable, leave debugging restrictions
enabled and do not enable the plugin. Unlike the iMessage plugin's basic mode,
FaceTime has no public-API fallback for monitoring, answering, dialing, or call
control.

To restore standard SIP later, boot into Recovery, run `csrutil enable`, and
reboot. FaceTime call control will stop working until debugging restrictions
are disabled again.

## Install the paired audio driver

The plugin uses two paired devices instead of a duplex BlackHole route:

- `OpenClaw-Feed` receives model speech.
- `OpenClaw-Mic` is selected as the call app microphone.

Install and verify the driver:

```bash
openclaw gateway call facetime.installDriver --json
system_profiler SPAudioDataType | grep -E 'OpenClaw-(Mic|Feed)'
```

The setup action builds the pinned driver source locally, presents the normal
macOS administrator prompt, verifies the installed bundle, and restarts Core
Audio only when necessary. Inspect without changing the system:

```bash
openclaw gateway call facetime.driverStatus --json
```

The generated driver is a separate modified build of GPL-3.0 BlackHole. It is
not distributed in the npm package. See the source package's
`THIRD_PARTY_NOTICES.md` and driver licensing notes before distributing any
generated artifact.

## Route the call apps

Configure each app that can own a call:

- microphone: `OpenClaw-Mic`
- output: physical speakers or headphones
- macOS system input: any physical microphone
- macOS system output: any physical device

Do not select Aggregate, Multi-Output, BlackHole, `OpenClaw-Feed`, or
`OpenClaw-Mic` as the call output. The process tap suppresses the call app's
local hardware playback while preserving audio capture, so caller speech does
not play from the unattended Mac.

For unattended incoming calls, keep Focus off or allow the expected caller. In
System Settings > Notifications, set notifications while mirroring or sharing
the display to **Allow Notifications**. Otherwise macOS can reject the call
before the helper observes it.

## Verify setup

Restart the Gateway and run the guided setup report:

```bash
openclaw gateway restart
openclaw plugins inspect facetime --runtime --json
openclaw gateway call facetime.setup --json
```

The report checks Xcode, Developer Tools access, SIP debugging restrictions,
the paired audio driver, helper injection into FaceTime and Phone, Focus,
notification behavior, audio capture, and Realtime credentials. Protected
macOS changes are reported as operator actions and are never applied silently.

FaceTime sign-in and per-process audio routing do not have reliable public
readiness APIs. They remain `verify-on-call` until a live call proves caller
audio, assistant audio, and Mac speaker suppression.

For the lower-level audio checks:

```bash
openclaw gateway call facetime.preflight --json
```

## Place and manage a call

Start an allowlisted outbound audio call:

```bash
openclaw gateway call facetime.dial \
  --params '{"handle":"owner@example.com","mode":"audio"}' \
  --json
```

Use `"mode":"video"` for FaceTime video. Inspect an inbound or outbound call:

```bash
openclaw gateway call facetime.status --json
```

An active, bridged call should report `audioReady: true`,
`realtimeActive: true`, and `processOutputSuppressed: true`. Send a deterministic
audio proof through the same output path:

```bash
openclaw gateway call facetime.testAudio \
  --params '{"phrase":"This is OpenClaw speaking through FaceTime."}' \
  --json
```

Hang up through the Gateway:

```bash
openclaw gateway call facetime.hangup --json
```

During a realtime call, the authenticated caller can also say "hang up" or
"end this call." The voice model receives a call-scoped control that ends the
carrier directly.

## Agent tool

The package includes a `facetime` skill and a `facetime_call` tool with these
actions:

- `get_status`
- `check_readiness`
- `initiate_call`
- `end_call`

Restrictive agent tool profiles must allow the tool explicitly:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: { alsoAllow: ["facetime_call"] },
      },
    ],
  },
}
```

Driver installation, SIP changes, FaceTime sign-in, TCC permissions, and
System Settings remain operator-only.

## Current limits

- One bridged call is supported at a time.
- Selecting `OpenClaw-Mic` replaces the Mac's physical microphone for that app.
- FaceTime video and Phone-owned FaceTime Audio need separate acceptance tests.
- A live remote participant is required to prove actual caller delivery.
- Realtime model fallback is not automatic.

For implementation details, source-development commands, and the full live
acceptance procedure, see
[`extensions/facetime/README.md`](https://github.com/openclaw/openclaw/blob/main/extensions/facetime/README.md).
