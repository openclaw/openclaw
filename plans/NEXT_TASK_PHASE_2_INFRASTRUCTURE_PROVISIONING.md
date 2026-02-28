# Next Task: Phase 2 - Infrastructure Provisioning

**Status:** Ready to Start  
**Estimated Duration:** 2-3 weeks  
**Owner:** DevOps / SRE  
**Prerequisite:** Phase 1 Architecture Planning ✅ COMPLETE  
**Completion Gate:** Staging cluster ready, all monitoring deployed, DNS configured

---

## Task Overview

Provision the production and staging Kubernetes infrastructure as specified in the Router Service Production Deployment Architecture. This phase involves setting up the cloud infrastructure, Kubernetes clusters, monitoring stack, and certificate management—all foundational requirements before CI/CD pipeline setup (Phase 3) and application deployment (Phase 4-7).

**Reference Documents:**
- Architecture spec: `plans/ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md`
- Execution strategy: `plans/ROUTER_DEPLOYMENT_EXECUTION_STRATEGY.md`

---

## Phase 2 Objectives

### Primary Goals
1. **Kubernetes Cluster:** Provision EKS/GKE clusters for production and staging
2. **Observability Stack:** Deploy Prometheus, Grafana, and Loki for metrics/logs/alerting
3. **TLS/HTTPS:** Install cert-manager with Let's Encrypt integration for automatic certificate renewal
4. **Ingress Controller:** Deploy NGINX ingress with TLS termination
5. **Container Registry:** Set up ECR/GCR with security scanning and image retention policies
6. **Networking:** Configure VPC, security groups, and network policies
7. **Namespace Isolation:** Create namespaces (clarity-router, clarity-router-staging) with RBAC

### Success Criteria (Phase 2 Completion Gate)
- [ ] Production K8s cluster created with 3 nodes across 3 AZs
- [ ] Staging K8s cluster created with 2 nodes across 2 AZs
- [ ] Prometheus deployed and scraping metrics from cluster
- [ ] Grafana accessible with sample dashboards
- [ ] Loki deployed and receiving logs
- [ ] cert-manager installed with ClusterIssuer configured
- [ ] Ingress NGINX controller running
- [ ] ECR/GCR repository created and authenticated
- [ ] Network policies configured (default deny + whitelist)
- [ ] RBAC ServiceAccounts created for router pods
- [ ] Resource quotas and limits set per namespace
- [ ] DNS zones configured (clarity-router.example.com, clarity-router-staging.example.com)

---

## Subtask Breakdown (6 Subtasks)

### Subtask 2.1: Set Up Kubernetes Cluster (EKS or GKE)

**Objective:** Provision primary and secondary Kubernetes clusters with HA configuration

**Requirements (from Architecture Doc - Section 2.1):**
```
Production Cluster:
  - Platform: EKS (AWS) or GKE (GCP) — CONFIRM PREFERENCE
  - Region: us-east-1 (AWS) or us-central1 (GCP)
  - AZs: 3 (us-east-1a, us-east-1b, us-east-1c)
  - Node Type: t3.medium (2 vCPU, 4GB RAM)
  - Nodes Desired: 3 (1 per AZ)
  - Nodes Min/Max: 2/6 (auto-scaling enabled)
  - Disk: 50GB gp3 (EBS/PD)
  - K8s Version: 1.28+ (latest stable)
  - VPC CIDR: 10.0.0.0/16

Staging Cluster:
  - Region: us-west-2 (AWS) or us-west1 (GCP) — secondary region
  - AZs: 2
  - Node Type: t3.small (2 vCPU, 2GB RAM)
  - Nodes Desired: 2
  - Nodes Min/Max: 1/3
  - Disk: 30GB gp3
```

**Deliverables:**
- [ ] Production cluster running with 3 healthy nodes
- [ ] Staging cluster running with 2 healthy nodes
- [ ] `kubectl` context configured for both clusters
- [ ] Node auto-scaling groups configured
- [ ] Security groups applied (ingress 443/22, egress unrestricted)
- [ ] IAM roles for worker nodes created
- [ ] Pod CIDR configured (e.g., 10.1.0.0/16)

**Verification Commands:**
```bash
# Check production cluster
kubectl cluster-info
kubectl get nodes -o wide

# Check node resources
kubectl describe nodes | grep -E "Name:|Allocatable|cpu|memory"

# Verify 3 AZs
kubectl get nodes -L topology.kubernetes.io/zone
```

---

### Subtask 2.2: Install Prometheus + Grafana + Loki Stack

**Objective:** Deploy open-source observability stack for metrics, logs, and alerting

**Requirements (from Architecture Doc - Section 4.1-4.4):**

**Prometheus:**
- Scrape interval: 30 seconds
- Retention: 15 days (production), 7 days (staging)
- ServiceMonitor for router pods (port 9090)
- Recording rules for latency percentiles
- AlertmanagerConfig for routing alerts

**Grafana:**
- Dashboards:
  1. Router Health Overview (availability, latency, throughput)
  2. Detailed Performance (errors by stage, latency heatmap)
  3. Infrastructure Health (node CPU/memory, network)
- Data source: Prometheus + Loki
- Alerts configured for SLO violations

**Loki:**
- Log retention: 30 days (prod), 7 days (staging)
- Labels: job, pod, namespace, environment, stage
- Query examples for router outages, high latency

**Deliverables:**
- [ ] Prometheus pod running, scraping metrics
- [ ] Grafana deployed with admin credentials
- [ ] Loki deployed, receiving log streams
- [ ] 3 Grafana dashboards created
- [ ] AlertManager configured to send alerts to Slack/PagerDuty
- [ ] Monitoring stack accessible via load balancer (optional)

**Verification Commands:**
```bash
# Check Prometheus
kubectl get pods -n prometheus
curl -s http://localhost:9090/api/v1/query?query=up

# Check Grafana
kubectl get svc grafana -n monitoring
# Verify: Login to Grafana UI (port 3000)

# Check Loki
kubectl logs -n loki -l app=loki
```

---

### Subtask 2.3: Configure Ingress Controller with TLS Termination

**Objective:** Deploy NGINX ingress controller with automatic TLS via cert-manager

**Requirements (from Architecture Doc - Section 2.2, 3):**

**Ingress NGINX:**
- Controller type: ingress-nginx
- Service type: LoadBalancer (creates AWS ALB/GCP LB)
- Replicas: 2 (for HA)
- Resource limits: 200m CPU, 256MB memory

**cert-manager Integration:**
- ClusterIssuer for Let's Encrypt (production)
- DNS-01 challenge (Route53/Cloud DNS)
- Auto-renewal 30 days before expiry
- Certificate resources for:
  - clarity-router.example.com
  - clarity-router-staging.example.com

**Deliverables:**
- [ ] Ingress NGINX controller deployed
- [ ] cert-manager deployed with ClusterIssuer
- [ ] Ingress resource created with TLS
- [ ] Certificate SecretRef pointing to router-tls
- [ ] ALB/LB external IP assigned
- [ ] HTTPS endpoint accessible (test with curl -k)
- [ ] Certificate auto-renewal verified

**Verification Commands:**
```bash
# Check Ingress Controller
kubectl get svc -n ingress-nginx ingress-nginx-controller
kubectl get pods -n ingress-nginx

# Check cert-manager
kubectl get pods -n cert-manager
kubectl get clusterissuer
kubectl get certificate

# Test HTTPS
curl -k https://clarity-router.example.com/health
```

---

### Subtask 2.4: Set Up Container Registry (ECR/GCR)

**Objective:** Create and configure container image repository with security scanning

**Requirements (from Architecture Doc - Section 6.1):**

**ECR (AWS) or GCR (GCP):**
- Repository name: `clarity-router`
- Image scanning: Enabled (CVE detection)
- Retention policy:
  - Keep all tagged releases (v1.2.0, v1.2.1, etc.)
  - Keep last 10 images by SHA
  - Delete untagged images after 30 days
- Lifecycle rules configured
- Cross-region replication (optional for Phase 5+)

**Authentication:**
- IAM role for GitHub Actions CI/CD
- Docker config for local pushes
- Service account token for K8s ImagePullSecrets

**Deliverables:**
- [ ] Repository created and accessible
- [ ] Image scanning enabled
- [ ] Lifecycle retention policy applied
- [ ] CI/CD service account with push/pull permissions
- [ ] Local docker login configured
- [ ] Helm values for image pull secrets

**Verification Commands:**
```bash
# AWS ECR
aws ecr describe-repositories --repository-names clarity-router
aws ecr start-image-scan --repository-name clarity-router --image-id imageTag=latest

# GCP GCR
gcloud container images list --repository=gcr.io/PROJECT_ID
gcloud container images scan IMAGE_URL
```

---

### Subtask 2.5: Configure Cluster Networking and Security Groups

**Objective:** Set up VPC, security groups, and network policies for secure communication

**Requirements (from Architecture Doc - Section 2.1, 8.1-8.3):**

**Security Groups (AWS):**
- Ingress:
  - Port 443 (HTTPS) from 0.0.0.0/0
  - Port 22 (SSH) from admin IPs only
  - Port 9090 (Prometheus) from K8s pods only
- Egress: Unrestricted (to NLP-Engine and external)

**Network Policies (Kubernetes):**
- Default deny all ingress
- Allow router pods to receive traffic on port 3001 from Ingress
- Allow Prometheus scraper to reach port 9090
- Allow router pod to reach NLP-Engine service (external)
- Deny all unexpected egress

**VPC Configuration:**
- CIDR: 10.0.0.0/16
- Subnets: Public (10.0.0.0/24, 10.0.1.0/24, 10.0.2.0/24) × 3 AZs
- Private: For worker nodes if desired
- NAT Gateway: For egress (if using private subnets)

**Deliverables:**
- [ ] VPC created with proper CIDR
- [ ] Security groups applied to EC2/GKE nodes
- [ ] NetworkPolicy resources deployed
- [ ] Egress to NLP-Engine verified
- [ ] Ingress from Prometheus verified
- [ ] Isolation between namespaces tested

**Verification Commands:**
```bash
# Check Network Policies
kubectl get networkpolicies -A
kubectl describe networkpolicy router-egress -n clarity-router

# Test connectivity
kubectl run -it --rm debug --image=nicolaka/netcat --restart=Never -- nc -zv router 3001
```

---

### Subtask 2.6: Create Namespace Isolation (RBAC, Quotas, Limits)

**Objective:** Set up Kubernetes namespaces with RBAC and resource controls

**Requirements (from Architecture Doc - Section 6.3):**

**Namespaces:**
- clarity-router (production)
- clarity-router-staging (staging)
- monitoring (Prometheus/Grafana/Loki)
- cert-manager (certificate management)

**RBAC:**
- ServiceAccount `router` with minimal permissions
- Role for pod management (get, list, watch)
- RoleBinding to ServiceAccount
- ClusterRole for cert-manager (global)

**Resource Management:**
- ResourceQuota per namespace:
  - Requests: 6 CPU, 12GB memory (prod)
  - Limits: 12 CPU, 24GB memory (prod)
- LimitRange for pod resources

**Deliverables:**
- [ ] Namespaces created
- [ ] ServiceAccounts configured
- [ ] Roles and RoleBindings applied
- [ ] ResourceQuota enforced
- [ ] LimitRange defaults set
- [ ] Pods can only run with defined requests/limits

**Verification Commands:**
```bash
# List namespaces
kubectl get namespaces

# Check RBAC
kubectl get rolebindings,roles -n clarity-router
kubectl get clusterrolebindings,clusterroles | grep cert-manager

# Verify ResourceQuota
kubectl get resourcequota -n clarity-router
kubectl describe resourcequota clarity-router-quota -n clarity-router
```

---

## Implementation Strategy

### Week 1: Infrastructure Foundation
- [ ] 2.1: Provision K8s clusters (EKS/GKE)
- [ ] 2.5: Configure networking and security groups
- [ ] 2.6: Create namespaces and RBAC

### Week 2: Observability & TLS
- [ ] 2.2: Deploy Prometheus + Grafana + Loki
- [ ] 2.3: Install ingress controller + cert-manager
- [ ] 2.4: Set up container registry

### Week 3: Validation & Hardening
- [ ] Verify all components interconnected
- [ ] Test failover and recovery scenarios (staging)
- [ ] Security audit (network policies, RBAC)
- [ ] Cost optimization review

---

## Dependencies & Blockers

**External Dependencies:**
- AWS/GCP account with billing enabled
- Domain name registered (clarity-router.example.com)
- DNS zone delegated to Route53/Cloud DNS
- GitHub repository access for CI/CD setup

**Internal Dependencies:**
- Phase 1 Architecture Planning ✅ (COMPLETE)
- Next: Phase 3 CI/CD Pipeline (after 2.4)

---

## Acceptance Criteria

When Phase 2 is complete:

✅ **Functional:**
- Both K8s clusters running with all nodes healthy
- Prometheus scraping 100+ metrics
- Grafana dashboards accessible and populated
- Loki receiving log streams
- cert-manager auto-renewing certificates
- Container registry accepting images

✅ **Observable:**
- Prometheus dashboard shows cluster metrics
- Grafana shows node resources, network I/O
- Loki logs searchable by pod, namespace, stage
- AlertManager configured

✅ **Secure:**
- TLS enforced (HTTPS only)
- Network policies blocking unexpected traffic
- RBAC restricting pod permissions
- Audit logging enabled

✅ **Documented:**
- Cluster access credentials secured
- Terraform/IaC code version-controlled
- Runbook for cluster troubleshooting
- Monitoring access instructions

---

## Handoff to Phase 3

Upon Phase 2 completion, Phase 3 (CI/CD Pipeline & Automation) can begin:
- GitHub Actions workflow will push images to registry
- ArgoCD/Flux will deploy to staging/production clusters
- Certificate management will be automatic via cert-manager

---

## Questions to Answer Before Starting

1. **AWS or GCP?** Which cloud platform should be used for EKS/GKE?
2. **Domain:** What domain should clarity-router.example.com resolve to?
3. **Billing:** Is ~$335/month budget approved for infrastructure?
4. **Team:** Who will execute Phase 2 (DevOps/SRE)?
5. **Timeline:** What is the target completion date?
6. **Approval:** Who needs to sign off on Phase 2 completion?

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cluster Health** | 99.9% node availability | Monitor via Prometheus |
| **Deployment Speed** | Pod startup <30 seconds | Time to Ready state |
| **Log Latency** | <1 second ingestion | Loki query response time |
| **Certificate Renewal** | Auto-renews >30 days before expiry | Monitor cert-manager logs |
| **Cost** | ~$335/month | AWS/GCP billing dashboard |

---

## Related Documentation

- **Architecture Reference:** `plans/ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md` (Sections 1-2, 4)
- **Execution Strategy:** `plans/ROUTER_DEPLOYMENT_EXECUTION_STRATEGY.md` (Phase 2 section)
- **Kubernetes Specs:** Full YAML manifests in architecture doc (Sections 3-6)

---

**Status:** Ready for Team Assignment  
**Next Review:** Upon Phase 2 completion (week 2-3)  
**Escalation:** Contact Architecture Team if blockers arise
