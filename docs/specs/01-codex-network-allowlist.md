---
title: Codex network allowlist
summary: "Use OpenClaw configuration to select Codex native domain restrictions."
read_when:
  - Configuring network access for Codex sandbox commands
  - Changing the Codex plugin networkProxy configuration path
---

# Feature Spec: Codex network allowlist

**Date:** 2026-09-24
**Status:** Implementation verified locally; integration gaps remain
**Owner:** Codex plugin

## Problem and Decision

Use the existing `plugins.entries.codex.config.appServer.networkProxy` configuration to pass a domain allowlist to Codex native enforcement. This capability already exists on the inspected baseline; delivery should clarify its use and close demonstrated admission failures, without introducing another policy API or proxy.

This specification follows the narrowed request for an allowlist in OpenClaw config. Full managed-deployment policy parity, MITM request hooks, credential injection, and certificate configuration are outside this delivery.

Baseline: OpenClaw [`0580bd904564bb771f623c4fd709eab299adf8fb`](https://github.com/openclaw/openclaw/tree/0580bd904564bb771f623c4fd709eab299adf8fb). Native contracts were inspected at Codex `0.155.1` ([source revision](https://github.com/openai/codex/tree/be2951ea34f0d295ed0becf97079f92fa5f6950e)) and `0.149.0` ([source revision](https://github.com/openai/codex/tree/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0)); source inspection and local execution results are distinguished in Verification below.

## Scope

- Keep the existing `enabled`, `domains`, and optional `mode` fields, generated permission profile, and native approval behavior.
- Make an explicitly enabled but invalid or unenforceable allowlist fail visibly before affected command execution.
- Document configuration, network scope, and a small acceptance matrix; add runtime changes only for reproduced gaps.
- Do not add a second allowlist field, managed-profile selector, custom domain matcher, proxy service, hook executor, certificate store, policy reconciler, or dependency upgrade.
- Do not turn a normal configuration allowlist into a tamper-proof administrative policy. Native deployment requirements remain independently authoritative; this work does not provision them.

## Contract

### Configuration

This existing configuration requests domain restrictions and disables approval-based exceptions for unattended commands:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            approvalPolicy: "never",
            sandbox: "workspace-write",
            networkProxy: {
              enabled: true,
              domains: {
                "api.example.com": "allow",
                "*.packages.example.com": "allow",
                "blocked.packages.example.com": "deny",
              },
            },
          },
        },
      },
    },
  },
}
```

The schema already accepts this map and the resolver forwards it to `permissions.<generated-profile>.network.domains`, enables the native network proxy feature, and selects `default_permissions`. Reuse that producer and consumer: [parser](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/config-parsing.ts#L70-L91), [resolver](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/config-security.ts#L42-L109), [thread request](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/thread-requests.ts#L447-L455).

| Input                                       | Required behavior                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy absent or disabled                    | Preserve current behavior and defaults; do not enable restrictions implicitly.                                                                          |
| `enabled: true` with allowed domains        | Codex evaluates each destination against its native domain policy.                                                                                      |
| Explicit deny overlapping an allow          | A deny in the effective native policy wins; approval cannot grant that destination.                                                                     |
| Host absent from effective native allowlist | Native allowlist miss; the example's `never` policy denies it. Other approval policies retain their existing explicit approval flow.                    |
| Enabled with no allowed domains             | Do not synthesize a wildcard or unrestricted fallback. Preserve native policy composition, including managed allows and the configured approval policy. |
| `mode` omitted or `"full"`                  | Preserve native full-mode method behavior; full mode still evaluates domains.                                                                           |
| `mode: "limited"`                           | Preserve native GET/HEAD/OPTIONS restrictions and the native TLS handling needed to enforce them. No new MITM settings.                                 |

Codex owns matching and normalization: exact hostnames, `*.example.com` for subdomains, and `**.example.com` for apex plus subdomains. These are host patterns, not URL paths. Do not implement a competing matcher. Invalid patterns must surface a configuration error, not disable the proxy. [Native matching](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/network-proxy/src/policy.rs#L195-L232), [mode contract](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/network-proxy/src/config.rs#L361-L379).

An effective allowlist miss can reach Codex's approval decider; explicit denies cannot. `approvalPolicy: "never"` prevents approval-based exceptions. Native system requirements may contribute allowed domains or select the managed set, so the OpenClaw map is not an immutable deployment ceiling or a replacement for native policy. OpenClaw preserves native policy composition and refusals. [Managed domain composition](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/core/src/config/network_proxy_spec.rs#L382-L427), [native decision boundary](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/network-proxy/src/network_policy.rs#L363-L400).

### Runtime and failure behavior

- Preserve the generated sandbox profile on thread start, resume, and normal turns. A request that replaces it with an incompatible sandbox must fail before command execution; never retry without the allowlist. This is an admission rule, not a new policy-merging system.
- Preserve existing profile fingerprinting and thread rotation when config changes. Use the next admitted turn to adopt the changed configuration; do not promise revocation of an already-running process or add a background watcher. [Binding lifecycle](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/thread-lifecycle-run.ts#L559-L572).
- Preserve existing version detection from the app-server initialize handshake: managed runtime `0.155.1`, minimum `0.149.0`; reject missing, malformed, and older versions. Keep the existing warning for newer versions and require normal runtime capability checks. No allowlist-specific version bump is justified by the inspected source. [Version admission](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/client.ts#L1036-L1070).
- Keep unsupported backends unavailable for this configuration. The current container execution backend rejects native managed networking; expose that failure clearly rather than falling back to unrestricted execution. [Backend guard](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/sandbox-exec-server/processes.ts#L121-L131).
- Errors identify the configuration key or unsupported execution capability and a corrective action. Do not dump complete config, environment variables, credentials, request headers, or bodies.

These restrictions cover commands executed through the Codex sandbox. They do not govern OpenClaw Gateway traffic, model-provider requests, unrelated MCP processes, or whole-container egress. Existing local/private-address, upstream-proxy, SOCKS, and Unix-socket settings retain their current behavior; domain allowlisting alone does not override them. Operating-system or container-wide isolation is a separate deployment concern.

### Scoped parity

The reference deployment is summarized at capability level; private source evidence is retained separately.

| Capability                                                                             | Current OpenClaw                                 | This delivery and verification                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Native domain allow/deny policy                                                        | Existing typed map and native profile forwarding | Reuse; prove allowed, unlisted, and denied destinations.       |
| Network mode selection                                                                 | Existing `limited` and `full`                    | Preserve; prove allowed GET and mode-specific POST behavior.   |
| No unattended approval escape                                                          | Existing `approvalPolicy: "never"` configuration | Document the example; prove no exception for unlisted traffic. |
| Immutable deployment policy, request shaping, credential injection, custom trust setup | Not provided by the ordinary allowlist map       | Outside narrowed scope; no parity claim.                       |

## Implementation

The existing `networkProxy.domains` API, derived types, manifest, and native profile resolver remain unchanged. The only runtime change is a five-line guard in `readCodexPluginConfig`: when parsing fails and the raw configuration explicitly enables the network proxy, throw a redacted configuration error instead of returning `{}`. Absent or disabled proxy configurations retain their existing fallback behavior.

The reproduced admission gap is `networkProxy.profileName: ""`: normal manifest validation accepts the string, but the internal parser requires a nonempty value and previously discarded the entire enabled policy. Focused regressions cover that path, a malformed sibling configuration field, and preserved fallback behavior without an enabled proxy. Valid configurations require no migration.

No broader sandbox override guard was added. Source inspection found that the existing external sandbox environment advertises `networkProxyLaunch: false`; native Codex refuses the managed networking request before spawning a command. The backend also retains its own rejection of managed network restrictions. Existing lifecycle, version, and backend tests exercise the unchanged boundaries. [Environment capability](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/sandbox-exec-server/session.ts#L118-L124), [backend guard](https://github.com/openclaw/openclaw/blob/0580bd904564bb771f623c4fd709eab299adf8fb/extensions/codex/src/app-server/sandbox-exec-server/processes.ts#L121-L131).

The [transport guide](/plugins/codex-harness-reference/app-server-transport) provides the minimal example; the [config field reference](/plugins/codex-harness/config-fields) owns matching, approval semantics, policy inheritance, and scope.

## Verification

Local implementation checks passed: 160 config tests and 30 focused lifecycle, version, and backend tests. The parser regression was reproduced before the guard and passed after the fix.

An isolated probe used the actual OpenClaw runtime resolver and app-server client with Codex `0.155.1`, disposable state, and the generated native permission profile. Native `command/exec` performed successful HTTPS GETs in both full and limited modes. A host absent from the effective allowlist returned HTTP 403 with `blocked-by-allowlist`; an explicitly denied host returned HTTP 403 with `blocked-by-denylist`. Native system requirements remained active, and a separate successful request confirmed that managed allowed domains can survive omission from the OpenClaw map.

This proves the config-to-native-command boundary, not a model-driven OpenClaw turn or interactive approval routing: `command/exec` has no thread ID and starts the proxy without a policy decider. A direct request initially failed DNS resolution. A follow-up cleared proxy variables, disabled proxy use, and supplied a pre-resolved public IP with curl `--resolve`; it failed immediately with curl exit 7 while a proxied GET to the same host succeeded. This eliminates DNS as the cause of that failed direct TCP attempt, but does not prove enforcement across every egress route. POST behavior, controlled origin receipt counts, and a model-driven turn were not tested. Certificate validation remained enabled; certificate identity was not separately captured.

The original acceptance matrix below remains the target. The local results above do not close the untested outcomes.

| Required outcome                                                           | Focused proof                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public configuration reaches Codex                                         | Load the example through normal plugin validation and runtime resolution; inspect the native thread request. Reuse existing `config.test.ts` profile assertions.                                                                                    |
| Defaults and modes remain stable                                           | Absent/disabled proxy unchanged; full and limited preserve their respective method rules; no allowed entries do not become allow-all.                                                                                                               |
| Explicit policy cannot disappear silently                                  | Malformed map and invalid host pattern fail before execution; test the public validation path and any reachable fallback parser path.                                                                                                               |
| Lifecycle retains policy                                                   | Start, resume, and next turn after changing domains use the expected profile; incompatible explicit sandbox/backend fails visibly.                                                                                                                  |
| Versions fail clearly                                                      | Existing handshake tests cover malformed, missing, below-minimum, managed, and newer-version behavior.                                                                                                                                              |
| Allowed traffic succeeds and blocked traffic never reaches its destination | Run an isolated real OpenClaw-to-Codex turn against controlled HTTPS endpoints; allow one host, omit another, and explicitly deny a third. With `never`, assert success for the first and no origin receipt for the other two.                      |
| Native enforcement survives simple bypass attempts                         | In the same sandbox, unset proxy variables and set `NO_PROXY`; direct access to the blocked origin must fail. Attempt an incompatible sandbox override and confirm rejection. Retain native restrictions; do not create a second enforcement layer. |
| Both modes work end to end                                                 | Against the allowed HTTPS host, GET succeeds in both modes; POST succeeds in full and is denied in limited. Keep native certificate validation enabled.                                                                                             |

Use disposable workspace/state, synthetic hostnames and credentials, free ports, and the managed runtime; do not modify an operator's live gateway. Control both successful and denied endpoints so DNS or service failure cannot masquerade as policy denial. Record OpenClaw SHA, actual Codex handshake version, transport, commands, sanitized outcomes, and origin receipt counts. Exercise a remote app-server only when that transport is claimed supported. Unsupported container networking remains a documented refusal.

For the specification change itself, run formatting, docs-index/link/config-example checks, and `git diff --check`. Do not run runtime tests merely to validate this document.

## Remaining Verification

No API decision remains. The demonstrated parser fallback is fixed; existing external sandbox admission already refuses unsupported networking. The broader acceptance work still needs a model-driven turn against controlled HTTPS origins, receipt counts for denied requests, and full-versus-limited POST checks. The observed failed direct TCP bypass covers one destination and route. These are explicit proof gaps, not successful results or reasons to expand the implementation.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-24: Implemented the enabled-proxy parsing guard, documented effective native policy inheritance, and recorded local test and command proof with remaining integration gaps.
- 2026-09-24: Scoped to the existing Codex network allowlist configuration at OpenClaw `0580bd904564`; broader managed-policy parity excluded by request. Private authoring provenance is retained outside the public repository.
