# OpenClaw Secret Wallet Plugin

OpenClaw plugin for the `secret-wallet` CLI with safer default behavior:

- read tools are available
- write tools are gated (`allowWriteTools=false` by default)
- inject tool is gated (`allowInjectTool=false` by default)
- `secret_wallet_inject` always injects selected secrets via repeated `--only`

## Install

```bash
openclaw plugins install @baekho-lim/secret-wallet
```

## Required binary

Install `secret-wallet` first:

```bash
brew install baekho-lim/tap/secret-wallet
```

## Config

```json5
{
  plugins: {
    entries: {
      "secret-wallet": {
        enabled: true,
        config: {
          binaryPath: "/usr/local/bin/secret-wallet",
          allowWriteTools: false,
          allowInjectTool: true,
        },
      },
    },
  },
}
```

`binaryPath` can be omitted to resolve `secret-wallet` from `PATH`.

## Tools

- `secret_wallet_status`
- `secret_wallet_list`
- `secret_wallet_get`
- `secret_wallet_add` (registered only when `allowWriteTools=true`)
- `secret_wallet_remove` (registered only when `allowWriteTools=true`)
- `secret_wallet_inject` (registered only when `allowInjectTool=true`)

`secret_wallet_inject` input:

```json
{
  "command": ["node", "server.js"],
  "secretNames": ["OPENAI_KEY", "DB_URL"]
}
```

This maps to:

```bash
secret-wallet inject --only OPENAI_KEY --only DB_URL -- node server.js
```

## Local development

```bash
pnpm --filter @baekho-lim/secret-wallet build
pnpm --filter @baekho-lim/secret-wallet test
pnpm --filter @baekho-lim/secret-wallet pack:smoke
```

## Packaging note

The npm package includes `index.ts` and `src/*` so plugin discovery can load the declared
`openclaw.extensions` entry (`./index.ts`) directly from installed packages.
Prebuilt `dist/*` is still included for standalone packaging workflows.

## Contribution note (OpenClaw repository)

When contributing from the OpenClaw monorepo, follow repository guidance and use:

```bash
scripts/committer "<conventional-commit-message>" <files...>
```
