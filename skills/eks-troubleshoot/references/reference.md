# EKS Troubleshooting Reference

Advanced patterns and less common scenarios.

## Node-Level Troubleshooting

### Node Not Ready

```bash
# Check node conditions
kubectl describe node <node-name> | grep -A20 "Conditions:"

# Check kubelet logs (requires SSH or SSM)
aws ssm start-session --target <instance-id>
journalctl -u kubelet -f

# Check node resource pressure
kubectl describe node <node-name> | grep -E "(MemoryPressure|DiskPressure|PIDPressure)"

# Cordon node to prevent new pods
kubectl cordon <node-name>

# Drain node for maintenance
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

### Node Resource Exhaustion

```bash
# View allocatable vs capacity
kubectl get node <node-name> -o jsonpath='{.status.allocatable}' | jq

# View all pods on a node
kubectl get pods --all-namespaces --field-selector spec.nodeName=<node-name>

# Check for pods without limits (resource hogs)
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.spec.containers[*].resources.limits}{"\n"}{end}' | grep -v "memory\|cpu"
```

## Storage Troubleshooting

### PVC Issues

```bash
# Check PVC status
kubectl get pvc -n <namespace>

# Describe PVC for events
kubectl describe pvc <pvc-name> -n <namespace>

# Check storage class
kubectl get storageclass

# Check PV status
kubectl get pv

# Check EBS volumes in AWS
aws ec2 describe-volumes --filters "Name=tag:kubernetes.io/cluster/<cluster>,Values=owned"
```

### Volume Mount Issues

```bash
# Check volume mounts in pod spec
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.volumes}' | jq

# Check mount paths
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].volumeMounts}' | jq

# Exec into pod and check mounts
kubectl exec -it <pod-name> -n <namespace> -- df -h
kubectl exec -it <pod-name> -n <namespace> -- ls -la /path/to/mount
```

## Security/RBAC Troubleshooting

### Permission Denied

```bash
# Check service account
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.serviceAccountName}'

# Check RBAC for service account
kubectl auth can-i --list --as=system:serviceaccount:<namespace>:<sa-name>

# Check specific permission
kubectl auth can-i get pods --as=system:serviceaccount:<namespace>:<sa-name> -n <namespace>

# View roles/rolebindings
kubectl get roles,rolebindings -n <namespace>
kubectl get clusterroles,clusterrolebindings | grep <sa-name>
```

### Security Context Issues

```bash
# Check security context
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.securityContext}' | jq
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].securityContext}' | jq

# Check namespace pod-security labels (replaces PSP on modern clusters)
kubectl get ns <namespace> -o jsonpath='{.metadata.labels}' | jq 'with_entries(select(.key | startswith("pod-security")))'
kubectl get constrainttemplate  # if Gatekeeper/OPA
```

## Init Container Issues

```bash
# Check init container status
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.status.initContainerStatuses}' | jq

# Logs from init containers
kubectl logs <pod-name> -n <namespace> -c <init-container-name>

# Describe shows init container order
kubectl describe pod <pod-name> -n <namespace> | grep -A30 "Init Containers:"
```

## Sidecar/Multi-Container Issues

```bash
# List all containers in pod
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].name}'

# Logs from specific container
kubectl logs <pod-name> -n <namespace> -c <container-name>

# Exec into specific container
kubectl exec -it <pod-name> -n <namespace> -c <container-name> -- sh
```

## HPA/Scaling Issues

```bash
# Check HPA status
kubectl get hpa -n <namespace>

# Describe HPA for metrics and events
kubectl describe hpa <hpa-name> -n <namespace>

# Check metrics-server
kubectl get pods -n kube-system | grep metrics-server
kubectl top pods -n <namespace>

# Check custom metrics (API version depends on adapter; v1beta2 is common on newer clusters)
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta2 | jq
```

## Job/CronJob Issues

```bash
# Check job status
kubectl get jobs -n <namespace>
kubectl describe job <job-name> -n <namespace>

# Check cronjob schedule
kubectl get cronjobs -n <namespace>
kubectl describe cronjob <name> -n <namespace>

# List pods from job
kubectl get pods -n <namespace> -l job-name=<job-name>

# Check job history
kubectl get jobs -n <namespace> --sort-by=.metadata.creationTimestamp
```

## StatefulSet Issues

```bash
# Check StatefulSet status
kubectl get statefulset -n <namespace>
kubectl describe statefulset <name> -n <namespace>

# Check pod ordinal and PVC binding
kubectl get pods -n <namespace> -l app=<statefulset-label> -o wide

# Check headless service
kubectl get svc -n <namespace> | grep None
```

## Webhook Issues

```bash
# Check validating webhooks
kubectl get validatingwebhookconfigurations

# Check mutating webhooks
kubectl get mutatingwebhookconfigurations

# Check webhook endpoints
kubectl describe validatingwebhookconfiguration <name>

# Webhook troubleshooting - check webhook pod logs
kubectl logs -n <webhook-namespace> -l app=<webhook-app>
```

## CNI/Networking Deep Dive

```bash
# Check CNI plugin (usually aws-node for EKS)
kubectl get pods -n kube-system -l k8s-app=aws-node
kubectl logs -n kube-system -l k8s-app=aws-node

# Check pod CIDR allocation
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.podCIDR}{"\n"}{end}'

# Check ENI allocation (EKS specific)
kubectl get pods -n kube-system -l k8s-app=aws-node -o jsonpath='{range .items[*]}{.metadata.name}: {.status.hostIP}{"\n"}{end}'

# Check security groups on nodes
aws ec2 describe-instances --filters "Name=tag:kubernetes.io/cluster/<cluster>,Values=owned" --query 'Reservations[*].Instances[*].[InstanceId,SecurityGroups[*].GroupId]'
```

## Useful One-Liners

```bash
# Find all failed pods
kubectl get pods -A --field-selector=status.phase=Failed

# Find pods not running or completed
kubectl get pods -A | grep -v "Running\|Completed"

# Get all container images in cluster
kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | sort -u

# Find pods with high restart counts
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' | awk -F: '$2 > 5'

# Watch pod status changes
kubectl get pods -n <namespace> -w

# Get pod resource usage vs limits
kubectl top pods -n <namespace> --containers

# Find pods without resource limits
kubectl get pods -A -o json | jq -r '.items[] | select(.spec.containers[].resources.limits == null) | "\(.metadata.namespace)/\(.metadata.name)"'

# Get all events cluster-wide sorted by time
kubectl get events -A --sort-by='.lastTimestamp' | tail -50
```

## Emergency Procedures

### Mass Pod Failures

```bash
# Quick triage - what's failing?
kubectl get pods -A | grep -v "Running\|Completed" | head -20

# Check recent events cluster-wide
kubectl get events -A --sort-by='.lastTimestamp' | grep -i "warning\|error" | tail -30

# Check node status
kubectl get nodes -o wide
kubectl top nodes

# Check system pods
kubectl get pods -n kube-system
```

### Cluster Unresponsive

```bash
# Check API server
kubectl cluster-info

# Check AWS EKS control plane
aws eks describe-cluster --name <cluster-name> --query 'cluster.[status,health]'

# Check if it's just kubectl context
kubectl config current-context
aws eks update-kubeconfig --name <cluster-name> --region <region>
```

### Runaway Resource Usage

```bash
# Find top CPU consumers
kubectl top pods -A --sort-by=cpu | head -10

# Find top memory consumers
kubectl top pods -A --sort-by=memory | head -10

# Check for pod spam (many pods from same deployment)
kubectl get pods -A -o wide | awk '{print $1"/"$2}' | cut -d'-' -f1-3 | sort | uniq -c | sort -rn | head -10
```
