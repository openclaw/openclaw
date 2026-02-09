---
name: yoink
description: Play Yoink, an onchain capture-the-flag game on Base. Yoink the flag from the current holder, check game stats and leaderboards, view player scores, and compete for the trophy. Uses Bankr for transaction execution.
metadata: {"openclaw":{"emoji":"🚩","homepage":"https://basescan.org/address/0x4bBFD120d9f352A0BEd7a014bd67913a2007a878","requires":{"bins":["curl","jq"]}}}
---

# Yoink

Play Yoink, an onchain capture-the-flag game on Base. Yoink the flag from the current holder to start your clock. The player with the most total yoinks holds the trophy.

**Contract:** `0x4bBFD120d9f352A0BEd7a014bd67913a2007a878` on Base (chain ID 8453)

## Game Rules

1. **Yoink the flag** - Call `yoink()` to take the flag from the current holder
2. **Cooldown** - You must wait 10 minutes (600 seconds) between yoinks
3. **No self-yoink** - You cannot yoink from yourself
4. **Accumulate time** - While you hold the flag, your time score increases
5. **Compete for trophy** - The player with the most total yoinks holds the trophy (token ID 2)
6. **Track yoinks** - Your total yoink count is tracked separately from time

## Contract Interface

**RPC template:**
```bash
curl -s -X POST https://mainnet.base.org -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x4bBFD120d9f352A0BEd7a014bd67913a2007a878","data":"SELECTOR+PARAMS"},"latest"],"id":1}' | jq -r '.result'
```

| Function | Selector | Params | Returns |
|----------|----------|--------|---------|
| `yoink()` | `0x9846cd9e` | - | (write) |
| `lastYoinkedBy()` | `0xd4dbf9f4` | - | address |
| `lastYoinkedAt()` | `0x6a99616f` | - | uint256 timestamp |
| `totalYoinks()` | `0xa5d0dadd` | - | uint256 |
| `topYoinker()` | `0x6a974e6e` | - | address (trophy holder) |
| `mostYoinks()` | `0xd2d7774a` | - | uint256 (record) |
| `COOLDOWN()` | `0xa2724a4d` | - | uint256 (600) |
| `score(address)` | `0x776f3843` | addr (32B padded) | (yoinks, time, lastYoinkedAt) |
| `balanceOf(address,uint256)` | `0x00fdd58e` | addr + tokenId | uint256 (FLAG_ID=1, TROPHY_ID=2) |

**Encoding:** Addresses are zero-padded to 32 bytes. `score()` returns 96 bytes (3 × uint256).

## Yoinking

Use Bankr's arbitrary transaction feature:

```
{
  "to": "0x4bBFD120d9f352A0BEd7a014bd67913a2007a878",
  "data": "0x9846cd9e",
  "value": "0",
  "chainId": 8453
}
```

## Errors

| Error | Selector | Meaning |
|-------|----------|---------|
| `SlowDown(uint256)` | `0x58d6f4c6` | Cooldown not elapsed. Param = seconds remaining. |
| `Unauthorized()` | `0x82b42900` | You already hold the flag. |

**Cooldown check:** `current_time - lastYoinkedAt() >= 600`

## Workflow

- Query `lastYoinkedBy()` and `lastYoinkedAt()` to check status/cooldown
- Ensure cooldown elapsed (600s) and you're not current holder
- Submit yoink transaction via Bankr
- Verify with `lastYoinkedBy()` or `score(address)`

## Resources

- **Basescan:** https://basescan.org/address/0x4bBFD120d9f352A0BEd7a014bd67913a2007a878 (ABI, events, source)
- **Source Code:** https://github.com/horsefacts/yoink-contracts
