# Mux Integration Plan (Deprecated)

This document described the legacy tenant API key control-plane model (admin bootstrap + tenant-scoped inbound-target wiring).

That model has been removed in favor of instance-centric runtime auth:

- OpenClaw instances register themselves via `POST /v1/instances/register` using a shared `MUX_REGISTER_KEY`.
- mux mints:
  - a per-instance runtime JWT for mux APIs (`/v1/pairings/*`, `/v1/mux/outbound/send`)
  - a short-lived inbound JWT per delivery for mux -> OpenClaw calls
- OpenClaw validates mux-issued JWTs via `GET /.well-known/jwks.json`.

Use these docs instead:

- `mux-server/JWT_INSTANCE_RUNTIME_DESIGN.md`
- `mux-server/README.md`
- `phala-deploy/UPDATE_RUNBOOK.md`
- Avoid introducing per-channel special logic in control plane.
