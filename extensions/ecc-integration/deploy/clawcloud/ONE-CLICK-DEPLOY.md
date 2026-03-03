# 🚀 ONE-CLICK DEPLOYMENT GUIDE

## Your System is Ready!

I've prepared everything with your credentials. You just need to upload ONE file to ClawCloud.

---

## ⚡ Deploy in 2 Steps

### Step 1: Go to ClawCloud Run
1. Visit: https://run.claw.cloud
2. Sign in to your account
3. Click **"Create App"** (big button in dashboard)

### Step 2: Upload & Deploy
1. Select **"Kubernetes YAML"** or **"Upload Template"**
2. Upload this file: `READY-TO-DEPLOY.yaml`
3. Click **"Deploy"**
4. Wait 3-5 minutes
5. **Done!** 🎉

---

## ✅ What's Included

Your deployment includes:
- ✅ NVIDIA NIM integration (11 free models)
- ✅ Your API key configured
- ✅ Neon database connected
- ✅ Upstash Redis connected
- ✅ 3 pods: Gateway + API + Worker
- ✅ Auto SSL/HTTPS
- ✅ Health checks

---

## 🔗 Your App URL

After deployment, access at:
```
https://openclaw-ecc.run.claw.cloud
```

Or check the dashboard for the exact URL.

---

## 🧪 Test Your Deployment

Run these commands to verify:

```bash
# 1. Health check
curl https://openclaw-ecc.run.claw.cloud/health

# 2. List available AI models
curl https://openclaw-ecc.run.claw.cloud/api/models

# 3. Generate text (auto-routes to best model)
curl -X POST https://openclaw-ecc.run.claw.cloud/api/generate \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello, what model are you?"}]}'
```

---

## 📁 Files in This Directory

- `READY-TO-DEPLOY.yaml` - **UPLOAD THIS FILE** ⬅️
- `deploy-to-clawcloud.sh` - Alternative deployment script
- `README.md` - Full documentation
- `ONE-CLICK-DEPLOY.md` - This file

---

## ⚠️ Security Note

**IMPORTANT**: After successful deployment, delete this file to protect your credentials:

```bash
rm READY-TO-DEPLOY.yaml
```

Your credentials are safely stored in Kubernetes Secrets within ClawCloud.

---

## 🆘 Need Help?

**Deployment Issues:**
- ClawCloud Support: support@run.claw.cloud
- Check logs in ClawCloud dashboard

**OpenClaw Issues:**
- GitHub: https://github.com/openclaw/openclaw/issues

**Emergency:** If deployment fails, you can also try:
1. Railway.app (backup option)
2. Fly.io (backup option)

See `../docs/HOSTING_STRATEGY.md` for alternatives.

---

## 🎉 You're All Set!

Just upload `READY-TO-DEPLOY.yaml` to ClawCloud and your OpenClaw + ECC system will be live in 5 minutes!
