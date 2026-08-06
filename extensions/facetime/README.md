# OpenClaw FaceTime

This directory is the canonical source for the experimental FaceTime voice
plugin for OpenClaw agents. The plugin ships separately from the OpenClaw core
package as `@openclaw/facetime`.

It combines call control, OpenClaw agent consultation, and the audio path proven
on macOS 26.4:

```text
caller -> FaceTime or Phone -> Core Audio process tap -> OpenClaw Realtime
caller <- FaceTime or Phone <- OpenClaw-Mic <- OpenClaw-Feed <- OpenClaw Realtime
```

The injected FaceTime helper owns call events, answering, transmission, and hangup. The Swift capture helper accepts only Apple-signed FaceTime, Phone, or `avconferenced` identities and taps the single process reporting active audio output. Model speech is written to the output-only `OpenClaw-Feed`, then mirrored by the paired driver to the input-only `OpenClaw-Mic` selected in the call app.

This avoids the duplex BlackHole route that current FaceTime Voice Processing suppresses. The plugin never changes the Mac's default input or output devices.

## Beta status and security boundary

This is an experimental private-API plugin for a dedicated Apple Silicon Mac.
It injects an authenticated helper into FaceTime and Phone, captures call audio,
and gives allowlisted callers the configured OpenClaw agent's owner-level
workspace and tools. Read the [SIP requirement](#system-integrity-protection-requirement)
and [access-control model](#identity-and-access-control) before enabling it.

The package requires OpenClaw `>=2026.7.2-beta.8`, the first planned release
line containing owner-authorized realtime consultation. Earlier betas do not
export the authorization contract this plugin requires and are rejected at
startup rather than silently reducing caller privileges.

## Requirements

| Requirement       | Supported or tested state                                                          |
| ----------------- | ---------------------------------------------------------------------------------- |
| Hardware          | Apple Silicon only                                                                 |
| macOS API floor   | macOS 14.4 or later                                                                |
| Live-tested host  | macOS 26.4                                                                         |
| OpenClaw          | Host plugin API `>=2026.7.2-beta.8`                                                |
| Node.js           | `22.22.3`, `24.15.0`, `25.9.0`, or a later compatible release in those lines       |
| Build tools       | Full Xcode at `/Applications/Xcode.app`; Command Line Tools alone are insufficient |
| Runtime tools     | SoX                                                                                |
| Apple services    | FaceTime signed in for the logged-in macOS user                                    |
| Realtime provider | OpenAI Platform API key with Realtime API access                                   |
| Call policy       | Consent from everyone before capturing or processing audio                         |

FaceTime video uses FaceTime. On the live-tested macOS 26.4 route, FaceTime
Audio uses Phone. Treat other macOS versions as unverified until both call types
pass the live acceptance procedure.

## Quick start

Install the official package, then enable it explicitly:

```sh
brew install sox
openclaw plugins install @openclaw/facetime
openclaw plugins enable facetime
```

The plugin is experimental and disabled by default. Installation does not
change SIP, install the audio driver, grant macOS permissions, or start
accepting calls. Complete the configuration and setup checks below before
placing a call.

To test a source checkout before the first package release, run from the
OpenClaw repository root:

```sh
pnpm install --frozen-lockfile
openclaw plugins install --link "$PWD/extensions/facetime" --force
openclaw plugins enable facetime
```

`--force` confirms that you reviewed and trust the linked local source. It does
not bypass OpenClaw's install policy or other safety checks.

## Configure OpenClaw

Merge this entry into your OpenClaw configuration. Do not replace existing
values in `plugins.allow`; add `facetime` alongside the plugins already there.

```json5
{
  plugins: {
    allow: ["facetime"],
    entries: {
      facetime: {
        enabled: true,
        config: {
          whitelistHandles: ["owner@example.com"],
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

Every `whitelistHandles` entry is an authenticated owner identity. Use the
exact email addresses and E.164 phone numbers FaceTime reports for you. Do not
add a guest or anyone who should have reduced privileges.

OpenAI Realtime uses Platform API billing. A ChatGPT subscription or Codex
OAuth login does not replace a Platform API key. The plugin resolves an
OpenAI key from its plugin-scoped `apiKey` SecretRef, the configured OpenClaw
OpenAI model provider, or `OPENAI_API_KEY`. Use `openclaw configure` to store
the credential through OpenClaw's supported secret path. Do not put a plaintext
key in committed configuration.

`gpt-realtime-2.1` is the default. There is currently no automatic model
fallback, so configure another OpenAI Realtime model explicitly if your account
does not have access to it.

Restart and inspect the live plugin:

```sh
openclaw gateway restart
openclaw plugins inspect facetime --runtime --json
openclaw gateway call facetime.setup --json
```

Older local builds used `plugins.entries.facetime.config.audio` for duplex
BlackHole routing. That property is retired. `openclaw doctor --fix` removes
only that obsolete object and preserves the rest of the FaceTime configuration.

## Prepare the audio path

On first activation, the plugin builds and signs the Core Audio process-tap
helper from packaged Swift source. For source development, build it explicitly
from the OpenClaw repository root:

```sh
pnpm --dir extensions/facetime build:capture
```

OpenClaw installs npm plugins with lifecycle scripts disabled. On first plugin activation, the plugin checks for this helper and builds it from the packaged Swift source when missing. Xcode must therefore remain installed on the OpenClaw Mac. The explicit command above is useful for setup verification and development.

Install the pinned BlackHole v0.7.1 source as the paired OpenClaw driver:

```sh
openclaw gateway call facetime.installDriver --json
system_profiler SPAudioDataType | grep -E 'OpenClaw-(Mic|Feed)'
```

This idempotent setup action builds the driver locally when needed, presents the
normal macOS administrator prompt, verifies the installed bundle, and restarts
Core Audio only when the installed recipe is missing or stale. The plugin
rejects the action during an active or pending managed call. You can inspect it
without changing the system:

```sh
openclaw gateway call facetime.driverStatus --json
```

`facetime.installDriver` acknowledges as soon as setup starts so the gateway
call does not time out while the administrator prompt is open. Follow
`driverInstall.phase` in `facetime.status`; it becomes `succeeded` or `failed`
when setup finishes.

For source development, `pnpm --dir extensions/facetime build:driver` and
`pnpm --dir extensions/facetime install:driver` invoke the same build and
installation path.

The first process-tap check prompts for Screen & System Audio Recording permission. Grant it to the app that runs OpenClaw, quit that app completely, reopen it, and rerun preflight.

## Driver licensing boundary

The generated `OpenClawBridge.driver` is a separate modified build of GPL-3.0 BlackHole. It is ignored by Git and excluded from the npm package. The build script pins and verifies the upstream archive, then records the changed identity, device names, visibility, and input/output capabilities in its compiler flags.

Do not commit or silently distribute the generated driver. Distribution requires compliance with BlackHole's GPL-3.0 terms, a separate license from Existential Audio, or a replacement driver with a compatible license.

The persistent OpenClaw gateway now owns helper preparation and injection. On
startup it builds the signed helper from packaged source when missing or stale,
opens FaceTime and Phone in the background if needed, injects each process, and
retries with bounded backoff whenever an authenticated helper disconnects.
There is no separate LaunchAgent and no CocoaPods dependency, so plugin updates
and removal cannot leave a stale helper service behind.

### System Integrity Protection requirement

The plugin intentionally uses the same kind of private-API deployment boundary
as `imsg`: an injected helper reaches call control that macOS does not expose
through public APIs. FaceTime and Phone are protected Apple apps, so LLDB cannot
attach while SIP debugging restrictions remain enabled.

**Changing SIP is a real security tradeoff.** Debugger attachment to protected
processes increases the attack surface of the whole Mac. Use a dedicated
OpenClaw Mac, keep it patched and physically controlled, and do not install
unrelated software on it. The plugin detects this state but never changes it.

The verified FaceTime configuration is narrower than the full SIP disablement
commonly used by `imsg`. It leaves the other SIP protections enabled and
disables only debugging restrictions:

1. Shut down the Apple Silicon Mac.
2. Hold the power button until startup options appear.
3. Choose Options, authenticate, and open Terminal from the Utilities menu.
4. Run:

```sh
csrutil enable --without debug
```

5. Reboot and verify:

```sh
csrutil status
```

The output must report `Debugging Restrictions: disabled`. A full
`csrutil disable`, a Library Validation override, and custom boot arguments
were not required in the successful macOS 26.4 acceptance run. Do not weaken
additional system protections to work around an injection failure.

Enable Developer Tools mode once from an interactive Terminal before the first
automatic injection:

```sh
sudo /usr/sbin/DevToolsSecurity -enable
```

macOS can also request permission for the OpenClaw host to control developer
tools the first time LLDB attaches. Grant that prompt once.

If you do not accept the SIP tradeoff, leave debugging restrictions enabled and
do not enable this plugin. Unlike `imsg` basic mode, FaceTime has no public-API
fallback for monitoring, answering, dialing, or controlling calls. Setup will
remain `action-required`, and the helper will not attach.

To return the dedicated Mac to standard SIP policy later, boot into Recovery,
run `csrutil enable`, and reboot. The FaceTime plugin will stop working until
debugging restrictions are disabled again.

Manual build and injection commands remain available for development or
recovery:

```sh
pnpm --dir extensions/facetime build:helper:macabi
pnpm --dir extensions/facetime inject:helper
pnpm --dir extensions/facetime inject:helper:phone
```

If a non-interactive agent owns the terminal, use:

```sh
pnpm --dir extensions/facetime inject:helper:terminal
```

Each helper connects to `127.0.0.1` on `45670 + uid - 501`. The connection is
authenticated with a locally generated key. FaceTime owns
incoming video calls, while Phone owns incoming FaceTime Audio calls on the
live-tested macOS 26.4 route.

## Identity and access control

The Realtime voice layer derives its identity and persona from the configured
agent's `IDENTITY.md`, `USER.md`, and `SOUL.md`. Delegated turns use that same
agent, `sessionKey`, full workspace context, memory, tools, and approval
policies. The plugin does not maintain a separate "Lobster" persona or a second
privilege model.

Inbound callers are admitted only when the canonical FaceTime handle matches
`whitelistHandles`. An admitted caller is marked `senderIsOwner: true`, and
owner tool policy is available only for that allowlisted call. Unknown callers
are rejected before a Realtime or delegated-agent session starts. Outbound
calls are restricted to the same allowlist and also require a trusted one-shot
OpenClaw plugin approval.

## Route FaceTime or Phone

Set this route once in the app that owns the call:

- microphone: `OpenClaw-Mic`
- output: physical speakers or headphones
- macOS system input: any physical microphone
- macOS system output: any physical device

FaceTime video calls use FaceTime. On macOS 26.4, FaceTime Audio calls use
Phone. The native process tap first suppresses the call app's hardware
playback, then the helper answers with the uplink muted. Only after answer does
the plugin connect the Realtime provider, verify that `OpenClaw-Mic` is the
active call process's only input device and that its outputs are physical, and
enable transmission. This keeps provider startup latency out of the
incoming-call answer path. The plugin keeps re-resolving the audio owner and
checking both routes during the call, then hangs up if anything changes.

Do not select an Aggregate, Multi-Output, BlackHole, `OpenClaw-Feed`, or `OpenClaw-Mic` device as the call output.

For unattended inbound calls on a remotely managed Mac:

- Keep Focus off, or configure the active Focus to allow the expected caller.
- In System Settings > Notifications, set "when mirroring or sharing the
  display" to "Allow Notifications." macOS otherwise rejects an incoming call
  through its DND filter before the injected helper can observe or answer it.
- If Phone diverts filtered calls before the helper can answer, turn off Live
  Voicemail in Phone > Settings > Calls while diagnosing the route.

The Core Audio process tap starts before auto-answer and uses per-process mute behavior. Caller audio is still captured for OpenClaw, but the call process sends nothing to speakers or headphones. This suppression follows the process across volume and default-output changes and does not change the Mac's global mute state.

If provider startup, routing, helper control, or carrier hangup fails after answer, the plugin immediately stops model input and speech, safety-mutes both call directions, retains the process tap, and retries hangup instead of dropping local protection around a still-connected call.

## Preflight and live test

Start the OpenClaw gateway with the plugin enabled, then run:

```sh
openclaw gateway call facetime.setup --json
```

The guided setup report checks the full Xcode installation, developer-tools
access, SIP debugging restrictions, the paired audio driver, automatic helper
injection into FaceTime and Phone, Focus, notification behavior while the
display is shared, and all preflight checks below. It returns machine-readable
actions for anything that still needs attention.

Safe repairs happen automatically when the plugin runtime starts: native
artifacts are built when missing, FaceTime and Phone are launched, and the
authenticated helper is injected and supervised. Protected macOS changes are
never applied silently:

- Install or update the audio driver with `facetime.installDriver`. macOS may
  request administrator approval and Core Audio restarts after installation.
- Grant Screen & System Audio Recording in System Settings when requested.
- Enable developer tools access with
  `sudo /usr/sbin/DevToolsSecurity -enable` if setup reports it disabled.
- Disable only SIP debugging restrictions from macOS Recovery after accepting
  the security tradeoff. The plugin detects the state but never changes it.
- Turn off Focus and allow notifications while mirroring or sharing the
  display for unattended incoming calls.

FaceTime sign-in and the final per-process audio route do not have supported
macOS readiness APIs. The report marks those checks as `verify-on-call` until a
live call proves caller audio, assistant audio, and Mac speaker suppression.

For the lower-level audio preflight alone, run:

```sh
openclaw gateway call facetime.preflight --json
```

Required checks cover:

- helper connection
- SoX
- signed capture helper
- FaceTime or Phone process
- `OpenClaw-Mic` and `OpenClaw-Feed`
- physical system output
- live Core Audio process tap and TCC permission
- `OpenClaw-Feed` to `OpenClaw-Mic` signal
- Realtime provider credentials

The call-specific `OpenClaw-Mic` check happens when the actual FaceTime or Phone audio process becomes active.

Start an allowlisted outbound audio call from the OpenClaw Mac:

```sh
openclaw gateway call facetime.dial \
  --params '{"handle":"user@example.com","mode":"audio"}' \
  --json
```

Use `"mode":"video"` for a FaceTime video call. The injected helper creates a
native dial request with the macOS confirmation UI disabled, so this works when
the call app's window is off-screen. The target must match `whitelistHandles`,
and the plugin rejects a second dial while a call or outbound request is active.
The result includes an immediate `dialID` and uses `state: "pending"` when macOS
accepts the dial before assigning its call UUID. The helper stamps that ID into
the native call for exact cancellation and helper-restart recovery, then
correlates the UUID from the outgoing event.

Alternatively, place a whitelisted call manually and inspect status:

```sh
openclaw gateway call facetime.status --json
```

An active call should report `audioReady: true`, `realtimeActive: true`, `processOutputSuppressed: true`, and the paired transport names.

Send a deterministic test phrase through the same output-only path:

```sh
openclaw gateway call facetime.testAudio \
  --params '{"phrase":"This is OpenClaw speaking through FaceTime."}' \
  --json
```

Run the guided acceptance sequence with the user present:

```sh
extensions/facetime/scripts/live-acceptance.sh
```

Hang up through OpenClaw:

```sh
openclaw gateway call facetime.hangup --json
```

During a live realtime call, the authenticated caller can also say “hang up”
or “end this call.” The realtime voice model receives a call-scoped control
that ends the current carrier directly, without starting a separate agent turn
or asking for confirmation.

## Agent tool and skill

The plugin bundles a `facetime` skill and registers the `facetime_call` tool so
OpenClaw agents can inspect readiness and manage calls without shell commands.
The available actions are:

- `get_status`
- `check_readiness`
- `initiate_call`
- `end_call`

Outbound calls require an allowlisted handle and a trusted, one-shot OpenClaw
plugin approval. Persistent approval is intentionally unavailable. Driver
installation, SIP changes, FaceTime sign-in, TCC permissions, and System
Settings remain operator-only.

Agents using a restrictive tool profile must also allow the tool explicitly:

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

## Development checks

```sh
node scripts/run-vitest.mjs extensions/facetime
node scripts/lib/plugin-npm-runtime-build.mjs extensions/facetime
pnpm --dir extensions/facetime build:capture
pnpm --dir extensions/facetime build:helper:macabi
bash -n extensions/facetime/scripts/*.sh
bash extensions/facetime/scripts/test-native.sh
(cd extensions/facetime && npm pack --dry-run)
```

Generated `dist/` and `native/.build/` outputs are ignored. Helper and driver
artifacts are built into user cache or application-support directories. The npm
package includes the TypeScript build, native capture source, helper source, and
setup scripts, but excludes generated native binaries and GPL driver artifacts.

## Current limits

- This is a dedicated AI side of a private call. Selecting `OpenClaw-Mic` replaces the Mac's physical microphone for that call app.
- One bridged call is supported at a time.
- FaceTime video and Phone-owned FaceTime audio require separate live acceptance passes.
- A live remote participant is required to prove that app-specific routing reaches the caller.
- Realtime model fallback is not automatic.

## License

The original plugin source is available under the [MIT License](LICENSE).
Incorporated and adapted helper source retains its upstream Apache-2.0 and MIT
terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The locally generated `OpenClawBridge.driver` remains a separate modified build
of GPL-3.0 BlackHole. See [Driver licensing boundary](#driver-licensing-boundary)
before distributing any generated driver artifact.
