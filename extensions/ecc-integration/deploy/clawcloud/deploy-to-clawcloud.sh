#!/bin/bash
# deploy-to-clawcloud.sh - Deploy OpenClaw ECC to ClawCloud Run
# This script prepares and deploys the application

set -e

echo "🚀 OpenClaw ECC - ClawCloud Deployment"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if credentials are provided as arguments or environment variables
NVIDIA_API_KEY="${NVIDIA_API_KEY:-$1}"
DATABASE_URL="${DATABASE_URL:-$2}"
REDIS_URL="${REDIS_URL:-$3}"

# Prompt for missing credentials
if [ -z "$NVIDIA_API_KEY" ]; then
    echo -e "${YELLOW}Enter your NVIDIA API Key (from build.nvidia.com):${NC}"
    read -s NVIDIA_API_KEY
    echo ""
fi

if [ -z "$DATABASE_URL" ]; then
    echo -e "${YELLOW}Enter your Database URL (from neon.tech) - optional:${NC}"
    read DATABASE_URL
    echo ""
fi

if [ -z "$REDIS_URL" ]; then
    echo -e "${YELLOW}Enter your Redis URL (from upstash.com) - optional:${NC}"
    read REDIS_URL
    echo ""
fi

# Validate NVIDIA API Key
if [ -z "$NVIDIA_API_KEY" ]; then
    echo -e "${RED}❌ NVIDIA API Key is required${NC}"
    exit 1
fi

if [[ ! $NVIDIA_API_KEY =~ ^nvapi- ]]; then
    echo -e "${YELLOW}⚠️  Warning: NVIDIA API Key should start with 'nvapi-'${NC}"
fi

echo -e "${GREEN}✓ Credentials collected${NC}"
echo ""

# Create temporary deployment directory
DEPLOY_DIR="$(pwd)/.clawcloud-deploy-$(date +%s)"
mkdir -p "$DEPLOY_DIR"

echo "📦 Preparing deployment package..."

# Copy template files
cp index.yml "$DEPLOY_DIR/"
cp README.md "$DEPLOY_DIR/"

# Generate manifest with credentials
cat > "$DEPLOY_DIR/manifest.yaml" << EOF
apiVersion: v1
kind: Namespace
metadata:
  name: openclaw-ecc
---
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-secrets
  namespace: openclaw-ecc
type: Opaque
stringData:
  nvidia-api-key: "$NVIDIA_API_KEY"
  database-url: "$DATABASE_URL"
  redis-url: "$REDIS_URL"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw-gateway
  namespace: openclaw-ecc
  labels:
    app: openclaw-gateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw-gateway
  template:
    metadata:
      labels:
        app: openclaw-gateway
    spec:
      containers:
      - name: gateway
        image: node:22-alpine
        workingDir: /app
        command: ["sh", "-c"]
        args:
          - |
            apk add --no-cache git &&
            npm install -g pnpm &&
            git clone --depth 1 https://github.com/openclaw/openclaw.git . &&
            git submodule update --init --recursive &&
            pnpm install &&
            pnpm build &&
            pnpm start:gateway
        env:
        - name: NODE_ENV
          value: "production"
        - name: GATEWAY_PORT
          value: "3000"
        - name: NVIDIA_API_KEY
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: nvidia-api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: redis-url
        ports:
        - containerPort: 3000
          name: http
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 120
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 60
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: openclaw-gateway
  namespace: openclaw-ecc
spec:
  selector:
    app: openclaw-gateway
  ports:
  - port: 80
    targetPort: 3000
    name: http
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw-api
  namespace: openclaw-ecc
  labels:
    app: openclaw-api
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw-api
  template:
    metadata:
      labels:
        app: openclaw-api
    spec:
      containers:
      - name: api
        image: node:22-alpine
        workingDir: /app
        command: ["sh", "-c"]
        args:
          - |
            apk add --no-cache git &&
            npm install -g pnpm &&
            git clone --depth 1 https://github.com/openclaw/openclaw.git . &&
            git submodule update --init --recursive &&
            pnpm install &&
            pnpm build &&
            pnpm start:api
        env:
        - name: NODE_ENV
          value: "production"
        - name: API_PORT
          value: "3001"
        - name: NVIDIA_API_KEY
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: nvidia-api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: redis-url
        ports:
        - containerPort: 3001
          name: http
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 120
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 60
          periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: openclaw-api
  namespace: openclaw-ecc
spec:
  selector:
    app: openclaw-api
  ports:
  - port: 80
    targetPort: 3001
    name: http
  type: ClusterIP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw-worker
  namespace: openclaw-ecc
  labels:
    app: openclaw-worker
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw-worker
  template:
    metadata:
      labels:
        app: openclaw-worker
    spec:
      containers:
      - name: worker
        image: node:22-alpine
        workingDir: /app
        command: ["sh", "-c"]
        args:
          - |
            apk add --no-cache git &&
            npm install -g pnpm &&
            git clone --depth 1 https://github.com/openclaw/openclaw.git . &&
            git submodule update --init --recursive &&
            pnpm install &&
            pnpm build &&
            pnpm start:worker
        env:
        - name: NODE_ENV
          value: "production"
        - name: NVIDIA_API_KEY
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: nvidia-api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: redis-url
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "250m"
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: openclaw-ingress
  namespace: openclaw-ecc
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  rules:
  - host: openclaw-ecc.run.claw.cloud
    http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: openclaw-api
            port:
              number: 80
      - path: /
        pathType: Prefix
        backend:
          service:
            name: openclaw-gateway
            port:
              number: 80
EOF

echo -e "${GREEN}✓ Deployment package created${NC}"
echo ""

# Create deployment instructions
cat > "$DEPLOY_DIR/DEPLOY_INSTRUCTIONS.txt" << 'EOF'
🚀 DEPLOYMENT INSTRUCTIONS
===========================

Your deployment package is ready in this directory!

FILES INCLUDED:
- manifest.yaml    : Kubernetes manifests with your credentials
- index.yml        : ClawCloud template definition
- README.md        : Documentation

MANUAL DEPLOYMENT STEPS:
========================

Option 1: ClawCloud Dashboard (Easiest)
---------------------------------------
1. Visit https://run.claw.cloud
2. Sign in to your account
3. Click "Create App" or "Deploy"
4. Select "Upload Template" or "Custom Template"
5. Upload the manifest.yaml file
6. Click "Deploy"
7. Wait 3-5 minutes for deployment
8. Access your app at the provided URL

Option 2: Using kubectl (Advanced)
----------------------------------
1. Download kubeconfig from ClawCloud dashboard
2. Set KUBECONFIG environment variable
3. Run: kubectl apply -f manifest.yaml
4. Check status: kubectl get pods -n openclaw-ecc

VERIFICATION:
=============
After deployment, test these endpoints:

1. Health Check:
   curl https://your-app-url.run.claw.cloud/health

2. List Models:
   curl https://your-app-url.run.claw.cloud/api/models

3. Generate Text:
   curl -X POST https://your-app-url.run.claw.cloud/api/generate \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"Hello"}]}'

TROUBLESHOOTING:
================

If pods are not starting:
- Check logs in ClawCloud dashboard
- Ensure NVIDIA_API_KEY is set correctly
- Verify resource limits (4 vCPU / 8GB RAM total)

If database connection fails:
- Verify DATABASE_URL format
- Check if Neon database is active (free tier sleeps)

SUPPORT:
========
- ClawCloud: support@run.claw.cloud
- OpenClaw: https://github.com/openclaw/openclaw/issues

EOF

echo -e "${GREEN}✓ Instructions created${NC}"
echo ""

echo "📁 Deployment package location:"
echo "   $DEPLOY_DIR"
echo ""

echo -e "${GREEN}🎉 Deployment package ready!${NC}"
echo ""
echo "Next steps:"
echo "1. cd $DEPLOY_DIR"
echo "2. Read DEPLOY_INSTRUCTIONS.txt"
echo "3. Upload manifest.yaml to ClawCloud Run"
echo "4. Or run: kubectl apply -f manifest.yaml"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: After deployment, delete this directory to protect your credentials:${NC}"
echo "   rm -rf $DEPLOY_DIR"
echo ""

# List files
echo "Package contents:"
ls -la "$DEPLOY_DIR"
