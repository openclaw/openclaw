---
title: Protected content prerequisite and native Codex lane
summary: Design-review proposal for retained protection followed by owned native Codex execution.
---

# Protected content prerequisite and native Codex lane

**Design-review draft. No implementation readiness, runtime security proof, activation permission, or maintainer acceptance is claimed.**

## User goal and delivery order

A user should be able to select an authorized native Codex execution target, start a normal OpenClaw subagent, receive useful coding findings and test results, and request revisions on the same native thread. Native credentials remain with their existing account. The parent must be able to supervise without exposing protected child content to people who lack access.

The proposal has two eventual implementation PRs:

1. A generic retained protected-content prerequisite, including its complete supported producer/consumer and publication cutover.
2. The dependent native Codex lane using that prerequisite and existing plugin/session lifecycle owners.

This document is one early design review, not either implementation PR. Partial foundations must remain inactive until all required consumers and proof are complete.

## Original facts are not current authority

Each independently retained artifact carries its original source identity and incarnation, protection requirements, and relevant resource identity. A replacement session row, reused key, new target label, copied schema version, or missing marker cannot turn old protected content into ordinary content.

Current authenticated read authority must be evaluated against those original facts, including retained original sharing policy and independently current resource read grants. The existing sharing owner retains the protected lineage's current creator/visibility/membership policy and revocations independently of the live session row, for as long as protected content or derivatives remain. Authorized access therefore survives session deletion while that original policy and source remain available. An old grant identifier is evidence, not a capability. Explicit policy erasure or missing/corrupt original authority makes protected content unavailable; a successor cannot supply it. This is retained policy for protected lineage, not a new universal historical ACL service for every ordinary record.

Effects have a separate check: current original task/delegation/turn/custody and execution authority at the actual effect boundary. A successful historical read, approval projection, publication acknowledgment, or recovered reference cannot authorize execution, resolve an approval, resume a thread, or consume a grant. Authority must be rechecked after waits and at disclosure/effect boundaries.

Protection follows results, retries, cached replies, completion/collector output, approvals, events, summaries, artifacts, media, usage, and supported copy/recovery formats. Optional unsupported protected copy/export operations may visibly refuse before disclosure; required lifecycle paths must preserve requirements or remain visibly blocked. Supported protected usage reports must filter original contributions and return correct authorized totals. Only genuinely inseparable or unknown data yields explicit unavailable/partial results without hidden counts; omission is not a scope-saving default. No zero total may masquerade as an exact protected aggregate.

## Parent consent and the coordinator fallback

Child findings entering the parent model are protected derivatives. Before they enter an existing parent's context, obtain explicit consent for the resulting visibility change and commit protection through the parent context, retained outputs, summaries, caches, and delivery owners. Content protection must not copy the child's execution binding or change the parent's harness.

A pre-cutover source with uncertain retained first-party exports may be ineligible for in-place promotion. Offer an explicit protected coordinator instead of silently promoting, deleting, renaming, or replacing the original. Preserve ordinary access under its existing policy. The coordinator must support real findings, revision, and verification; a handle-only result is not an equivalent workflow.

## Existing owners and proposed native extension

Reuse normal session admission, `sessions_spawn(runtime="subagent")`, continuation, completion, approvals, and the Codex plugin/harness. Reuse the app-server client for request correlation and indeterminate writes, transport lifetime, session-binding store/codec, native mutation and event projection. Reuse authenticated paired-node duplex and node connection generations rather than introducing a second dispatcher, thread registry, RPC client, or authority service.

The proposed missing generic seam is trusted owner-prepared execution-resource admission. A logical selector resolves to a bounded opaque execution target, with current requester/delegation/session and resource policy retained by the owner. Neither an arbitrary HOME path nor model-supplied authority flags are accepted. Discovery, preparation, receipt recovery and spawn consumption are proposed contracts, not currently available tools certified by this draft.

The October 27 native-lane design and October 28 coding-lane acceptance contract select an owned direct-stdio app-server in an explicitly approved native home on a paired node, superseding the earlier shared-daemon proxy proposal. The existing exec-server command is not that app-server capability; a fixed plugin-owned command and typed byte adapter are needed. Native account credentials/history do not mean untouched native instructions or tools: fresh managed threads receive normal harness policy and authorized Gateway tools.

Initial scope is fresh OpenClaw-managed threads and guarded continuation of those threads. One controller owns a context and the supported per-home/thread writer lock. Human/native access is sequential after settlement and explicit release; later Gateway continuation reacquires ownership and revalidates current authority. Refuse a busy thread without unloading, stealing, or killing another owner. Cooperative locking does not isolate against malicious processes under the same OS account. No arbitrary-thread adoption, Desktop scraping, public listener, ACP/CLI fallback, or shared-daemon proxy fallback is included.

## First-party publication versus authorized reading

The enforceable promise covers repository-supported automatic publication jobs, including pending, replay, terminal, expiry and retry work: no new provider handoff after original-source protection unless a supported source-Gateway protected publication route has current original authority.

An authorized human/API response discloses data to its current authorized reader. Reading does not enroll a publisher or reserve execution authority. A human or arbitrary external program can save or copy those bytes; this system cannot revoke that copy. This exclusion cannot be used by shipped helpers, SDK adapters, or retained automatic jobs to escape the publication contract.

An admitted publication envelope is a canonical job bound to its source and executor, not merely data with similar fields. Supported automatic ingress must obtain canonical owner admission; supplying an actual read projection to a raw request handler must not manufacture a job. Source-Gateway-owned protected sends remain supported. Remote protected prompt redistribution is unsupported with an explicit content-free outcome. Ordinary remote publication remains supported after the consumer migration, without relocating credentials.

## Explicit wire and SDK compatibility break

Activate a source-Gateway protocol floor that retires content-bearing legacy approval formats for **ordinary and protected** requests together:

- Legacy `exec.approval.list`, `plugin.approval.list`, `openclaw.approval.list`, and `exec.approval.get` authenticate normally but return explicit content-free upgrade-required errors with replacement routes. No empty-success deception, sentinel item, same-name read alias, or ordinary-content fallback.
- Legacy requested/resolved event families stop carrying content. New versioned read/event projections and admitted publication contracts replace them. Requester-visible delivery status must explain unsupported old publication routes; an ignored event alone is not visible failure.
- Preserve complete authorized human pending queues, unified get/history, ordinary/protected read semantics, ordinary remote publication, and canonical resolution/recovery with separate final effect authorization.
- Migrate every shipped automatic consumer and actual transport boundary together, including UI, TUI, CLI, public SDK, ACP, MCP and native channel adapters. Cover surviving agent approval streams and ACP fallback data; prefix-string retirement alone is not completeness proof.

This is an intentional public protocol/SDK compatibility change requiring owner acceptance. A type declaration, advertised capability, connection close, changed client label, or optional guard does not enforce it against an old unmodified helper.

## Enrollment, retirement, activation and recovery

The source owner atomically orders publisher enrollment against source closing/sealing. Shared canonical jobs remain non-exportable until their required source receipts settle; no cross-database atomic transaction is assumed. Retirement is bound to the original executor, source/job/generation and transition. Future initiation must be irreversibly disabled before protection commits. Already initiated provider work may settle; later retries are new handoffs.

A new connection/process, empty queue, TTL, modern read, or missing old row cannot retire an old executor. Uncertain first-party retained exports block in-place promotion. Content-free cleanup remains independent and must not disturb unrelated work.

Startup persists and settles the protocol floor before positively qualifying a fresh source cohort. Existing schema/reader/writer admission must actually reject old software that omits the floor; an additive marker is insufficient. Keep dependent service unready while floor/cohort settlement is uncertain. All new-window, import, copy and repair writers consume current owner facts. Inherited, experimental, restored or unknown provenance cannot become fresh by absence of metadata.

Supported rollback must not reopen old prompt formats while retaining protected-capable certification. Full restore conservatively marks affected original eligibility unknown unless current retirement facts are preserved and qualified; even a coherent old backup can omit later exports. Scoped Doctor/restore follows the same original-identity rule. Deployment requires supported exclusive ownership; raw external rollback is outside that qualification, not something a new format can magically detect.

## Scope and alternatives

The generic prerequisite uses existing storage/sharing, canonical approval/delivery, source publisher, schema/startup/restore and derivative owners. It is not a native-specific parallel ACL layer. Protected native-home designation must survive relevant configuration retirement or raw reads must refuse; target-label reuse is not original identity.

Alternatives considered:

- Child-only protection is smaller but fails once real findings enter the parent.
- A universal ordinary-history ACL/migration service is broader than retaining original policy for enrolled protected lineage under the existing sharing owner. Denying history merely because the live session was deleted is not the selected policy.
- Source-Gateway-only publication is simpler when that Gateway already owns credentials, but replacing ordinary remote-only credential topology changes the intended scope.
- Shared-daemon experiments can characterize a protocol, but do not prove owned-stdio custody or OpenClaw integration.

Non-goals include retroactive control of arbitrary authorized copies, semantic DLP, malicious same-account isolation, simultaneous Desktop ownership, arbitrary adoption, broad historical reclassification, production census, configuration changes, and activation by this PR.

## Delivery and proof plan

1. Establish inactive durable source eligibility/enrollment/retirement foundations under existing owners. Measure actual changed paths/LOC and reached regressions. A foundations checkpoint does not certify a fresh deployment.
2. Complete replacement human reads, ordinary remote publication, all supported consumer ingress, final response/event floor enforcement, transport retirement, schema admission and restore qualification before activation is possible.
3. Finish retained derivatives, parent consent/coordinator, original resource read/effect separation and all necessary copy/recovery paths. Validate the complete generic prerequisite as implementation PR one.
4. Integrate the native lane under those contracts as dependent implementation PR two, with normal plugin coding, tests, completion and same-native-thread revision.
5. Produce accessible sanitized exact-head evidence, independent complete-candidate review, and required owner/CI acceptance before readiness or activation.

Required proof includes two genuinely authenticated users (including an ungranted administrator), current-grant revocation during waits, original deletion/key reuse, old unmodified consumers against actual wire formats, injected read projections at automatic ingress, both enrollment/seal orderings, stale retirement acknowledgments, actual queued provider boundaries, restart/rollback/restore, human reads creating no jobs, ordinary positive controls, parent consent and real native lock/release/reacquisition. Helper fixtures alone cannot certify these paths.

## Claim and evidence map

| Claim                                                                         | Evidence class and limitation                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-owner architecture is a coherent proposal                            | Source-oriented design synthesis. Owner seams were previously inspected against OpenClaw `f810bb4eede72229dffe70be69c366141c4141a2`; later prerequisite work used base `55d82ecb0da219c6e34284f265a19d12884b80a3`. This does not prove current main or deployed behavior. |
| Revised all-payload floor addresses the old-helper ordinary-export design gap | A prior independent design-confirmation report found no actionable P0–P2 structural finding in that revised contract. This is reported design evidence, not a review of this public document or runtime proof.                                                            |
| Candidate fixtures establish complete implementation readiness                | **Not claimed.** Prior reports contain failed checks and subsequent unvalidated corrections. No aggregate green, clean compiler, complete security acceptance or current-candidate verdict is inferred.                                                                   |
| Native app-server contracts are compatible with this design                   | Prior release-source work referenced Codex `rust-v0.164.0`, commit `6aaac694803004a63c6f393d153c96d22521a6b9`. Current executable compatibility and full owned lane must be requalified later.                                                                            |
| This PR changes product behavior                                              | **False.** Documentation only; no implementation, schema, config, credential, runtime or deployment changes.                                                                                                                                                              |

Private experiment logs and advisory transcripts are deliberately not published or linked as accessible proof. This committed summary is the accessible record of the limited claims above; it is not independently reproducible evidence for unshipped behavior. Full sanitized proof belongs to the later implementation PRs. No prior review can substitute for owner approval of public protocol, SDK, storage, channel or permission changes.

## Questions for maintainers

1. Are the existing ownership seams and two-PR dependency order appropriate?
2. Is the explicit all-payload legacy wire/SDK break acceptable, with complete replacement reads and ordinary remote publication required before activation?
3. Is retaining minimal original protected-lineage policy after session deletion, with current revocable memberships and independent current read grants, the right availability/metadata-retention trade-off? Explicitly erased or unavailable original authority still fails closed.
4. Is explicit parent consent plus a protected coordinator for uncertain pre-cutover sources the right user-facing trade-off?
5. Which additional first-party consumers and restore/rollback qualification cases must be in the mandatory acceptance inventory?
6. What accessible exact-head evidence and owner review should gate the eventual implementation PRs and activation?
