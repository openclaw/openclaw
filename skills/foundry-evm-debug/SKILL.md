---
name: foundry-evm-debug
description: "Morpho EVM debugging with Foundry (`cast`, `anvil`) using clean git worktrees and the cached Morpho RPC."
metadata: { "openclaw": { "emoji": "⛓️", "requires": { "env": ["RPC_SECRET"] } } }
---

# Foundry EVM Debug

Use this skill for:

- onchain state reads
- transaction replay / tracing
- forked simulation with `anvil`
- protocol source inspection in a clean git worktree

## Guardrails

- Never hardcode RPC URLs with secrets.
- Always build RPC URLs through `{baseDir}/scripts/rpc-url.sh`.
- Prefer a clean worktree before reading protocol source.
- Do not edit a shared or dirty checkout when debugging protocol code.
- Default to forked simulation and impersonation. Only use real signing keys when the user explicitly asks.
- Prefer environment-based RPC injection when Foundry supports it. `ETH_RPC_URL="$({baseDir}/scripts/rpc-url.sh ...)" cast ...` keeps secret-bearing URLs out of argv.
- `anvil` still needs `--fork-url`, so `anvil-fork.sh` necessarily exposes the full RPC URL in process arguments while it runs. Treat local `ps` or `/proc/*/cmdline` access as secret-bearing.

## Required environment

- `RPC_SECRET`

Optional overrides:

- `MORPHO_EVM_RPC_BASE` — default `https://rpc.morpho.dev/cache/evm`
- `OPENCLAW_FOUNDRY_WORKTREE_ROOT` — default `~/.openclaw/workspace-evm/worktrees`
- `OPENCLAW_FOUNDRY_CACHE_ROOT` — default `~/.openclaw/workspace-evm/git-cache`

## Sandbox requirement

If the agent is sandboxed, ensure the sandbox image already contains Foundry.
Recommended path:

```bash
INSTALL_FOUNDRY=1 scripts/sandbox-common-setup.sh
```

Then point the agent at `openclaw-sandbox-common:bookworm-slim`.

Recommended agent config:

```json5
{
  agents: {
    list: [
      {
        id: "evm-debug",
        workspace: "~/.openclaw/workspace-evm",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "rw",
          docker: {
            image: "openclaw-sandbox-common:bookworm-slim",
            network: "bridge",
            env: { RPC_SECRET: "$RPC_SECRET" },
          },
        },
      },
    ],
  },
}
```

`network: "bridge"` matters because sandbox default is `network: "none"`, which blocks RPC calls.

## First checks

Before using the workflow, verify the tools exist:

```bash
command -v cast
command -v anvil
command -v forge
command -v chisel
cast --version
anvil --version
forge --version
chisel --version
```

## Common flows

RPC URL for a chain:

```bash
{baseDir}/scripts/rpc-url.sh 1
{baseDir}/scripts/rpc-url.sh 8453
```

Replay and trace a tx:

```bash
{baseDir}/scripts/tx-trace.sh 1 0xabc123...
```

Fork a chain at head:

```bash
{baseDir}/scripts/anvil-fork.sh 1
```

Fork at a fixed block:

```bash
{baseDir}/scripts/anvil-fork.sh 8453 28881818
```

Open a clean worktree for protocol source:

```bash
{baseDir}/scripts/worktree-open.sh https://github.com/morpho-org/morpho-blue.git main
{baseDir}/scripts/worktree-open.sh /path/to/local/repo 9b1c2d3
```

Once the worktree exists, inspect source there and correlate traces to exact commits.

## Useful direct Foundry commands

Read contract state:

```bash
ETH_RPC_URL="$({baseDir}/scripts/rpc-url.sh 1)" \
  cast call 0xContract "totalSupply()(uint256)"
```

Trace a read:

```bash
ETH_RPC_URL="$({baseDir}/scripts/rpc-url.sh 1)" \
  cast call 0xContract "previewRedeem(uint256)(uint256)" 1000000000000000000 \
    --trace
```

Raw JSON-RPC:

```bash
ETH_RPC_URL="$({baseDir}/scripts/rpc-url.sh 1)" \
  cast rpc eth_getBlockByNumber 0x10 false
```

## Notes

- `tx-trace.sh` uses `cast run` with `ETH_RPC_URL`, which replays a historical tx without putting the secret-bearing RPC URL in argv.
- `anvil-fork.sh` enables `--auto-impersonate` for operator/debug flows, but `anvil --fork-url` still exposes the secret-bearing RPC URL in argv.
- `worktree-open.sh` uses a mirror cache, then creates a fresh worktree per ref.
