---
name: mutual
description: Operate the Mutual CLI — a P2P matchmaker where nodes find each other by skills and chat. Use when starting a bootstrap server, initializing a node, setting skills, finding peers with /match, sending introductions with /intro, managing connections, or chatting via /connect. Mutual is a Node.js REPL-based CLI run with `npx tsx bin/mutual.ts` from the project directory.
---

# Mutual

P2P matchmaker CLI. Nodes publish skills, find each other via bootstrap registry, intro through direct or one-hop mutual paths, and chat.

## Project location

cd /path/to/mutual

## Two-process system

Both must run. Start bootstrap first.

```bash
# Process 1: bootstrap server (keep running)
npx tsx bin/bootstrap.ts

# Process 2: your node
npx tsx bin/mutual.ts
```

## First-time setup

```bash
# 1. Bootstrap: capture the multiaddr it prints
npx tsx bin/bootstrap.ts
#   → /ip4/0.0.0.0/tcp/999/p2p/Qm...   ← save this

# 2. Init node (non-interactive)
printf 'myhost.com:4001\n/ip4/127.0.0.1/tcp/999/p2p/Qm...\n' | npx tsx bin/mutual.ts init
#   → Identity: 0x...   ← save this

# 3. Start REPL — ready when prompt appears
npx tsx bin/mutual.ts
#   → [mutual] >
```

## REPL state machine

```
MAIN MODE  [mutual] >
  /connect <id> ──────→  CHAT MODE  [mutual:chat:<peer_8>] >
                              non-/ lines → sent as chat messages
                              /exit ──────→ MAIN MODE
  /exit → process exits
```

**In CHAT MODE only `/exit` works. All other commands require MAIN MODE.**

## Core workflow

```
/skills set pos,printer,retail     ← publish your skills
/match --skills pos,printer        ← find peers (up to 3 results)
/intro --to 0x<full_identity>      ← send intro, get connection ID
/connection list                   ← see all connections + IDs
/connect <full_uuid>               ← enter chat
hello world                        ← send message (no / prefix)
/exit                              ← leave chat
/deactivate <full_uuid>            ← mark connection inactive
```

## Ready signals

| Process | Wait for |
|---------|----------|
| Bootstrap | prints `/ip4/...` multiaddr line |
| Node REPL | prints `[mutual] >` |

## Async events (printed between commands)

```
[intro] New connection from 0x<peer>... (id: <id_8>)   ← auto-accepted
0x<sender_8>: <message>                                 ← incoming chat
```

## Key facts

- Connection IDs: use the **full UUID** from `/intro` output for `/connect` and `/deactivate`
- `/match` output truncates identities — use full address for `/intro`
- Mutual paths only work when BOTH A→B and B→C connections are **active**
- State persists in `~/.mutual/mutual.db` across restarts

## Full command reference

See [references/commands.md](references/commands.md) for complete output formats, all failure cases, and the multi-node walkthrough.
