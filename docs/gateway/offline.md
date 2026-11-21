---
summary: "Run OpenClaw with local models and no outbound traffic: which settings stop OpenClaw's own requests, which parts stay local, and how to verify it"
read_when:
  - You want OpenClaw to work on a machine with no internet access
  - You want to confirm nothing leaves the host while you use local models
  - You are preparing an air-gapped or privacy-sensitive setup
title: "Offline use"
---

OpenClaw has no single "offline mode" switch. You get offline behavior by combining three things: a local model, a short list of settings that stop OpenClaw's own background requests, and a network rule outside OpenClaw that enforces the result. This page lists the settings that exist today, the local building blocks, and what each one does **not** cover.

<Warning>
These settings reduce what OpenClaw itself sends. They are not an egress guarantee. Agent tools such as `exec` can run any program, and plugins can open their own connections. If nothing may leave the host, enforce that with a firewall or network namespace and [verify it](#verify-that-nothing-leaves-the-host).
</Warning>

## Prepare while you are online

Everything below must already be on disk before you disconnect. OpenClaw does not install dependencies at runtime.

- A local chat model and its server. See [Local models](/gateway/local-models) and [Local model services](/gateway/local-model-services).
- Local embeddings, if you use memory search. The `local` provider needs its GGUF file downloaded first. See [Builtin memory](/concepts/memory-builtin).
- A local speech-to-text binary, if you transcribe audio. See [Audio and voice notes](/nodes/audio).
- Every plugin you need. Installing a plugin or skill fetches it from a registry.
- On a Mac, the [Apple Foundation Models](/plugins/apple-fm) plugin needs Apple Intelligence enabled with its model downloaded, plus the Apple Swift developer tools on first discovery.

## Stop OpenClaw's own requests

| Traffic                          | Setting                                                      | Effect                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update checks and update notices | `update.checkOnStart: false` or `OPENCLAW_NO_AUTO_UPDATE=1`  | Stops the daily check against `telemetry.openclaw.ai`, update-outcome reports, feature statistics, and update notices. Headless node auto-update stops too.                                                                                                            |
| Anonymous feature statistics     | `telemetry.enabled: false` or `DO_NOT_TRACK=1`               | Off by default. Does **not** stop the daily update check; use the row above for that. See [Usage telemetry](/gateway/telemetry).                                                                                                                                       |
| Hosted model catalog refresh     | `models.catalogRefresh.enabled: false`                       | Disables all remote model catalog traffic. OpenClaw keeps using the bundled catalog.                                                                                                                                                                                   |
| Web search                       | `tools.web.search.enabled: false`                            | Removes the managed `web_search` tool.                                                                                                                                                                                                                                 |
| Web fetch                        | `tools.web.fetch.enabled: false`                             | Removes the `web_fetch` tool.                                                                                                                                                                                                                                          |
| Link understanding               | `tools.links.enabled: false`                                 | Stops automatic fetching and summarizing of URLs in messages.                                                                                                                                                                                                          |
| LAN advertising                  | `discovery.mdns.mode: "off"` or `OPENCLAW_DISABLE_BONJOUR=1` | Stops multicast mDNS advertising. See [Bonjour discovery](/gateway/bonjour).                                                                                                                                                                                           |
| Tailscale exposure               | `gateway.tailscale.mode: "off"`                              | Already the default. See [Gateway configuration](/gateway/config-gateway).                                                                                                                                                                                             |
| Messaging channels               | `channels.<id>.enabled: false` for every channel             | A channel with no `enabled` field counts as enabled, and credentials can come from the Gateway environment (for example `TELEGRAM_BOT_TOKEN`), so deleting `channels.<id>` does not reliably stop it. Use the Control UI or the terminal UI for a fully local session. |

Check the result of the update and telemetry settings without sending anything:

```bash
openclaw telemetry show
```

When policy disables every automatic request, the output shows `Request: none` with the reason.

```json5
{
  update: { checkOnStart: false },
  telemetry: { enabled: false },
  models: { catalogRefresh: { enabled: false } },
  tools: {
    web: { search: { enabled: false }, fetch: { enabled: false } },
    links: { enabled: false },
  },
  discovery: { mdns: { mode: "off" } },
}
```

## Keep inference local

Turning off background requests does not make model calls local. Check each place a model or provider can be chosen.

- **Primary model and fallbacks.** Point `agents.defaults.model.primary` at a local provider and set `fallbacks: []`. A fallback list that still names a hosted model can send a request off the host when the local model fails. Cron jobs and per-agent overrides that set only `primary` inherit the default fallbacks unless you set `fallbacks: []`. See [Agent models](/gateway/config-agents/models).
- **Utility model.** Short internal tasks such as session titles use `utilityModel`, which has its own fallback list, independent of `model.fallbacks`. Set it to a local model, or to [Apple Foundation Models](/plugins/apple-fm) on a supported Mac.
- **Speech to text.** Audio auto-detection tries configured provider auth **before** local binaries, so a hosted provider key in your config wins over a local `whisper-cli` on `PATH`. Remove hosted audio providers or pin a local entry in `tools.media.models`. The Python `whisper` fallback downloads models automatically, so run it once while online or avoid it. Inspect the selection without transcribing:

  ```bash
  openclaw doctor --lint --only core/doctor/local-audio-acceleration --severity-min info
  ```

- **Embeddings.** Set `memory.search.provider: "local"` and `fallback: "none"`. Without an embedding provider, memory search uses keyword (BM25) matching only.

```json5
{
  agents: {
    defaults: {
      model: { primary: "<provider>/<local-model>", fallbacks: [] },
    },
  },
  memory: { search: { provider: "local", fallback: "none" } },
}
```

## Keep the Gateway local

`gateway.bind` defaults to `loopback` on a regular host, so the Gateway listens only on `127.0.0.1`. A detected container defaults to `auto`, which listens on `0.0.0.0`; set `gateway.bind: "loopback"` explicitly there. See [Gateway configuration](/gateway/config-gateway).

## Route what remains through a deny-all proxy

If you run an operator-managed forward proxy that refuses every destination, pointing `proxy.proxyUrl` at it sends OpenClaw's normal HTTP and WebSocket egress there while loopback traffic keeps connecting directly in the default `gateway-only` mode. OpenClaw does not ship or configure the proxy, and the routing covers `fetch`, Node HTTP(S), and common WebSocket clients, not every transport. Some plugins own a custom transport; the documented example is the Telegram Bot API client. See [Network proxy](/security/network-proxy).

Do not use `proxy.loopbackMode: "block"` for this purpose. It denies the Gateway control-plane and browser connections on loopback, which an offline setup still needs.

## What these settings do not cover

- **Agent tools that run programs.** `exec` can start `curl`, `git`, `npm`, or anything else the host allows. Restrict tools with your tool policy, or run the agent in the [sandbox](/gateway/security).
- **Plugin and channel code with its own network access.** A plugin you enable has the trust of local code on the Gateway host.
- **Non-HTTP traffic.** Proxy routing handles HTTP and WebSocket clients. Other protocols are outside it.
- **Browser tool.** A browser the agent drives can load any page the host can reach.
- **First-time provisioning.** Model downloads, plugin installs, and tool installs need the network once.

## Verify that nothing leaves the host

Verify at the operating-system level, not from OpenClaw's own logs.

Inspect open connections for the Gateway process while you use it. On macOS:

```bash
lsof -nP -i -a -p <gateway-pid>
nettop -p <gateway-pid>
```

On Linux:

```bash
ss -tpn
```

For enforcement, block outbound traffic from the Gateway's user or network namespace with your platform firewall, then confirm that local chat, memory search, and your normal workflow still work. Anything that fails is a dependency on the network that this page did not remove.

## Related

- [Local models](/gateway/local-models)
- [Apple Foundation Models](/plugins/apple-fm)
- [Usage telemetry and update checks](/gateway/telemetry)
- [Network proxy](/security/network-proxy)
- [Bonjour discovery](/gateway/bonjour)
