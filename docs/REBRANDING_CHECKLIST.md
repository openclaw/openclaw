# Jarvis Rebranding & Voice Enhancement Checklist

## Pre-Rebranding (Phase 1)

### Documentation & Planning
- [x] Create rebranding strategy document
- [x] Create migration guide
- [x] Create comprehensive rebranding map
- [x] Document breaking changes

### Code Preparation
- [x] Create rebranding scripts
- [x] Create tool verification script
- [x] Create automated rebranding runner
- [x] Prepare voice-to-voice engine

## Execution Phase (Phase 2)

### Run Automated Rebranding
```bash
# Test run (dry-run)
node scripts/rebrand-automated.js --dry-run --verbose

# Actual rebranding
node scripts/rebrand-automated.js

# Verify tools
node scripts/verify-tools.js
```

### Manual File Updates (if needed)
- [ ] Update main CLI entry (openclaw.mjs → jarvis.mjs)
- [ ] Update README.md title and description
- [ ] Update website references
- [ ] Update GitHub repository settings
- [ ] Update npm registry listings

### Package Updates
```bash
npm pkg set name="@jarvis/core"
pnpm -r exec npm pkg set name=$PKG_NAME_JARVIS
```

## Verification Phase (Phase 3)

### Automated Tests
- [ ] All tools pass verification: `node scripts/verify-tools.js`
- [ ] No OpenClaw references remain
- [ ] Configuration system works: `jarvis setup`
- [ ] CLI commands work: `jarvis --version`

### Manual Testing
- [ ] Browser tool functional
- [ ] Canvas tool functional
- [ ] Sessions tool functional
- [ ] Cron tool functional
- [ ] Nodes tool functional
- [ ] Gateway starts successfully
- [ ] Agent responds to queries

## Voice Features Setup (Phase 4)

### NVIDIA Riva Installation
- [ ] Pull Docker image: `docker pull nvcr.io/nvidia/riva/riva-server:latest`
- [ ] Start Riva server with GPU support
- [ ] Set environment variables
- [ ] Verify connection: `jarvis voice test`

### Voice Testing
- [ ] Speech-to-text working
- [ ] Text-to-speech working (NVIDIA Riva)
- [ ] Laptop control commands available
- [ ] Full voice pipeline tested

## Release Phase (Phase 5)

### Version Management
- [ ] Update version numbers to 2026.6.0
- [ ] Update CHANGELOG.md
- [ ] Update all package.json files

### Documentation
- [ ] Update docs.jarvis.ai
- [ ] Update GitHub README
- [ ] Update installation instructions

### NPM Publishing
- [ ] Publish to npm registry
- [ ] Update dist-tags
- [ ] Verify installation works

## Post-Release (Phase 6)

### Monitoring
- [ ] Monitor error logs
- [ ] Track user feedback
- [ ] Support migration questions

## Critical Verifications

- [ ] All tools still functional
- [ ] No breaking changes in tool APIs
- [ ] Configuration migration works
- [ ] Voice engine properly integrated
- [ ] NVIDIA Riva optional (not required)
- [ ] All CLI commands available

## Timeline

- Phase 1: 2 hours
- Phase 2: 1 hour
- Phase 3: 2 hours
- Phase 4: 3 hours
- Phase 5: 2 hours
- **Total: ~10 hours**
