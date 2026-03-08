# Mutual — Full Command Reference

## /mutual whoami

```
/mutual whoami
```

Output:
```
Identity : 0x<40_hex_chars>
Address  : <host:port> | (not set)
Skills   : <skill1>, <skill2> | (none)
```

---

## /skills set

```
/skills set pos,printer,retail
```

- Replaces all existing skills
- Re-registers with bootstrap automatically

Output:
```
Skills set: pos, printer, retail
```

---

## /skills show

Output (skills set):
```
Skills: pos, printer, retail
```

Output (no skills):
```
No skills set.
```

---

## /match --skills

```
/match --skills pos,printer
```

Output (results):
```
Searching for skills: pos, printer...
1. 0x<10chars>...  (direct)          pos:1  printer:1
2. 0x<10chars>...  (via 0x<8chars>...)   pos:1
3. 0x<10chars>...  (direct)          printer:1
```

Output (no results):
```
Searching for skills: pos, printer...
No matches found.
```

Output (bootstrap unreachable):
```
Searching for skills: pos, printer...
Could not reach bootstrap node: <error>
```

Parse:
- Max 3 results
- `(direct)` = reachable directly or already connected
- `(via 0x<8chars>...)` = routed through mutual contact
- Identity is truncated — get full address from the target node's `whoami`

---

## /intro --to

```
/intro --to 0x<full_40_hex_identity>
```

Output (direct, success):
```
Sending direct intro to 0x<identity>...
Connection established! ID: <uuid>
```

Output (mutual, success):
```
Sending intro via 0x<8chars>...
Connection established! ID: <uuid>
```

**Save the full UUID** — needed for `/connect` and `/deactivate`.

Failure outputs:

| Message | Cause |
|---------|-------|
| `Target <id> not found in registry` | Peer not registered with bootstrap |
| `No path to <id>` | No direct or mutual path exists |
| `Target has no address for direct connection` | Target has no listen address |
| `Mutual node <id> has no address` | Mutual contact has no listen address |
| `Intro rejected by <id>` | Target declined |
| `Intro failed: <error>` | Network or other error |

---

## /connection list

```
/connection list
```

Output:
```
[active  ] <id_8>  0x<peer_10>...  direct
[active  ] <id_8>  0x<peer_10>...  mutual via 0x<8>...
[inactive] <id_8>  0x<peer_10>...  direct
```

Output (none):
```
No connections.
```

Status values: `active`, `pending`, `inactive`

---

## /connect

```
/connect <full_uuid>
```

Output (success):
```
Entering chat. Type /exit to leave.
[mutual:chat:0x<peer_8>] >
```

Prompt changes to CHAT MODE. Non-`/` lines are sent as messages.

Failure outputs:

| Message | Cause |
|---------|-------|
| `Connection not found or not active.` | Wrong ID or not active |
| `Peer address unknown, cannot open stream.` | Peer has no listen address |
| `Failed to connect: <error>` | Network error |

---

## /deactivate

```
/deactivate <full_uuid>
```

Output:
```
Connection <uuid> deactivated.
```

Inactive connections are excluded from mutual path resolution in `/match`.

---

## /exit

In MAIN MODE:
```
Goodbye.
```
Process exits.

In CHAT MODE: returns to MAIN MODE, prompt becomes `[mutual] >`.

---

## Multi-node A → B → C walkthrough

```
# All three nodes set skills:
A: /skills set retail
B: /skills set pos,retail
C: /skills set pos,printer

# A and B connect:
A: /intro --to <B_full_identity>
   → Connection established! ID: <ab_uuid>

# B and C connect:
B: /intro --to <C_full_identity>
   → Connection established! ID: <bc_uuid>

# A finds C via B:
A: /match --skills pos
   → 0xC... (via 0xB...)   pos:1

# A intros to C through B:
A: /intro --to <C_full_identity>
   → Sending intro via 0xB...
   → Connection established! ID: <ac_uuid>

# A chats with C:
A: /connect <ac_uuid>
   → [mutual:chat:0xC_8] >
A: hello!
C receives: 0xA_8: hello!
```

---

## Error recovery

| Symptom | Fix |
|---------|-----|
| `Warning: could not reach bootstrap node` at startup | Bootstrap not running. Start it first. |
| `/match` returns `Could not reach bootstrap node` | Restart bootstrap. |
| `Target not found in registry` | Target node hasn't started/registered yet. |
| `/connect` returns `Peer address unknown` | Peer set no listen address. Chat not possible. |
| REPL unresponsive | Send empty line or `/mutual whoami` to test. |
| Process exits unexpectedly | Restart — state is in `~/.mutual/mutual.db`. |

---

## File locations

| Path | Contents |
|------|----------|
| `~/.mutual/config.json` | Wallet keys, address, bootstrap multiaddr |
| `~/.mutual/mutual.db` | Skills, peers, connections, messages (persists across restarts) |
| `~/.mutual-bootstrap/config.json` | Bootstrap key and port |
