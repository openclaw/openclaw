# Subtask 2.1: Set Up Kubernetes Clusters (EKS or GKE)

**Document Version:** 1.0  
**Date:** February 15, 2026  
**Status:** Ready for Implementation  
**Estimated Duration:** 3-5 days  
**Target Completion Gate:** Both production and staging clusters operational with all nodes healthy

---

## Executive Summary

This guide provides step-by-step instructions to provision production and staging Kubernetes clusters on Amazon EKS (primary) or Google GKE (alternative). Both clusters will be configured for high availability, auto-scaling, and full integration with the observability stack deployed in Subtask 2.2.

### Deliverables by End of Subtask 2.1

✅ **Production Cluster:**
- 3 healthy nodes across 3 Availability Zones
- Node type: t3.medium (2 vCPU, 4GB RAM)
- 50GB disk per node (gp3)
- Auto-scaling configured (min 2, max 6 nodes)
- All kubectl contexts configured and operational

✅ **Staging Cluster:**
- 2 healthy nodes across 2 Availability Zones
- Node type: t3.small (2 vCPU, 2GB RAM)
- 30GB disk per node (gp3)
- Auto-scaling configured (min 1, max 3 nodes)
- kubectl contexts configured

✅ **Networking & Security:**
- VPC with CIDR 10.0.0.0/16
- Pod CIDR 10.1.0.0/16
- Security groups configured (ingress 443, 22, 9090)
- Network policies applied
- IAM roles for worker nodes

✅ **Verification:**
- All nodes marked Ready status
- Metrics Server installed and functional
- CoreDNS operational
- DNS resolution working across nodes
- Network connectivity verified

---

## 1. Prerequisites Checklist

Complete all items before proceeding with cluster provisioning.

### 1.1 Tools & CLI Installation

| Tool | Version | Purpose | Installation |
|------|---------|---------|--------------|
| **AWS CLI** | 2.13+ | AWS resource management | `pip install --upgrade awscli` or [aws.amazon.com/cli](https://aws.amazon.com/cli) |
| **kubectl** | 1.28+ | Kubernetes cluster management | `curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"` |
| **eksctl** | 0.160+ | EKS cluster provisioning (AWS only) | `curl --silent --location "https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz" \| tar xz -C /tmp && sudo mv /tmp/eksctl /usr/local/bin` |
| **Helm** | 3.12+ | Kubernetes package manager | `curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \| bash` |
| **gcloud** | Latest | GCP resource management (GKE only) | [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) |

**Verification:**
```bash
# Verify installed versions
aws --version
kubectl version --client
eksctl version
helm version --short
# If using GCP:
gcloud --version
```

### 1.2 AWS Account Setup (EKS Path)

**Required Permissions (IAM):**

Create an IAM user with the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "eks:*",
        "ec2:*",
        "iam:CreateRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:PassRole",
        "elasticloadbalancing:*",
        "iam:ListOpenIDConnectProviders",
        "iam:CreateOpenIDConnectProvider"
      ],
      "Resource": "*"
    }
  ]
}
```

**AWS CLI Configuration:**

```bash
# Configure AWS credentials
aws configure
# Enter Access Key ID: [YOUR_ACCESS_KEY]
# Enter Secret Access Key: [YOUR_SECRET_KEY]
# Enter Default region: us-east-1 (for production)
# Enter Default output format: json

# Verify configuration
aws sts get-caller-identity
# Expected output:
# {
#   "UserId": "AIDAI...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/your-user"
# }
```

### 1.3 GCP Project Setup (GKE Path)

**Create GCP Project:**

```bash
# Set project ID (customize as needed)
export PROJECT_ID="clarity-router-prod"
export BILLING_ACCOUNT_ID="[YOUR_BILLING_ACCOUNT_ID]"

# Create project
gcloud projects create $PROJECT_ID

# Link billing account
gcloud billing projects link $PROJECT_ID \
  --billing-account=$BILLING_ACCOUNT_ID

# Set as default project
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable container.googleapis.com
gcloud services enable compute.googleapis.com
gcloud services enable cloudresourcemanager.googleapis.com
```

**Create Service Account for Cluster Operations:**

```bash
gcloud iam service-accounts create gke-admin \
  --display-name="GKE Admin Service Account"

# Grant necessary roles
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gke-admin@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/container.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:gke-admin@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/compute.admin"

# Create and download key
gcloud iam service-accounts keys create ~/gke-admin-key.json \
  --iam-account=gke-admin@$PROJECT_ID.iam.gserviceaccount.com

# Activate service account
gcloud auth activate-service-account --key-file=~/gke-admin-key.json
gcloud config set project $PROJECT_ID
```

### 1.4 Domain Registration & DNS Setup

**Prerequisites:**

- [ ] Domain registered (e.g., clarity-router.example.com)
- [ ] DNS provider access (Route53 for AWS, Cloud DNS for GCP)
- [ ] Subdomain delegation configured

**AWS Route53 (EKS):**

```bash
# Create hosted zone
aws route53 create-hosted-zone \
  --name clarity-router.example.com \
  --caller-reference "clarity-router-$(date +%s)"

# Get zone ID
ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name clarity-router.example.com \
  --query 'HostedZones[0].Id' \
  --output text)

echo "Zone ID: $ZONE_ID"

# Note the nameservers for parent domain delegation
aws route53 get-hosted-zone --id $ZONE_ID \
  --query 'DelegationSet.NameServers' \
  --output text
```

**Google Cloud DNS (GKE):**

```bash
# Create DNS zone
gcloud dns managed-zones create clarity-router \
  --dns-name=clarity-router.example.com \
  --description="DNS zone for ClarityBurst Router"

# Get nameservers
gcloud dns managed-zones describe clarity-router \
  --format="value(nameServers)"

# Delegate parent domain to these nameservers
```

### 1.5 Pre-Flight Checklist

Before starting infrastructure provisioning, confirm:

- [ ] AWS CLI configured with appropriate credentials (or gcloud authenticated)
- [ ] kubectl installed and version 1.28+
- [ ] eksctl or gcloud CLI installed and functional
- [ ] IAM roles/permissions verified (test with `aws sts get-caller-identity`)
- [ ] Billing account active and has available credit
- [ ] Domain registered and nameserver delegation ready
- [ ] At least 2 hours of uninterrupted time available
- [ ] VPN access (if required by organization)
- [ ] Slack/PagerDuty channels configured for cluster notifications

---

## 2. Implementation Path A: AWS EKS (Primary)

### 2.1 Step 1: Prepare AWS Environment (VPC, Security Groups, IAM)

#### 2.1.1 Create VPC and Subnets

```bash
# Set variables for consistency
export REGION="us-east-1"
export VPC_CIDR="10.0.0.0/16"
export CLUSTER_NAME_PROD="clarity-router-prod"
export CLUSTER_NAME_STAGING="clarity-router-staging"

# Create VPC for production cluster
VPC_ID=$(aws ec2 create-vpc \
  --cidr-block $VPC_CIDR \
  --region $REGION \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=clarity-router-vpc}]" \
  --query 'Vpc.VpcId' \
  --output text)

echo "Created VPC: $VPC_ID"

# Enable DNS hostnames
aws ec2 modify-vpc-attribute \
  --vpc-id $VPC_ID \
  --enable-dns-hostnames \
  --region $REGION

# Create Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
  --region $REGION \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=clarity-router-igw}]" \
  --query 'InternetGateway.InternetGatewayId' \
  --output text)

aws ec2 attach-internet-gateway \
  --internet-gateway-id $IGW_ID \
  --vpc-id $VPC_ID \
  --region $REGION

# Create public subnets across 3 AZs for production
# AZ 1: us-east-1a (10.0.0.0/24)
SUBNET_A=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID \
  --cidr-block 10.0.0.0/24 \
  --availability-zone ${REGION}a \
  --region $REGION \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=clarity-router-subnet-a},{Key=kubernetes.io/cluster/$CLUSTER_NAME_PROD,Value=shared}]" \
  --query 'Subnet.SubnetId' \
  --output text)

# AZ 2: us-east-1b (10.0.1.0/24)
SUBNET_B=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID \
  --cidr-block 10.0.1.0/24 \
  --availability-zone ${REGION}b \
  --region $REGION \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=clarity-router-subnet-b},{Key=kubernetes.io/cluster/$CLUSTER_NAME_PROD,Value=shared}]" \
  --query 'Subnet.SubnetId' \
  --output text)

# AZ 3: us-east-1c (10.0.2.0/24)
SUBNET_C=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID \
  --cidr-block 10.0.2.0/24 \
  --availability-zone ${REGION}c \
  --region $REGION \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=clarity-router-subnet-c},{Key=kubernetes.io/cluster/$CLUSTER_NAME_PROD,Value=shared}]" \
  --query 'Subnet.SubnetId' \
  --output text)

echo "Created subnets: $SUBNET_A, $SUBNET_B, $SUBNET_C"

# Enable public IP assignment on subnets
aws ec2 modify-subnet-attribute \
  --subnet-id $SUBNET_A \
  --map-public-ip-on-launch \
  --region $REGION

aws ec2 modify-subnet-attribute \
  --subnet-id $SUBNET_B \
  --map-public-ip-on-launch \
  --region $REGION

aws ec2 modify-subnet-attribute \
  --subnet-id $SUBNET_C \
  --map-public-ip-on-launch \
  --region $REGION

# Create Route Table and associate with subnets
ROUTE_TABLE=$(aws ec2 create-route-table \
  --vpc-id $VPC_ID \
  --region $REGION \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=clarity-router-rt}]" \
  --query 'RouteTable.RouteTableId' \
  --output text)

# Add route to Internet Gateway
aws ec2 create-route \
  --route-table-id $ROUTE_TABLE \
  --destination-cidr-block 0.0.0.0/0 \
  --gateway-id $IGW_ID \
  --region $REGION

# Associate route table with subnets
aws ec2 associate-route-table \
  --subnet-id $SUBNET_A \
  --route-table-id $ROUTE_TABLE \
  --region $REGION

aws ec2 associate-route-table \
  --subnet-id $SUBNET_B \
  --route-table-id $ROUTE_TABLE \
  --region $REGION

aws ec2 associate-route-table \
  --subnet-id $SUBNET_C \
  --route-table-id $ROUTE_TABLE \
  --region $REGION

# Verify VPC setup
echo "VPC Setup Complete:"
echo "VPC ID: $VPC_ID"
echo "Subnets: $SUBNET_A (us-east-1a), $SUBNET_B (us-east-1b), $SUBNET_C (us-east-1c)"
echo "Route Table: $ROUTE_TABLE"
echo "IGW: $IGW_ID"
```

#### 2.1.2 Create Security Groups

```bash
# Create security group for worker nodes
SECURITY_GROUP=$(aws ec2 create-security-group \
  --group-name clarity-router-nodes \
  --description "Security group for EKS worker nodes" \
  --vpc-id $VPC_ID \
  --region $REGION \
  --query 'GroupId' \
  --output text)

echo "Created Security Group: $SECURITY_GROUP"

# Add ingress rule: HTTPS (443) from anywhere
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP \
  --protocol tcp \
  --port 443 \
  --cidr 0.0.0.0/0 \
  --region $REGION

# Add ingress rule: SSH (22) from admin IPs (replace with your IP range)
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0 \
  --region $REGION

# Add ingress rule: Prometheus (9090) from pods only (pod CIDR 10.1.0.0/16)
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP \
  --protocol tcp \
  --port 9090 \
  --cidr 10.1.0.0/16 \
  --region $REGION

# Add ingress rule: Node-to-node communication
aws ec2 authorize-security-group-ingress \
  --group-id $SECURITY_GROUP \
  --protocol tcp \
  --port 1025-65535 \
  --source-group $SECURITY_GROUP \
  --region $REGION

# Verify security group
aws ec2 describe-security-groups \
  --group-ids $SECURITY_GROUP \
  --region $REGION \
  --query 'SecurityGroups[0].IpPermissions[*].[FromPort, ToPort]'
```

**Expected Output:**
```json
[
  [443, 443],
  [22, 22],
  [9090, 9090],
  [1025, 65535]
]
```

#### 2.1.3 Create IAM Roles for Worker Nodes

```bash
# Create IAM role for EKS cluster
CLUSTER_ROLE=$(aws iam create-role \
  --role-name clarity-router-cluster-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "eks.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }' \
  --query 'Role.RoleName' \
  --output text 2>/dev/null || echo "Role already exists")

# Attach policy for EKS cluster
aws iam attach-role-policy \
  --role-name clarity-router-cluster-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy

# Create IAM role for worker nodes
NODE_ROLE=$(aws iam create-role \
  --role-name clarity-router-node-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Service": "ec2.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }' \
  --query 'Role.RoleName' \
  --output text 2>/dev/null || echo "Role already exists")

# Attach policies for worker nodes
aws iam attach-role-policy \
  --role-name clarity-router-node-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy

aws iam attach-role-policy \
  --role-name clarity-router-node-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy

aws iam attach-role-policy \
  --role-name clarity-router-node-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name clarity-router-node-instance-profile 2>/dev/null || echo "Instance profile already exists"

aws iam add-role-to-instance-profile \
  --instance-profile-name clarity-router-node-instance-profile \
  --role-name clarity-router-node-role

echo "IAM Roles Created:"
echo "Cluster Role: clarity-router-cluster-role"
echo "Node Role: clarity-router-node-role"
```

### 2.2 Step 2: Create Production EKS Cluster

#### 2.2.1 Create Cluster with eksctl

```bash
# Set region and cluster name
export REGION="us-east-1"
export CLUSTER_NAME_PROD="clarity-router-prod"
export K8S_VERSION="1.28"

# Create EKS cluster using eksctl (recommended)
eksctl create cluster \
  --name $CLUSTER_NAME_PROD \
  --region $REGION \
  --version $K8S_VERSION \
  --nodegroup-name clarity-router-nodes \
  --node-type t3.medium \
  --nodes 3 \
  --nodes-min 2 \
  --nodes-max 6 \
  --node-volume-size 50 \
  --node-volume-type gp3 \
  --enable-ssm \
  --tags "Environment=production,Project=clarity-router,CreatedBy=terraform" \
  --vpc-cidr 10.0.0.0/16 \
  --with-oidc \
  --managed \
  --wait

echo "EKS Cluster created successfully!"
```

**Expected Duration:** 10-15 minutes

#### 2.2.2 Configure kubectl Access

```bash
# Update kubeconfig
aws eks update-kubeconfig \
  --name $CLUSTER_NAME_PROD \
  --region $REGION \
  --alias clarity-router-prod

# Verify connection
kubectl cluster-info --context clarity-router-prod

# Expected output:
# Kubernetes control plane is running at https://[ENDPOINT].eks.us-east-1.amazonaws.com
# CoreDNS is running at https://[ENDPOINT].eks.us-east-1.amazonaws.com/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
```

### 2.3 Step 3: Create Staging EKS Cluster

```bash
# Set staging variables
export STAGING_REGION="us-west-2"
export CLUSTER_NAME_STAGING="clarity-router-staging"
export K8S_VERSION="1.28"

# Create staging cluster
eksctl create cluster \
  --name $CLUSTER_NAME_STAGING \
  --region $STAGING_REGION \
  --version $K8S_VERSION \
  --nodegroup-name clarity-router-staging-nodes \
  --node-type t3.small \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 3 \
  --node-volume-size 30 \
  --node-volume-type gp3 \
  --enable-ssm \
  --tags "Environment=staging,Project=clarity-router,CreatedBy=terraform" \
  --vpc-cidr 10.1.0.0/16 \
  --with-oidc \
  --managed \
  --wait

# Update kubeconfig for staging
aws eks update-kubeconfig \
  --name $CLUSTER_NAME_STAGING \
  --region $STAGING_REGION \
  --alias clarity-router-staging

echo "Staging cluster created!"
```

### 2.4 Step 4: Verify Clusters & Configure kubectl

#### 2.4.1 Verify Production Cluster

```bash
# Switch to production cluster context
kubectl config use-context clarity-router-prod

# Check cluster info
kubectl cluster-info
# Expected output shows Kubernetes API and CoreDNS endpoints

# List all nodes
kubectl get nodes -o wide
# Expected: 3 nodes in Ready state

# Check node resources
kubectl describe nodes | grep -E "Name:|Allocatable" | head -12
# Shows CPU/memory allocatable on each node

# Verify 3 AZs
kubectl get nodes -L topology.kubernetes.io/zone
# Expected: nodes in us-east-1a, us-east-1b, us-east-1c

# Check system pods
kubectl get pods -n kube-system | head -20
# Should see coredns, kube-proxy, aws-node pods all Running
```

#### 2.4.2 Verify Staging Cluster

```bash
# Switch to staging
kubectl config use-context clarity-router-staging

# Quick verification
kubectl get nodes -o wide
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get pods -n kube-system
```

#### 2.4.3 Configure kubectl Contexts

```bash
# List contexts
kubectl config get-contexts

# Set default context to production
kubectl config use-context clarity-router-prod

# View kubeconfig
cat ~/.kube/config | grep -A 5 "clusters:"
```

### 2.5 Step 5: Configure Auto-Scaling

#### 2.5.1 Install Metrics Server

```bash
# Apply Metrics Server (required for HPA)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Verify Metrics Server is running
kubectl get deployment metrics-server -n kube-system

# Wait for metrics to be available
sleep 60
kubectl top nodes
```

**Expected Output:**
```
NAME                           CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
ip-10-0-0-xxx.ec2.internal    45m          2%     156Mi           4%
ip-10-0-1-xxx.ec2.internal    42m          2%     142Mi           4%
ip-10-0-2-xxx.ec2.internal    48m          2%     165Mi           4%
```

#### 2.5.2 Verify Auto-Scaling Configuration

```bash
# For production cluster
export CLUSTER_NAME_PROD="clarity-router-prod"
export REGION="us-east-1"

# Get Auto Scaling Group details
aws autoscaling describe-auto-scaling-groups \
  --region $REGION \
  --query "AutoScalingGroups[?Tags[?Key=='eks:cluster-name' && Value=='$CLUSTER_NAME_PROD']].{Name: AutoScalingGroupName, Min: MinSize, Max: MaxSize, Desired: DesiredCapacity}"

# Expected output:
# [
#   {
#     "Name": "eks-clarity-router-nodes-...",
#     "Min": 2,
#     "Max": 6,
#     "Desired": 3
#   }
# ]
```

---

## 3. Implementation Path B: Google GKE (Alternative)

### 3.1 Step 1: Create Production GKE Cluster

```bash
# Set variables
export PROJECT_ID="clarity-router-prod"
export REGION="us-central1"
export CLUSTER_NAME_PROD="clarity-router-prod"

# Create production GKE cluster
gcloud container clusters create $CLUSTER_NAME_PROD \
  --project=$PROJECT_ID \
  --region=$REGION \
  --node-locations us-central1-a,us-central1-b,us-central1-c \
  --num-nodes 3 \
  --machine-type n1-standard-2 \
  --enable-autoscaling \
  --min-nodes 2 \
  --max-nodes 6 \
  --disk-size 50 \
  --disk-type pd-ssd \
  --enable-autorepair \
  --enable-autoupgrade \
  --enable-cloud-logging \
  --logging-service logging.googleapis.com/kubernetes \
  --enable-cloud-monitoring

# Get credentials
gcloud container clusters get-credentials $CLUSTER_NAME_PROD \
  --project=$PROJECT_ID \
  --region=$REGION

# Rename context (optional)
kubectl config rename-context gke_${PROJECT_ID}_${REGION}_${CLUSTER_NAME_PROD} gke-prod
```

### 3.2 Step 2: Create Staging GKE Cluster

```bash
# Set staging variables
export STAGING_REGION="us-west1"
export CLUSTER_NAME_STAGING="clarity-router-staging"

# Create staging cluster
gcloud container clusters create $CLUSTER_NAME_STAGING \
  --project=$PROJECT_ID \
  --region=$STAGING_REGION \
  --node-locations us-west1-a,us-west1-b \
  --num-nodes 2 \
  --machine-type n1-standard-1 \
  --enable-autoscaling \
  --min-nodes 1 \
  --max-nodes 3 \
  --disk-size 30 \
  --disk-type pd-ssd

# Get credentials
gcloud container clusters get-credentials $CLUSTER_NAME_STAGING \
  --project=$PROJECT_ID \
  --region=$STAGING_REGION

# Rename context
kubectl config rename-context gke_${PROJECT_ID}_${STAGING_REGION}_${CLUSTER_NAME_STAGING} gke-staging
```

### 3.3 Step 3: Verify GKE Clusters

```bash
# Switch to production
kubectl config use-context gke-prod

# Check cluster
gcloud container clusters describe clarity-router-prod \
  --project=$PROJECT_ID \
  --region=us-central1

# Verify nodes
kubectl get nodes -L topology.kubernetes.io/zone

# Install Metrics Server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Check metrics
kubectl top nodes
```

---

## 4. Post-Cluster Setup

### 4.1 Install Essential Add-ons

#### 4.1.1 Verify Metrics Server

```bash
kubectl config use-context clarity-router-prod

# Check deployment
kubectl get deployment metrics-server -n kube-system

# Verify metrics are available
kubectl top nodes
kubectl top pods -A
```

#### 4.1.2 Verify CoreDNS

```bash
# Check CoreDNS deployment
kubectl get deployment coredns -n kube-system

# Test DNS resolution
kubectl run -it --rm debug --image=nicolaka/netcat --restart=Never -- \
  nslookup kubernetes.default

# Expected output includes IP address resolution
```

#### 4.1.3 Create Namespaces

```bash
# Create production namespace
kubectl create namespace clarity-router
kubectl label namespace clarity-router environment=production

# Create staging namespace
kubectl create namespace clarity-router-staging
kubectl label namespace clarity-router-staging environment=staging

# Create monitoring namespace
kubectl create namespace monitoring
kubectl label namespace monitoring app=monitoring

# Create cert-manager namespace
kubectl create namespace cert-manager
kubectl label namespace cert-manager app=cert-manager

# Verify
kubectl get namespaces
```

### 4.2 Configure Network Policies

```bash
# Switch to production cluster
kubectl config use-context clarity-router-prod

# Create default deny network policy
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: clarity-router
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
EOF

# Allow DNS egress
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: clarity-router
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53
EOF

echo "Network policies configured"
```

---

## 5. Verification Checklist

### 5.1 Production Cluster (clarity-router-prod)

```bash
kubectl config use-context clarity-router-prod

# 1. Cluster Info
echo "=== CLUSTER INFO ==="
kubectl cluster-info

# 2. Node Status
echo -e "\n=== NODE STATUS (should be 3 Ready nodes) ==="
kubectl get nodes -o wide
kubectl get nodes | grep Ready | wc -l  # Should output 3

# 3. AZ Distribution
echo -e "\n=== AVAILABILITY ZONE DISTRIBUTION ==="
kubectl get nodes -L topology.kubernetes.io/zone

# 4. Node Resources
echo -e "\n=== NODE ALLOCATABLE RESOURCES ==="
kubectl describe nodes | grep -A 6 "Allocatable:" | head -20

# 5. System Pods
echo -e "\n=== SYSTEM PODS ==="
kubectl get pods -n kube-system -o wide | head -15

# 6. Metrics
echo -e "\n=== NODE METRICS ==="
kubectl top nodes

# 7. API Server Health
echo -e "\n=== API SERVER HEALTH ==="
kubectl get --raw /readyz

# 8. Recent Events
echo -e "\n=== RECENT EVENTS ==="
kubectl get events -A --sort-by='.lastTimestamp' | tail -10
```

### 5.2 Staging Cluster (clarity-router-staging)

Repeat all checks above for staging:

```bash
kubectl config use-context clarity-router-staging
# Run same commands as production
```

### 5.3 Networking Validation

```bash
# Test DNS
kubectl run -it --rm debug --image=nicolaka/netcat --restart=Never -- \
  nslookup kubernetes.default

# Test external connectivity
kubectl run -it --rm debug --image=nicolaka/netcat --restart=Never -- \
  curl https://www.google.com
```

---

## 6. Troubleshooting Guide

### 6.1 Nodes Not Ready

**Check node status:**
```bash
kubectl get nodes
kubectl describe node <node-name>
kubectl logs -n kube-system -l component=kubelet --tail=50
```

**Common solutions:**
- Verify security group allows inter-node communication
- Check IAM roles have correct policies attached
- Verify VPC CIDR doesn't conflict with pod CIDR (10.1.0.0/16)

### 6.2 Pods Not Scheduling

**Check pending pods:**
```bash
kubectl get pods -A --field-selector=status.phase=Pending
kubectl describe pod <pod-name> -n <namespace>
```

**Solutions:**
- Add more nodes via auto-scaling
- Check resource requests vs node capacity
- Verify security groups allow pod communication

### 6.3 DNS Resolution Issues

**Test DNS:**
```bash
kubectl run -it --rm debug --image=nicolaka/netcat --restart=Never -- \
  nslookup google.com
```

**Check CoreDNS:**
```bash
kubectl logs -n kube-system -l k8s-app=kube-dns
kubectl get svc -n kube-system kube-dns
```

### 6.4 High Latency

**Check node resources:**
```bash
kubectl top nodes
kubectl top pods -A
```

**Check for evictions:**
```bash
kubectl get events -A | grep Evicted
kubectl get pods -A --field-selector=status.phase=Failed
```

---

## 7. Success Criteria (Pass/Fail)

### Production Cluster Checklist

```bash
kubectl config use-context clarity-router-prod

# [ ] 3 healthy nodes
kubectl get nodes | grep Ready | wc -l
# Expected: 3

# [ ] Nodes in 3 AZs
kubectl get nodes -L topology.kubernetes.io/zone | grep us-east-1 | wc -l
# Expected: 3

# [ ] Node type t3.medium
aws ec2 describe-instances --region us-east-1 --filters "Name=instance-state-name,Values=running" | jq '.Reservations[].Instances[].InstanceType' | grep t3.medium | wc -l
# Expected: 3

# [ ] Auto-scaling min 2, max 6
aws autoscaling describe-auto-scaling-groups --region us-east-1 | jq '.AutoScalingGroups[] | select(.AutoScalingGroupName | contains("clarity-router-prod")) | {Min: .MinSize, Max: .MaxSize}'
# Expected: Min: 2, Max: 6

# [ ] Metrics Server running
kubectl get deployment metrics-server -n kube-system
# Expected: 1/1 Ready

# [ ] CoreDNS running
kubectl get deployment coredns -n kube-system
# Expected: 2/2 Ready

# [ ] API server responding
kubectl get --raw /readyz
# Expected: ok

# [ ] No pending pods
kubectl get pods -A --field-selector=status.phase=Pending | wc -l
# Expected: 0
```

### Staging Cluster Checklist

```bash
kubectl config use-context clarity-router-staging

# [ ] 2 healthy nodes (same checks, expect 2 not 3)
kubectl get nodes | grep Ready | wc -l
# Expected: 2

# [ ] Node type t3.small
# [ ] Auto-scaling min 1, max 3
# [ ] All system pods Running
```

---

## 8. Cost Analysis

### AWS EKS - Production Cluster (us-east-1, 3 nodes)

| Component | Unit | Qty | Cost/Unit | Monthly |
|-----------|------|-----|-----------|---------|
| EKS Control Plane | per cluster/month | 1 | $73.00 | $73.00 |
| t3.medium instance-hour | 730 hours/month × 3 nodes | 2,190 | $0.0416 | $91.11 |
| EBS gp3 storage | per GB/month | 150GB | $0.10 | $15.00 |
| Data transfer out | per GB | 50 | $0.02 | $1.00 |
| **Production Subtotal** | | | | **$180.11** |

### AWS EKS - Staging Cluster (us-west-2, 2 nodes)

| Component | Unit | Qty | Cost/Unit | Monthly |
|-----------|------|-----|-----------|---------|
| EKS Control Plane | per cluster/month | 1 | $73.00 | $73.00 |
| t3.small instance-hour | 730 hours/month × 2 nodes | 1,460 | $0.0208 | $30.37 |
| EBS gp3 storage | per GB/month | 60GB | $0.10 | $6.00 |
| Data transfer out | per GB | 20 | $0.02 | $0.40 |
| **Staging Subtotal** | | | | **$109.77** |

### **Total Monthly Cost: ~$290/month (for clusters only)**

**Note:** Costs exclude monitoring stack (Prometheus, Grafana, Loki) deployed in Subtask 2.2. Add ~$50-100/month for observability infrastructure.

---

## 9. Next Steps - Handoff to Subtask 2.2

### Prerequisites for Subtask 2.2 Completion

Before proceeding to install monitoring stack:

- ✅ Both EKS clusters (prod & staging) fully operational
- ✅ All nodes in Ready state across proper AZs
- ✅ kubectl contexts configured and working
- ✅ Metrics Server installed
- ✅ CoreDNS resolving addresses
- ✅ Namespaces created (clarity-router, clarity-router-staging, monitoring)
- ✅ Network policies configured

### Subtask 2.2 Overview

**Subtask 2.2: Install Prometheus + Grafana + Loki Stack**

Deliverables:
- Prometheus deployed, scraping metrics from cluster
- Grafana dashboards configured (Router Health, Performance, Infrastructure)
- Loki receiving and indexing logs
- AlertManager integrated for Slack/PagerDuty notifications
- Recording rules for SLO metrics (p99 latency, availability)

**Estimated Duration:** 2-3 days

### Transition Checklist

Confirm these items before starting Subtask 2.2:

```bash
# Production cluster ready
kubectl config use-context clarity-router-prod
kubectl get nodes | grep Ready | wc -l  # Should be 3
kubectl get pods -n kube-system | grep Running | wc -l  # Should be all

# Staging cluster ready
kubectl config use-context clarity-router-staging
kubectl get nodes | grep Ready | wc -l  # Should be 2

# Namespaces exist
kubectl get ns | grep clarity-router
kubectl get ns | grep monitoring

# Metrics available
kubectl top nodes
```

---

## 10. Quick Reference Commands

### Cluster Management

```bash
# Switch contexts
kubectl config use-context clarity-router-prod
kubectl config use-context clarity-router-staging

# View current context
kubectl config current-context

# List all clusters
kubectl config get-contexts

# Get cluster info
kubectl cluster-info
kubectl get nodes -o wide
```

### Node Operations

```bash
# Check node resources
kubectl describe nodes
kubectl top nodes
kubectl get nodes -L topology.kubernetes.io/zone

# Drain node for maintenance
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# Uncordon node
kubectl uncordon <node-name>
```

### Debugging

```bash
# Get pod details
kubectl describe pod <pod-name> -n <namespace>

# Check logs
kubectl logs <pod-name> -n <namespace> -f

# Execute commands in pod
kubectl exec -it <pod-name> -n <namespace> -- /bin/bash

# Port forward
kubectl port-forward <pod-name> 8080:3001 -n <namespace>
```

---

## 11. Contact & Support

### Escalation Path

**For cluster issues:**
1. Check Slack #clarity-router-deploy channel
2. Review AWS CloudTrail / GCP Cloud Audit Logs
3. Contact DevOps team lead
4. Escalate to Cloud infrastructure team if needed

**Documentation:**
- Architecture: `plans/ROUTER_SERVICE_PRODUCTION_DEPLOYMENT_ARCHITECTURE.md`
- Phase 2 Strategy: `plans/NEXT_TASK_PHASE_2_INFRASTRUCTURE_PROVISIONING.md`
- This guide: `plans/SUBTASK_2_1_KUBERNETES_CLUSTER_SETUP.md`

---

**Document Status:** ✅ Complete  
**Last Updated:** February 15, 2026  
**Next Review:** Upon Phase 2.2 completion
