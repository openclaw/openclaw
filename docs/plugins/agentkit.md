---
summary: "Configure the AgentKit plugin for World-backed OpenClaw HITL approvals"
read_when:
  - You want World AgentKit to protect selected OpenClaw tools
  - You are configuring World ID human approvals for OpenClaw HITL
  - You need the AgentKit status, approval, or local verifier commands
title: "AgentKit plugin"
sidebarTitle: "AgentKit"
---

The AgentKit plugin adds World-backed human-in-the-loop authorization to
OpenClaw plugin approvals. It stays opt-in: enable the plugin, choose the tools
that require approval, and pick the proof mode.

AgentKit does not replace OpenClaw's approval system. OpenClaw still pauses and
resumes the tool call; AgentKit supplies the World-backed proof that can resolve
the pending approval.

## Modes

`human-approval` is the QR/link flow for OpenClaw HITL. A protected tool pauses,
the TUI or `/agentkit approve` starts a World verification request, and the
pending OpenClaw approval is resolved only after the World proof verifies.

`delegation` checks a configured AgentKit-protected resource before resolving
the pending OpenClaw approval. Use this when you have an AgentBook-backed
resource URL and a signer that should prove human-backed delegation.

## Configure human approval

Hosted human approval uses a World approval broker that signs short-lived World
requests for OpenClaw. This keeps the World app, relying-party ID, and signing
key out of the local OpenClaw config, but the broker is an explicit operator
choice. OpenClaw does not default to a hosted broker endpoint.

```json5
{
  plugins: {
    entries: {
      agentkit: {
        enabled: true,
        config: {
          hitl: {
            enabled: true,
            mode: "human-approval",
            protectedTools: ["exec"],
            timeoutMs: 120000,
            grantScope: "session",
            grantTtlMs: 1800000,
            humanApproval: {
              provider: "hosted",
              brokerUrl: "https://your-broker.example.com/v1/world-id/sign-request",
              environment: "production",
            },
          },
        },
      },
    },
  },
}
```

Use `protectedTools` for exact OpenClaw tool names. `exec` is the shell tool. Add
more tools only when they should require a World-backed approval every time the
grant cache does not already cover the current session or agent.

Set `humanApproval.brokerUrl` to the hosted broker endpoint you operate or
trust. Local development brokers may use `http://localhost`; other broker URLs
must use HTTPS.

## World App bridge and exposure model

In hosted mode, OpenClaw sends the configured broker only the derived World
action, the operator-facing action description, TTL, and World environment. It
does not send tool arguments, transcripts, environment variables, file paths,
provider credentials, or pending approval payloads.

When a protected tool pauses, OpenClaw creates a per-approval World action from
`actionPrefix` and the approval ID. The hosted broker signs that action and
returns the World app ID, relying-party ID, nonce, timestamps, and RP signature.
OpenClaw then shows a QR/link in the TUI or `openclaw agentkit approve` output.
The operator scans that QR in World App. After World App returns a proof,
OpenClaw checks the expected nonce, environment, and action when present,
verifies the proof with World, and resolves the pending OpenClaw plugin approval
only when verification succeeds.

The intentional public surface is small:

- config contains the approval provider, broker URL, environment, action prefix,
  grant scope, grant TTL, and protected OpenClaw tool names
- status output reports the provider and whether custom signing credentials are
  configured, not signing key values
- approval UI exposes the pending OpenClaw approval, World request ID, QR/link,
  and whether the grant is one-shot or reusable for the configured scope
- grant storage records decision, scope, timestamps, and the proof nullifier; it
  does not store the World signing key or full proof response

Treat QR links and proof output as ephemeral operator-facing data.

## Custom World credentials

Use `provider: "custom"` when the local OpenClaw setup owns the World app,
relying-party ID, and signing key, or when you need an offline or
enterprise-owned approval path. Prefer `signingKeyEnvVar` over `signingKey` so
signing keys stay outside committed config files. Do not paste private keys,
World signing keys, proof payloads, QR links, or approval result JSON into
shared logs.

```json5
{
  plugins: {
    entries: {
      agentkit: {
        enabled: true,
        config: {
          hitl: {
            enabled: true,
            mode: "human-approval",
            protectedTools: ["exec"],
            humanApproval: {
              provider: "custom",
              appId: "app_...",
              rpId: "rp_...",
              signingKeyEnvVar: "WORLD_ID_SIGNING_KEY",
              environment: "production",
            },
          },
        },
      },
    },
  },
}
```

## Configure delegation

```json5
{
  plugins: {
    entries: {
      agentkit: {
        enabled: true,
        config: {
          walletAddress: "0x...",
          hitl: {
            enabled: true,
            mode: "delegation",
            resourceUrl: "https://agentkit.example.com/protected",
            protectedTools: ["exec"],
            grantScope: "session",
            grantTtlMs: 1800000,
          },
        },
      },
    },
  },
}
```

Run registration when the wallet and local AgentKit CLI are ready:

```bash
openclaw agentkit status
openclaw agentkit register
```

For an `npx` based CLI setup, configure:

```json5
{
  plugins: {
    entries: {
      agentkit: {
        config: {
          cli: {
            command: "npx",
            args: ["-y", "@worldcoin/agentkit-cli"],
          },
        },
      },
    },
  },
}
```

## Approve a pending tool

When a protected tool pauses, list pending AgentKit approvals:

```bash
openclaw agentkit approvals
```

In `human-approval` mode, print the World QR/link and wait for verification:

```bash
openclaw agentkit approve --approval-id plugin:approval-123
```

With `--json`, the approve command emits newline-delimited JSON events: a
`pending` event with the World link before polling starts, then a `resolved`
event after proof verification.

From the TUI approval card, choose the AgentKit approval action instead. The card
starts the same World verification flow and resolves the pending OpenClaw
approval when the proof succeeds.

Generic approval commands can still deny an AgentKit request, but allow
decisions are resolved only by the AgentKit proof-backed flow after World
verification succeeds.

In `delegation` mode, prove access to the configured protected resource before
resolving the OpenClaw approval:

```bash
openclaw agentkit approve --approval-id plugin:approval-123 --private-key-file ./agentkit.key
```

`allow-once` grants only the blocked action. `allow-always` stores a reusable
grant for the configured `grantScope` until `grantTtlMs` expires.

## Local verifier commands

Use the local verifier commands to test AgentKit request signing without
touching production resources:

```bash
openclaw agentkit verifier-server
openclaw agentkit verifier-request --server http://127.0.0.1:4123
openclaw agentkit verify-header --resource http://127.0.0.1:4123/protected --header-file ./header.txt
openclaw agentkit request --resource https://agentkit.example.com/protected --private-key-file ./agentkit.key
```

These commands are CLI-only. They are for local verifier checks and protected
resource proof, not for starting agent turns.
