---
summary: "CLI reference for `openclaw id` (OpenClaw ID remote access status, moving a claw to new keys, publishing)"
read_when:
  - OpenClaw ID remote access is off because a key file is missing or replaced
  - You want to move a claw to new connection keys with its recovery kit
title: "OpenClaw ID"
---

# `openclaw id`

OpenClaw ID remote access of the Gateway on this machine (an experimental Lab, see
[Remote access with OpenClaw ID](/concepts/experimental-features#make-a-claw-reachable)).
Run these commands on the computer that runs the claw: the Gateway accepts `rebind` only
from a direct-loopback client, never over the tunnel or another network.

## Common options

- `--url <url>`: Gateway WebSocket URL. It must be this machine's Gateway.
- `--token <token>`: Gateway token, if required.
- `--timeout <ms>`: RPC timeout in milliseconds; defaults to `60000`.
- `--json`: Print the result as JSON.

## Status

```bash
openclaw id status
```

Shows whether remote access is on, the claw's hostname, its binding number with the one
Discovery has, the connection keys (endpoint key and Gateway key) as short fingerprints,
and the last publication.

When a key file is missing or holds a different key, status says so:

- `keys_missing`: "Remote access is off: this claw's connection keys are missing from this
  computer, so your devices can't reach it."
- `key_mismatch`: "Remote access is off: the connection key on this computer isn't the one
  your devices trust."

The Gateway keeps running for everything on this computer. Only remote access is off, and
no new key is created on its own: restore the original files under
`<state dir>/openclaw-id/`, or move the claw to new keys.

## Move to new keys

```bash
openclaw id rebind
openclaw id rebind --code <link-code> --kit-stdin --yes < kit.txt
openclaw id rebind --cancel
```

Moves this claw to a new endpoint key and Gateway key with its recovery kit (`OCK1-…`).
Use it when a key file was lost or may have leaked, after a move to a new computer without
the key files, or to rotate keys. In the Control UI on this computer the same action is
**Move to new keys**.

1. You give a link code from your OpenClaw ID account (the **Add a claw** page at
   `https://claws.<loaderDomain>/link`), at the prompt or with `--code`. Discovery moves a claw
   to new keys only with a code from the owner's account.
2. The Gateway prepares two new keys next to the current ones and reads the claw's published
   binding from Discovery with the code.
3. You type the recovery kit at a hidden prompt (or pipe it with `--kit-stdin`). The kit is
   never accepted as an argument. The CLI derives the owner root key from it, checks that the
   kit belongs to this claw, verifies Discovery's binding with it, shows the old and new key
   fingerprints and asks you to confirm.
4. The owner root key signs a new server binding for the new keys, numbered above both this
   computer's binding and Discovery's (so a computer restored from an older backup moves
   ahead too). The Gateway stores it,
   restarts remote access on the new keys and publishes them to Discovery.

Your owner devices, people, nodes, invites and device sign-ins all stay. Connected devices
disconnect for a moment and reconnect by themselves. Owners get a notice that the claw moved
to new keys.

A kit for another claw is refused: "This recovery kit is for another claw (`XXXXX-XXXXX-…`).
Use the kit made for `<hostname>`." Without the kit, the claw cannot be moved.

If Discovery can't be read, or what it publishes does not verify under your kit, nothing is
signed. You can then pass `--binding-seq <n>` with a number above every binding you know of;
a number at or below a verified binding is refused.

If the Gateway restarts before Discovery confirmed the new keys, or the code expires (codes
last ten minutes), `openclaw id status` says the new keys wait for a link code; run
`openclaw id publish --code <link-code>`.

`--yes` skips the confirmation and needs `--kit-stdin` and `--code`.

If the Gateway accepted the move but the CLI cannot read publication status, the command
prints that the move **committed** and exits normally with warning code **2**, rather than
throwing an error. With `--json`, it reports `moved: true`, the committed `bindingSeq`,
`published: null` (unknown), `publicationError`, and `nextStep: "openclaw id status"`.
Run `openclaw id status` to check the result; do not automatically repeat `rebind`.
Repeating the whole command after a committed move prepares another rotation, not a replay
of the previous commit. A refused commit still reports an error, not `moved: true`.

If `openclaw id status` says Discovery lists newer keys for this claw that this computer
doesn't have, either this computer was restored from an older backup, or someone with your
recovery kit moved the claw. Either way, run `openclaw id rebind`: it signs above the binding
Discovery publishes. If you didn't restore a backup, do it now. If that fails because your
account is also compromised, relink this claw as a new claw from this computer. `--cancel` deletes the keys staged
by a move you did not finish; running `rebind` again reuses them. If the Gateway stops after
the move was stored but before it switched keys, it finishes the switch at its next start.

A move does not review who has access. If you think a key leaked, also check **Your
devices** and **People**.

## Publish

```bash
openclaw id publish
openclaw id publish --code <link-code>
```

Publishes the claw's descriptor and membership to Discovery now. The Gateway also retries on
its own. A link code from `https://claws.<loaderDomain>/link` is needed only when the claw is
not registered at Discovery yet.
