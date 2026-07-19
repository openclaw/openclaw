---
summary: "Apply deny-only, sender-aware policy checks to tools, message actions, and commands"
title: "Authorization policies"
read_when:
  - You want different callers to have different runtime permissions
  - You are building a plugin that vetoes tools, message actions, or commands
  - You need to understand authorization identity and fail-closed behavior
---

Authorization policies are trusted plugin callbacks that can veto host-owned
operations using the authenticated caller and the prepared operation as input.
They run in the Gateway process at execution boundaries for tools, outbound
message actions, and commands.

An authorization policy is **deny-only**. Returning `pass` means "this policy
does not object." It does not grant a tool, bypass an approval, authorize a
sender, or override an existing allowlist.

<Warning>
  Authorization policy plugins are native code running inside the Gateway.
  Install only reviewed plugins, explicitly enable them, and keep policy
  handlers small and deterministic.
</Warning>

## Choose the right gate

Authorization policies add caller-aware vetoes after the normal OpenClaw
access controls. Keep the existing control that owns each earlier decision:

| Goal                                                        | Use                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Decide who may send messages or commands                    | Channel allowlists, pairing, `commands.allowFrom`, and [access groups](/channels/access-groups) |
| Decide which tools or message actions exist for an agent    | `tools.allow`, per-agent tool policy, and `tools.message.actions.allow`                         |
| Ask a human before one plugin action                        | [Plugin permission requests](/plugins/plugin-permission-requests)                               |
| Approve host command execution                              | [Exec approvals](/tools/exec-approvals)                                                         |
| Rewrite tool parameters                                     | `before_tool_call` or a manifest-gated trusted tool policy                                      |
| Veto a prepared operation based on its authenticated caller | An authorization policy                                                                         |

The model may still see a tool that a policy can reject. This is intentional:
tool visibility remains a base-policy concern, while the authorization policy
is a host enforcement layer. OpenClaw-managed operations are checked at the
final prepared boundary; native harness exceptions are documented below. A
rejected attempt returns a generic authorization error to the model or caller.

## Quickstart

This example gives an owner every operation already permitted by base config.
Members of a Discord maintainer role may use `/fix` and a small set of message
actions in one agent's maintenance conversation. Everyone else in that domain
is denied; operations outside the domain pass to their own policies and gates.

### Declare the policy

Every installed policy plugin declares its local policy ids in
`openclaw.plugin.json`:

```json
{
  "id": "maintainer-authorization",
  "name": "Maintainer authorization",
  "contracts": {
    "authorizationPolicies": ["maintainer-control"]
  },
  "activation": {
    "onStartup": true
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["targetAgentId", "provider", "accountId", "conversationIds"],
    "properties": {
      "targetAgentId": { "type": "string", "minLength": 1 },
      "provider": { "type": "string", "minLength": 1 },
      "accountId": { "type": "string", "minLength": 1 },
      "conversationIds": {
        "type": "array",
        "items": { "type": "string", "minLength": 1 },
        "minItems": 1,
        "uniqueItems": true
      },
      "ownerKeys": {
        "type": "array",
        "items": { "type": "string" }
      },
      "maintainerRoleKeys": {
        "type": "array",
        "items": { "type": "string" }
      },
      "maintainerToolNames": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

Policy ids are local to the plugin. Two plugins may both register
`maintainer-control`, but one plugin cannot register the same id twice.
Set the package's `openclaw.compat.pluginApi` and `minGatewayVersion` floors to
the first OpenClaw release that contains this API. See
[Building plugins](/plugins/building-plugins#quickstart).

### Register the policy

Register with `api.authorization.registerPolicy(...)`. The host supplies a
frozen operation snapshot, frozen invocation context, and an abort signal:

```typescript
import {
  definePluginEntry,
  type AuthorizationInvocationContext,
  type AuthorizationPolicyRegistration,
} from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "maintainer-authorization";
const SAFE_MESSAGE_ACTIONS = new Set(["react", "send", "thread-create", "thread-reply"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value.map(text).filter(Boolean));
}

function identityKey(provider: unknown, accountId: unknown, subjectId: unknown): string {
  const parts = [provider, accountId, subjectId].map(text);
  return parts.every(Boolean) ? parts.join(":") : "";
}

function normalizeDiscordTarget(value: unknown): string {
  let target = text(value);
  const mention = target.match(/^<#(\d+)>$/u);
  if (mention) {
    return mention[1] ?? "";
  }
  for (const prefix of ["discord:", "channel:", "thread:"]) {
    if (target.startsWith(prefix)) {
      target = target.slice(prefix.length);
    }
  }
  return target;
}

function targetMatchesSource(
  target: unknown,
  threadId: unknown,
  context: AuthorizationInvocationContext,
): boolean {
  const current = normalizeDiscordTarget(context.conversationId);
  const parent = normalizeDiscordTarget(context.parentConversationId);
  const preparedTarget = normalizeDiscordTarget(target);
  const preparedThread = normalizeDiscordTarget(threadId);
  if (!current || !preparedTarget) {
    return false;
  }
  if (preparedTarget === current) {
    return !preparedThread || preparedThread === current;
  }
  return Boolean(parent && preparedTarget === parent && preparedThread === current);
}

export function createMaintainerPolicy(
  config: Record<string, unknown>,
): AuthorizationPolicyRegistration {
  const targetAgentId = text(config.targetAgentId);
  const provider = text(config.provider);
  const accountId = text(config.accountId);
  const conversationIds = stringSet(config.conversationIds);
  const ownerKeys = stringSet(config.ownerKeys);
  const maintainerRoleKeys = stringSet(config.maintainerRoleKeys);
  const maintainerToolNames = stringSet(config.maintainerToolNames);
  if (!targetAgentId || !provider || !accountId || conversationIds.size === 0) {
    throw new Error("maintainer policy requires agent, provider, account, and conversation scope");
  }

  const access = (
    context: AuthorizationInvocationContext,
  ): "outside" | "owner" | "maintainer" | "other" => {
    const conversationId = normalizeDiscordTarget(context.conversationId);
    const parentConversationId = normalizeDiscordTarget(context.parentConversationId);
    if (
      text(context.agentId) !== targetAgentId ||
      (!conversationIds.has(conversationId) && !conversationIds.has(parentConversationId))
    ) {
      return "outside";
    }
    const principal = context.principal;
    if (principal.kind === "operator") {
      return principal.isOwner || principal.scopes.includes("operator.admin") ? "owner" : "other";
    }
    if (
      principal.kind !== "sender" ||
      text(principal.provider) !== provider ||
      text(principal.accountId) !== accountId
    ) {
      return "other";
    }
    const senderKey = identityKey(principal.provider, principal.accountId, principal.senderId);
    if (principal.senderIsOwner || ownerKeys.has(senderKey)) {
      return "owner";
    }
    const hasMaintainerRole = principal.roleIds?.some((roleId) =>
      maintainerRoleKeys.has(identityKey(principal.provider, principal.accountId, roleId)),
    );
    return principal.isAuthorizedSender && hasMaintainerRole ? "maintainer" : "other";
  };

  return {
    id: "maintainer-control",
    description: "Owner access plus bounded maintainer commands and messaging",
    handlers: {
      "tool.call": (request, context) => {
        const level = access(context);
        if (level === "outside" || level === "owner") {
          return { effect: "pass" as const };
        }
        if (level !== "maintainer" || request.phase !== "final") {
          return { effect: "deny" as const, code: "tool-not-permitted" };
        }
        if (request.toolName === "message") {
          return request.action && SAFE_MESSAGE_ACTIONS.has(request.action)
            ? { effect: "pass" as const }
            : { effect: "deny" as const, code: "message-action-not-permitted" };
        }
        return maintainerToolNames.has(request.toolName)
          ? { effect: "pass" as const }
          : { effect: "deny" as const, code: "tool-not-permitted" };
      },
      "message.action": (request, context) => {
        const level = access(context);
        if (level === "outside" || level === "owner") {
          return { effect: "pass" as const };
        }
        const allowed =
          level === "maintainer" &&
          SAFE_MESSAGE_ACTIONS.has(request.action) &&
          text(request.channel) === provider &&
          text(request.accountId) === accountId &&
          request.targets === undefined &&
          targetMatchesSource(request.target, request.threadId, context);
        return allowed
          ? { effect: "pass" as const }
          : { effect: "deny" as const, code: "message-action-not-permitted" };
      },
      "command.invoke": (request, context) => {
        const level = access(context);
        if (level === "outside" || level === "owner") {
          return { effect: "pass" as const };
        }
        const allowed =
          level === "maintainer" &&
          request.phase === "final" &&
          (request.source === "text" || request.source === "native") &&
          request.commandName === "fix" &&
          request.owner.kind === "plugin" &&
          request.owner.pluginId === PLUGIN_ID;
        return allowed
          ? { effect: "pass" as const }
          : { effect: "deny" as const, code: "command-not-permitted" };
      },
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Maintainer authorization",
  description: "Applies caller-aware operation vetoes",
  register(api) {
    api.authorization.registerPolicy(
      createMaintainerPolicy((api.pluginConfig ?? {}) as Record<string, unknown>),
    );
    api.registerCommand({
      name: "fix",
      description: "Continue the agent with a bounded repair request",
      channels: ["discord"],
      acceptsArgs: true,
      requireAuth: true,
      handler: () => ({ continueAgent: true }),
    });
  },
});
```

This is an example plugin-owned role model, not a built-in config schema.
Validate any richer policy config in your plugin manifest and bind identity
keys to provider plus account. Sender and role ids are not globally unique
across accounts, Discord, Telegram, Slack, or other channels.

### Require operation coverage

Pin the policy and the operations it must cover in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "maintainer-authorization": {
        enabled: true,
        authorization: {
          requiredPolicies: [
            {
              id: "maintainer-control",
              operations: ["tool.call", "message.action", "command.invoke"],
              scope: {
                agentIds: ["maintenance-agent"],
                conversationIds: ["<DISCORD_MAINTENANCE_CHANNEL_ID>"],
              },
            },
          ],
        },
        config: {
          targetAgentId: "maintenance-agent",
          provider: "discord",
          accountId: "bot-account",
          conversationIds: ["<DISCORD_MAINTENANCE_CHANNEL_ID>"],
          ownerKeys: ["discord:bot-account:<OWNER_SENDER_ID>"],
          maintainerRoleKeys: ["discord:bot-account:<DISCORD_MAINTAINER_ROLE_ID>"],
          maintainerToolNames: ["web_search"],
        },
      },
    },
  },
}
```

`requiredPolicies` is an operator-owned fail-closed pin. For every listed
operation, OpenClaw requires that exact plugin-local policy and handler. A
missing plugin registration or missing required handler denies the operation.
The pin also makes the plugin a startup activation candidate.

`scope` limits where the pin itself applies. Configured fields use AND
semantics, while values within one field use OR semantics. A conversation
matches its own ID or its parent conversation ID, so a channel ID also covers
threads below that channel. Omit `scope` for a global pin. An explicit scope
must contain at least one non-empty selector.

Scope is not the authorization rule. It only determines where a missing plugin
or handler must fail closed. The policy handler must still validate the full
authenticated principal, operation, and prepared input. Use a narrow scope for
an agent-specific policy so removing that plugin does not deny unrelated agents
that share the Gateway. Prefer stable routing selectors such as `agentIds` and
`conversationIds` for a required pin. Missing provenance cannot prove that an
invocation is outside a scoped pin, so missing provider or account provenance on
a sender or unknown principal keeps the pin active. A known value outside the
configured selectors skips it, as does an authenticated operator or service
principal for a provider/account scope. The policy must still validate and reject
missing or malformed provenance when the authorization rule requires it.

The pin does not replace base access configuration. The maintainer still needs
to pass channel and command sender authorization, the `message` tool must be
available, and its action allowlist must include each intended action. For
example:

```json5
{
  tools: {
    message: {
      actions: {
        allow: ["react", "send", "thread-create", "thread-reply"],
      },
    },
  },
  commands: {
    useAccessGroups: true,
  },
}
```

Replies use the `send` action with `replyTo`; `reply` is not a separate message
action. A Discord-only policy should also verify the authenticated account and
that the prepared target remains the source channel or thread.

See [Access groups](/channels/access-groups) for reusable sender lists and
[Slash commands](/tools/slash-commands#configuration) for command sender
authorization.

Allowing `command.invoke` for `fix` authorizes that command dispatch only.
Subsequent agent tool calls still pass through `tool.call`; this example lets a
maintainer search the web and use the listed message actions, but does not allow
file access or shell execution. Add only the tool names the maintained workflow
needs, and leave dangerous operations behind their existing approvals and policy
checks.

### Restart and inspect

Policy code, manifest declarations, registrations, and required-policy pins
are startup security state. Restart the Gateway after installing the plugin or
changing any of them:

```bash
openclaw gateway restart
openclaw plugins inspect maintainer-authorization --runtime --json
```

Verify that the manifest declares the policy, the runtime registered it, and
the configured required operations have handlers before sending live traffic.

## Operation contracts

One policy can implement any combination of the three operation handlers.
`requiredPolicies[].operations` selects which handlers must exist for the
operator's fail-closed guarantee.

### `tool.call`

`tool.call` receives the host tool name, optional tool-kind discriminators,
host-derived `action`, JSON-compatible input, and a phase:

- `phase: "final"` means OpenClaw is at its managed execution boundary.
- `phase: "pre-execution"` means a native harness relay can still have its own
  lower-level processing before the native effect.

The `action` field is derived by the host from the request input. Do not trust a
separate caller-provided convenience field.

### `message.action`

`message.action` runs over the canonical outbound action immediately before
the channel effect. It includes the resolved channel, account, target or
targets, thread, dry-run state, action, and prepared input.

One logical send can invoke the handler more than once. The first check covers
the prepared action. If a reply delivery hook, presentation renderer, or
channel adapter normalization later changes the policy-relevant payload,
OpenClaw invokes `message.action` again with that changed canonical input before
transport I/O. The later decision applies to the exact payload that will be
sent.

The authorization unit is one logical semantic payload. Channel text chunks
and media units are derived only after that complete payload is authorized and
share its decision; policy invocation count is not provider-call count.

Keep this handler pure, idempotent, and fast. Do not debit a quota, emit a
non-idempotent external side effect, or treat invocation count as message count.
Perform accounting from the observation-only
[`message_sent` hook](/plugins/hooks#message-hooks) instead.

Use this handler for action-level rules such as allowing `react`, `send` with
`replyTo`, or `thread-reply` while denying `delete`, `edit`, `pin`, or group
administration. A
`tool.call` check on the outer `message` tool is useful defense in depth, but
it does not replace this final canonical action check.

For a live queued send protected by an active `message.action` policy, OpenClaw
stores a pending authorization record, seals the row to a digest of the exact
final semantic payload, and promotes the seal to authorized before channel I/O.
Ordering-only broadcast leaves use the same durable states, so a crash before
the all-leaf barrier releases cannot replay one leaf alone. Crash recovery
replays only an authorized row whose recovered payload still matches that
digest. Pending, merely sealed, malformed, or mismatched authorization records
fail closed and are not sent. Recovery validates the durable seal instead of
reconstructing the original caller's authority or rerunning the plugin policy.
Every new queue row records whether it originated at the `message.action`
boundary, even when no policy was active, or from an ordinary delivery where
that policy does not apply. If policy becomes active before recovery, a marked
message-action row without an authorization record fails closed while an
ordinary row remains replayable. Legacy rows written before this provenance
field existed have no reliable origin marker and remain eligible for replay;
policy activation is intentionally non-retroactive for that one legacy case.
Rows with platform send evidence are reconciled first, which can finalize an
already committed message but never blindly replays it.

When one broadcast includes a Gateway-owned channel, OpenClaw delegates the
whole logical broadcast to that Gateway before any leaf sends. Every final
payload is therefore authorized and released by one coordinator; a denial on
any leaf produces zero channel effects. The delegated request keeps the signed
sender or authenticated operator principal and the original idempotency key.
Single Gateway-owned actions use the same signed-principal rule. Sender and
service actions fail closed when OpenClaw cannot mint a runtime identity token;
run those actions beside the target Gateway instead of relaying them through an
unsigned operator connection.

### `command.invoke`

`command.invoke` receives the normalized command name, command owner, source,
parsed arguments when available, and a phase. Owners are distinguished as
core, plugin, or skill commands. Sources are `text`, `native`, or `unknown`.

- `phase: "session-mutation"` protects an explicit `/new` or hard `/reset` rollover
  before the old session is archived or runtime state is cleared. Its
  `sessionId`, when present, identifies the current session being replaced.
- `phase: "final"` is the command execution boundary. Ordinary commands run
  only this phase; reset commands may run both phases because the rollover and
  command dispatch are separate effects.

Keep command handlers pure and idempotent. Do not treat policy invocation count
as command count.

The policy runs in addition to normal command sender authorization and
owner-only command rules. Returning `pass` cannot make `/config`, `/bash`, or
another command available to a sender who failed those earlier gates.

## Principal and invocation context

Policies receive one explicit principal kind:

| Principal  | Meaning                                         | Useful fields                                                                                               |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sender`   | Authenticated message-channel sender            | `provider`, `accountId`, `senderId`, normalized `aliases`, `senderIsOwner`, `isAuthorizedSender`, `roleIds` |
| `operator` | Authenticated Gateway client                    | `scopes`, optional `clientId`, `deviceId`, and `isOwner`                                                    |
| `service`  | Named internal service                          | `serviceId`                                                                                                 |
| `unknown`  | No authenticated identity reached this boundary | Optional provider and account hints only                                                                    |

Gateway client capabilities are feature claims, not authorization scopes. Only
authenticated operator scopes appear on an `operator` principal. Channel,
target, route, and thread fields are resource context; they are never treated
as identity.

`sender.aliases` can contain normalized `name`, `username`, and `e164` values
captured by the host at admission. They use the same case-insensitive matching
semantics as `toolsBySender` selectors; a leading `@` is removed from
`username`. These aliases are immutable for that turn, but names and usernames
remain mutable channel attributes. Prefer stable `senderId` rules for grants;
use aliases mainly for compatibility restrictions or deliberate mutable-name
policies.

The surrounding invocation context can also include agent, session, run,
conversation, parent-conversation, and thread identifiers. Treat every field
as optional except `principal`. Deny `unknown` unless the operation has an
explicit anonymous or internal-service contract.

The protection is operation-centric, not Discord-specific. Shared
message-channel paths carry a `sender` principal, authenticated Gateway paths
carry an `operator`, and scheduled or internal paths carry a `service` or
`unknown`. A custom channel or harness that fails to propagate identity becomes
`unknown`; OpenClaw never silently upgrades it to owner.

## Evaluation and failure behavior

Policies run in deterministic registry order. A `pass` continues to the next
policy. The first `deny` is terminal. Policies can only narrow the result of
core allowlists, approvals, sandbox policy, channel access, and tool exposure.

The host passes a recursively frozen clone of the request and context to every
handler. Policies cannot rewrite the operation or retain a mutable reference to
the value that execution will use. Use a tool hook when parameter rewriting is
the intended behavior.

Each policy has a 15-second default timeout. `timeoutMs` is clamped to the
supported range of 1 millisecond through 30 seconds, and the whole policy chain
has a 30-second asynchronous deadline. Synchronous blocking JavaScript cannot
be interrupted, so handlers must stay pure, idempotent, and nonblocking. Avoid
network lookups on the authorization hot path; prepare or cache identity facts
under a clear plugin lifecycle owner instead.

OpenClaw denies the operation when a policy:

- returns `deny`
- throws or rejects
- times out or is aborted
- returns a malformed decision
- has an invalid or unreadable registration
- is required but missing
- lacks a handler for a configured required operation

Policy denial codes are 1-64 lowercase ASCII characters matching
`[a-z0-9][a-z0-9._-]{0,63}`. Policy-authored text is not forwarded to the model,
channel user, or HTTP client. External callers receive a stable generic
authorization error; detailed policy and code identity stays in trusted
diagnostics.

`unhandled` controls operations not implemented by a policy:

- omitted or `"pass"`: an unimplemented, non-required operation adds no veto
- `"deny"`: any unimplemented operation is denied

Use `unhandled: "deny"` for a policy intended to cover every current and future
operation. Independently, use `requiredPolicies[].operations` so an operator
can assert the exact handlers that must exist now.

## Native Codex boundary

OpenClaw-managed dynamic tools reach `tool.call` with `phase: "final"`. Native
Codex hooks otherwise report shell, patch, MCP, and collaboration tools at a
`phase: "pre-execution"` boundary. Codex does not currently provide a mandatory,
fail-closed hook contract for every native effect. Therefore, whenever an
authorization policy is active, OpenClaw disables the Codex-native tool,
environment, and multi-agent surfaces for that turn. OpenClaw dynamic tools
remain available and reach the final host-owned boundary normally.

This is intentionally broader than one policy's scoped pin. Do not depend on a
native Codex tool from a sender-aware policy deployment. A future mandatory
upstream hook contract can narrow this restriction without changing the policy
API. See [Codex hook boundaries](/plugins/codex-harness-runtime#hook-boundaries).

## Lifecycle and migration

Authorization policy metadata and registrations are process-stable. Restart
the Gateway after changing plugin code, `contracts.authorizationPolicies`, or
any `plugins.entries.<id>` field for a plugin that declares or registers an
authorization policy, including `enabled`, `config`, and
`authorization.requiredPolicies`. Changes to global plugin activation settings
such as `plugins.enabled`, `plugins.allow`, `plugins.deny`, or `plugins.slots`
also restart the Gateway when a discovered policy plugin is present because
they can add or remove it. A plugin-specific reload hook may refresh its own
ordinary data, but it must not be used to swap the registered security boundary
in place. Ordinary non-policy plugin entries remain hot-reloadable.

Before disabling or removing a required policy plugin, first remove its
`requiredPolicies` pin and restart intentionally. Leaving the pin in place is a
safe rollback state: listed operations continue to fail closed.

This API does not deprecate existing sender allowlists, per-agent tool policy,
message action allowlists, command authorization, or approval flows. Any future
configuration consolidation needs a separate migration and deprecation plan;
do not remove those base gates when adopting authorization policies.

## Troubleshooting

| Symptom                                                     | Check                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Every protected operation is denied after plugin removal    | Remove the matching `requiredPolicies` pin only if the removal is intentional, then restart                                                |
| Runtime says the policy is undeclared                       | Add the id to `contracts.authorizationPolicies`; installed plugins cannot register undeclared ids                                          |
| Runtime says the installed plugin is not explicitly enabled | Set `plugins.entries.<id>.enabled: true` and restart                                                                                       |
| One required operation fails closed                         | Add its handler or remove that operation from the required pin after reviewing the reduced coverage                                        |
| Maintainer still cannot use an allowed operation            | Check base channel, command, tool, action, sandbox, and approval policy; `pass` grants nothing                                             |
| Policy sees `unknown`                                       | Fix identity propagation at the channel, harness, HTTP, RPC, or internal-service boundary; do not infer identity from route or target data |
| Calls fail at 30 seconds                                    | Remove blocking or remote work from the handler and precompute the needed facts                                                            |
| One send produces more than one policy evaluation           | Expected when hooks, rendering, or adapter normalization changes the payload; make the handler pure and idempotent                         |
| A queued send does not recover after restart                | Check that live authorization reached `authorized` and that the recovered final payload still matches its sealed digest                    |

## Related

- [Building plugins](/plugins/building-plugins)
- [Plugin manifest](/plugins/manifest#contracts-reference)
- [Plugin hooks](/plugins/hooks#tool-call-policy)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Access groups](/channels/access-groups)
- [Multi-agent tool policy](/tools/multi-agent-sandbox-tools)
