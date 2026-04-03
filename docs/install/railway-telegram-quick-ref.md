# Railway + Telegram Setup - Quick Reference

Quick reference for the detailed [Railway + Telegram Setup Guide](railway-telegram-setup.md).

## 🚀 Quick Start (5 minutes)

1. **Deploy on Railway**: Use OpenClaw template
2. **Create Telegram Bot**: Chat with @BotFather
3. **Set Environment Variables**:
   ```bash
   OPENCLAW_GATEWAY_TOKEN=your-64-char-hex-token
   TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
   ```
4. **Connect Mobile Device**: Use setup code from guide
5. **Run Auto-Approval**: Use provided script for device pairing

## 📋 Essential Information

**Your Railway URL Format:**  
`https://your-project-name-production-xxxxx.up.railway.app`

**Mobile Setup Code Generation:**

```bash
echo -n 'https://your-app-url|your-gateway-token' | base64 -w 0
```

**Auto-Approval Script:** Available in main guide  
**Troubleshooting:** Comprehensive section in main guide

## 🔗 Links

- **Full Guide**: [railway-telegram-setup.md](railway-telegram-setup.md)
- **Railway Docs**: [docs.railway.app](https://docs.railway.app)
- **Telegram Bot API**: [core.telegram.org/bots](https://core.telegram.org/bots)

---

**Created:** April 2026  
**Based on:** Live configuration experience  
**Status:** Production-ready
