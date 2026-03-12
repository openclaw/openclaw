# Troubleshooting Paths

Detailed commands and checks by symptom. Use after initial diagnosis.

## CrashLoopBackOff

The container starts but crashes repeatedly.

```bash
# Check current logs
kubectl logs <pod-name> -n <namespace>

# Check previous container logs (after crash)
kubectl logs <pod-name> -n <namespace> --previous

# Multi-container pod - specify container
kubectl logs <pod-name> -n <namespace> -c <container-name>

# Stream logs with stern (multi-pod)
stern <pod-name-pattern> -n <namespace>

# Check exit code
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.exitCode}'
```

Common causes:

- Exit code 1: application error - check logs for stack trace
- Exit code 137: SIGKILL - not always OOMKilled; verify with Prometheus and disk usage
- Exit code 143: SIGTERM - graceful shutdown issue
- Missing config/secrets - check mounts and env vars

Exit code 137 differential diagnosis:

- OOMKilled: memory near container limit in Prometheus
- Liveness probe failure: check events for probe failures
- Disk full: check `df -h` - can't write RDB/logs
- Node eviction: check node conditions

## ImagePullBackOff / ErrImagePull

Cannot pull the container image.

```bash
# Check the image being pulled
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].image}'

# Verify ECR image exists
aws ecr describe-images --repository-name <repo-name> --image-ids imageTag=<tag>

# List available tags
aws ecr list-images --repository-name <repo-name> --query 'imageIds[*].imageTag' --output table

# Check ECR login/auth
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com

# Verify imagePullSecrets on pod
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.imagePullSecrets}'

# Check service account
kubectl get sa <service-account> -n <namespace> -o yaml
```

## OOMKilled

Container exceeded memory limits.

```bash
# Check current limits
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].resources}'

# Check actual memory usage (if pod is running)
kubectl top pod <pod-name> -n <namespace>

# Check node memory pressure
kubectl describe node <node-name> | grep -A5 "Conditions"

# View resource quotas in namespace
kubectl get resourcequota -n <namespace>
```

Fix: increase memory limits in deployment:

```yaml
resources:
  limits:
    memory: "512Mi" # Increase as needed
  requests:
    memory: "256Mi"
```

## Pending

Pod cannot be scheduled.

```bash
# Check why pod is pending
kubectl describe pod <pod-name> -n <namespace> | grep -A10 "Events"

# Check node resources
kubectl describe nodes | grep -A5 "Allocated resources"

# Check for taints
kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints

# Check PVC status (if using volumes)
kubectl get pvc -n <namespace>

# Check node capacity
kubectl top nodes
```

Common causes:

- Insufficient resources - scale cluster or reduce requests
- Node selector/affinity not matching - check node labels
- PVC not bound - check storage class and PV availability
- Taints without tolerations - add tolerations to pod spec

## CreateContainerConfigError

Configuration issue preventing container creation.

```bash
# Check for missing ConfigMaps
kubectl get configmap -n <namespace>
kubectl describe configmap <name> -n <namespace>

# Check for missing Secrets
kubectl get secrets -n <namespace>
kubectl describe secret <name> -n <namespace>

# Verify env vars reference existing resources
kubectl get pod <pod-name> -n <namespace> -o yaml | grep -A20 "env:"
```

---

# Network Troubleshooting

## Service Connectivity

```bash
# Check service exists and has endpoints
kubectl get svc -n <namespace>
kubectl get endpoints <service-name> -n <namespace>

# Test DNS resolution from within cluster
kubectl run debug-dns --image=busybox:1.28 --rm -it --restart=Never -- nslookup <service-name>.<namespace>.svc.cluster.local

# Test connectivity from debug pod
kubectl run debug-net --image=nicolaka/netshoot --rm -it --restart=Never -- curl -v <service-name>:<port>

# Check network policies
kubectl get networkpolicies -n <namespace>
```

## DNS Issues

```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS logs
kubectl logs -n kube-system -l k8s-app=kube-dns

# Test DNS from pod
kubectl exec -it <pod-name> -n <namespace> -- cat /etc/resolv.conf
kubectl exec -it <pod-name> -n <namespace> -- nslookup kubernetes.default
```

## Ingress/Load Balancer

```bash
# Check ingress status
kubectl get ingress -n <namespace>
kubectl describe ingress <name> -n <namespace>

# Check ALB/NLB in AWS
aws elbv2 describe-load-balancers --query 'LoadBalancers[*].[LoadBalancerName,State.Code,DNSName]' --output table

# Check target group health
aws elbv2 describe-target-health --target-group-arn <arn>
```

---

# Advanced Debugging

## Ephemeral Debug Container

```bash
# Attach debug container to running pod
kubectl debug -it <pod-name> -n <namespace> --image=busybox --target=<container-name>

# Debug with full networking tools
kubectl debug -it <pod-name> -n <namespace> --image=nicolaka/netshoot --target=<container-name>

# Copy pod for debugging (creates a copy you can modify)
kubectl debug <pod-name> -n <namespace> --copy-to=debug-pod --container=<container> -- sh
```

## Interactive k9s Session

```bash
# Launch k9s for the namespace
k9s -n <namespace>

# k9s shortcuts:
# :pods - view pods
# :deploy - view deployments
# :svc - view services
# :events - view events
# l - view logs
# d - describe
# s - shell into container
# ctrl-d - delete
```

## Stern Log Aggregation

```bash
# Tail logs from all pods matching pattern
stern <pod-pattern> -n <namespace>

# Include timestamps
stern <pod-pattern> -n <namespace> -t

# Filter by container
stern <pod-pattern> -n <namespace> -c <container-name>

# Since time
stern <pod-pattern> -n <namespace> --since 15m

# Exclude patterns
stern <pod-pattern> -n <namespace> --exclude "health"
```

---

# Prometheus Metrics Debugging

Important: Exit code 137 does not always mean OOMKilled. Verify with Prometheus and disk usage.

## Access Prometheus

```bash
# Prometheus is accessible at:
# - Internal: prometheus.morpho.internal
# - Via kubectl port-forward: kubectl port-forward -n monitoring svc/prometheus-stack-kube-prom-prometheus 9090:9090
```

## Container Memory Usage

```bash
# Get current memory usage for pods (in GB)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=container_memory_working_set_bytes{namespace="<namespace>",pod=~"<pod-pattern>.*",container="<container>"}/1024/1024/1024'

# Memory usage vs limits (percentage)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=container_memory_working_set_bytes{namespace="<namespace>",pod=~"<pod-pattern>.*"}/container_spec_memory_limit_bytes{namespace="<namespace>",pod=~"<pod-pattern>.*"}*100'

# Memory usage over time (last hour, 5m resolution; GNU date syntax)
curl -s 'http://prometheus.morpho.internal/api/v1/query_range?query=container_memory_working_set_bytes{namespace="<namespace>",pod=~"<pod-pattern>.*",container="<container>"}/1024/1024/1024&start='$(date -d '1 hour ago' +%s)'&end='$(date +%s)'&step=300'
```

## Container CPU Usage

```bash
# CPU usage (cores)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=rate(container_cpu_usage_seconds_total{namespace="<namespace>",pod=~"<pod-pattern>.*",container="<container>"}[5m])'

# CPU throttling (indicates CPU limits being hit)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=rate(container_cpu_cfs_throttled_seconds_total{namespace="<namespace>",pod=~"<pod-pattern>.*"}[5m])'
```

## Disk/Storage Usage

```bash
# Check disk usage on PersistentVolumes
kubectl exec <pod-name> -n <namespace> -c <container> -- df -h /data

# PVC usage via Prometheus (if kubelet metrics enabled)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=kubelet_volume_stats_used_bytes{namespace="<namespace>",persistentvolumeclaim=~"<pvc-pattern>.*"}/kubelet_volume_stats_capacity_bytes{namespace="<namespace>",persistentvolumeclaim=~"<pvc-pattern>.*"}*100'
```

## Exit Code 137 - Differential Diagnosis

Exit code 137 = SIGKILL (128 + 9). Common causes:

| Cause                  | How to Verify                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| OOMKilled              | Check `kubectl describe pod` for `OOMKilled` reason AND verify memory near limit in Prometheus |
| Liveness probe failure | Check events: `kubectl get events -n <namespace> --field-selector involvedObject.name=<pod>`   |
| Disk full              | Check `df -h /data` inside container - look for RDB/write errors in logs                       |
| Node eviction          | Check node conditions and events                                                               |

## Quick Nushell Prometheus Query

```nushell
# Query Prometheus and format as table (uses nushell)
curl -s 'http://prometheus.morpho.internal/api/v1/query?query=container_memory_working_set_bytes{namespace="morpho-dev",pod=~"redis.*",container="redis"}' | from json | get data.result | each { |r| {pod: $r.metric.pod, memory_bytes: $r.value.1} }
```

## Common PromQL Queries for Troubleshooting

```promql
# Pods restarting frequently (last hour)
increase(kube_pod_container_status_restarts_total{namespace="<namespace>"}[1h]) > 3

# Containers waiting (not running)
kube_pod_container_status_waiting{namespace="<namespace>"} == 1

# OOMKilled containers
kube_pod_container_status_last_terminated_reason{namespace="<namespace>",reason="OOMKilled"} == 1

# High memory usage (>80% of limit)
container_memory_working_set_bytes / container_spec_memory_limit_bytes > 0.8

# PVC near full (>80%)
kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.8
```

---

# AWS-Specific Diagnostics

## EKS Cluster Health

```bash
# Check cluster status
aws eks describe-cluster --name <cluster-name> --query 'cluster.status'

# Check node groups
aws eks list-nodegroups --cluster-name <cluster-name>
aws eks describe-nodegroup --cluster-name <cluster-name> --nodegroup-name <nodegroup>

# Check for cluster issues
aws eks describe-cluster --name <cluster-name> --query 'cluster.health'
```

## CloudWatch Logs

```bash
# List log groups for EKS
aws logs describe-log-groups --log-group-name-prefix /aws/eks/<cluster-name>

# Tail container logs (if sent to CloudWatch)
aws logs tail /aws/eks/<cluster-name>/containers/<namespace>/<pod-name> --follow

# Search logs
aws logs filter-log-events --log-group-name <group> --filter-pattern "ERROR" --start-time <epoch-ms>
```

## ECR Repository

```bash
# List repositories
aws ecr describe-repositories --query 'repositories[*].repositoryName' --output table

# Check image scan results
aws ecr describe-image-scan-findings --repository-name <repo> --image-id imageTag=<tag>

# Get image details
aws ecr batch-get-image --repository-name <repo> --image-ids imageTag=<tag> --query 'images[*].imageManifest'
```

## IAM/IRSA Issues

```bash
# Check service account annotations
kubectl get sa <sa-name> -n <namespace> -o jsonpath='{.metadata.annotations}'

# Verify IAM role trust policy
aws iam get-role --role-name <role-name> --query 'Role.AssumeRolePolicyDocument'

# Check OIDC provider
aws eks describe-cluster --name <cluster-name> --query 'cluster.identity.oidc.issuer'
```

---

# Common Fix Patterns

## Restart Deployment

```bash
# Rolling restart
kubectl rollout restart deployment/<name> -n <namespace>

# Watch rollout status
kubectl rollout status deployment/<name> -n <namespace>

# Rollback if needed
kubectl rollout undo deployment/<name> -n <namespace>
```

## Scale for Debugging

```bash
# Scale down to isolate issue
kubectl scale deployment/<name> -n <namespace> --replicas=1

# Scale back up
kubectl scale deployment/<name> -n <namespace> --replicas=3
```

## Force Delete Stuck Pod

```bash
# Delete with grace period 0
kubectl delete pod <pod-name> -n <namespace> --grace-period=0 --force
```

## Update Image

```bash
# Set new image
kubectl set image deployment/<name> <container>=<new-image> -n <namespace>

# Verify
kubectl get deployment/<name> -n <namespace> -o jsonpath='{.spec.template.spec.containers[*].image}'
```

---

# Checklist for Systematic Debugging

When troubleshooting, work through this checklist:

1. [ ] Pod Status: `kubectl get pod` - what state is it in?
2. [ ] Events: `kubectl describe pod` - any warnings or errors?
3. [ ] Logs: `kubectl logs` / `stern` - what does the application say?
4. [ ] Resources: `kubectl top` - is it hitting limits?
5. [ ] Prometheus: query actual memory/CPU usage - do not assume from exit codes
6. [ ] Disk: `df -h /data` - is the PV full?
7. [ ] Config: ConfigMaps, Secrets mounted correctly?
8. [ ] Network: can it reach dependencies? DNS working?
9. [ ] AWS: ECR image exists? IAM roles correct? Cluster healthy?
