# DNA Workflows

This document describes key workflows for developing, maintaining, and using DNA.

---

## Development Workflows

### Syncing Enhancements from Clawdbot Workspace

When you enhance your personal Clawdbot setup and want to bring changes into DNA:

```bash
cd ~/clawd/dna
./scripts/sync-from-workspace.sh
git add -A
git commit -m "Sync: [description of changes]"
git push
```

**What gets synced:**
- Skills (with clawdbot→dna renaming)
- IDE updates
- Knowledge system structure
- Templates

**What stays private:**
- Memory files (personal logs)
- Profile data
- Credentials

### Adding a New Skill

1. Create skill folder:
```bash
mkdir -p skills/my-skill
```

2. Create SKILL.md:
```bash
cat > skills/my-skill/SKILL.md << 'EOF'
# My Skill

Description of what this skill does.

## When to Use
- Trigger phrase 1
- Trigger phrase 2

## Commands
\`\`\`bash
command-to-run
\`\`\`

## Examples
User: "Help with X"
Action: Do Y
EOF
```

3. Test and commit:
```bash
git add skills/my-skill
git commit -m "Add my-skill: [description]"
git push
```

### Updating from Upstream (Moltbot)

To pull new features from the original Moltbot project:

```bash
cd ~/clawd/dna

# Add upstream remote (one time)
git remote add upstream https://github.com/moltbot/moltbot.git

# Fetch upstream changes
git fetch upstream

# Merge (careful - may need conflict resolution)
git merge upstream/main

# Re-apply DNA branding
find . -type f \( -name "*.json" -o -name "*.js" -o -name "*.md" \) \
  -not -path "./.git/*" -not -path "./node_modules/*" \
  -exec sed -i '' -e 's/moltbot/dna/g' -e 's/Moltbot/DNA/g' {} +

git add -A
git commit -m "Merge upstream moltbot changes + reapply DNA branding"
git push
```

---

## Release Workflow

### Preparing a Release

1. **Update version:**
```bash
npm version patch  # or minor/major
```

2. **Update CHANGELOG.md** with new features

3. **Build and test:**
```bash
npm run build
./dna.mjs status
```

4. **Tag and push:**
```bash
git tag v1.0.1
git push origin main --tags
```

### Publishing to npm (Optional)

```bash
npm login
npm publish --access public
```

---

## Branding Workflow

### Logo Generation

1. **Generate concepts** with Logo Diffusion:
   - Use prompts from `branding/BRAND-GUIDE.md`
   - Generate 20+ variations
   - Select top 3

2. **Refine with Midjourney** (optional):
   - Upload selected concepts
   - Generate variations with `--v 6`

3. **Vectorize:**
   - Use vectorizer.ai or manual trace in Figma
   - Export SVG for web, PNG for social

4. **Create variations:**
   - Full color on white
   - White on dark
   - Monochrome black
   - Square icon (app icon)
   - Favicon (16x16, 32x32)

### Video Production

1. **Record screen demos:**
   - Screen Studio (Mac) or OBS
   - WhatsApp demo on phone
   - IDE demo on desktop

2. **Generate voiceover:**
   - Copy script from `branding/VIDEO-SCRIPT.md`
   - Use ElevenLabs with settings from script
   - Export as WAV

3. **Edit in Descript or Final Cut:**
   - Sync VO to screen recordings
   - Add transitions and music
   - Export 4K master + 1080p web

4. **Upload:**
   - YouTube (unlisted or public)
   - Embed on landing page

### Landing Page Deployment

1. **Fork AstroWind:**
```bash
git clone https://github.com/onwidget/astrowind landing-page
cd landing-page
npm install
```

2. **Apply DNA branding:**
   - Update colors in `tailwind.config.js`
   - Replace logo assets
   - Update content per `branding/LANDING-PAGE.md`

3. **Deploy to Cloudflare:**
```bash
# Connect GitHub repo to Cloudflare Pages
# Configure build: npm run build, output: dist
```

4. **Configure DNS:**
   - Add CNAME record: `dna` → `<project>.pages.dev`

---

## User Workflows

### Daily Usage

1. **Start DNA:**
```bash
./dna.mjs gateway start
```

2. **Chat via WhatsApp/Telegram**

3. **Use IDE:**
```bash
cd extensions/ide
npm start
# Open http://localhost:3333
```

### Memory Management

1. **View today's notes:**
```bash
cat ~/dna-workspace/memory/$(date +%Y-%m-%d).md
```

2. **Search memory:**
```
"Search my memory for project X"
```

3. **Add to long-term memory:**
```
"Remember that I prefer dark themes"
```

### Skill Discovery

```
"What skills do you have?"
"Help me with GitHub"
"Check my calendar"
```

---

## Maintenance Workflows

### Backup

```bash
# Backup workspace
tar -czvf dna-backup-$(date +%Y%m%d).tar.gz \
  ~/.dna \
  ~/dna-workspace

# Backup to cloud (optional)
aws s3 cp dna-backup-*.tar.gz s3://your-bucket/backups/
```

### Updating DNA

```bash
cd ~/clawd/dna
git pull
npm install
npm run build
./dna.mjs gateway restart
```

### Health Check

```bash
./dna.mjs status
./dna.mjs gateway logs --tail 20
```

---

## Troubleshooting Workflow

### Debug Mode

```bash
# Run with verbose logging
DEBUG=* ./dna.mjs gateway run
```

### Reset Session

```bash
# WhatsApp
rm -rf ~/.dna/whatsapp-session
./dna.mjs wizard

# Full reset
rm -rf ~/.dna
./dna.mjs wizard
```

### Check API Status

```bash
# Test Anthropic
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-sonnet-20240229","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
```
