# Publishing Guide for DNA Update Skill

## Pre-Publication Checklist

- [x] Remove personal data (paths, agent names, etc.)
- [x] Set author to pasogott
- [x] MIT License included
- [x] Dynamic workspace detection (no hardcoded paths)
- [x] Generic examples in documentation
- [x] All scripts executable
- [x] package.json configured
- [x] .clawdhub.json configured
- [x] README with installation instructions

## Files Ready for Publication

```
/tmp/dna-update-publish/
├── backup-dna-dryrun.sh     # Dry run preview
├── backup-dna-full.sh       # Full backup
├── restore-dna.sh           # Restore
├── validate-setup.sh             # Validation
├── check-upstream.sh             # Update checker
├── config.json                   # Skill config
├── package.json                  # npm metadata
├── .clawdhub.json               # ClawdHub metadata
├── LICENSE                       # MIT License
├── README.md                     # Quick start
├── SKILL.md                      # Full documentation
├── UPDATE_CHECKLIST.md          # Step-by-step guide
└── QUICK_REFERENCE.md           # Command cheat sheet
```

## Publishing to npm

### 1. Prepare npm package

```bash
cd /tmp/dna-update-publish

# Verify package.json
cat package.json

# Test installation locally
npm pack
```

### 2. Publish to npm

```bash
# Login to npm (if not already)
npm login

# Publish (scoped package)
npm publish --access public
```

### 3. Verify publication

```bash
# Check package page
open https://www.npmjs.com/package/@dna/skill-update

# Test installation
npm install -g @dna/skill-update
```

## Publishing to ClawdHub

### 1. Create repository

```bash
# Option A: Create new repo
gh repo create pasogott/dna-skill-update --public

# Option B: Fork DNA repo and add as subdirectory
# Follow ClawdHub contribution guidelines
```

### 2. Push to repository

```bash
cd /tmp/dna-update-publish

# Initialize git
git init
git add .
git commit -m "Initial release: DNA Update Skill v1.0.0

Features:
- Dynamic workspace detection
- Multi-agent support
- Dry run preview
- Full backup & restore
- Git integration
- Validation checks

Author: Pascal Schott (@pasogott)
License: MIT"

# Push to GitHub
git remote add origin https://github.com/pasogott/dna-skill-update.git
git branch -M main
git push -u origin main
```

### 3. Submit to ClawdHub

Visit https://clawdhub.com and follow submission process:

1. Navigate to "Submit Skill"
2. Provide repository URL
3. ClawdHub will read `.clawdhub.json` automatically
4. Review and submit

## Installation Instructions for Users

### Via ClawdHub (Recommended)

```bash
dna skills install dna-update
```

### Via npm

```bash
npm install -g @dna/skill-update

# Link to skills directory
ln -s /usr/local/lib/node_modules/@dna/skill-update ~/.skills/dna-update
```

### Manual Installation

```bash
git clone https://github.com/pasogott/dna-skill-update.git ~/.skills/dna-update
chmod +x ~/.skills/dna-update/*.sh
```

## Post-Publication

### 1. Create GitHub Release

```bash
# Tag release
git tag -a v1.0.0 -m "Release v1.0.0

Features:
- Dynamic workspace detection
- Multi-agent support
- Dry run preview
- Full backup & restore
- Git integration
- Validation checks"

git push origin v1.0.0

# Create release on GitHub
gh release create v1.0.0 \
  --title "v1.0.0 - Initial Release" \
  --notes "First public release of DNA Update Skill"
```

### 2. Announce

- Post on DNA Discord/Community
- Tweet/share if applicable
- Add to DNA skills documentation

### 3. Monitor

- Watch GitHub issues
- Respond to npm feedback
- Update documentation as needed

## Version Bumping (Future)

### Update version

```bash
# Edit package.json version
# Edit .clawdhub.json version
# Edit config.json version

# Commit
git commit -am "Bump version to 1.1.0"

# Tag
git tag v1.1.0
git push origin v1.1.0

# Publish
npm version patch  # or minor, major
npm publish
```

## Maintenance Checklist

- [ ] Keep aligned with DNA breaking changes
- [ ] Test with new DNA releases
- [ ] Update documentation
- [ ] Respond to issues
- [ ] Add new features based on feedback

## Repository Structure

```
dna-skill-update/
├── .github/
│   └── workflows/
│       └── test.yml          # CI/CD
├── backup-dna-dryrun.sh
├── backup-dna-full.sh
├── restore-dna.sh
├── validate-setup.sh
├── check-upstream.sh
├── config.json
├── package.json
├── .clawdhub.json
├── LICENSE
├── README.md
├── SKILL.md
├── UPDATE_CHECKLIST.md
├── QUICK_REFERENCE.md
└── .gitignore
```

## Quality Checks Before Release

- [ ] All scripts have shebang (`#!/bin/bash`)
- [ ] All scripts are executable (`chmod +x`)
- [ ] No hardcoded personal paths
- [ ] No sensitive data (keys, tokens, etc.)
- [ ] Documentation is clear and generic
- [ ] Examples use placeholder data
- [ ] License is properly attributed
- [ ] package.json is valid
- [ ] .clawdhub.json is valid

## Contact

**Author**: Pascal Schott  
**GitHub**: [@pasogott](https://github.com/pasogott)  
**Issues**: Report via GitHub Issues  
**License**: MIT

---

Ready to publish! 🚀
