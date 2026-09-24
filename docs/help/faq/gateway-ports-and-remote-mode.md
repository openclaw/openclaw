---
summary: "Gateway ports, remote-mode clients, bind addresses, and running more than one Gateway"
title: "Gateway ports, already running, and remote mode"
read_when:
  - The Gateway will not bind or reports it is already running
  - You are connecting a client to a Gateway elsewhere
---

## Gateway: ports, "already running", and remote mode

<AccordionGroup>
  <Accordion title="What port does the Gateway use?">
    `gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.). Precedence:

    ```text
    --port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
    ```

  </Accordion>

  <Accordion title='Why does openclaw gateway status say "Runtime: running" but "Connectivity probe: failed"?'>
    "Running" is the **supervisor's** view (launchd/systemd/schtasks); the connectivity probe is the CLI actually connecting to the gateway WebSocket. Trust these lines from `openclaw gateway status`: `Probe target:` (the URL the probe used), `Listening:` (what is actually bound on the port), `Last gateway error:` (common root cause when the process is alive but the port is not listening).
  </Accordion>

  <Accordion title='Why does openclaw gateway status show "Config (cli)" and "Config (service)" different?'>
    You are editing one config file while the service runs another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

    Fix, run from the same `--profile` / environment you want the service to use:

    ```bash
    openclaw gateway install --force
    ```

  </Accordion>

  <Accordion title='What does "another gateway instance is already listening" mean?'>
    OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` ("another gateway instance is already listening").

    Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

  </Accordion>

  <Accordion title="How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?">
    Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with shared-secret remote credentials:

    ```json5
    {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://gateway.tailnet:18789",
          token: "your-token",
          password: "your-password",
        },
      },
    }
    ```

    - `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass an override flag).
    - The macOS app watches the config file and switches modes live when these values change.
    - `gateway.remote.token` / `.password` are client-side remote credentials only; they do not enable local gateway auth by themselves.

  </Accordion>

  <Accordion title='The Control UI says "unauthorized" (or keeps reconnecting). What now?'>
    Your gateway auth path and the UI's auth method do not match.

    Facts (from code):

    - The Control UI keeps the token in `sessionStorage`, scoped to the current browser tab and selected gateway URL, so same-tab refreshes keep working without long-lived localStorage token persistence.
    - On `AUTH_TOKEN_MISMATCH`, trusted clients can attempt one bounded retry with a cached device token when the gateway returns retry hints (`canRetryWithDeviceToken=true`, `recommendedNextStep=retry_with_device_token`).
    - That cached-token retry reuses the cached approved scopes stored with the device token; explicit `deviceToken` / explicit `scopes` callers keep their requested scope set instead of inheriting cached scopes.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - Built-in setup-code bootstrap returns a node device token with `scopes: []` plus a bounded operator handoff token for trusted mobile onboarding. The operator handoff can read setup-time native configuration but does not grant pairing mutation scopes or `operator.admin`.

    Fix:

    - Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows an SSH hint if headless).
    - No token yet: `openclaw doctor --generate-gateway-token`.
    - Remote: tunnel first with `ssh -N -L 18789:127.0.0.1:18789 user@host`, then open `http://127.0.0.1:18789/`.
    - Shared-secret mode: set `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`, then paste the matching secret in Control UI settings.
    - Tailscale Serve mode: confirm `gateway.auth.allowTailscale` is enabled and you are opening the Serve URL, not a raw loopback/tailnet URL that bypasses Tailscale identity headers.
    - Trusted-proxy mode: confirm you are coming through the configured identity-aware proxy. Same-host loopback proxies also need `gateway.auth.trustedProxy.allowLoopback = true`.
    - Mismatch persists after the one retry: rotate/re-approve the paired device token:
      ```bash
      openclaw devices list
      openclaw devices rotate --device <id> --role operator
      ```
    - Rotate denied: paired-device sessions can rotate only their **own** device unless they also have `operator.admin`, and explicit `--scope` values cannot exceed the caller's current operator scopes.
    - Still stuck: `openclaw status --all` plus [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

  </Accordion>

  <Accordion title="I set gateway.bind tailnet but it listens only on loopback">
    `tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine is not on Tailscale (or the interface is down), the Gateway falls back to loopback instead of exposing another network interface.

    Fix: start Tailscale on that host and restart the Gateway, or switch explicitly to `gateway.bind: "loopback"` / `"lan"`.

    `tailnet` is explicit; `auto` prefers loopback. Use `gateway.bind: "tailnet"` to limit non-loopback exposure to the Tailnet while retaining the required same-host `127.0.0.1` listener.

  </Accordion>

  <Accordion title="Can I run multiple Gateways on the same host?">
    Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only for redundancy (for example a rescue bot) or hard isolation, and isolate each with its own `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `agents.defaults.workspace`, and unique `gateway.port`.

    Recommended: `openclaw --profile <name> ...` per instance (auto-creates `~/.openclaw-<name>`), a unique `gateway.port` per profile config (or `--port` for manual runs), and a per-profile service with `openclaw --profile <name> gateway install`.

    Profiles also suffix service names: launchd `ai.openclaw.<profile>`, systemd `openclaw-gateway-<profile>.service`, Windows `OpenClaw Gateway (<profile>)`. The unqualified `openclaw-gateway` systemd unit only exists for the default profile; the legacy pre-rename systemd unit name `clawdbot-gateway` is migrated automatically.

    Full guide: [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>

  <Accordion title='What does "invalid handshake" / code 1008 mean?'>
    The Gateway is a **WebSocket server** and expects the first message to be a `connect` frame. Anything else closes the connection with **code 1008** (policy violation).

    Common causes: you opened the **HTTP** URL in a browser instead of a WS client, used the wrong port/path, or a proxy/tunnel stripped auth headers or sent a non-Gateway request.

    Fix: use the WS URL (`ws://<host>:18789`, or `wss://...` over HTTPS), do not open the WS port in a normal browser tab, and include the token/password in the `connect` frame when auth is on. CLI/TUI example:

    ```bash
    openclaw tui --url ws://<host>:18789 --token <token>
    ```

    Protocol details: [Gateway protocol](/gateway/protocol).

  </Accordion>
</AccordionGroup>
