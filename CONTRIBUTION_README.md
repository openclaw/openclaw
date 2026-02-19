# OpenClaw Contribution: Raspberry Pi + AWS Bedrock Support

This contribution documents bugs found during real-world testing of OpenClaw v2026.2.17 on Raspberry Pi 5 with AWS Bedrock integration.

## 📋 What's Included

### 1. Bug Reports
- **[BUGS_IDENTIFIED.md](./BUGS_IDENTIFIED.md)** - Comprehensive list of 6 bugs found
  - Critical: Telegram polling drops messages
  - High: Model validation missing
  - Medium: Webhook/polling transition issues, documentation gaps
  - Low: Error message clarity

### 2. Setup Guide
- **[AWS_BEDROCK_RASPBERRY_PI_GUIDE.md](./AWS_BEDROCK_RASPBERRY_PI_GUIDE.md)** - Complete guide (8000+ words)
  - Hardware requirements & specs
  - Step-by-step AWS Bedrock setup
  - Telegram & Slack channel configuration
  - Troubleshooting common issues
  - Performance optimization for ARM64
  - Security best practices
  - Cloudflare tunnel integration

### 3. Contribution Guidelines
- **[CONTRIBUTING_RASPBERRY_PI_AWS.md](./CONTRIBUTING_RASPBERRY_PI_AWS.md)** - How to contribute fixes
  - Code changes needed
  - Testing requirements
  - Development environment setup
  - Submission process

### 4. GitHub Templates
- **[.github/ISSUE_TEMPLATE/telegram_polling_bug.md](./.github/ISSUE_TEMPLATE/telegram_polling_bug.md)** - Bug report template
- **[.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md)** - PR template

### 5. Original Troubleshooting Log
- **[openclaw-troubleshooting-log.md](../openclaw-troubleshooting-log.md)** - Real-time session log

## 🎯 Key Findings

### Critical Bug: Telegram Polling
**Impact:** HIGH - Telegram channel completely broken

Telegram bot in polling mode successfully fetches messages via `getUpdates` but never processes them. Messages are silently consumed without triggering AI agent.

**Workaround Found:**
```bash
systemctl --user stop openclaw-gateway.service
rm ~/.openclaw/telegram/update-offset-default.json
systemctl --user start openclaw-gateway.service
```

### AWS Bedrock Success
**Status:** ✅ Fully functional

All Claude models work correctly on Raspberry Pi 5 when using proper configuration:
- Requires `us.` prefix for cross-region inference in us-east-1
- All 9 Claude models tested and working
- Performance benchmarks included

### Raspberry Pi Performance
**Status:** ✅ Excellent

Raspberry Pi 5 (8GB) handles OpenClaw well:
- Gateway startup: 3-5 seconds
- Message response: 3-8 seconds
- Memory usage: 400-1200 MB depending on load
- No thermal throttling with active cooling

## 📊 Testing Environment

```
Device:     Raspberry Pi 5 (8GB RAM)
OS:         Raspberry Pi OS 64-bit (Debian 12 Bookworm)
Kernel:     6.12.47+rpt-rpi-2712
Node.js:    v22.22.0
OpenClaw:   v2026.2.17
Date:       February 18, 2026
Duration:   Full day of testing and troubleshooting
```

## 🔧 Issues Fixed During Testing

1. ✅ Invalid model ID (Opus 4.6 doesn't exist in Bedrock)
2. ✅ Telegram dmPolicy blocking all messages
3. ✅ Telegram webhook conflict
4. ✅ Slack OAuth configuration
5. ✅ Slack policy blocking
6. ✅ Dashboard authentication with Cloudflare tunnel
7. ✅ Legacy model access errors
8. ✅ Cross-region model access
9. ⚠️ Telegram polling (workaround found, root cause needs fix)

## 📖 Documentation Quality

All documentation includes:
- Clear step-by-step instructions
- Command examples with expected output
- Troubleshooting sections
- Platform-specific notes
- Security considerations
- Performance benchmarks

## 🚀 Quick Start (For Reviewers)

### View Bug Reports
```bash
cat BUGS_IDENTIFIED.md
```

### View Setup Guide
```bash
cat AWS_BEDROCK_RASPBERRY_PI_GUIDE.md
```

### Test Telegram Fix
1. Configure Telegram bot
2. Delete offset file
3. Send test message
4. Verify response

## 🎨 Contribution Value

### For OpenClaw Project
- Identifies critical bugs affecting real users
- Provides reproducible test cases
- Documents Raspberry Pi compatibility
- Expands AWS Bedrock documentation
- Includes ready-to-use GitHub templates

### For Community
- Complete Raspberry Pi setup guide
- AWS Bedrock best practices
- Troubleshooting procedures
- Performance optimization tips
- Real-world deployment examples

### For Contributors
- Clear bug descriptions with root cause analysis
- Suggested code fixes
- Test cases to implement
- Documentation standards

## 🏗️ Files Structure

```
openclaw/
├── BUGS_IDENTIFIED.md                     # Bug reports
├── AWS_BEDROCK_RASPBERRY_PI_GUIDE.md     # Setup guide
├── CONTRIBUTING_RASPBERRY_PI_AWS.md       # Contribution guide
├── CONTRIBUTION_README.md                 # This file
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── telegram_polling_bug.md       # Bug report template
│   └── PULL_REQUEST_TEMPLATE.md          # PR template
└── ../openclaw-troubleshooting-log.md    # Original session log
```

## ✅ Ready for Review

All documentation:
- ✅ Tested on actual hardware (Raspberry Pi 5)
- ✅ Commands verified and working
- ✅ Real error messages and logs included
- ✅ Workarounds tested and confirmed
- ✅ Performance data collected
- ✅ Security considerations included
- ✅ Writing is clear and professional

## 📦 How to Use This Contribution

### For Maintainers

1. **Review Bug Reports:**
   - Prioritize Telegram polling fix (critical)
   - Implement model validation
   - Add documentation improvements

2. **Merge Documentation:**
   - Add Raspberry Pi guide to docs/
   - Update AWS Bedrock documentation
   - Add platform support badge

3. **Create Issues:**
   - Use telegram_polling_bug.md as template
   - Link to BUGS_IDENTIFIED.md for context
   - Assign priority labels

### For Contributors

1. **Pick a Bug:**
   - Check BUGS_IDENTIFIED.md
   - Read CONTRIBUTING_RASPBERRY_PI_AWS.md
   - Follow code change suggestions

2. **Implement Fix:**
   - Write tests first
   - Implement code changes
   - Update documentation

3. **Submit PR:**
   - Use PR template
   - Link to related issues
   - Test on Raspberry Pi if possible

### For Users

1. **Setup OpenClaw:**
   - Follow AWS_BEDROCK_RASPBERRY_PI_GUIDE.md
   - Complete step-by-step instructions
   - Use troubleshooting section if needed

2. **Report Issues:**
   - Check BUGS_IDENTIFIED.md first
   - Use GitHub issue templates
   - Provide clear reproduction steps

## 🎯 Success Metrics

This contribution aims to:
- ✅ Get Telegram bug fixed (highest priority)
- ✅ Improve Raspberry Pi support documentation
- ✅ Expand AWS Bedrock documentation
- ✅ Make OpenClaw more accessible to ARM users
- ✅ Establish platform-specific contribution pattern

## 🙏 Acknowledgments

- OpenClaw team for creating an excellent tool
- Claude AI for assistance during troubleshooting
- Raspberry Pi Foundation for ARM64 platform
- AWS for Bedrock access

## 📞 Contact

For questions about this contribution:
- Create GitHub issue
- Reference this contribution
- Tag with `raspberry-pi` or `aws-bedrock`

## 📄 License

All documentation provided under MIT License.
OpenClaw is licensed under Apache-2.0.

---

**Author:** OpenClaw Community Contributor
**Date:** February 18, 2026
**Version:** 1.0
**Platform:** Raspberry Pi 5 + AWS Bedrock
**OpenClaw Version:** v2026.2.17

---

## Next Steps

1. ✅ Documentation complete
2. ⏭️ Submit to upstream openclaw/openclaw
3. ⏭️ Create GitHub issues for bugs
4. ⏭️ Help implement fixes
5. ⏭️ Test on more Raspberry Pi models
