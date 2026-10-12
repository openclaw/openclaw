---
title: Native local personal identity proposal
summary: "Proposal for verified personal admission in a local native app without changing shared or device identity."
read_when:
  - Reviewing native personal identity and local Primary adoption
  - Designing device-bound continuation of verified Gateway admission
---

# Native local personal identity proposal

**Status: contributor proposal for Core review, not an implemented or accepted authentication contract.**
Part of [native personal identity umbrella #162164](https://github.com/openclaw/openclaw/issues/162164).
This document changes no runtime behavior and defines no usable endpoint, credential format, or configuration option.

## User problem and intended outcome

A local macOS Gateway and its native app can use shared credentials while the same person has a verified personal profile through another connection. That browser sign-in does not identify the app's shared connection. Renaming Shared owner cannot solve personal message attribution.

The desired flow is explicit personal sign-in followed by ordinary local operation: normal Primary Chat, Quick Chat, and the embedded Dashboard use the Gateway-verified person, while the app still connects directly to literal loopback and retains local managed/attached lifecycle behavior. Personal sign-in must not require remote mode or a separate saved-profile window as the default.

Shared-only operation remains a deliberate supported choice, including when Tailscale is installed. Installing Tailscale, owning its daemon, connecting from localhost, or saving a display name must not authenticate a person. Shared credentials and paired node/device credentials retain their existing meaning.

## Existing ownership and related work

Core owns authenticated admission, canonical profiles, permissions, pairing, persistent authority, and revocation. Native clients consume those decisions; they do not maintain another profile authority.

- [#163765](https://github.com/openclaw/openclaw/pull/163765) supplies the iOS personal Tailscale choice and same-authority Dashboard work. At contributor head `706c6fccf7596f67f0504664bb3a74d7833dad65`, personal eligibility requires a TLS `.ts.net` endpoint, suppresses shared/stored-device fallback, and requires Tailscale admission. Reuse its intent and guards; do not treat that candidate as a shipped loopback continuation.
- [#158051](https://github.com/openclaw/openclaw/pull/158051) composes the native Cloudflare session and embedded Dashboard path. Its origin-bound session is not permission to copy browser cookies to a different local origin.
- [#164593](https://github.com/openclaw/openclaw/pull/164593), [#164607](https://github.com/openclaw/openclaw/pull/164607), and [#164825](https://github.com/openclaw/openclaw/pull/164825) concern shared-name presentation, existing-profile channel links, and optional naming. None turns a name or channel association into personal authentication.
- [#159167](https://github.com/openclaw/openclaw/pull/159167) fixes origin-scoped device-token lookup for local probes. That diagnostic credential lookup is a separate responsibility, not this proposed human sign-in mechanism.

The source audit for this proposal is pinned to main `6070074dabf6b45f74d4039590cd307640317862`:

- `src/gateway/auth.ts` consumes verified Tailscale Serve ingress for Tailscale admission; direct loopback must not fabricate that ingress.
- `src/gateway/local-user-ingress.ts` prepares authenticated attribution, not a personal credential issuer.
- `src/gateway/server-methods/gateway-personal-caller.ts` separates eligible personal callers from delegated/synthetic callers.
- `src/gateway/mcp-grant-store.ts` owns agent-tool delegation, not native human sign-in.
- `docs/gateway/config-gateway.md` documents Gateway TLS. `GatewayEndpointStore.swift` consumes TLS configuration. This identifies transport owners, not proof that native and WebKit loopback pinning already implement this flow.

## Proposed journey

1. The user selects personal sign-in for this local Gateway. The app starts an authorization transaction bound to the intended Gateway and its existing device key. Starting the transaction grants no personal authority.
2. The app uses the trusted Tailscale Serve origin for initial personal admission. Core derives the person from verified ingress, resolves the existing canonical profile, and obtains explicit authorization for this app/device. Caller-supplied profile identifiers and local account metadata are not identity evidence.
3. A short-lived, single-use authorization result is redeemed with proof from the requesting app. Bind the transaction and exact callback destination. Do not put reusable credentials in redirect URLs. If Core chooses OAuth, use authorization code with PKCE S256 and its full applicable protections; this proposal does not require adding OAuth infrastructure.
4. Core issues a revocable continuation of that verified personal admission, bound to this Gateway, person, provider provenance, device key, and admitted permissions. Reuse an existing persistence owner if suitable; do not add a parallel identity store. Opaque server-held references are a candidate, not a settled format.
5. Before presenting personal proof, the app authenticates the actual local Gateway. It then connects over authenticated TLS to literal loopback, for example `wss://127.0.0.1:<port>`. Core checks the continuation, device proof, pairing, and current profile/permission admission. Record this as continued personal admission, not a fresh Tailscale-proxied request.
6. Chat, Quick Chat, and Dashboard consume that admitted principal. The native Dashboard bridge binds each request to the current principal, exact origin, generation, and negotiated permissions. Reusable native credentials must not be exposed to page JavaScript.
7. Sign-out, account replacement, personal/device revocation, or disabled profiles retire affected authority and pending work. Failed selected personal admission requires explicit recovery, never silent fallback to Shared owner. Users can deliberately choose shared mode separately.

Serve carries establishment and any provider-required renewal; it need not carry every ordinary message. Whether a continuation survives provider unavailability or removal, and for how long, requires an explicit Core validity policy. App sign-out and Tailscale sign-out are different events.

## Trust and security requirements

Loopback is a network location, not an authenticated server identity. An unrelated process can occupy the expected port. Device challenge signing alone can be relayed and does not secure a plaintext connection against an active intermediary.

The proposal therefore prefers existing Gateway TLS with an expected Gateway key/certificate established through the trusted enrollment transaction. Do not trust any self-signed certificate returned from the local port. Define IP certificate validation, pin delivery, key rotation, and recovery before implementation. Native and WebKit behavior need separate verification.

Authenticate the receiving Gateway before transmitting personal proof. Restrict authority to the intended Gateway and device, check current permissions at admission and before protected effects, and retire obsolete asynchronous work when its principal or authority changes. Pairing remains independently enforced; a continuation grants no new permissions.

Human sign-in credentials must not enter prompts, tools, node channels, or arbitrary local agents. Agent actions needing human authority use separately bounded Core delegation. Existing MCP run grants must not be reinterpreted as native human login.

Provider revocation requires authoritative revalidation or a documented bounded validity window. No instantaneous provider-revocation guarantee is claimed without that mechanism. Persistence, expiry, renewal, retention, logout, and restart behavior are unresolved contract decisions, not client defaults to invent.

## Decisions requested from Core

Can Core own a revocable continuation of verified personal admission, consumed by ordinary local operator sessions without changing device-token semantics?

Before implementation, settle:

- The existing issuer/verifier and persistence owner, public admission surface, credential/device binding, expiry, renewal, and revocation behavior.
- How the app authenticates this Gateway's loopback key, validates the endpoint, and handles rotation or Gateway replacement.
- Provider removal/unavailability and revocation policy, including reconnect and Gateway restart.
- The native Dashboard authorization adapter and its origin/generation retirement rules.

No new RPC name, token format, lifetime, schema, or recovery promise is specified here. Maintainer acceptance of the umbrella's user problem is not acceptance of these new mechanisms.

## Proposed implementation PR sequence

1. **Core/shared vertical slice, after contract acceptance:** issue and verify the continuation through existing admission/profile/pairing owners; demonstrate local protected effects and failure/revocation boundaries with a minimal synthetic client. Add only the missing generic contract, not a provider-specific parallel identity service.
2. **macOS local Primary integration, dependent on that slice:** reuse native authentication intent and Dashboard ownership, preserve managed and attached lifecycle behavior, and apply the admitted identity to normal Chat, Quick Chat, and Dashboard. Demonstrate the full local journey rather than only a saved-profile window.

Keep both code PRs independently reviewable and reference their actual dependency when opened. This design PR does not close the umbrella or claim either implementation is complete. Existing iOS/Cloudflare contributions retain their ownership and attribution.

## Acceptance evidence required

These are future acceptance conditions, not passing test results:

- Verified admission and explicit app/device association produce the same canonical person in final Chat, Quick Chat, and protected Dashboard effects over observed literal loopback transport.
- Wrong device/Gateway, copied continuation, replayed authorization/proof, and a fake local listener are rejected. No credentials reach an unauthenticated listener.
- Two people remain distinct. Account switching during awaited work, disabled profiles, permission changes, revocation, and obsolete Dashboard documents cannot reuse retired authority.
- Selected personal mode never silently downgrades. Explicit shared-only mode remains shared, with separate node/device pairing and no agent privilege leakage.
- Cold app launch, reconnect, Gateway restart, and both managed/attached local lifecycle paths obey the accepted persistence/recovery policy. Compatibility and installed-state migration receive their own evidence.
- Native/WebKit TLS validation, authenticated key rotation, provider unavailability, and the accepted provider-revocation window are demonstrated.

Use meaningful boundary regressions for inexpensive proof and a bounded end-to-end journey for native final effects. Synthetic tests, native execution, released-install upgrade, and live provider proof must be reported separately. No tests or runtime validation are added by this document.

## Alternatives and guidance

Keeping all traffic on Serve is an existing useful route but does not satisfy direct literal-loopback operation. Inferring a human from daemon ownership, merging Shared owner into a person, or copying proxy headers/cookies bypasses existing authority boundaries. A bespoke local broker or cryptographic transport is not the preferred first step while existing Gateway/session/TLS owners can serve the responsibility. Authenticated local IPC would change the TCP-loopback requirement.

Applicable guidance, not proof of an OpenClaw implementation:

- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html): native external-user-agent authorization and PKCE; its HTTP loopback exception concerns callbacks, not a general plaintext authenticated API.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): least privilege, sender/resource restriction, and renewal protection.
- [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html): proof of possession does not replace TLS or server authentication.
- [Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers): identity provenance belongs to the verified proxied request; tagged devices do not supply human identity headers.
- [Apple ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession): platform-owned native web-authentication and callback delivery, not browser credential scraping.
- [MCP local transport security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): authentication and Origin validation remain relevant on loopback. This is analogous agent-tool guidance, not an OpenClaw protocol requirement.
