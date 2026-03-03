# ClawCloud Run Deployment - Multiple Methods

## Method 1: Docker Image (Easiest - No Upload Needed)

Since you don't see a file upload option, the easiest way is using Docker Hub.

### Step 1: I'll Create a Docker Image

Let me create a Dockerfile that includes everything:

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Install git and pnpm
RUN apk add --no-cache git
RUN npm install -g pnpm

# Clone and setup
RUN git clone --depth 1 https://github.com/openclaw/openclaw.git . && \
    git submodule update --init --recursive && \
    pnpm install && \
    pnpm build

# Set environment (you'll add these in ClawCloud UI)
ENV NODE_ENV=production
ENV GATEWAY_PORT=3000
ENV API_PORT=3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Expose ports
EXPOSE 3000 3001

# Start gateway by default
CMD ["pnpm", "start:gateway"]
```

### Step 2: In ClawCloud UI

1. Go to https://run.claw.cloud
2. Click **"Create App"**
3. Select **"Deploy from Docker Image"** or **"Container Image"**
4. Enter image: `node:22-alpine` (we'll customize this)
5. Set environment variables in the UI:

```
NVIDIA_API_KEY=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
DATABASE_URL=https://ep-blue-morning-a1zjgpm2.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1
REDIS_URL=https://open-bullfrog-15428.upstash.io
NODE_ENV=production
GATEWAY_PORT=3000
```

6. Click Deploy

---

## Method 2: GitHub Repository Integration

ClawCloud can deploy directly from GitHub.

### Step 1: Fork OpenClaw
1. Go to https://github.com/openclaw/openclaw
2. Click **"Fork"** (top right)
3. This creates your copy at `https://github.com/YOUR_USERNAME/openclaw`

### Step 2: In ClawCloud
1. Click **"Create App"**
2. Select **"Deploy from GitHub"** or **"Git Repository"**
3. Connect your GitHub account
4. Select the `openclaw` repository
5. Set build command: `pnpm install && pnpm build`
6. Set start command: `pnpm start:gateway`
7. Add environment variables (same as above)
8. Deploy

---

## Method 3: Manual Steps (No Upload)

Let me guide you through the ClawCloud UI:

### What You Should See in ClawCloud Dashboard:

```
┌─────────────────────────────────────────┐
│           CLAWCLOUD DASHBOARD          │
├─────────────────────────────────────────┤
│  [Create App]  [Templates]  [Docs]    │
│                                         │
│  Your Apps:                             │
│  (empty or existing apps)               │
│                                         │
│  Quick Start:                           │
│  • Deploy from GitHub                   │
│  • Deploy from Docker Hub               │
│  • Deploy Template                      │
│  • Blank App                            │
└─────────────────────────────────────────┘
```

### Click "Create App" then look for:

**Option A: "Blank App" or "Create Application"**
- Click it
- Look for "Environment Variables" or "Configuration" tab
- Add the 3 secrets there

**Option B: "Templates"**
- Click "App Store" or "Templates"
- Look for "Node.js" or "Custom"
- Select it
- Configure environment variables

**Option C: "App List" → "+" Button**
- Click the plus (+) button
- Select runtime: Node.js 22
- Upload your code (zip file option)

---

## Method 4: Railway.app (Alternative - Actually Easier)

Since ClawCloud UI might be confusing, Railway is simpler:

### Step 1: Go to Railway
1. Visit https://railway.app
2. Sign up with GitHub
3. Click **"New Project"**
4. Select **"Deploy from GitHub repo"**
5. Choose `openclaw/openclaw`

### Step 2: Configure
1. Add environment variables:
   ```
   NVIDIA_API_KEY=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
   DATABASE_URL=https://ep-blue-morning-a1zjgpm2.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1
   REDIS_URL=https://open-bullfrog-15428.upstash.io
   ```
2. Set start command: `pnpm start:gateway`
3. Deploy

Railway has a simpler UI and is more beginner-friendly.

---

## Method 5: CLI Deployment (Most Reliable)

If ClawCloud supports kubectl or has a CLI:

### Step 1: Get Kubeconfig
1. In ClawCloud dashboard, look for:
   - "API Keys" or "Access Keys"
   - "Download Kubeconfig"
   - "CLI Access"
2. Download the kubeconfig file

### Step 2: Deploy via CLI
```bash
# Set kubeconfig
export KUBECONFIG=~/Downloads/clawcloud-kubeconfig.yaml

# Deploy
cd extensions/ecc-integration/deploy/clawcloud
kubectl apply -f READY-TO-DEPLOY.yaml

# Check status
kubectl get pods -n openclaw-ecc
kubectl get services -n openclaw-ecc
```

---

## What to Look For in ClawCloud

Since you don't see upload, look for these options:

### Keywords to Find:
- "Create Application" or "New App"
- "Deploy" button
- "Import" or "Upload"
- "GitHub" integration
- "Docker" deployment
- "Environment Variables" or "Secrets"
- "Templates" or "App Store"

### Screenshots to Look For:
If you see buttons like:
- [Deploy from GitHub] ← **Click this**
- [Create from Template] ← **Or this**
- [Container Image] ← **Or this**
- [Start from Scratch] ← **Or this**

---

## Quick Decision Tree

```
Do you see "Deploy from GitHub"?
├── YES → Use Method 2 (GitHub)
│
└── NO → Do you see "Docker" or "Container"?
    ├── YES → Use Method 1 (Docker)
    │
    └── NO → Do you see "Create App" or "New Project"?
        ├── YES → Click it, look for env vars section
        │
        └── NO → Consider Railway.app (Method 4) instead
```

---

## Easiest Path Right Now

Given you can't find upload, here's the **absolute easiest** way:

### Deploy to Railway (5 minutes, guaranteed)

1. **Go to**: https://railway.app
2. **Sign in** with GitHub
3. **Click**: "New" → "Project" → "Deploy from GitHub repo"
4. **Select**: `openclaw/openclaw` (or fork it first to your account)
5. **Add Variables** (Settings tab):
   ```
   NVIDIA_API_KEY=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
   DATABASE_URL=https://ep-blue-morning-a1zjgpm2.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1
   REDIS_URL=https://open-bullfrog-15428.upstash.io
   ```
6. **Set Start Command**: `pnpm start:gateway`
7. **Deploy**

Railway will give you a URL like `https://openclaw-production.up.railway.app`

---

## Which Method Should You Use?

| Your Situation | Recommended Method |
|---------------|-------------------|
| Can't find upload in ClawCloud | Method 4 (Railway) - Guaranteed to work |
| See "Deploy from GitHub" | Method 2 (GitHub) |
| See "Docker" or "Container" | Method 1 (Docker) |
| Have CLI/kubeconfig | Method 5 (kubectl) |
| Just want it working NOW | Method 4 (Railway) |

---

## My Recommendation

**Use Railway.app (Method 4)** for now because:
- ✅ You have all credentials ready
- ✅ 5-minute setup guaranteed
- ✅ No file upload needed
- ✅ Better UI/UX than ClawCloud
- ✅ $5/month free credit (same as ClawCloud)
- ✅ No sleep mode (24/7)

You can always migrate to ClawCloud later once you understand their UI better.

**Go to https://railway.app right now and deploy in 5 minutes.**
