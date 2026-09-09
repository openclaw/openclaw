---
summary: "The browser config block, tab cleanup, screenshot vision, ports, SSRF policy, and picking a Chromium binary"
title: "Browser configuration"
read_when:
  - You are writing the browser block in openclaw.json
  - You need the CDP port ranges or the SSRF policy options
  - You want a text-only model to read browser screenshots
  - You want OpenClaw to launch Brave, Edge, or another Chromium browser
---

## Configuration

Browser settings live in `~/.openclaw/openclaw.json`.

```json5
{
  browser: {
    enabled: true, // default: true
    evaluateEnabled: true, // default: true; false disables act:evaluate (arbitrary JS)
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // allowedHostnames: ["localhost"],
      // allowRfc2544BenchmarkRange: true, // trusted fake-IP proxy range
      // allowIpv6UniqueLocalRange: true, // trusted fake-IP proxy IPv6 range
    },
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    tabCleanup: {
      enabled: true, // default: true
    },
    // snapshotDefaults: { mode: "efficient" }, // default snapshot mode when the caller omits one
    defaultProfile: "openclaw",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    profiles: {
      openclaw: { cdpPort: 18800 },
      work: {
        cdpPort: 18801,
        headless: true,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      user: {
        driver: "existing-session",
        attachOnly: true,
      },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222" },
    },
  },
}
```

`browser.snapshotDefaults.mode: "efficient"` changes the default `snapshot`
extraction mode when a caller does not pass an explicit `snapshotFormat` or
`mode`. Changes apply to the next snapshot; see
[Browser control API](/tools/browser-control) for per-call snapshot options.

On drivers with stable document identity, repeated AI or role snapshots of the
same tab, document, and option family mark newly appeared ref-bearing elements
with `[new]`. The first snapshot—and the first snapshot after navigation—sets
an unmarked baseline. Existing-session snapshots omit deltas.

### Tab cleanup ownership

Session tab cleanup applies only to tabs created by the OpenClaw browser tool
with `action: "open"`. OpenClaw does not adopt tabs that were already open,
opened by the user, or otherwise have unknown ownership. The
`browser.tabCleanup` block controls periodic idle and cap sweeps for primary
sessions. Changes apply on the next sweep without restarting the browser;
disabling it does not disable explicit session lifecycle cleanup.

OpenClaw-managed Chrome also applies a separate, best-effort cap of eight page
tabs when opening a tab. This cap is independent of `browser.tabCleanup`;
remote and attach-only profiles do not use it.

For host-local opens, ownership with a stable native CDP target and browser
identity is stored in the shared SQLite state. Those records survive a Gateway
restart and remain eligible for `/new` and other session lifecycle cleanup;
session lifecycle cleanup includes subagent, cron, and ACP session endings.
Records whose tool-facing target is the native CDP target also remain eligible
for idle and per-session cap sweeps after restart. Chrome MCP target handles are
process-local, so cold existing-session records wait for lifecycle cleanup
rather than risking an idle sweep against activity that cannot be attributed
safely after restart. This durable path can cover OpenClaw-managed profiles,
regular remote CDP profiles, and existing-session profiles with an explicit
`cdpUrl`, provided OpenClaw can resolve both the native target and a stable
browser identity. Before closing a durable record, OpenClaw verifies that the
configured profile and browser instance still match.

Chrome MCP `--autoConnect`, CDP endpoints whose `/json/version` response lacks
a stable browser identity, and opens whose native target cannot be resolved
remain process-local best-effort tracking. They can be cleaned up while that
Gateway process is running, but they are not automatically closed after a
Gateway restart. Tabs left open before durable tracking was available are not
retroactively adopted; close those tabs manually.

Cleanup is best-effort, not a guarantee that every eligible tab closes
immediately. A transient ownership check or close failure leaves durable
cleanup pending for a later retry. Retries are not unbounded: when the browser
stays unreachable and the tab has gone unused for over a day, the tracking row
is retired so the durable store cannot fill up with tabs that can never be
verified again.

### Screenshot vision (text-only model support)

When the main model is text-only (no vision/multimodal support), browser
screenshots return image blocks that the model cannot read. Browser screenshots
reuse the existing image-understanding configuration, so an image model
configured for media understanding can describe screenshots as text without any
browser-specific model settings.

```json5
{
  tools: {
    media: {
      models: [
        { provider: "bytedance", model: "doubao-seed-2.0-pro", capabilities: ["image"] },
        // Add fallback candidates; first success wins
        { provider: "openai", model: "gpt-4o", capabilities: ["image"] },
      ],
    },
  },
  agents: {
    defaults: {
      // Existing image-model defaults are also honored.
      // imageModel: { primary: "openai/gpt-4o" },
    },
  },
}
```

**How it works:**

1. Agent calls `browser screenshot` and an image is captured to disk as usual.
2. The browser tool asks the existing image-understanding runtime whether it
   can describe the screenshot using configured media image models, shared media
   models, image-model defaults, or an auth-backed image provider.
3. The vision model returns a text description, which is wrapped with
   `wrapExternalContent` (prompt injection guard) and returned to the agent
   as a text block instead of an image block.
4. If image understanding is unavailable, skipped, or fails, the browser falls
   back to returning the original image block.

Screenshot image blocks are private tool results: the agent can inspect them,
but OpenClaw does not automatically attach them to channel replies. To share a
screenshot, ask the agent to send it explicitly with the message tool.

Use `tools.media.models` for model fallbacks, timeouts, byte limits, profiles,
and provider request settings. Tag screenshot-capable entries with the `image`
capability.

If the active main model already supports vision and no explicit image
understanding model is configured, OpenClaw keeps the normal image result so the
main model can read the screenshot directly.

<AccordionGroup>

<Accordion title="Ports and reachability">

- Control service binds to loopback on a port derived from `gateway.port` (default `18791` = gateway + 2). `OPENCLAW_GATEWAY_PORT` takes priority over `gateway.port`; either shifts the derived ports in the same family.
- Local `openclaw` profiles use a CDP port range starting 9 ports above the control port (default `18800`-`18899`). OpenClaw allocates from that range for
  the implicit default profile and for profiles created with
  `openclaw browser create-profile`, writing the chosen `cdpPort` into the
  config. A profile you declare by hand must set `cdpPort` itself, or `cdpUrl`
  for a remote endpoint: the schema rejects an `openclaw` or `clawd` profile
  that sets neither with `Profile must set cdpPort or cdpUrl`.
  `existing-session` profiles use `cdpUrl` unless valid endpoint arguments in
  `mcpArgs` override it; see [Custom Chrome MCP launch](/tools/browser/existing-session#custom-chrome-mcp-launch).
  They ignore `cdpPort`; `extension` profiles own their relay port and reject
  `cdpUrl`.
- Remote and `attachOnly` CDP reachability, WebSocket handshakes, and local
  managed-Chrome startup use built-in deadlines.
- Repeated managed Chrome launch/readiness failures are circuit-broken per
  profile. After several consecutive failures, OpenClaw pauses new launch
  attempts briefly instead of spawning Chromium on every browser tool call. Fix
  the startup problem, disable the browser if it is not needed, or restart the
  Gateway after repair.

</Accordion>

<Accordion title="SSRF policy">

- Browser navigation and open-tab requests are preflight checked. During the action and bounded post-action grace, guarded Playwright interactions (click, coordinate click, hover, drag, scroll, select, press, type, form fill, and evaluate) intercept policy-denied top-level and subframe document loads before HTTP request bytes, then best-effort re-check the final `http(s)` URL.
- Before each fresh OpenClaw-managed Chrome launch, OpenClaw best-effort disables network prediction, suppressing Chromium's observed speculative preconnect for those denied loads. This is defense in depth, not a policy boundary: a browser reused across a control-service restart and other browser backends may not share the hardening. Playwright routing is still not a network firewall and does not intercept redirect hops, a popup's first request, Service Worker traffic, page code that runs after the bounded guard window, or every background/subresource path. Complete egress isolation requires owner-side isolation or a policy-enforcing proxy.
- In strict SSRF mode, remote CDP endpoint discovery and `/json/version` probes (`cdpUrl`) are checked too.
- Guarded remote CDP connections now fail closed when the selected driver cannot
  keep the approved endpoint bound to the actual socket. Use the regular
  `openclaw` driver for Browserless, Browserbase, Notte, or other guarded
  remote CDP providers. `existing-session`/Chrome MCP profiles with an explicit
  `cdpUrl` or `--browserUrl`/`--wsEndpoint` MCP argument are rejected under the
  default strict Browser policy because Chrome MCP cannot carry OpenClaw's
  pinned DNS lookup or guarded discovery result across its subprocess boundary.
  They remain supported only when private-network Browser access is explicitly
  trusted. Otherwise, omit the explicit endpoint and attach Chrome MCP to a
  host-local Chrome profile, or switch the profile to the regular driver for
  guarded CDP.
- Redirecting CDP discovery to a different authority remains unsupported unless
  the active policy explicitly allows that authority change. Revalidating a
  returned hostname is not enough; the WebSocket transport must use the endpoint
  that passed policy validation.
- Gateway/provider `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` environment variables do not automatically proxy the OpenClaw-managed browser. Managed Chrome launches direct by default so provider proxy settings do not weaken browser SSRF checks.
- OpenClaw-managed local CDP readiness probes and DevTools WebSocket connections bypass the managed network proxy for the exact launched loopback endpoint, so `openclaw browser start` still works when an operator proxy blocks loopback egress.
- To proxy the managed browser itself, pass explicit Chrome proxy flags through `browser.extraArgs`, such as `--proxy-server=...` or `--proxy-pac-url=...`. Strict SSRF mode blocks explicit browser proxy routing unless private-network browser access is intentionally enabled.
- `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` is off by default; enable only when private-network browser access is intentionally trusted.
- `browser.ssrfPolicy.allowedHostnames` grants exact hosts while the rest of the private network remains blocked.
- `browser.ssrfPolicy.allowRfc2544BenchmarkRange` and `browser.ssrfPolicy.allowIpv6UniqueLocalRange` narrowly allow trusted fake-IP proxy ranges.
- `browser.ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.

</Accordion>

<Accordion title="Profile behavior">

- `attachOnly: true` means never launch a local browser; only attach if one is already running.
- `headless` can be set globally or per local managed profile. Per-profile values override `browser.headless`, so one locally launched profile can stay headless while another remains visible.
- `POST /start?headless=true` and `openclaw browser start --headless` request a
  one-shot headless launch for local managed profiles without rewriting
  `browser.headless` or profile config. Existing-session, attach-only, and
  remote CDP profiles reject the override because OpenClaw does not launch those
  browser processes.
- On Linux hosts without `DISPLAY` or `WAYLAND_DISPLAY`, local managed profiles
  default to headless automatically when neither the environment nor profile/global
  config explicitly chooses headed mode. Use the unambiguous browser-level form
  `openclaw browser --json status`; trailing `openclaw browser status --json`
  also works because `status` does not define its own `--json`. The command reports
  `headlessSource` as `env`, `profile`, `config`,
  `request`, `linux-display-fallback`, or `default`.
- `OPENCLAW_BROWSER_HEADLESS=1` forces local managed launches headless for the
  current process. `OPENCLAW_BROWSER_HEADLESS=0` forces headed mode for ordinary
  starts and returns an actionable error on Linux hosts without a display server;
  an explicit `start --headless` request still wins for that one launch.
- The browser-control route and programmatic client keep the no-display error's
  human-readable `error` and expose the stable reason
  `no_display_for_headed_profile`. Its `details` contain only `profile`,
  `requestedHeadless`, `headlessSource`, and `displayPresent`, so API clients can
  choose the correct remediation without matching message text.
- For a running local managed profile, status and doctor query Chrome's
  browser-level CDP endpoint for renderer, backend, device/driver, feature
  status, driver workarounds, and accelerated video capabilities. The result is
  cached for that browser process and exposed in full by
  `openclaw browser --json status`. A passive status call does not launch Chrome.
  Existing-session, extension, remote CDP, and sandbox browsers remain separate
  and are not inspected through this managed-host path.
- Headless managed Chrome still uses the conservative `--disable-gpu` default.
  The diagnostics do not enable acceleration, add a global acceleration setting,
  or grant sandbox browser device access.
- `executablePath` can be set globally or per local managed profile. Per-profile values override `browser.executablePath`, so different managed profiles can launch different Chromium-based browsers. Both forms accept `~` for your OS home directory.
- Default profile is `openclaw` (managed standalone). Use `defaultProfile: "user"` to opt into the signed-in user browser.
- Auto-detect order: system default browser if Chromium-based; otherwise Chrome, Brave, Edge, Chromium, Chrome Canary.
- `driver: "existing-session"` uses Chrome DevTools MCP instead of raw CDP. It can attach through Chrome MCP auto-connect, or through `cdpUrl` when you already have a DevTools endpoint for the running browser.
- `driver: "extension"` drives your signed-in Chrome through the [OpenClaw Chrome extension](/tools/chrome-extension). The relay owns its loopback endpoint, so these profiles do not accept `cdpUrl`. This is the only signed-in-browser mode that works with nobody at the computer.
- Set `browser.profiles.<name>.userDataDir` when an existing-session profile should attach to a non-default Chromium user profile (Brave, Edge, etc.). This path also accepts `~` for your OS home directory.

</Accordion>

</AccordionGroup>

## Use Brave or another Chromium-based browser

If your **system default** browser is Chromium-based (Chrome/Brave/Edge/etc),
OpenClaw uses it automatically. Set `browser.executablePath` to override
auto-detection. Top-level and per-profile `executablePath` values accept `~`
for your OS home directory:

```bash
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set browser.profiles.work '{"cdpPort":18801,"executablePath":"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}' --strict-json --merge
```

Or set it in config, per platform:

<Tabs>
  <Tab title="macOS">
```json5
{
  browser: {
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
}
```
  </Tab>
  <Tab title="Windows">
```json5
{
  browser: {
    executablePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  },
}
```
  </Tab>
  <Tab title="Linux">
```json5
{
  browser: {
    executablePath: "/usr/bin/brave-browser",
  },
}
```
  </Tab>
</Tabs>

Per-profile `executablePath` only affects local managed profiles that OpenClaw
launches. `existing-session` profiles attach to an already-running browser
instead, and remote CDP profiles use the browser behind `cdpUrl`.
