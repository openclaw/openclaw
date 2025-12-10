## Tests

- `pnpm test:force`: Kills any lingering gateway process holding the default lock/port, removes stale lock files, runs the full Vitest suite with an isolated temporary gateway lock path so gateway server tests don’t collide with a running instance. Use this when a prior gateway run left `/tmp/clawdis-gateway.lock` or port 18789 occupied.
