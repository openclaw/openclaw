---
summary: "Profile-based overview of ZekeBot capabilities."
read_when:
  - Explaining a ZekeBot profile to an operator
  - Checking which capabilities are expected for each runtime
title: "What your ZekeBot can do"
---

# What Your ZekeBot Can Do

ZekeBot capabilities are profile-based. The same fork image can run different tool catalogs depending on the selected profile and ZekeFlow authority token.

## Sprout

Sprout is the internal Chief of Staff profile. It can ask for Zeke context, search cited evidence, explain context routes, read approved source references, inspect bounded repo files, run bounded repo searches, list bounded repo globs, and propose signals for same-chat approval.

Sprout can also use bounded OpenClaw session primitives configured for its runtime. `sessions_spawn` is restricted to the approved investigator profile.

## Rambo internal

Rambo is the operational browser and QA profile. It receives the context subset only: ask, search, explain route, and read source. Rambo does not receive signal proposal authority, repo-wide readers, or session spawning.

## External client

External-client is the safe baseline for future tenant runtimes. It starts with no internal Zeke tools. Any expansion requires a new governed profile change and test evidence.

## Always denied

`create_signal` is never model-facing. Signal creation stays inside ZekeFlow backend paths. Native plugin code must not write Zeke state directly.
