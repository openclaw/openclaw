# TUI: gateway token mismatch / device token mismatch

If `openclaw tui` shows:

- `gateway disconnected: unauthorized: gateway token mismatch`
- `gateway disconnected: unauthorized: device token mismatch`

do the following.

## 1. Free port 18789 (if something else is using it)

Another process (e.g. an SSH tunnel) may be bound to the default gateway port. Then the TUI connects to that process instead of your local gateway, which causes token errors.

**Check what is using 18789:**

```bash
lsof -i :18789
# or
ss -tlnp | grep 18789
```

If you see an **SSH tunnel** (e.g. `ssh -L 127.0.0.1:18789:...`):

- Either **stop that tunnel** so the local gateway can use 18789, or
- Use a **different local port** for the tunnel (e.g. `-L 127.0.0.1:18790:127.0.0.1:18789`) and use `openclaw tui --url ws://127.0.0.1:18790` when you want to use the remote gateway.

**Kill only the SSH client that is forwarding 18789** (replace PID with the one from `lsof`):

```bash
kill <PID>
```

## 2. Sync gateway auth token and restart

So the gateway process and the CLI use the same token:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Wait a few seconds, then check:

```bash
openclaw gateway status
```

You want **Runtime: running** and **RPC probe: ok**.

## 3. Try TUI again

```bash
openclaw tui
```

## 4. If you still see "device token mismatch"

The gateway may be rejecting the client until the device is paired:

```bash
openclaw devices list
openclaw devices approve <device-id>   # approve this machine if it appears
```

Then run `openclaw tui` again.
