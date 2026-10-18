---
summary: "Encode-once transcript events: ownership, transport copies, and implemented slices"
read_when:
  - Changing transcript ingestion, replicas, worker transport, or subscriber encoding
  - Reducing transcript allocation without changing stored formats
title: "Transcript event bytes"
---

# Transcript event bytes

**Design; broadcast and shared-response slices implemented.** Preserve the transcript owner's
canonical JSON and carry encoded payloads through readers and transports. Decode
only for consumers that need message fields. This complements
[conversation transcript ownership](/refactor/conversation-transcript-ownership):
one writer remains authoritative, independent of how its events are transported.

## Current allocations

These locations identify the current ownership boundaries, rather than implying
that every event visits every path. Line numbers refer to the implementation at
this proposal's introduction.

| Boundary                                                                       | Current work                                                                                                  | Encode-once cutover                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/llm/providers/stream-wrappers/stream-payload-utils.ts:15`                 | Patches the mutable provider request in place; the earlier clone is already removed.                          | Lane 1061 owns provider request copies; provider requests are distinct from persisted transcript events.  |
| `src/agents/embedded-agent-runner/session-fork.ts:141`                         | Clones replay context; `:170` already retains the final provider payload as JSON.                             | Coordinate provider capture with lane 1061; preserve replay and prompt-prefix bytes.                      |
| `src/shared/immutable-data.ts:17`                                              | Traverses graphs to classify/freeze plain data.                                                               | Lane 1065 owns admission reuse; encoded internal payloads need no repeat graph inspection.                |
| `src/config/sessions/session-actor-replica.ts:272`                             | Clones/freezes hot state, then stringifies for size accounting; `:300` also stringifies transcript retention. | Retain encoded transcript bodies and their known byte lengths; leave hot metadata objects with the actor. |
| `src/config/sessions/session-actor-transcript-replica.ts:148`                  | Clones hydrated events when seeding replica context.                                                          | Retain encoded rows; materialize only for tree/context logic.                                             |
| `src/config/sessions/session-accessor.sqlite-transcript-message-append.ts:245` | Encodes the authoritative message envelope; fallback `:267` parses committed bytes for the receipt.           | Carry the committed encoding and normalized message together from ingestion.                              |
| `src/infra/sqlite-worker-operation-admission.ts:320`                           | Posts worker reply object graphs through structured-clone transport.                                          | Lane 1062 owns byte transfer and lazy reply decoding, including history pass-through.                     |
| `src/gateway/server-broadcast.ts:67`                                           | Serializes projected payloads and assembles connection frames.                                                | First slice shares one UTF-8 message field per publication; recipient envelopes remain separate.          |

## Representation and lifecycle

Ingestion owns normalization and validation of external input. After normalization,
encode the canonical event once, preserving property order, text, and existing
storage semantics. Keep a small record with session identity, sequence, parent,
kind, encoded JSON, and byte length. This is a process representation, not a new
schema or persistent format. SQLite's existing JSON/compressed payload columns
remain authoritative. Existing compression still requires output allocation.

The committed receipt publishes the encoded event plus the fields its consumers
actually need. Actor replicas retain the same immutable encoding, bounded by
existing event/byte limits and actor generation. Append receipts advance that
version; rewrite/reset replace affected entries; actor retirement releases them.
There is no independent cache, freshness probe, or second transcript authority.
A consumer that edits replay/context data materializes its own object at that
editing boundary. Do not eagerly build both object and byte graphs for forwarding.

Across worker boundaries, transfer a dedicated ArrayBuffer when the sender gives
up ownership. A transfer detaches the sender's buffer: do not transfer the actor's
retained buffer or a pooled Buffer backing store. Concurrent retention/fanout needs
an explicit read-only shared representation or one transport-owned copy; avoid
claiming that transfer alone makes multi-reader distribution zero-copy. Lane 1062
owns that contract. SQLite/native transport, compression, WebSocket framing and
the kernel can still copy bytes.

Authorize each history page or subscriber using current owner-held facts before
sending. Encoded content never certifies disclosure authority. Encode the common
message once, then combine it with the audience's projected metadata. A complete
frame can be shared only when audience, sequence and recipient stamps match.
Ancestor receipts and backpressure settlement remain connection-owned.

## First slice and remaining work

The transcript publisher certifies ownership of the message graph for synchronous
fanout. Its recipient projection lazily encodes the `message` field into UTF-8 once
for that `session.message` publication. Broadcast omits that object from its
fresh envelope and inserts the encoded field while assembling a text WebSocket
frame. This removes the recursive stringify replacer, long-string map, and
per-recipient traversal/escaping of message contents. Ordinary broadcasts and
custom projections retain their ordinary JSON semantics, including getters,
mutations between recipients, and `toJSON`. The encoding expires
with the publication, so there is no invalidation policy to maintain.

This slice still encodes the message independently of SQLite and copies bytes
into each distinct recipient frame.

### Slice 2: retain the owned shared-response buffer

History forwarding already prepares and encodes the response message array in
the transcript worker. The worker transfers those bytes; `SerializedJsonArray`
carries them into the socket serializer without main-thread decode/re-encode.
List subscription snapshots similarly register their owner's encoded rows.
Consumed history paging metadata is removed before the worker reply.

`SerializedJsonPayload` now retains a view of the serializer's owned frame buffer
instead of copying the full frame before retaining the payload. The frame assembly
already separates it from the input row/worker bytes. Ordinary string responses
still require UTF-8 encoding. Shared-read expiry and revision invalidation continue
to own retention; each recipient still receives a separately framed response with
its own request id and current disclosure authority.

Remaining work is to carry committed storage encoding into broadcast and replica
consumers where they still materialize objects. Worker message transport and
transcript-worker GC remain separate owners; this slice changes neither. No schema
change is required.

Measure sampled allocated bytes including collected objects, GC time, event
counts, and main-thread CPU on identical synthetic fixtures. Report sampling
noise and native Buffer allocation limits; lower retained heap alone is not
allocation proof. Tests cover recipient isolation, Unicode escaping, text frames,
sequence numbers, serialization failures and transport retirement.
