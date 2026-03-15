# OpenClaw Helm Chart

A lightweight Helm chart equivalent of `scripts/k8s/manifests`.

## Install

```bash
helm upgrade --install openclaw ./charts/openclaw \
  --namespace openclaw --create-namespace \
  --set secret.gatewayToken="<gateway-token>" \
  --set secret.providerKeys.openai="<OPENAI_API_KEY>"
```

## Use existing secret

```bash
helm upgrade --install openclaw ./charts/openclaw \
  --namespace openclaw --create-namespace \
  --set secret.create=false \
  --set secret.existingSecret=openclaw-secrets
```

## Notes

- Defaults are aligned with current kustomize manifests.
- This chart keeps the gateway bind on loopback by default (port-forward workflow).
- For ingress/load balancer exposure, update `config.openclawJson` and secure gateway access.
