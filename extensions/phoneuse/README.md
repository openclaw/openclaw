# Phoneuse for OpenClaw

Optional integration for [lxe/phoneuse](https://github.com/lxe/phoneuse): see and
operate a locally paired, unmodified iPhone from a Linux desktop. The plugin
contributes the upstream stdio MCP server and a phone-operation skill. It does
not install Phoneuse, change Bluetooth/firewall settings, or enable itself.

## Scope and cost

Evaluated on November 8, 2026 against upstream commit
[`6bce214`](https://github.com/lxe/phoneuse/tree/6bce214f3dba4a79c2a273c63d6bab4789493d05).
Upstream describes this as a technology demo under heavy construction, tested
on one iPhone 17 Pro running iOS 26, Arch Linux, Hyprland, and an NVIDIA GPU.

| Area        | Verified upstream capability / limitation                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device      | A real iPhone; AirPlay receives the screen, Bluetooth HID sends mouse/keyboard input. No jailbreak, developer account, or on-phone app required for this route.                                                                                                                                                                                                        |
| Observation | Screenshots and local OCR/grounding; MCP actions normally return a screenshot strip plus text. Text-only observation is supported, but the default is **not** screenshot-free.                                                                                                                                                                                         |
| Actions     | Tap, text-target tap, long press, swipe, scroll, type, key shortcuts, app launch, navigation, owner-approved unlock, session handback.                                                                                                                                                                                                                                 |
| Host        | Linux with BlueZ, Hyprland IPC, UxPlay, GStreamer, GTK4, Python, and supporting packages. Mac, Windows, Android/ADB, and USB control are not delivered by the inspected integration.                                                                                                                                                                                   |
| Reliability | Best-effort UI control, not an application API. No exposed frame-age token, transaction receipt, or idempotency key. An acknowledged HID action is not a verified app outcome.                                                                                                                                                                                         |
| License     | Upstream code is [MIT](https://github.com/lxe/phoneuse/blob/6bce214f3dba4a79c2a273c63d6bab4789493d05/LICENSE); dependencies and downloaded model weights have their own licenses. No upstream source is vendored here.                                                                                                                                                 |
| Cost        | No Phoneuse service subscription is required by this local code path. You still supply a phone, compatible Linux host/Bluetooth adapter, Wi-Fi, electricity, setup and maintenance, local OCR/grounding compute/model downloads, and an OpenClaw agent model (local resources or provider charges). There is no included hosted phone fleet, SLA, or managed recovery. |

This establishes a local phone-control building block, **not** feature parity
with an unnamed commercial service. Compare a specific service’s documented
devices, hosting, privacy, concurrency, reliability, support, and current pricing
before describing it as an equivalent free replacement.

## Setup (operator action required)

1. Review upstream’s [README](https://github.com/lxe/phoneuse/blob/6bce214f3dba4a79c2a273c63d6bab4789493d05/README.md),
   [architecture](https://github.com/lxe/phoneuse/blob/6bce214f3dba4a79c2a273c63d6bab4789493d05/ARCHITECTURE.md),
   and [recipes](https://github.com/lxe/phoneuse/blob/6bce214f3dba4a79c2a273c63d6bab4789493d05/docs/RECIPES.md).
   Follow its dependency, AssistiveTouch, pairing, and AirPlay setup on the
   **phone-connected desktop**, not a remote headless Gateway.
   Upstream installation uses sudo and changes bluetoothd so the PC stops
   accepting its own Bluetooth keyboards/mice; review that tradeoff first. It
   also documents AirPlay firewall ports and an uninstall procedure.
2. Review and run upstream `scripts/setup-mcp.sh` in your Phoneuse checkout.
   It creates `.venv-mcp` with system packages and installs `mcp>=2.3` using uv.
   Keep that checkout and its environment available; this plugin never downloads
   or executes an installer. Make `bin/phoneuse-mcp` available on the Gateway’s
   PATH, or use the absolute command override below.
3. Start upstream `phoneuse up`, pair the intended phone, and select PhoneUse
   in the iPhone’s Screen Mirroring menu. Run OpenClaw as the desktop user with
   access to its runtime sockets/display. A Gateway on another machine cannot
   reach the local phone merely by enabling this plugin.
4. Enable the plugin deliberately in your OpenClaw configuration. Merge, do not
   replace, existing plugin allowlists and tool policy:

```json5
{
  plugins: { entries: { phoneuse: { enabled: true } } },
  // Optional: overrides the manifest default command "phoneuse-mcp".
  mcp: {
    servers: {
      phoneuse: {
        transport: "stdio",
        command: "/home/you/phoneuse/bin/phoneuse-mcp",
      },
    },
  },
}
```

The command is local stdio, not an unauthenticated HTTP control endpoint.
`mcp.servers.phoneuse` replaces the plugin default; `{ enabled: false }`
disables it. An explicitly configured MCP server is independent of the plugin:
if you add the override and later disable the plugin, also disable/remove that
server to stop connecting. Session server/tool denials and normal OpenClaw tool
policy still apply. Use Settings → MCP and the chat’s Plugins → Tool access to
inspect access; do not broaden policies just to make the server callable.

The upstream launcher discovers the desktop runtime directory and Wayland
display when absent. If it cannot, configure the actual desktop environment
through the existing MCP `env` field; do not copy another user’s runtime path.
No phone passcode or pairing key belongs in OpenClaw config. Upstream owns its
local pairing trust and optional passcode storage; unlock still requires the
owner’s local approval. Screen data returned to the agent may reach its model
provider: consider the selected model before exposing personal apps.

## Verify and operate

```sh
openclaw plugins inspect phoneuse
openclaw mcp doctor phoneuse --probe
```

Inspection proves metadata; probing proves MCP initialization/discovery, not a
working phone or a safe action. In a fresh agent turn, load the Phoneuse skill
and ask for a read-only `status` and `look` before any action. Keep the normal
per-action approval rules for sends, purchases, deletion, and security changes.
Use `end_session` to return control when done.

### Disconnects and uncertain actions

The skill requires observe → act once → verify. Upstream can return `ok` for an
action followed by an observation error in the **same successful MCP response**.
An unchanged or cached frame also does not prove the action failed. A timeout,
cancellation, dropped AirPlay stream, or lost MCP response leaves the effect
unknown: stop mutations; never blindly replay. Restore the link, obtain a new
observation, and reconcile the app outcome before any new attempt. If freshness
or the outcome cannot be established, ask the owner to check the phone.

OpenClaw’s MCP owner handles process lifecycle and reconnects; this plugin adds
no retry loop, transport, credential store, or persistent action ledger. The
skill is guidance, not a freshness interlock or exactly-once execution guarantee.
A model can ignore guidance, and a native harness owns its own MCP behavior.
Do not rely on this demo for unattended high-stakes transactions.

## Validation and remaining hardware proof

`node scripts/run-vitest.mjs src/plugins/phoneuse.test.ts --maxWorkers=1` exercises
the real manifest/config/MCP owners: disabled-by-default discovery, operator and
session disablement, an explicit command override, an accepted tool request with
a lost stdio response, and reconnect for a separate observation without replaying
the action. The MCP peer is synthetic; it does **not** run upstream Python, OCR,
Bluetooth, AirPlay, or a physical phone, and it does not prove agent compliance.

Before real use, an operator should verify on their hardware:

- `status` and `look` reflect the intended phone; text-only and image results agree.
- A benign app navigation action returns the expected screen.
- Interrupt AirPlay immediately after one benign tap, then restore it. Determine
  on the phone whether the tap happened **before considering any retry**. Verify
  the agent reports uncertainty and does not act on an old frame.
- Stop/restart the MCP process after a received action but before its response;
  verify no duplicate action and explicitly reconcile after reconnect.
- Owner takeover and `end_session` return control; unlock requires local approval.

No physical iPhone verification is claimed by the repository tests.
