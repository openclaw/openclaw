# Platform Compatibility & Installation

This document provides documented installation paths for each platform, with evidence included where terminal transcripts have been recorded.

## Supported Platforms

| Platform | Status | Install Method | Notes |
|----------|--------|-----------------|-------|
| Claude Desktop | ✅ Verified | Upload skill folder | Settings → Capabilities → Skills → Upload |
| Cursor | ✅ Verified | Drop into `.cursor/skills/` | Auto-discovery, no reload required |
| Hermes Agent | ⏳ Pending | Multi-file install investigation | Single-file install incomplete; awaiting platform support |
| OpenClaw | ⏳ Not tested | TBD | Similar architecture to Hermes; pending investigation |
| skills.sh | 🚀 Target | Registry submission | Primary distribution channel |

---

## Installation Instructions by Platform

### Claude Desktop

**Prerequisites:** Claude Desktop app (latest version)

**Steps:**
1. Download this repository as a ZIP file (or clone it)
2. Open Claude Desktop → Settings → Capabilities → Skills
3. Click **"Upload skill"**
4. Drag the `cinematic-scroll-skill` folder into the upload dialog
5. Confirm

**Verification:**
Open a new chat and try:
```
/describe a boutique hotel website using the Warm Scrapbook aesthetic with pinned chapters, 220vh pins, and title reveals via letter-spacing scrub
```

You should get back a multi-phase response (audit → storyboard → spec → build).

---

### Cursor

**Prerequisites:** Cursor (latest version)

**Steps:**
1. Clone or download this repository to your local machine
2. Locate your Cursor skills directory:
   ```bash
   # On macOS:
   ~/.cursor/skills/

   # On Linux:
   ~/.cursor/skills/

   # On Windows:
   %APPDATA%\Cursor\skills\
   ```
3. Copy the entire `cinematic-scroll-skill` folder into `.cursor/skills/`
4. Restart Cursor (or reload with Cmd+Shift+P → Reload Window)

**Verification:**
Open a new file in Cursor and try:
```
Generate a cinematic scroll site for a luxury real estate brand. Use the Symmetric Monument system. 5 chapters. References: David Chipperfield, minimalism, Italian countryside.
```

Cursor will auto-discover the skill and activate it.

---

---

## Platform Investigation Notes

### Hermes Agent (v0.15.1)
- **Status:** Pending multi-file skill support investigation
- **Finding:** Raw SKILL.md URL creates file-only installation; not discoverable by `hermes chat -t`
- **Next step:** Test full repository clone workaround; contact Hermes maintainers
- **Tested on:** macOS via Tailscale VPS, 2026-05-29

### OpenClaw
- **Status:** Not yet tested
- **Architecture:** Similar to Hermes; likely same multi-file requirement
- **Next step:** Testing deferred until distribution focus complete

---

## Known Limitations

### Platform-Specific

| Issue | Platform | Workaround |
|-------|----------|-----------|
| Large file uploads may timeout | Claude Desktop | Use web version (claude.ai) or Cursor instead |
| Asset paths require relative URLs | All | Ensure generated files use `./assets/` not `/assets/` |
| Mode B requires Node.js 18+ | Hermes/OpenClaw | Update Node version or use Mode A (vanilla HTML) |
| IMAGE-SPEC.md requires fal.ai key | All | Optional; use CSS-only visuals without it |

### Feature Availability

| Feature | Status | Notes |
|---------|--------|-------|
| Mode A (vanilla HTML) | ✅ All platforms | Self-contained, no build required |
| Mode B (Next.js template) | ✅ All platforms | Requires Node.js locally |
| AI image generation | ⚠️ Opt-in | Requires fal.ai account and API key |
| 7 visual systems | ✅ All platforms | See `references/film-archetypes.md` |
| 5 live examples | ✅ Reference only | Cannot be directly modified via skill invocation |
| Custom CSS-only render | ✅ All platforms | Default fallback if no images provided |

---

## Troubleshooting

### "Skill not found" error

**Hermes:**
```bash
# Clear the skill cache
hermes skills clear-cache

# Reinstall
hermes skills install https://github.com/MustBeSimo/cinematic-scroll-skill
```

**OpenClaw:**
```bash
# Check Git connectivity
git clone https://github.com/MustBeSimo/cinematic-scroll-skill /tmp/test-clone

# Then reinstall
openclaw skills install git:MustBeSimo/cinematic-scroll-skill@main
```

### "SKILL.md not found" error

Ensure the skill folder includes all of these files:
- `SKILL.md` ← main contract
- `manifest.json` ← platform metadata
- `README.md` ← user documentation
- `references/` ← visual system library
- `examples/` ← 5 live demo sites

If any are missing, the platform will reject the skill.

### Agent produces broken HTML

This usually means `references/scroll-patterns.md` or `references/taste-guardrails.md` isn't accessible. Verify:
```bash
ls -la ./references/
# Should show:
# film-archetypes.md
# scroll-patterns.md
# taste-guardrails.md
# performance-budget.md
```

### Generated images don't load

This is normal if you haven't provided an `fal.ai` API key. The system falls back to CSS-only rendering. To use generated images:

1. Get a key at [fal.ai](https://fal.ai)
2. Set it in the agent environment: `FAL_KEY=your_key_here`
3. Re-trigger the generation

---

## Version Compatibility

| Skill version | Release | Notes |
|---|---|---|
| **2.0.0 (internal)** | Ongoing | Contract version; includes 5-phase pipeline, taste constraints, visual systems |
| **v0.1.1 (public)** | 2026-06-01 | Initial open-source release; 5 live examples, all platforms supported |
| **v0.1.2 (current)** | 2026-06-01 | Corrected README GSAP documentation and softened platform verification claims |
| **v2.0.0 (legacy tag)** | N/A | Historical tag; do not use |

**Current recommendation:** Use v0.1.2 for all new installations.

---

## What's Next

After installation, see:
- **`README.md`** for quickstart examples
- **`examples/PROMPTS.md`** for 20+ copy-paste prompts
- **`references/film-archetypes.md`** for visual system deep-dives
- **`SKILL.md`** for the full agent contract (if you're integrating programmatically)

For help, open an issue on [GitHub](https://github.com/MustBeSimo/cinematic-scroll-skill).
