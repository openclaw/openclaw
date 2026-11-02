---
summary: "CLI reference for `openclaw users` (profiles, email aliases, and duplicate merges)"
read_when:
  - You need to find a durable Gateway profile ID
  - You want to link an email alias or merge duplicate profiles
title: "Users"
---

# `openclaw users`

Manage durable Gateway profiles through the Gateway RPC API. These profiles
identify people; they are separate from the CLI's `--profile` option, which
selects an isolated OpenClaw configuration and state directory.

## Common options

- `--url <url>`: Gateway WebSocket URL; defaults to `gateway.remote.url` when configured.
- `--token <token>`: Gateway token, if required.
- `--timeout <ms>`: RPC timeout in milliseconds; defaults to `10000`.
- `--json`: Print the Gateway result as JSON.

Place these options after the subcommand.

## List profiles

```bash
openclaw users list
openclaw users list --json
```

Requires `operator.read`. Human output lists each profile's ID, display name, and
email aliases. Use the durable IDs when linking or merging profiles.

## Link an email alias

```bash
openclaw users link-email person@example.com --to <profile-id>
```

Requires `operator.admin`. Calls `users.linkEmail` to move one email alias to the
target profile. If the previous profile loses its last email, it merges into the
target. Otherwise, it remains a separate profile with its other aliases.

## Merge duplicate profiles

```bash
openclaw users merge <source-profile-id> --into <target-profile-id>
openclaw users merge <source-profile-id> --into <target-profile-id> --json
```

Requires `operator.admin`. Calls `users.merge` with `sourceProfileId` and
`targetProfileId`. Use this when both profiles belong to the same person and the
whole source profile should retire, including when it has no email aliases.

The target must be an existing, unmerged profile distinct from the source.
The shared **Owner** profile cannot be merged in either direction. Repeating an
already completed merge into the same target succeeds. If the source points to
another survivor, the command fails and names that current profile.

Human output names the survivor and retired ID. JSON returns `profile`, the
surviving profile, and `movedAliasKinds`, the alias categories actually moved:
`email`, `provider`, or `channel`. An unchanged repeat returns an empty list.

The survivor keeps its role, display name, primary identity, and conflicting
preferences and account choices. Logins, channel links, and personal accounts
follow the survivor under the existing merge rules. History keeps its original
attribution; previously captured authority for the retired profile does not
transfer. See [Merging duplicate profiles](/concepts/user-model#merging-duplicate-profiles)
for transfer rules and personal `USER.md` handling.
