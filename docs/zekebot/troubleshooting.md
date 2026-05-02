---
summary: "Common ZekeBot symptoms and first checks."
read_when:
  - A ZekeBot runtime does not show the expected tools
  - Native Zeke tools fail at call time
title: "ZekeBot troubleshooting"
---

# ZekeBot Troubleshooting

Most ZekeBot failures fall into one of three areas: profile selection, ZekeFlow authority, or image drift.

| Symptom                                     | Likely cause                                                    | First action                                                                         |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Sprout cannot see `propose_signal`          | Wrong profile or missing native plugin config                   | Query the runtime tool catalog and compare it to `profiles/sprout.json`.             |
| Rambo can see `propose_signal`              | Profile boundary regression                                     | Stop the runtime and inspect `profiles/rambo-internal.json` plus plugin allow rules. |
| External-client sees any internal Zeke tool | Unsafe profile exposure                                         | Treat as a release blocker and revert the profile change.                            |
| Native Zeke tool returns auth failure       | Missing or wrong per-profile token                              | Check the configured token environment variable without printing its value.          |
| Proposal approval text does nothing         | Same-chat approval did not reach the signed operator reply path | Check the ZekeFlow proposal reply endpoint and pending proposal row.                 |
| Image drift event appears                   | Upstream or ZekeBot digest changed                              | Review `docs/upstream-merges.md` and the rollback runbook before changing pins.      |

## Fail-closed expectation

A missing token, unknown profile, denied tool, or spoofed caller should fail closed. If the runtime falls back to a broader catalog, treat that as a boundary bug.
