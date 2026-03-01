# OpenClaw → Operator Rebranding Plan

> **Goal**: Visual rebrand to "Operator" with Matrix theme, while keeping internal code compatible with upstream OpenClaw for easy updates.

---

## ⚠️ Key Principle: Superficial Rebrand Only

**DO NOT** change internal code references. This keeps the fork mergeable with upstream.

| Change                        | Do It? | Reason                  |
| ----------------------------- | ------ | ----------------------- |
| UI theme & colors             | ✅ Yes | Separate CSS/components |
| Logo & visual assets          | ✅ Yes | Separate asset files    |
| Dashboard display text        | ✅ Yes | UI layer only           |
| README & docs                 | ✅ Yes | Your fork, your docs    |
| Package name (`openclaw`)     | ❌ NO  | Merge conflicts         |
| CLI command (`openclaw`)      | ❌ NO  | Merge conflicts         |
| Env vars (`OPENCLAW_*`)       | ❌ NO  | Merge conflicts         |
| Config paths (`~/.openclaw/`) | ❌ NO  | Merge conflicts         |
| Internal source strings       | ❌ NO  | Merge conflicts         |

---

## 📋 Table of Contents

1. [What We Change](#what-we-change)
2. [What We Keep](#what-we-keep)
3. [Visual Identity](#visual-identity)
4. [UI Text Changes](#ui-text-changes)
5. [Asset Replacements](#asset-replacements)
6. [Upstream Sync Strategy](#upstream-sync-strategy)

---

## What We Change

### ✅ Safe to Rebrand

These live in separate files/layers with minimal upstream conflict:

1. **UI Theme** (`ui/` folder)
   - Color palette → Matrix green/black
   - Typography → Monospace fonts
   - Animations → Glow effects, scanlines
   - Component styling → All custom

2. **Visual Assets** (`assets/`, `ui/public/`)
   - Logo files
   - Favicon
   - Social images
   - App icons

3. **UI Display Text**
   - Page titles: "Operator Dashboard"
   - Headers: "Operator" instead of "OpenClaw"
   - Welcome messages
   - About/footer text

4. **README.md**
   - Your fork, your branding
   - Keep attribution to OpenClaw

5. **GitHub Repo**
   - Name: `operator` ✓
   - Description
   - Topics
   - Social preview

---

## What We Keep

### ❌ Do NOT Change (Upstream Compatibility)

| Keep As-Is                    | Location          | Why                       |
| ----------------------------- | ----------------- | ------------------------- |
| `openclaw` package name       | `package.json`    | npm identity              |
| `openclaw` CLI command        | `bin` field       | User scripts depend on it |
| `OPENCLAW_*` env vars         | Throughout source | Config compatibility      |
| `~/.openclaw/` paths          | Config loading    | User data location        |
| Internal class/function names | `src/**/*.ts`     | Massive merge conflicts   |
| Log prefixes `[openclaw]`     | Logger code       | Minor, not worth changing |
| API endpoints                 | Gateway           | Client compatibility      |

### Alias Option (Optional)

If you really want `operator` CLI command, create an alias wrapper:

```bash
# In your shell rc file
alias operator="openclaw"
```

Or publish a tiny wrapper package later.

---

## Visual Identity

### Brand Elements

| Element          | Value              |
| ---------------- | ------------------ |
| **Display Name** | Operator           |
| **Tagline**      | "I need an exit."  |
| **Emoji**        | 🔴 (red pill)      |
| **Theme**        | Matrix / Cyberpunk |

### Color Palette

| Name        | Hex       | CSS Variable          |
| ----------- | --------- | --------------------- |
| Background  | `#0D0208` | `--matrix-black`      |
| Surface     | `#003B00` | `--matrix-dark-green` |
| Muted       | `#008F11` | `--matrix-green`      |
| Primary     | `#00FF41` | `--matrix-lime`       |
| Accent      | `#39FF14` | `--matrix-glow`       |
| Destructive | `#FF0000` | `--red-pill`          |

### Typography

| Usage | Font Stack                                  |
| ----- | ------------------------------------------- |
| UI    | `'Share Tech Mono', 'Fira Code', monospace` |
| Code  | `'Fira Code', 'JetBrains Mono', monospace`  |

### Effects

- Text glow on primary elements
- Subtle scanline overlay (optional)
- Grid background pattern
- Smooth hover transitions

---

## UI Text Changes

### Strings to Update (UI Layer Only)

| Location        | Original              | New               |
| --------------- | --------------------- | ----------------- |
| Page title      | "OpenClaw Dashboard"  | "Operator"        |
| Sidebar header  | "OpenClaw"            | "Operator"        |
| Welcome message | "Welcome to OpenClaw" | "Wake up, Neo."   |
| Footer          | "OpenClaw v..."       | "Operator • v..." |
| Error states    | Generic               | Matrix-themed     |
| Empty states    | Generic               | Matrix-themed     |

### Where These Live

All in the new `ui/` React components — **not** in backend `src/`.

---

## Asset Replacements

### Files to Create/Replace

| File                   | Location     | Purpose                   |
| ---------------------- | ------------ | ------------------------- |
| `logo.svg`             | `ui/public/` | Main logo                 |
| `logo-text.svg`        | `ui/public/` | Logo with "Operator" text |
| `favicon.svg`          | `ui/public/` | Browser tab icon          |
| `favicon.ico`          | `ui/public/` | Legacy favicon            |
| `apple-touch-icon.png` | `ui/public/` | iOS bookmark              |
| `og-image.png`         | `ui/public/` | Social share preview      |
| `README-header.png`    | Root         | GitHub header             |

### Logo Concepts

Options to consider:

1. Stylized "O" with Matrix code effect
2. Headset/operator icon
3. Red pill icon
4. Terminal cursor with glow

---

## Upstream Sync Strategy

### Regular Sync Workflow

```bash
# Add upstream (one-time)
git remote add upstream https://github.com/openclaw/openclaw.git

# Fetch latest
git fetch upstream

# Merge into your branch
git checkout main
git merge upstream/main

# Resolve conflicts (should be minimal — mostly ui/, assets/, README)
# Commit and push
git push origin main
```

### Expected Conflict Zones

| Path           | Conflict Risk | Resolution                        |
| -------------- | ------------- | --------------------------------- |
| `ui/**`        | High          | Keep yours (custom UI)            |
| `assets/**`    | Medium        | Keep yours (custom branding)      |
| `README.md`    | High          | Keep yours or merge manually      |
| `package.json` | Low           | Usually auto-merge, check version |
| `src/**`       | None          | Should auto-merge cleanly         |

### Conflict Resolution Rules

1. **Your UI** → Always keep yours
2. **Your assets** → Always keep yours
3. **Their bug fixes** → Accept theirs
4. **Their features** → Accept theirs
5. **Version bumps** → Take higher version

---

## Implementation Checklist

### Phase 1: Visual Foundation

- [ ] Create Matrix color palette CSS
- [ ] Set up custom fonts
- [ ] Design logo concepts
- [ ] Create favicon

### Phase 2: UI Rebrand

- [ ] Build new React UI (separate task)
- [ ] Apply Matrix theme throughout
- [ ] Update display text to "Operator"
- [ ] Add custom animations/effects

### Phase 3: Assets

- [ ] Finalize logo
- [ ] Create all icon sizes
- [ ] Create social preview image
- [ ] Update README header

### Phase 4: Documentation

- [ ] Update README.md
- [ ] Keep OpenClaw attribution
- [ ] Document your additions

---

## Attribution

Keep a note in README acknowledging the upstream:

```markdown
## Credits

Operator is a fork of [OpenClaw](https://github.com/openclaw/openclaw),
the open-source personal AI assistant.

Built with 💚 on top of the amazing OpenClaw foundation.
```

---

_Last updated: 2026-02-01_
