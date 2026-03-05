# PR Description: k8s Agent Cluster Scripting and Security Hardening

## Summary

- **Problem:** No turnkey way to run the OpenClaw gateway with a collaborative multi-agent setup (orchestrator + researcher/builder/reviewer) in local Kubernetes (k3s/k3d/Docker Desktop). Operators needed manual manifests and config assembly.
- **Why it matters:** Enables local dev/testing of agent-to-agent collaboration and Control UI workflows without production infrastructure.
- **What changed:** Added `scripts/k8s/openclaw-agent-cluster/` with `k3s-up.sh` and `k3s-down.sh` for one-command deploy/teardown, plus security-conscious defaults (token auth, secrets via Kubernetes Secrets, `dangerouslyAllowHostHeaderOriginFallback` only where needed for port-forward/Control UI).
- **What did NOT change:** Core gateway/auth logic; production deployment paths; existing Docker/install flows.

## Change Type (select all)

- [x] Feature
- [x] Security hardening
- [x] Docs

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [x] Auth / tokens
- [x] CI/CD / infra

## Linked Issue/PR

- Related: (add issue/PR if applicable)

## User-visible / Behavior Changes

- **New:** `./scripts/k8s/openclaw-agent-cluster/k3s-up.sh` deploys a multi-agent gateway to local k3s/k3d/Docker Desktop.
- **New:** `./scripts/k8s/openclaw-agent-cluster/k3s-down.sh` tears down the namespace.
- **Config:** k8s ConfigMap sets `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` so Control UI works when accessed via `kubectl port-forward` (Host-header origin fallback). This is documented as a deliberate, scoped security tradeoff for local dev.
- **Secrets:** Provider API keys and `OPENCLAW_GATEWAY_TOKEN` are stored in Kubernetes Secrets (`openclaw-secrets`), not in ConfigMap or env files.

## Security Impact (required)

- **New permissions/capabilities?** No. Scripts deploy a single gateway pod with existing capabilities.
- **Secrets/tokens handling changed?** Yes. k8s deployment uses `Secret` for `OPENCLAW_GATEWAY_TOKEN` and provider keys; values are base64-encoded and patched via `kubectl`. No secrets in ConfigMap.
- **New/changed network calls?** No. Gateway binds `lan` on 18789 as before; access is via `kubectl port-forward` or cluster-internal.
- **Command/tool execution surface changed?** No.
- **Data access scope changed?** No.

**Risk + mitigation:** `dangerouslyAllowHostHeaderOriginFallback` weakens origin checks for Control UI/WebSocket. Mitigation: (1) intended only for local k8s dev where operator controls the cluster; (2) documented in README and security docs; (3) `openclaw security audit` flags this setting. Token auth remains required.

## Repro + Verification

### Environment

- OS: macOS / Linux
- Runtime/container: Docker, kubectl, k3s or k3d or Docker Desktop Kubernetes
- Model/provider: OpenAI (or other provider with key in env)
- Relevant config: `OPENAI_API_KEY`, optional `OPENCLAW_GATEWAY_TOKEN`

### Steps

1. `export OPENAI_API_KEY="<key>"`
2. `./scripts/k8s/openclaw-agent-cluster/k3s-up.sh --model openai/gpt-5.2 --smoke`
3. `kubectl -n openclaw-agents port-forward svc/openclaw-gateway 18789:18789`
4. Open Control UI at `http://127.0.0.1:18789` (or gateway host) and verify WebSocket connects.
5. Run smoke: `kubectl -n openclaw-agents exec openclaw-gateway-0 -- node dist/index.js agent --local --agent orchestrator --message "Plan a k3s reliability hardening pass. Use researcher, builder, and reviewer via sessions_spawn, then summarize in 5 bullets."`
6. Teardown: `./scripts/k8s/openclaw-agent-cluster/k3s-down.sh`

### Expected

- Gateway rolls out; smoke turn completes; Control UI connects via port-forward.
- `openclaw security audit` reports `gateway.control_ui.host_header_origin_fallback` when `dangerouslyAllowHostHeaderOriginFallback` is set (expected for this deployment).

### Actual

- (Fill in after manual run)

## Evidence

- [x] README with deploy/connect/teardown instructions
- [x] TASK-multi-provider-gui.md for follow-up work (model switching, UI provider readiness)
- [x] k3s-up.sh supports k3d, k3s, and Docker Desktop image import

## Human Verification (required)

- Verified scenarios: (operator to fill)
- Edge cases checked: Docker Desktop worker-node detection, optional provider keys
- What you did **not** verify: Production k8s (EKS/GKE); multi-replica gateway

## Compatibility / Migration

- **Backward compatible?** Yes. New scripts only; no changes to existing install/gateway behavior.
- **Config/env changes?** No. k8s deployment uses its own ConfigMap/Secret.
- **Migration needed?** No.

## Failure Recovery (if this breaks)

- Disable: `./scripts/k8s/openclaw-agent-cluster/k3s-down.sh` removes namespace.
- Restore: Re-run `k3s-up.sh` if needed.
- Symptoms: Image import failures on Docker Desktop (no worker nodes); missing provider keys (smoke skipped).

## Risks and Mitigations

- **Risk:** `dangerouslyAllowHostHeaderOriginFallback` weakens origin checks.
  - **Mitigation:** Scoped to local k8s dev; documented; security audit flags it.
- **Risk:** Secrets in cluster; operator must secure cluster access.
  - **Mitigation:** Standard k8s Secret usage; operator controls cluster.
- **Risk:** `imagePullPolicy: Never` requires local image import.
  - **Mitigation:** Script auto-imports for k3d/k3s/Docker Desktop; README documents `--skip-import` for registry images.
