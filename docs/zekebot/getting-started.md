---
summary: "Bring up a ZekeBot runtime from an approved profile and image digest."
read_when:
  - Starting a ZekeBot-backed runtime
  - Reviewing profile and token requirements
title: "Getting started with ZekeBot"
---

# Getting Started With ZekeBot

ZekeBot deployments start from an approved image digest and one of the packaged profiles. Do not deploy from floating `latest` unless the promotion workflow has passed and the operator has approved the tag move.

## What you need

- A ZekeBot image digest from the approved GHCR package.
- A profile file such as `profiles/sprout.json`, `profiles/rambo-internal.json`, or `profiles/external-client.json`.
- A ZekeFlow authority URL reachable from the gateway.
- The per-profile ZekeFlow tool token required by that profile.
- Any runtime provider credentials required by the selected OpenClaw agent.

## Startup checklist

1. Pin the image by digest in your compose or deployment file.
2. Mount the OpenClaw config directory at `/home/node/.openclaw`.
3. Enable the `zeke` plugin only for profiles that should see native Zeke tools.
4. Provide the matching token environment variable for the profile.
5. Start the gateway and query the tool catalog before handing it to a user.

If the profile token is missing, the native Zeke plugin must fail closed. The runtime can still be restarted after the token is provisioned; no profile should silently downgrade into a broader tool catalog.

## First verification

Check that the visible tool catalog matches the intended profile. Sprout should see `propose_signal`; Rambo should not. External-client should not see internal Zeke tools.
