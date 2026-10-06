---
summary: "Pairing, operator scopes, role ceilings, and the one-gateway-is-one-trust-domain boundary"
title: "Identity and roles"
read_when:
  - You are configuring gateway roles, scopes, or an identity-aware front door
  - You need to know how OpenClaw bounds what a person can reach
  - You are evaluating OpenClaw for multi-tenant use
---

Device-authenticated control-plane clients present signed identities and go through [pairing](/gateway/pairing). Reconnecting with broader device scopes requires approval. Other admission paths include verified front doors and configured local or shared-secret access. With DM policy set to [pairing](/channels/pairing), unknown senders get a pairing code, not the agent. Identity-aware front doors ([Tailscale](/gateway/tailscale), [trusted proxy](/gateway/trusted-proxy-auth), [Cloudflare Access](/gateway/cloudflare-access)) map verified identities to scopes.

Eight [operator scopes](/gateway/operator-scopes) — `read`, `write`, `admin`, plus narrower ones for pairing, approvals, questions, and talk — are derived per request from the actual parameters before dispatch, and methods with no scope classification are denied rather than allowed. Write and admin operations require their corresponding scopes. [`gateway.roles`](/gateway/operator-scopes) assigns named person-level roles: visibility into other people's sessions, an agent allow-list, and a scope ceiling that is intersected with whatever connection auth granted, never added to it. Profiles without a valid assignment receive the configured default role; configure that role as deny-all for a hardened deployment. Omitting `gateway.roles` leaves the role boundary disabled. [Multi-user sessions](/concepts/multi-user) record an immutable creator, an assignable owner, and a bounded participant history, and verified GitHub identity can flow through to `Co-authored-by` trailers and PR-linked session transcripts ([user model](/concepts/user-model)).

Our [security docs](/gateway/security) define the scope: one gateway is one trust domain. Roles organize collaboration between people who already trust each other. For tenancy, you run one gateway per tenant; [`openclaw fleet`](/cli/fleet) automates this with one hardened container cell per tenant with its own state, credentials, and network (currently experimental), and the [multi-tenant guide](/gateway/multi-tenant-hosting) documents the isolation ladder above it, through gVisor and Kata up to separate machines.
