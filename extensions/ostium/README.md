# Ostium plugin

`ostium` adds a single optional agent tool with read and write actions backed by
`ostium-python-sdk`.

## Install prerequisites

```bash
python3 -m pip install ostium-python-sdk
```

Set environment variables:

```bash
export RPC_URL="https://arb-mainnet.g.alchemy.com/v2/<your-key>"
export PRIVATE_KEY="0x<evm-private-key>"
```

## Enable plugin and tool

```json5
{
  plugins: {
    entries: {
      ostium: {
        enabled: true,
        config: {
          allowWrites: true,
          defaultNetwork: "mainnet",
          pythonBin: "python3",
          timeoutMs: 120000,
          rpcUrlEnvVar: "RPC_URL",
          privateKeyEnvVar: "PRIVATE_KEY",
        },
      },
    },
  },
  agents: {
    list: [
      {
        id: "andy",
        tools: { allow: ["ostium"] },
      },
    ],
  },
}
```

## Tool actions

Read actions:

- `get_pairs`
- `get_open_trades`
- `get_open_trade_metrics`
- `get_target_funding_rate`
- `get_pair_max_leverage`
- `get_pair_overnight_max_leverage`
- `get_rollover_rate`
- `get_funding_rate`

Write actions:

- `open_trade`
- `close_trade`
- `cancel_limit_order`
- `update_tp`
- `update_sl`
