# ADR: ConsentGate deployment mode (Mode A first, optional Mode B)

## Status

Accepted (Draft). Date: 2026-02-19.

## Context

ConsentGate enforces explicit, auditable consent before high-risk tool execution. We need a deployment model that:

- Integrates quickly with the existing gateway and node paths.
- Allows incremental rollout (observe-only then enforce).
- Optionally supports higher-assurance deployments with stronger isolation.

## Decision

- **Mode A (default, first release):** ConsentGate runs in-process inside the gateway. Token state and WAL use a shared storage abstraction (v1: in-memory or local durable store). All invoke choke points (HTTP tool invoke, then node.invoke and node-host) call into the same ConsentGate API.
- **Mode B (enterprise, optional):** A separate ConsentGate service runs out-of-process. Gateway and node-host invoke paths call ConsentGate over a local socket or mTLS. Strict fail-closed behavior: if the service is unavailable, gated operations are denied.
- **Implementation order:** Build Mode A first. Keep storage and decision APIs transport-agnostic so that Mode B is a drop-in deployment profile (same API, different transport).

## Consequences

- Mode A minimizes latency and operational complexity; single choke point in the gateway process.
- Mode A does not add a process boundary: if the gateway process is fully compromised, an attacker could bypass consent checks in-process. Mode B addresses that for high-assurance tenants.
- Storage abstraction (token store + WAL) allows swapping in-process store for a remote or HA backend later without changing call sites.

## References

- [Enterprise ConsentGate implementation plan](/grants/enterprise-consentgate-implementation-plan) §4 (Target architecture).
