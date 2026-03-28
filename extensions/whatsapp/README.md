# @openclaw/whatsapp

WhatsApp channel plugin for OpenClaw.

## Installation

```bash
openclaw plugins install @openclaw/whatsapp
```

## Usage

```bash
openclaw channels login --channel whatsapp
```

## Publishing

This package is published to npm via the [Plugin NPM Release workflow](https://github.com/openclaw/openclaw/actions/workflows/plugin-npm-release.yml).

To publish a new version:

1. Update version in package.json (format: YYYY.M.D or YYYY.M.D-beta.N)
2. Merge to main
3. Trigger the workflow with `publish_scope=selected` and `plugins=@openclaw/whatsapp`

## License

MIT
