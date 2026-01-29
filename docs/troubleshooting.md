# Troubleshooting Guide

Solutions to common DNA issues.

## Installation Issues

### "npm install" fails

**Error:** Permission denied or EACCES
```bash
# Fix npm permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

**Error:** Python/node-gyp errors
```bash
# macOS: Install Xcode tools
xcode-select --install

# Ubuntu: Install build tools
sudo apt-get install build-essential python3
```

### "command not found: node"

Install Node.js:
```bash
# macOS
brew install node@20

# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Connection Issues

### WhatsApp won't connect

**Symptom:** QR code appears but never completes

1. **Check phone internet:** Make sure your phone is online
2. **Try fresh session:**
   ```bash
   rm -rf ~/.dna/whatsapp-session
   ./dna.mjs wizard
   ```
3. **Use phone's camera:** Don't screenshot the QR

**Symptom:** Disconnects frequently

- WhatsApp Web has session limits
- Only one "web" session per phone
- Log out of other WhatsApp Web sessions

### Telegram bot not responding

1. **Verify token:** Check token in config matches BotFather
2. **Check bot privacy:** Message /setprivacy to @BotFather, set to "Disable"
3. **Restart gateway:**
   ```bash
   ./dna.mjs gateway restart
   ```

### Discord bot offline

1. **Check token:** Ensure token hasn't been regenerated
2. **Verify intents:** Enable "Message Content Intent" in Discord Developer Portal
3. **Check permissions:** Bot needs "Send Messages" permission

---

## AI Issues

### "API key invalid"

1. **Check key format:**
   - Anthropic: starts with `sk-ant-`
   - OpenAI: starts with `sk-`
2. **Re-add key:**
   ```bash
   ./dna.mjs auth add anthropic
   ```
3. **Check credits:** Verify account has API credits

### "Rate limit exceeded"

- You've hit API limits
- Wait a few minutes
- Consider upgrading API tier
- Use fallback models:
  ```json
  {
    "model": {
      "primary": "anthropic/claude-sonnet-4",
      "fallbacks": ["openai/gpt-4o"]
    }
  }
  ```

### "Context length exceeded"

- Conversation too long
- Use `/compact` command to summarize
- Start fresh session with `/new`

### Responses are slow

1. **Check model:** Larger models (Opus, GPT-4) are slower
2. **Check internet:** Slow connection affects streaming
3. **Try faster model:**
   ```bash
   ./dna.mjs config set agents.defaults.model.primary anthropic/claude-haiku-3
   ```

---

## Gateway Issues

### "Port already in use"

```bash
# Find what's using the port
lsof -i :18790

# Kill it
kill -9 <PID>

# Or use different port
./dna.mjs gateway run --port 18791
```

### Gateway won't start

1. **Check logs:**
   ```bash
   ./dna.mjs gateway logs
   ```

2. **Validate config:**
   ```bash
   ./dna.mjs config validate
   ```

3. **Reset config:**
   ```bash
   mv ~/.dna/dna.json ~/.dna/dna.json.backup
   ./dna.mjs wizard
   ```

### Gateway crashes

1. **Check memory:** Ensure system has free RAM
2. **Check logs for errors:**
   ```bash
   ./dna.mjs gateway logs --tail 100
   ```
3. **Update DNA:**
   ```bash
   git pull && npm install && npm run build
   ```

---

## Workspace Issues

### Memory files not loading

1. **Check path:** Verify workspace path in config
2. **Check permissions:**
   ```bash
   ls -la ~/dna-workspace/
   chmod 755 ~/dna-workspace
   ```

### Skills not found

1. **Check location:** Skills should be in:
   - `~/dna-workspace/skills/` (custom)
   - DNA's `skills/` folder (built-in)

2. **Check SKILL.md exists:**
   ```bash
   ls ~/dna-workspace/skills/my-skill/SKILL.md
   ```

---

## IDE Issues

### IDE won't start

```bash
cd extensions/ide

# Clear and reinstall
rm -rf node_modules
npm install

# Check port
lsof -i :3333

# Start with different port
PORT=3334 npm start
```

### IDE can't connect to gateway

1. Ensure gateway is running:
   ```bash
   ./dna.mjs status
   ```

2. Check gateway port in IDE config matches

### Monaco editor not loading

- Clear browser cache
- Try incognito/private window
- Check browser console for errors

---

## Getting Help

### Collect Debug Info

```bash
./dna.mjs status
./dna.mjs gateway logs --tail 50
node --version
npm --version
uname -a
```

### Common Log Locations

- Gateway logs: `./dna.mjs gateway logs`
- WhatsApp session: `~/.dna/whatsapp-session/`
- Config file: `~/.dna/dna.json`

### Reset Everything

Nuclear option — start fresh:

```bash
# Stop gateway
./dna.mjs gateway stop

# Backup config
cp ~/.dna/dna.json ~/.dna/dna.json.backup

# Remove all state
rm -rf ~/.dna

# Re-run setup
./dna.mjs wizard
```

---

## Still Stuck?

1. Check existing issues on GitHub
2. Open a new issue with:
   - What you're trying to do
   - What error you see
   - Output of `./dna.mjs status`
   - Relevant logs
