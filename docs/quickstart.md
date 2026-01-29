# Quick Start Guide

Get DNA running in 5 minutes.

## 1. Clone & Install (2 min)

```bash
git clone https://github.com/vanek-nutic/dna.git
cd dna
npm install
npm run build
```

## 2. Get an API Key (1 min)

Choose one:
- **Anthropic:** https://console.anthropic.com/ → API Keys → Create
- **OpenAI:** https://platform.openai.com/api-keys → Create
- **OpenRouter:** https://openrouter.ai/keys → Create (access to all models)

## 3. Run Setup (1 min)

```bash
./dna.mjs wizard
```

- Select your provider
- Paste your API key
- Connect WhatsApp (scan QR) or skip for now

## 4. Start DNA (30 sec)

```bash
./dna.mjs gateway start
```

## 5. Test It

If you connected WhatsApp, send yourself a message:
```
Hello! What can you do?
```

Or use the CLI:
```bash
./dna.mjs chat "What can you do?"
```

---

## Next Steps

- **Set up your workspace:** Edit `~/dna-workspace/USER.md` with your info
- **Customize personality:** Edit `~/dna-workspace/SOUL.md`
- **Try the IDE:** `cd extensions/ide && npm install && npm start`
- **Explore skills:** `ls skills/`

---

## Quick Commands

```bash
# Status
./dna.mjs status

# Logs
./dna.mjs gateway logs

# Stop
./dna.mjs gateway stop

# Restart
./dna.mjs gateway restart
```

---

## Need Help?

- Check [Troubleshooting](troubleshooting.md)
- Read [Configuration](configuration.md)
- Explore [Skills](skills.md)
