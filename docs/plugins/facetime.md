---
summary: "Set up FaceTime voice calls with your OpenClaw agent on a Mac"
read_when:
  - You want to configure FaceTime calls with your OpenClaw agent
  - You need to install the native helper and configure Mac audio
title: "FaceTime plugin"
sidebarTitle: "FaceTime (experimental)"
doc-schema-version: 1
---

Connect FaceTime to your OpenClaw agent for two-way voice conversations. The
plugin automatically answers calls from your configured handles and lets your
agent call you with approval. A realtime voice provider handles speech, and your
OpenClaw agent handles requests that need tools or memory.

**Status: experimental, disabled by default.** Run the Gateway and native helper
on the same Mac, in the same signed-in user session. Configure FaceTime under
`plugins.entries.facetime`, not as a messaging channel.

<Warning>
FaceTime integration uses private Apple APIs and injects a helper into Apple call
applications. It requires reduced SIP debugging protections. Use a dedicated,
up-to-date Mac that you physically control. OpenClaw does not change SIP,
developer-tools access, or macOS privacy permissions automatically.
</Warning>

## Requirements

- An Apple Silicon Mac running macOS 14.4 or later.
- OpenClaw 2026.9.4 or later.
- FaceTime signed in to your Apple Account on the Gateway Mac.
- Full Xcode installed at `/Applications/Xcode.app`.
- The FaceTime plugin and matching signed native companion.
- A realtime voice provider with working credentials.
- An administrator account for the audio driver and Mac setup.

Everyone on a call must consent to having their audio processed by the voice
provider.

Keep calls one-to-one. The configured handle authorizes the call; the integration
does not authenticate each speaker or check the membership of a group call. Do
not add other participants to a call with agent tool access.

## Install the plugin and native companion

Run these commands on the Gateway Mac:

```bash
openclaw plugins install @openclaw/facetime
brew install openclaw/tap/openclaw-facetime
```

The native companion is maintained in
[openclaw/openclaw-facetime](https://github.com/openclaw/openclaw-facetime).
Use its matching signed release. If the package or formula is not available,
installation cannot continue until it is published.

## Configure owner identities

Add your FaceTime email address or full international phone number to
`ownerHandles`. Only listed handles can use the integration. Every listed handle
has owner authority; there is no guest tier.

Merge this into your OpenClaw configuration. Preserve existing plugin entries
and add `facetime` to your existing `plugins.allow` list if you use one.

```json5
{
  plugins: {
    allow: ["facetime"],
    entries: {
      facetime: {
        enabled: true,
        config: {
          ownerHandles: ["owner@example.com", "+12065550123"],
          realtime: {
            provider: "openai",
            sessionKey: "main",
            toolPolicy: "owner",
          },
        },
      },
    },
  },
}
```

### Configure voice credentials

The example selects OpenAI for realtime speech. Voice credentials are separate
from your text agent's login. Configure credentials supported by the selected
realtime provider; a text-agent subscription alone may not provide voice access.

Provider authentication uses the agent selected by `realtime.sessionKey`. For
OpenAI, that agent's API-key auth profile can supply voice credentials when no
plugin-specific API key is configured.

For an environment-backed OpenAI API key, merge this additional configuration:

```json5
{
  secrets: {
    providers: {
      voiceenv: { source: "env", allowlist: ["OPENAI_API_KEY"] },
    },
  },
  plugins: {
    entries: {
      facetime: {
        config: {
          realtime: {
            providers: {
              openai: {
                apiKey: { source: "env", provider: "voiceenv", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
      },
    },
  },
}
```

Make `OPENAI_API_KEY` available to the Gateway process, not just your terminal.
You can also reuse an existing file-backed or other supported
[SecretRef](/gateway/secrets) instead of storing the key in configuration.

### Choose the agent and tool access

`realtime.sessionKey` defaults to `main`, which selects the default agent. To
choose another agent, use an agent-qualified key such as `agent:assistant:main`,
replacing `assistant` with its configured ID.

Each call uses a separate consult session. It can inherit context from the
selected source session without adding the call's turns to that chat. The
agent's workspace, tool credentials, and approval policies still apply.

Choose a `realtime.toolPolicy`:

| Value             | Behavior                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `owner` (default) | Use the selected agent's normal tools and approval checks.                                                                           |
| `safe-read-only`  | Limit agent requests to a fixed set of file, search, web-fetch, and memory tools. Other plugin tools are not included automatically. |
| `none`            | Disable agent consults. Voice conversation and call control remain available.                                                        |

Invalid policy values are rejected. Only add your own identities to
`ownerHandles`, even when choosing a restricted tool policy.

### Choose a voice

Set `realtime.provider` explicitly to keep provider selection consistent.
`realtime.model` and `realtime.voice` are optional; when omitted, the selected
provider supplies its defaults. Set a supported voice explicitly if you do not
want to follow changes to the provider's default voice.

If `realtime.provider` is omitted, the registered realtime providers select the
provider automatically. OpenAI is an example here, not the plugin's default.

## Prepare the Mac

After saving your configuration, restart the Gateway and run setup:

```bash
openclaw gateway restart
openclaw gateway call facetime.setup --json
```

Setup reports required actions and can start the native helper, open the call
apps, and attach the helper. It does not dial a call.

### Enable developer-tools access

From an interactive administrator session, run:

```bash
sudo /usr/sbin/DevToolsSecurity -enable
```

### Allow debugger attachment

The native helper needs to attach to FaceTime and Phone. If setup reports that
SIP debugging restrictions block attachment:

1. Shut down the Mac.
2. Hold the power button until startup options appear, then choose **Options**.
3. Open **Utilities > Terminal** in macOS Recovery.
4. Run:

   ```bash
   csrutil enable --without debug
   ```

5. Restart into your normal user session and rerun `facetime.setup`.

This disables SIP's debugging restriction while retaining its other protections.
Do not disable all of SIP or change it to resolve unrelated authentication or
audio-driver errors. If setup cannot determine SIP status, run `csrutil status`
and inspect the result before making changes.

See [FaceTime recovery and removal](/plugins/facetime-recovery) to restore the
standard security settings when you remove the integration.

### Grant permissions and allow incoming calls

Complete macOS permission prompts from the same user session that runs the
Gateway. Check **System Settings > Privacy & Security > Screen & System Audio
Recording** if preflight reports that app-audio capture is blocked.

Setup also checks whether Focus or notification settings can block calls. Allow
FaceTime calls through your active Focus, and enable notifications while sharing
or mirroring the display if setup reports that setting is blocking notifications.

### Install the audio driver

Run the admin-only installer and complete its administrator prompt:

```bash
openclaw gateway call facetime.installDriver --json
openclaw gateway call facetime.driverStatus --json
```

The installer builds a pinned BlackHole-based driver locally using Xcode. It
checks the Xcode installation before building and does not accept a manually
built driver. If installation fails, follow the reported error or the
[driver recovery steps](/plugins/facetime-recovery#recover-a-failed-driver-update).

### Select the call audio devices

In FaceTime, and in Phone when it handles FaceTime Audio, select:

- **Microphone:** `OpenClaw-Mic`.
- **Output:** physical speakers or headphones.

Do not select `OpenClaw-Mic`, `OpenClaw-Feed`, BlackHole, an aggregate device, or a
multi-output device as the call output.

## Inspect and activate

Run setup again after completing the Mac and driver steps, then check audio
readiness:

```bash
openclaw gateway call facetime.setup --json
openclaw gateway call facetime.preflight --json
openclaw gateway call facetime.status --json
```

Resolve reported setup or preflight errors before making a call. These commands
do not dial anyone. `setup` and `preflight` are admin operations that can perform
live setup and audio checks. `status` can inspect an inactive runtime without
opening apps, staging helpers, or starting call audio.

## Verify your first call

Start with FaceTime Audio:

1. Confirm that the receiving device is available and its user consents to the call.
2. Ask your agent to call one of your configured owner handles, then approve
   the outgoing call.
3. Answer on the receiving device and check that you can hear the greeting and
   hold a two-way conversation.
4. Ask the agent to hang up, or end the call yourself.

The agent uses `facetime_call` and requests one-shot approval before dialing.
You can also call the Gateway Mac's FaceTime account from a configured owner
handle.

## Place and end calls

To dial directly as a Gateway operator:

```bash
openclaw gateway call facetime.dial \
  --params '{"handle":"owner@example.com","mode":"audio"}' \
  --json
```

The target must be in `ownerHandles`. Direct dialing requires `operator.write`
access and counts as an explicit operator action.

To end a call and check its status:

```bash
openclaw gateway call facetime.hangup --json
openclaw gateway call facetime.status --json
```

Wait until status shows no active or pending call before starting another.
A hangup acknowledgement means the request was sent, not that the call has
already ended.

A pending outbound dial reserves the call slot, so incoming calls are not
automatically answered until it finishes or its cancellation is confirmed. If a
helper disconnects or reports an uncertain dial outcome, the pending state stays
visible while OpenClaw reconciles the call.

## Update the integration

After updating the plugin and native companion, check `facetime.driverStatus`.
If the driver is outdated, update it from an interactive administrator session:

```bash
openclaw gateway call facetime.updateDriver --json
```

If upgrading a prototype configuration, run `openclaw doctor --fix`. Doctor
migrates `whitelistHandles` to `ownerHandles` and removes the retired
`helperHost`, `helperPort`, and `realtime.brain` settings.

## Remove the integration

End any active call, then run:

```bash
openclaw gateway call facetime.uninstall --json
openclaw plugins disable facetime
```

Follow [FaceTime recovery and removal](/plugins/facetime-recovery) to restart the
Apple call apps, check that the audio devices are removed, and restore SIP.

## Limits

- One managed call at a time.
- FaceTime calls only. Cellular, Wi-Fi Calling/PSTN, emergency, and unrecognized
  call types are rejected, even when the number matches an owner handle.
- Start with FaceTime Audio. Video and Phone-hosted FaceTime Audio remain
  experimental and may behave differently across macOS versions.
- Requests that use the agent's tools can take longer than ordinary voice replies.
- There is no FaceTime-specific realtime model fallback; provider behavior and
  defaults come from the selected realtime provider.

## Troubleshooting

| Symptom                                      | What to check                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin does not start                        | Confirm that it is enabled, `ownerHandles` is nonempty, and the Gateway runs in the signed-in Mac user session.                                        |
| Native helper is missing or rejected         | Install the matching signed, notarized native companion. Do not bypass its signature or protocol checks.                                               |
| Setup reports debugger attachment is blocked | Check developer-tools access and SIP debugging status in [Prepare the Mac](/plugins/facetime#prepare-the-mac).                                         |
| Audio driver installation fails              | Verify full Xcode is installed at `/Applications/Xcode.app`, then follow [driver recovery](/plugins/facetime-recovery#recover-a-failed-driver-update). |
| No greeting or one-way audio                 | Check the microphone and physical output selection in the Apple call app, then rerun setup and preflight.                                              |
| Voice authentication fails                   | Check the selected realtime provider's credentials in the Gateway process. A text-agent login is not sufficient for every voice provider.              |
| Voice changes unexpectedly                   | Set `realtime.provider` and a supported `realtime.voice` explicitly.                                                                                   |
| Voice works but agent tools do not           | Check `realtime.sessionKey`, `realtime.toolPolicy`, and the selected agent's tool credentials and approvals.                                           |
| Slow tool-backed responses                   | Use [Gateway logs](/logging) and [session inspection](/cli/sessions) to distinguish agent response time from tool execution time.                      |
| Call does not end                            | Check `facetime.status` before dialing again. Use the Apple call app to end the call if needed.                                                        |

Remove account identifiers, credentials, and private conversation content before
sharing logs.

## Related

- [Configuration reference](/plugins/reference/facetime)
- [FaceTime recovery and removal](/plugins/facetime-recovery)
- [Plugin management](/plugins/manage-plugins)
- [Secrets](/gateway/secrets)
