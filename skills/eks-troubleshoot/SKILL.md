---
name: eks-troubleshoot
description: Troubleshoot containers and pods in EKS clusters using kubectl and AWS CLI; `stern` and `k9s` are optional workstation helpers. Use for crashloops, OOMKilled, image pull errors, scheduling, networking, DNS, and service connectivity issues.
---

# EKS Container Troubleshooting

Focused workflow for diagnosing container and pod failures in Amazon EKS.

## Requirements

- kubectl (configured with cluster access, including pods/exec permissions)
- aws-cli v2 (configured)
- jq

Optional workstation tools:

- stern (multi-pod log tailing)
- k9s (terminal UI)

## Quick Start

1. Identify target: namespace, pod, or deployment
2. Gather state: status, events, recent logs
3. Pick the right troubleshooting path
4. Recommend or apply a fix

## Workflow

### Step 1: Establish Context

```bash
# List all namespaces
kubectl get namespaces

# Get pods across all namespaces (or specific namespace)
kubectl get pods -A
kubectl get pods -n <namespace>

# Quick health check
kubectl get pods -A | grep -v Running | grep -v Completed
```

If the user has not specified a namespace:

```bash
# Find pods by partial name
kubectl get pods -A | grep -i <partial-name>
```

### Step 2: Initial Diagnosis

```bash
# Detailed pod status
kubectl describe pod <pod-name> -n <namespace>

# Check events (sorted by time)
kubectl get events -n <namespace> --sort-by='.lastTimestamp'

# Pod conditions and status
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.status.conditions[*]}' | jq
```

### Step 3: Choose a Path

Use `references/paths.md` for detailed command sets:

- CrashLoopBackOff
- ImagePullBackOff / ErrImagePull
- OOMKilled
- Pending
- CreateContainerConfigError
- Network/DNS/Ingress
- Prometheus metrics checks
- AWS-specific diagnostics
- Common fix patterns
- Debugging checklist

### Step 4: Advanced Topics

For less common scenarios (node-level, storage, RBAC, init containers, HPA, webhooks), see `references/reference.md`.

## Output Format

When reporting findings, provide:

1. Summary: one-line description
2. Evidence: relevant command output (trimmed)
3. Root Cause: why it is happening
4. Recommendation: specific next steps
5. Commands: ready-to-run fix commands
