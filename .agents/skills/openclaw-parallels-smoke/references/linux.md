# Linux Parallels smoke

## Linux flow

- Preferred entrypoint: `pnpm test:parallels:linux`
- Use the newest versioned Ubuntu guest with a fresh poweroff snapshot. On Peter's host today, that is `Ubuntu 26.04`.
- If an exact requested Ubuntu VM is missing on the host, any Ubuntu guest with major version `>= 24` is acceptable; prefer the newest versioned Ubuntu guest over older fallback snapshots.
- Use plain `prlctl exec`; `--current-user` is not the right transport on this snapshot.
- Fresh snapshots may be missing `curl`, and `apt-get update` can fail on clock skew. Bootstrap with `apt-get -o Acquire::Check-Date=false update` and install `curl ca-certificates`.
- Fresh `main` tgz smoke still needs the latest-release installer first because the snapshot has no Node or npm before bootstrap.
- This snapshot does not have a usable `systemd --user` session; managed daemon install is unsupported.
- The Linux smoke now falls back to a manual `setsid openclaw gateway run --bind loopback --port 18789 --force` launch with `HOME=/root` and the provider secret exported, then verifies `gateway status --deep --require-rpc` when available.
- The Linux manual gateway launch should wait for `gateway status --deep --require-rpc` inside the `gateway-start` phase; otherwise the first status probe can race the background bind and fail a healthy lane.
- If Linux gateway bring-up fails, inspect `/tmp/openclaw-parallels-linux-gateway.log` in the guest phase logs first; the common failure mode is a missing provider secret in the launched gateway environment.
