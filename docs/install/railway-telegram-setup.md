# OpenClaw Installation Guide: Railway + Telegram Setup

This comprehensive guide walks you through deploying OpenClaw on Railway with Telegram integration, including mobile device pairing and troubleshooting.

## 📋 Prerequisites

- **Railway account** (free tier available)
- **Telegram account**
- **Mobile device** (Android/iOS) with OpenClaw app
- **Basic terminal/command line knowledge**

## 🚀 Step 1: Railway Deployment

### 1.1 Deploy OpenClaw Template

1. **Go to Railway**: Visit [railway.app](https://railway.app)
2. **Login/Signup**: Create account or login
3. **Deploy Template**:
   - Click "Deploy Now" on OpenClaw template
   - Or use: `https://railway.app/template/openclaw`
4. **Configure Project**:
   - Choose project name (e.g., `my-openclaw-bot`)
   - Select region closest to you
   - Click "Deploy"

### 1.2 Get Railway CLI (Optional but Recommended)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Link to your project
railway link
```

## 🤖 Step 2: Telegram Bot Setup

### 2.1 Create Telegram Bot

1. **Open Telegram** and search for `@BotFather`
2. **Start conversation** with BotFather
3. **Create bot**: Send `/newbot`
4. **Choose bot name**: e.g., "My OpenClaw Assistant"
5. **Choose username**: e.g., "myopenclaw_bot" (must end with 'bot')
6. **Save the token**: You'll get something like `1234567890:ABCdefGHIjklMNOpqrSTUvwxyz`

### 2.2 Configure Bot Permissions

Send these commands to @BotFather:

```
/setprivacy
# Select your bot
# Choose "Disable" to allow bot to read all messages

/setcommands
# Select your bot
# Add these commands:
help - Show available commands
status - Check bot status
start - Initialize conversation
```

## ⚙️ Step 3: Environment Configuration

### 3.1 Required Environment Variables

In your Railway dashboard, go to your project → Variables tab and add:

```bash
# Core OpenClaw Configuration
OPENCLAW_GATEWAY_TOKEN=your-secure-token-here
OPENCLAW_GATEWAY_MODE=local

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=1234567890:your-bot-token-from-botfather

# Optional: Custom Configuration
OPENCLAW_LOG_LEVEL=info
OPENCLAW_DEVICE_AUTO_APPROVE=false
```

### 3.2 Generate Gateway Token

**Option 1 - Use Railway CLI:**

```bash
railway run node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Option 2 - Generate locally:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Option 3 - Online generator:**

- Visit any secure random string generator
- Generate 64-character hex string

### 3.3 Set Environment Variables

**Via Railway Dashboard:**

1. Go to your project → Variables
2. Click "New Variable"
3. Add each variable name and value

**Via Railway CLI:**

```bash
railway variables set OPENCLAW_GATEWAY_TOKEN=your-token-here
railway variables set TELEGRAM_BOT_TOKEN=your-bot-token-here
```

## 📱 Step 4: Mobile Device Connection

### 4.1 Get Connection Information

Your Railway app URL format:

```
https://your-project-name-production-xxxxx.up.railway.app
```

**Find your URL:**

- Railway Dashboard → Your Project → Deployments → Domain
- Or via CLI: `railway status`

### 4.2 Mobile App Setup

**For Android OpenClaw App:**

**Method 1 - Setup Code:**

```bash
# Generate setup code (run in terminal with your details)
echo -n 'https://your-app-url|your-gateway-token' | base64 -w 0
```

**Method 2 - Manual Configuration:**

- Gateway URL: `your-app-url` (without https://)
- Token: `your-gateway-token`

**Method 3 - QR Code URL:**

```
https://your-app-url?mobile-code=<base64-encoded-token>
```

### 4.3 Device Pairing Process

1. **Open OpenClaw mobile app**
2. **Navigate to connection settings** (Connect/Setup tab)
3. **Enter configuration**:
   - Paste setup code, OR
   - Enter URL and token manually
4. **Connect**: App will show "Pairing Required"
5. **Approve device** (see Step 5)

## 🔐 Step 5: Device Approval

### 5.1 Automatic Approval Script

Create this script to auto-approve devices:

```javascript
// auto-approve.js
const WebSocket = require("ws");

const TOKEN = "your-gateway-token";
const GATEWAY = "wss://your-app-url";

console.log("🚀 OpenClaw Auto-Approval Service Starting...");

function createConnection() {
  const ws = new WebSocket(GATEWAY);
  let authenticated = false;
  let checkInterval;

  ws.on("open", () => {
    console.log("✅ Connected to OpenClaw Gateway");
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // Handle authentication
    if (msg.type === "event" && msg.event === "connect.challenge") {
      ws.send(
        JSON.stringify({
          id: "auth-" + Date.now(),
          method: "auth.token",
          params: { token: TOKEN, nonce: msg.payload.nonce },
        }),
      );
    }

    // Start monitoring after auth
    else if (msg.result !== undefined && !authenticated) {
      authenticated = true;
      console.log("🎯 Authenticated! Monitoring for devices...");

      checkInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              id: "list-" + Date.now(),
              method: "device.list",
              params: {},
            }),
          );
        }
      }, 3000);
    }

    // Auto-approve pending devices
    else if (msg.result && msg.result.pending && msg.result.pending.length > 0) {
      console.log("📱 Device found! Auto-approving...");
      msg.result.pending.forEach((device) => {
        ws.send(
          JSON.stringify({
            id: "approve-" + Date.now(),
            method: "device.approve",
            params: { requestId: device.requestId },
          }),
        );
      });
    }

    // Confirm approval
    else if (msg.result !== undefined && msg.id && msg.id.startsWith("approve-")) {
      console.log("🎉 Device approved successfully!");
    }
  });

  ws.on("close", () => {
    console.log("Connection closed, reconnecting...");
    if (checkInterval) clearInterval(checkInterval);
    setTimeout(createConnection, 5000);
  });
}

createConnection();
```

### 5.2 Run Approval Script

```bash
# Install WebSocket dependency
npm install ws

# Run the script
node auto-approve.js
```

### 5.3 Manual Approval (Alternative)

**Via Railway CLI:**

```bash
railway connect
# Then use OpenClaw admin commands to approve devices
```

**Via Web Interface:**

- Access your Railway app URL directly
- Login with gateway token
- Go to device management
- Approve pending devices

## 🧪 Step 6: Testing Your Setup

### 6.1 Test Telegram Bot

```bash
# Send test message to your bot
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H 'Content-Type: application/json' \
  -d '{"chat_id": "your-chat-id", "text": "Test message from OpenClaw!"}'
```

### 6.2 Test Mobile Connection

1. **Open OpenClaw mobile app**
2. **Send test message** to your Telegram bot
3. **Verify message appears** in mobile app
4. **Reply from mobile** and check Telegram

### 6.3 Test Commands

Try these in Telegram:

```
/start
/help
/status
@your_bot_username Hello from Telegram!
```

## 🐛 Troubleshooting

### Common Issues & Solutions

#### ❌ "Pairing Required" Error

**Problem:** Mobile app shows pairing required
**Solutions:**

1. Run auto-approval script
2. Check gateway token matches
3. Verify Railway app is running
4. Check device approval in logs

#### ❌ Telegram Bot Not Responding

**Problem:** Bot doesn't reply to messages
**Solutions:**

1. Verify `TELEGRAM_BOT_TOKEN` is correct
2. Check Railway app logs: `railway logs`
3. Ensure bot privacy is disabled
4. Test bot token with Telegram API

#### ❌ Mobile App Connection Failed

**Problem:** Cannot connect mobile app
**Solutions:**

1. Verify Railway app URL is accessible
2. Check gateway token format (64 hex chars)
3. Try different connection methods (manual vs. setup code)
4. Check Railway app is deployed and running

#### ❌ Railway Deployment Failed

**Problem:** Deployment fails or crashes
**Solutions:**

1. Check Railway logs for errors
2. Verify environment variables are set
3. Ensure proper resource limits
4. Redeploy with correct configuration

### Debug Commands

```bash
# Check Railway status
railway status

# View live logs
railway logs

# Check environment variables
railway variables

# Connect to Railway service
railway connect

# Test connectivity
curl -I https://your-app-url
```

## 📊 Monitoring & Maintenance

### 6.1 Check Health Status

**Via Railway Dashboard:**

- Monitor CPU/Memory usage
- Check deployment status
- Review error logs

**Via CLI:**

```bash
# Service status
railway status

# Resource usage
railway logs --tail

# Environment check
railway variables
```

### 6.2 Update Configuration

**Add new environment variables:**

```bash
railway variables set NEW_VARIABLE=value
```

**Update existing variables:**

```bash
railway variables set TELEGRAM_BOT_TOKEN=new-token
```

### 6.3 Scaling & Limits

**Free Tier Limits:**

- 500 hours/month runtime
- 1GB RAM
- 1GB storage
- No custom domain

**Upgrade for:**

- More resources
- Custom domains
- Priority support
- Advanced monitoring

## 🔒 Security Best Practices

### 7.1 Token Security

- **Never commit tokens** to version control
- **Use Railway environment variables** only
- **Rotate tokens** regularly
- **Monitor access logs**

### 7.2 Bot Security

- **Enable bot privacy** when appropriate
- **Use webhooks** instead of polling for production
- **Implement rate limiting**
- **Validate all inputs**

### 7.3 Network Security

- **Use HTTPS** for all connections
- **Validate SSL certificates**
- **Monitor for suspicious activity**
- **Keep dependencies updated**

## 📚 Additional Resources

- **OpenClaw Documentation**: [docs.openclaw.ai](https://docs.openclaw.ai)
- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Telegram Bot API**: [core.telegram.org/bots](https://core.telegram.org/bots)
- **GitHub Repository**: [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

## 🆘 Getting Help

**If you encounter issues:**

1. **Check logs first**: `railway logs`
2. **Review this guide** step by step
3. **Search existing issues**: GitHub Issues
4. **Ask in community**: Discord/Telegram groups
5. **Create new issue**: Provide logs and configuration details

---

**⚡ Quick Start Summary:**

1. Deploy Railway template
2. Create Telegram bot with @BotFather
3. Set environment variables in Railway
4. Connect mobile app with generated setup code
5. Run auto-approval script for device pairing
6. Test end-to-end functionality

**🎉 You're now ready to use OpenClaw with Railway and Telegram!**
