# Reaction conversations — source delivery

Branch: `ridge/firebed-reactions-fresh-20261107`.
Base: `d59f00281eb02167a86b57c42f04b2b59ed203fe` (`openclaw/openclaw`, upstream main).
Publication: non-force task branch on `saariuslystoned/openclaw`; upstream PR targets `main`.

Acceptance: authorized Discord/Signal reaction add/remove reaches ordinary routed conversation dispatch with bounded actor/account/target/occurrence facts; retained durable ingress prevents duplicate replay turns. Keyed outbound reactions have transport-bound durable receipts and cannot silently retry uncertain claims. A confirmed final conversational reaction can finish the reply, never a task or approval.

Implementation: existing channel plugins, ordinary room-event dispatch and native routing/ingress; one shared receipt operation over existing worker-backed plugin state. No new manager, daemon, schema, config option, credential principal or deployment. Existing explicitly bound native approval controls are separate and unchanged.

Status: Turn 2 same-owner continuation. Candidate source implemented; deterministic boundary tests and explicit-exit typechecks pass. Prior Signal fixture option mismatch repaired and replayed with dedupe assertions retained. Production Discord handler registration is now exercised directly; duplicate admission/wiring removed. Feature context: Related openclaw/openclaw#195017. Final checks/publication/independent review in progress; no CI or review clearance yet. No live Discord/Signal/phone delivery, customer sends, gateway changes or production activation performed or claimed. Merge remains maintainer-owned.
