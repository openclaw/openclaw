---
summary: "迭界AI on OpenClaw system boundary, marketplace split, and API bridge"
title: "迭界AI System Boundary"
---

# 迭界AI System Boundary

迭界AI is the product name across both layers. The OpenClaw fork is not an
external sidecar or a thin plugin host; after branding and business-rule
migration it is the 迭界AI main system itself, keeping OpenClaw's conversation,
programming, workspace, session, Gateway, and tool capabilities. Mercur/Medusa
is the open-source commerce and marketplace implementation base for the cloud
role marketplace. Mercur/Medusa names should not become the product brand shown
to users.

## Product Split

The target shape is one 迭界AI product made from two open-source forks linked by
APIs:

```text
迭界AI cloud layer
-> Mercur/Medusa marketplace fork
-> account, role marketplace, orders, one-time authorization, review
-> developer center, billing records, audit records, governance

迭界AI main system / local app
-> OpenClaw fork as the product body
-> conversation, programming, local Gateway, devices, sessions, workspace, tools
-> model proxy client and Gateway execution

迭界AI Gateway Bridge API
-> device binding, execution tokens, role package protocol, RoleResult return
-> audit summary upload
```

Do not merge the two systems into one database. Do not make the marketplace a
thin OpenClaw plugin. Do not make the 迭界AI main system own commerce facts.

## Adaptation Boundary

The first rule for both forks is adaptation, not hard insertion. 迭界AI must
reuse and reshape the original system facilities before adding anything new.

For the OpenClaw fork:

```text
existing conversation box -> use as the primary natural-language entry
existing session/workspace -> use for task context and local execution
existing Gateway -> use as the execution and RPC entry
existing tools/model/provider auth -> use for runtime capability
existing logs/usage/status surfaces -> connect Dijie data where they fit
```

Do not create a second product chat box, a second execution entry, or a parallel
runtime when OpenClaw already has the facility. Add only the Dijie business
logic that OpenClaw does not have: ActorContext, marketplace entitlement,
execution tokens, role package protocol, RoleResult/AuditSummary, audit bridge,
and billing/governance rules.

For the Mercur/Medusa fork:

```text
existing customer/developer account -> adapt for Dijie buyers/developers
existing product/listing/order primitives -> adapt for role listings and one-time authorization
existing admin/review surfaces -> adapt for role package review and governance
existing module/service patterns -> adapt for audit, entitlement, and payout records
```

Do not bypass or duplicate Mercur/Medusa commerce primitives with a separate
shadow marketplace unless the original framework truly lacks the needed
facility.

Any new module must pass a product boundary discussion before implementation.
The default answer is: adapt the original framework first. A new module is
allowed only when the existing framework has no suitable facility, or when
reusing it would break ownership, security, accounting, or lifecycle rules.

## Current Bridge Implementation

The OpenClaw-derived main system now exposes three Gateway methods for the first
real bridge slice:

```text
dijie.executionToken.request
-> UI supplies a transient cloud customer bearer and execution context
-> Gateway calls the 迭界AI岗位商场 execution-token API
-> response fills the short-lived execution token in the local role-builder form
-> if the grant includes executionId, the local audit-read field is filled too

dijie.executionAudit.read
-> UI supplies a transient cloud customer bearer and executionId
-> Gateway calls GET /dijie/executions/:executionId on the 迭界AI岗位商场
-> response returns the safe cloud execution audit projection
-> cloud access tokens must be bearer-only inputs and must not be echoed in the result

dijie.roleBuilder.run
-> main conversation flow or an internal caller submits the confirmed RoleBuildBrief plus execution token
-> Gateway validates execution context and runs the local role package builder
-> result returns changed files, validation state, RoleResult, and AuditSummary
-> if the local run returns executionId, the UI backfills the audit-read field
```

The cloud bearer is only an interim UI input for local development. It must not
be stored, echoed in results, written into role packages, or passed into the
role-builder execution payload. The final product should replace it with the
normal signed-in account/session bridge, but the failure rule stays the same:
missing cloud auth, missing execution token, or rejected entitlement is a hard
failure, not a fallback success.

Formal product flows must not expose a manual cloud bearer field to end users.
The signed-in account bridge is responsible for obtaining short-lived cloud
access on behalf of the user, and that access is only a request credential. It
is not a RoleResult field, AuditSummary field, role package field, local config
field, or UI state that can be persisted.

The AICS page is not a second product chat box. It may show bridge status,
execution authorization, and audit diagnostics while development is in progress,
but the primary natural-language flow must stay in OpenClaw's existing main
conversation surface.

## Development Operating Model

Future development on this architecture must use a three-agent model in both
planning and implementation when the user asks for multi-agent work across the
two open-source forks. Planning is not single-agent: the same split applies
before code is written.

Correct planning assignment:

```text
planning agent A: OpenClaw fork / 迭界AI main system plan
-> local app, Control UI, Gateway, device/session/workspace runtime
-> risks around local execution, model/runtime identity, UI failure states

planning agent B: Mercur/Medusa fork / 迭界AI岗位商场 plan
-> account, orders, entitlement, one-time authorization, audit read/write
-> risks around commerce truth, auth, review, listing lifecycle

planning agent C: integration / protocol / security plan
-> API contracts, ActorContext, token claims, RoleResult/AuditSummary
-> checks for secret leakage, cross-system state ownership, failure semantics
```

Correct implementation assignment:

```text
sub-agent A: OpenClaw fork / 迭界AI main system
-> local app, Control UI, Gateway, device/session/workspace runtime
-> local execution, OpenClaw-native runEmbeddedAgent, RoleResult/AuditSummary
-> UI failure states and local validation

sub-agent B: Mercur/Medusa fork / 迭界AI岗位商场
-> account, orders, entitlement, one-time authorization
-> execution token signing, audit upload, audit read model
-> developer center, review, listing lifecycle

sub-agent C or main Codex agent: controller/reviewer/integrator
-> split work, keep boundaries, review both sides, run focused tests
-> verify no fake success, no secret leakage, no cross-database writes
-> summarize business capability and remaining human-use gaps
```

The controller must not claim "three-agent planning" or "three-agent
development" unless all three roles were actually covered. If the sub-agent
limit prevents three simultaneous workers, the controller must state that
limitation clearly, reuse existing available sub-agents where possible, and
cover the integration/security role explicitly instead of silently dropping it.

Each sub-agent has a disjoint write boundary:

- OpenClaw-side workers do not modify the Mercur/Medusa marketplace repo.
- Mercur/Medusa-side workers do not modify the OpenClaw main-system repo.
- Integration/protocol workers may edit shared docs and protocol schema only
  after identifying the owning repo and checking current worktree state.
- The controller may edit integration docs and small glue fixes only after
  reviewing the sub-agent output and current worktree state.

Completion reporting must be business-first:

```text
what can the product do now?
which repository changed?
which real tests or smoke checks passed?
which human page flow is still not done?
```

Tests are evidence, not completion by themselves. Human-use closure remains the
acceptance standard for product milestones.

## Runtime Layer

The OpenClaw-derived 迭界AI main system provides the durable runtime surfaces:

- Gateway WebSocket protocol
- Control UI
- sessions
- agent workspace
- skills and tools
- local device identity
- platform model proxy client
- local execution runtime

The 迭界AI main system owns local runtime truth:

- local operator access
- device pairing
- Gateway local auth token or password
- local runtime profiles
- platform model proxy selection
- local agent workspace
- local sessions and runtime state
- local tool/runtime approvals

The 迭界AI main system does not own:

- role purchases
- marketplace entitlements
- buyer authorization state
- developer account standing
- package review state
- listing publish/unpublish state
- business audit truth

## Marketplace Layer

The role marketplace uses Mercur/Medusa as the open-source base, branded as
迭界AI岗位商场.

Mercur/Medusa provides the commerce and marketplace foundation:

- seller/developer portal
- buyer/customer account
- product/listing catalog
- cart and order primitives
- marketplace/vendor extension points
- admin surface
- storefront surface

迭界AI岗位商场 owns business truth:

- developer account
- buyer account
- role listing metadata
- role package owner
- listing owner
- entitlement holder
- billing beneficiary
- package review and deployment lifecycle
- listing publish/unpublish/archive/delete state
- human reviewer/operator refs
- billing and audit records

The marketplace does not own:

- local device pairing
- platform model API key storage
- OpenClaw provider auth profile
- local Gateway transport auth
- OpenClaw session storage
- direct tool execution

## API Bridge

The two systems communicate through the 迭界AI Gateway Bridge API.

Rules:

- The marketplace signs short-lived execution authorization for a purchased or
  installed role with a cloud-held Ed25519 private key.
- Gateway validates the execution token with the 迭界AI public key, then checks
  entitlement context, listing state, resource limits, and protocol shape before
  execution.
- The local OpenClaw fork exposes `dijie.execution.preflight` as the execution
  gate before role runtime work starts. It validates the token signature,
  expiry, required claims, `role.execute` scope, and local request context
  matching.
- The main-system role builder must call `dijie.execution.preflight` before
  confirmed package generation. After `confirm_brief=true`, it requires a
  confirmed `RoleBuildBrief`, an execution token, and matching local context,
  then starts OpenClaw main-system local execution in an isolated role-package
  workspace.
- Gateway starts the local OpenClaw runtime work and streams execution events.
- The current local AICS implementation can call OpenClaw-native
  `api.runtime.agent.runEmbeddedAgent` for confirmed role-builder execution.
  This is the preferred product direction because it uses the OpenClaw-derived
  迭界AI main system's own workspace/session/agent/tool runtime.
- A temporary subprocess adapter remains as a migration bridge. Its generic
  config fields are `localExecutorCommand`, `localExecutorArgs`,
  `localExecutorModel`, `localExecutorProfile`, and `localExecutorMode`; during
  migration it may continue to accept the legacy `codexBinary`, `codexModel`,
  and `codexProfile` fields for compatibility. This adapter is not the product
  engine boundary.
- There is no default Codex CLI product path. A confirmed role-builder run must
  either use OpenClaw-native `runEmbeddedAgent` or receive an explicit
  `localExecutorCommand` for the temporary adapter. Missing execution engine
  config fails closed.
- After the local executor exits, the local AICS extension must validate the
  generated `role_package/`, construct a local `RoleResult` and `AuditSummary`,
  and return them in the tool result. The summary must include `executionId`,
  `roleListingId`, `entitlementId`, `deviceId`, `workspaceRef`,
  `localGatewayId`, terminal `status`, `changedFiles`, artifact metadata,
  `toolUsage`, and nested `result`.
- `entitlementId` is an authorization reference, not a guaranteed permanent
  table name. In the current marketplace bridge it may resolve to `order_group.id`
  or `order.id`; once a dedicated entitlement table exists, the audit trail must
  keep backward-compatible order references instead of rewriting old execution
  records.
- If cloud audit upload is enabled, the local extension uploads the
  `AuditSummary` to Mercur `POST /dijie/audit` with
  `Authorization: Bearer <execution token>`. Required upload failures make the
  local role-builder run fail explicitly; the extension must not report full
  success when the cloud audit sink rejects or cannot persist the summary.
- The marketplace never writes OpenClaw runtime tables directly.
- OpenClaw never writes marketplace orders, entitlement, or review state directly.

Minimum bridge context:

```json
{
  "runtime_actor_ref": "openclaw:agent:main",
  "business_actor_ref": "buyer:local_owner",
  "workspace_ref": "workspace:local_owner",
  "developer_ref": "developer:merchant_001",
  "role_listing_ref": "role_listing:purchased_role_001",
  "entitlement_ref": "entitlement:purchased_role_001",
  "source": "dijie-marketplace",
  "session_ref": "agent:main:main"
}
```

Runtime identity explains who ran it locally. Business identity explains who is
accountable in the marketplace. Both are required for billable role execution.

## Protocol Policy

Do not rewrite OpenClaw's base communication protocol for the MVP.

Keep:

- Gateway WebSocket request/response/event framing
- Control UI connection model
- session event streaming
- tool schema and tool result shape
- plugin SDK registration and loading

Add 迭界AI bridge methods as namespaced protocol surface:

```text
dijie.marketplace.*
dijie.entitlement.*
dijie.roleBuilder.*
dijie.developerCenter.*
dijie.gateway.*
dijie.billing.*
dijie.audit.*
dijie.governance.*
```

The existing `aics.*` namespace may remain as a temporary migration alias, but
new product-facing code should use `dijie.*`.

## Tool Policy

OpenClaw tool protocol remains usable. 迭界AI adds business policy around tools.

迭界AI tools must:

- validate bridge actor context
- enforce listing state and entitlement before execution
- check one-time authorization before role execution
- emit audit records for every business state transition
- route write actions through HumanConfirm where required
- fail closed when secrets, entitlement, billing, or review state is missing

迭界AI tools must not:

- directly mutate listing state without marketplace governance
- directly mutate entitlement state without billing/audit
- read raw secrets
- skip deployment/package review
- bypass Gateway execution checks
- report success when local execution, model proxy, materials, sandbox, or write
  boundary requirements are missing

## Pricing Policy

The MVP uses one-time authorization pricing, not runtime duration billing.

```text
developer sets role authorization price
-> buyer pays once for the authorization
-> developer receives the full role payment
-> platform fee for marketplace role payments is zero
-> platform revenue comes from main-system usage metering
-> local execution is governed by resource limits, not hidden runtime charges
```

Every authorization and execution audit record must carry a pricing snapshot and
the developer/listing owner/billing beneficiary references used for settlement.
Developer payout must not depend only on the current listing owner looked up
after the fact.

Resource limits can still stop abuse:

- max single-run duration
- max concurrent executions
- max artifact size
- max model proxy requests
- max file write scope

These are safety and capacity controls, not extra usage fees.

## Main System Role Builder

There is no separate "first job" product. The 迭界AI main system is the
front-end product users operate. It is built on the OpenClaw runtime and already
has programming capability, so role-package generation is an isolated main
system capability, not a marketplace role listing.

Correct flow:

```text
developer opens 迭界AI main system / developer center
-> developer uses the existing main conversation, repeatedly, until the main
   system understands the concrete demand, scope, architecture, acceptance
   standard, package shape, pricing intent, and review target
-> main system turns the confirmed conversation into a RoleBuildBrief
-> isolated role-package workspace is created
-> main system starts OpenClaw main-system local execution with only
   RoleBuildContext
-> role_package/ is generated as a complete program package for the job role,
   not only a text description or listing stub
-> local validator requires role_package/manifest.json, listing.md, README.md,
   one wrapper/adapter/example file, and one validation/smoke material
-> local RoleResult and AuditSummary are built from command result, changed files,
   artifact metadata, tool usage, and validation status
-> optional or required cloud audit upload posts the AuditSummary to /dijie/audit
-> validation/smoke status is visible in the local result
-> developer downloads the generated role package
-> developer uploads the role package to developer center for listing metadata,
   pricing, token pricing, review, and publishing
-> marketplace review / publish / version lifecycle continues in cloud backend
```

The front-end contract is conversation-first. The main system may expose
progress, generated files, validation results, download actions, and developer
center upload handoff, but it must not replace the repeated natural-language
intake with a static product form. A form can exist only as the developer-center
listing/upload surface after the package exists.

The main system has two user-facing modes on the same product surface:

```text
user mode
-> default mode for buying, installing, and running existing roles
-> the conversation uses the user's purchased roles and normal work context

developer mode
-> awakened by an explicit mode switch, command, or developer-center entry
-> the same main conversation becomes a dedicated role-development agent
-> the agent's job is to clarify requirements and generate a complete
   downloadable role_package/ program for developer-center upload
```

Developer mode is a state of the main system conversation, not a second chat
product. Switching into it must also switch context, permissions, copy, and
available actions: it can gather role requirements, propose architecture, define
acceptance criteria, generate package files, run validation, and prepare a
download/upload handoff; it must not use the user's normal role-running context
as hidden input for a marketplace package.

Developer mode must not receive platform backend state as prompt material.
Execution ids, actor ids, entitlement ids, order/wallet facts, pricing snapshots,
settlement state, review state, cloud bearers, and raw tokens stay inside the
platform bridge, audit builder, settlement derivation, and cloud APIs. The role
development agent receives only developer-provided business materials, public
role-package protocol/templates, and the isolated workspace.

Inside developer mode, input/output shape, business rules, exception handling,
acceptance criteria, and test cases are internal structuring dimensions, not
parameters the developer must fill one by one. The agent derives them from the
developer's business logic and asks for confirmation in business language. Those
same dimensions may be published as external role-package standards for
developers who build packages outside 迭界AI with other tools.

The built-in developer-mode instruction set lives in
`docs/aics/developer-mode-guide-prompt.md`, and the internal material pack lives
in `docs/aics/developer-mode-material-pack.md`. Product UI should expose only
the simple developer-facing opening; the protocol and platform material remains
internal so developers can focus on business logic.

Missing local executor, missing login, insufficient materials,
write-boundary violations, validation failure, smoke failure, and required
audit-upload failure must fail explicitly. They must not fall back into a
successful marketplace state.

RoleBuildContext may include:

- confirmed brief
- user-uploaded materials
- public role-package protocol docs
- public templates
- current isolated workspace

RoleBuildContext must not include:

- main-system chat history
- long-term memory
- local private files
- model API keys or provider auth
- raw secrets
- cloud bearer, raw execution token, raw model request, or raw model response
- wallet, order, entitlement, review, or deployment database privileges

## Migration Implication

The legacy Python ai_gongsi_kekong_xitong web app is not the product host. It can remain
temporarily as a business logic source while its useful logic is migrated into:

1. OpenClaw fork for the 迭界AI main system / local app product body.
2. Mercur/Medusa fork for 迭界AI岗位商场.
3. 迭界AI Gateway Bridge API for execution linkage.

Completion is judged by human use through the two-system product flow, not by
tests alone and not by the existence of a plugin bridge.
