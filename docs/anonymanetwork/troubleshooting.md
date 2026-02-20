# Anonymanetwork Troubleshooting

## Quick diagnostics

Run:

```bash
pnpm anonymanetwork:doctor
```

It checks:

- Node runtime compatibility
- Control UI built assets
- Gateway daemon status
- `openclaw doctor` output availability

## Most common startup issue: no output

Use this sequence:

```bash
openclaw gateway status
openclaw status
pnpm anonymanetwork:doctor
```

If Control UI assets are missing:

```bash
pnpm ui:build
```

If gateway is not installed as daemon:

```bash
openclaw onboard --install-daemon
```

## Global install sanity

If you installed globally with npm/pnpm and UI does not load:

- Confirm `dist/control-ui/index.html` exists in your install root
- Reinstall package and run doctor again
- Keep Node 22+
