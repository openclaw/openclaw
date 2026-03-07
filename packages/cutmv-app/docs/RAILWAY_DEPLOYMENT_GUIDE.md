# Railway Deployment Guide - CUTMV

**Last Updated:** December 6, 2025
**Platform:** Railway.app
**Repository:** https://github.com/corey-beep/cutmv

---

## 🚀 Quick Deploy (15 minutes)

### **Prerequisites:**
- GitHub account (already done ✅ - your repo is at `corey-beep/cutmv`)
- Railway account (create at https://railway.app)
- Your environment variables ready (see below)

---

## Step 1: Create Railway Account & Project

1. Go to https://railway.app
2. Click "Login" → Sign in with GitHub
3. Authorize Railway to access your GitHub account
4. Click "New Project"
5. Select "Deploy from GitHub repo"
6. Choose `corey-beep/cutmv` from your repositories
7. Railway will detect it as a Node.js app

---

## Step 2: Configure Environment Variables

In the Railway dashboard, go to **Variables** tab and add these:

### **Required - Database:**
```bash
# Neon PostgreSQL (or your PostgreSQL provider)
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
```

### **Required - Stripe:**
```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### **Required - Cloudflare R2:**
```bash
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ENDPOINT=https://[account_id].r2.cloudflarestorage.com
R2_BUCKET_NAME=cutmv
R2_ACCOUNT_ID=...
```

### **Required - Email (Resend):**
```bash
RESEND_API_KEY=re_...
```

### **Required - Application:**
```bash
NODE_ENV=production
BASE_URL=https://your-app.up.railway.app
CUSTOM_DOMAIN=cutmv.fulldigitalll.com
SESSION_SECRET=your-long-random-string-here
```

### **Optional - Analytics:**
```bash
# PostHog
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://us.i.posthog.com

# Sentry
SENTRY_DSN=https://...@sentry.io/...
SENTRY_AUTH_TOKEN=...

# Kickbox Email Validation
KICKBOX_API_KEY=...
```

### **Optional - AI Features:**
```bash
OPENAI_API_KEY=sk-...
```

### **Optional - Additional Services:**
```bash
# Cloudflare (if using Workers)
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_QUEUE_NAME=...

# Google Cloud (if used)
GOOGLE_APPLICATION_CREDENTIALS=...
```

---

## Step 3: Deploy

1. Railway will automatically start building after you add environment variables
2. Watch the **Deployments** tab for build progress
3. Build takes ~3-5 minutes
4. Once deployed, you'll get a URL like: `https://your-app.up.railway.app`

---

## Step 4: Add Custom Domain

### **Option A: Use Railway's Domain**
- Your app is already live at `https://your-app.up.railway.app`
- You can use this for testing

### **Option B: Add Your Custom Domain (`cutmv.fulldigitalll.com`)**

1. In Railway dashboard, go to **Settings** → **Domains**
2. Click "Add Custom Domain"
3. Enter `cutmv.fulldigitalll.com`
4. Railway will show you DNS records to add

5. **In your domain registrar (Cloudflare, GoDaddy, etc.):**
   - Add CNAME record: `cutmv` → `your-app.up.railway.app`
   - Or A record pointing to Railway's IP

6. Wait 5-10 minutes for DNS propagation
7. Railway will automatically provision SSL certificate

---

## Step 5: Configure Stripe Webhook

Your Stripe webhooks need to point to your Railway deployment:

1. Go to https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. URL: `https://cutmv.fulldigitalll.com/api/stripe/webhook`
   (or `https://your-app.up.railway.app/api/stripe/webhook` if using Railway domain)
4. Select events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
   - `invoice.payment_succeeded`
5. Copy the webhook signing secret
6. Add it to Railway environment variables as `STRIPE_WEBHOOK_SECRET`

---

## Step 6: Database Migration

Run database migrations to set up tables:

### **Option A: Using Railway CLI** (Recommended)
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run migrations
railway run npm run db:push
```

### **Option B: Using Drizzle Studio**
```bash
# In your local environment with DATABASE_URL from Railway
npm run db:push
```

---

## Step 7: Test Your Deployment

1. Visit your app: `https://cutmv.fulldigitalll.com`
2. Test key features:
   - ✅ Homepage loads
   - ✅ User signup/login (magic link email)
   - ✅ Video upload (test with small video)
   - ✅ Video processing
   - ✅ Stripe payment
   - ✅ Download processed files
   - ✅ Referral system

---

## 🔧 Configuration Files

Railway uses these files (already in your repo):

### `railway.json`
```json
{
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "startCommand": "npm run start",
    "healthcheckPath": "/",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

### `nixpacks.toml`
```toml
[phases.setup]
nixPkgs = ["nodejs_20", "ffmpeg-full"]  # ← Installs FFmpeg!

[phases.install]
cmds = ["npm ci"]

[phases.build]
cmds = ["npm run build"]

[start]
cmd = "npm run start"
```

This ensures FFmpeg is installed in your Railway environment.

---

## 📊 Monitoring & Logs

### **View Logs:**
1. Railway Dashboard → **Deployments** tab
2. Click on active deployment
3. View real-time logs

### **Monitor Resources:**
1. **Metrics** tab shows:
   - CPU usage
   - Memory usage
   - Network traffic
2. Set up alerts if usage spikes

### **Cost Monitoring:**
1. **Usage** tab shows current month's usage
2. Estimated cost based on resources consumed
3. Hobby plan: $5/month minimum, pay for overages

---

## 🛠️ Troubleshooting

### **Build Fails:**
```bash
# Check logs in Railway dashboard
# Common issues:
# 1. Missing environment variables
# 2. Node version mismatch
# 3. Build timeout (increase in settings)
```

### **FFmpeg Not Found:**
```bash
# Verify nixpacks.toml includes:
nixPkgs = ["nodejs_20", "ffmpeg-full"]

# If still failing, add to Procfile:
web: bash -c "which ffmpeg && npm run start"
```

### **Database Connection Fails:**
```bash
# Verify DATABASE_URL format:
postgresql://user:pass@host:5432/dbname?sslmode=require

# For Neon, ensure sslmode=require is included
```

### **WebSocket Issues:**
```bash
# Railway supports WebSockets out of the box
# No special configuration needed
# Just ensure your domain is using HTTPS
```

### **File Upload Issues:**
```bash
# Check /tmp directory has space
# Railway provides 512MB /tmp
# Large videos (>500MB) should go direct to R2
```

---

## 🔄 Updating Your Deployment

Railway auto-deploys on every push to `main` branch:

```bash
# Make changes locally
git add .
git commit -m "Your changes"
git push origin main

# Railway automatically:
# 1. Detects push to main
# 2. Builds new version
# 3. Deploys with zero downtime
# 4. Rolls back if health check fails
```

### **Manual Redeploy:**
1. Railway Dashboard → **Deployments**
2. Click three dots on deployment
3. Select "Redeploy"

---

## 💰 Cost Estimation

### **Hobby Plan ($5/month minimum):**

**Light Usage (50-100 videos/month):**
- Base: $5/month
- Likely stays at minimum
- **Total: $5/month**

**Medium Usage (500 videos/month):**
- Processing: ~$3-5
- Base: $5
- **Total: $8-10/month**

**Heavy Usage (2000+ videos/month):**
- Processing: $15-25
- Base: $5
- **Total: $20-30/month**

**If you exceed ~$10/month consistently, consider Pro plan ($20/month) for better rates**

---

## 🎯 Post-Deployment Checklist

- [ ] App is accessible at custom domain
- [ ] SSL certificate is active (HTTPS)
- [ ] Database migrations completed
- [ ] Stripe webhook configured and working
- [ ] Test video upload and processing
- [ ] Test magic link authentication
- [ ] Test referral system
- [ ] Test credit redemption
- [ ] Monitor logs for errors
- [ ] Set up uptime monitoring (UptimeRobot, Pingdom)
- [ ] Configure backup strategy for database

---

## 🚨 Important Notes

### **Environment-Specific:**
1. Update `CUSTOM_DOMAIN` in Railway env vars
2. Update `BASE_URL` to your Railway URL
3. Ensure `NODE_ENV=production`

### **Security:**
1. Never commit `.env` file
2. Rotate `SESSION_SECRET` in production
3. Use strong Stripe webhook secrets
4. Enable Stripe live mode keys

### **Performance:**
1. Railway auto-scales based on load
2. Cold starts may take 1-2 seconds
3. Keep memory usage under 2GB for Hobby plan
4. Monitor /tmp usage for large files

---

## 📚 Additional Resources

- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- Nixpacks Docs: https://nixpacks.com
- FFmpeg in Railway: https://nixhub.io/packages/ffmpeg

---

## 🎉 You're Done!

Your CUTMV application is now live on Railway with:
- ✅ FFmpeg video processing
- ✅ WebSocket real-time progress
- ✅ 10GB+ file uploads
- ✅ Long-running background jobs
- ✅ Auto-scaling infrastructure
- ✅ Zero-downtime deployments
- ✅ SSL/HTTPS enabled
- ✅ Custom domain configured

**App URL:** https://cutmv.fulldigitalll.com
**Dashboard:** https://railway.app/dashboard

---

*Deployment guide for CUTMV v3.5 - December 2025*
