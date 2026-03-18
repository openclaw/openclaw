# Changelog

All notable changes to Bailian MaxPerf Skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-18

### Added
- Token usage compatibility fix for Alibaba Bailian
  - Maps `prompt_tokens` → `input_tokens`
  - Maps `completion_tokens` → `output_tokens`
  - Adds `compat.supportsUsageInStreaming: true` to all Bailian models
- Model window optimization with official 2026 specifications
  - qwen3.5-plus: 262,144 context window
  - qwen3-max-2026-01-23: 262,144 context window
  - qwen3-coder-next: 262,144 context window
  - qwen3-coder-plus: 262,144 context window
  - MiniMax-M2.5: 204,800 context window
  - glm-5: 202,752 context window
  - glm-4.7: 202,752 context window
  - kimi-k2.5: 262,144 context window
- Automated optimization script (`scripts/maxperf.sh`)
- Configuration validation
- Multi-language documentation (Chinese & English)
- Contributing guidelines
- Official model configuration reference (`configs/bailian-models-official.json`)

### Changed
- N/A (initial release)

### Deprecated
- N/A

### Removed
- N/A

### Fixed
- Token statistics showing `unknown` or `0/128k`
- Incorrect context window values for several models
- Missing streaming usage support for Bailian provider

### Security
- No sensitive data (API keys, etc.) included in skill files
- `.gitignore` configured to prevent credential leaks

---

## Future Versions (Planned)

### [1.1.0] - Planned
- Add retry mechanism for network failures
- Add caching optimization
- Support for additional Bailian models
- Performance benchmarks

### [2.0.0] - Planned
- Auto-update detection for OpenClaw upgrades
- Interactive configuration wizard
- Model performance monitoring
- Usage analytics dashboard

---

## Version Support

| OpenClaw Version | Skill Version | Status |
|-----------------|---------------|--------|
| 2026.3.13+      | 1.0.0         | ✅ Supported |
| < 2026.3.13     | 1.0.0         | ⚠️ Untested |

## Upgrade Notes

### From v1.0.0 to Future Versions

When upgrading OpenClaw:
```bash
npm install -g openclaw@latest
cd /path/to/bailian-maxperf
./scripts/maxperf.sh
openclaw gateway restart
```

---

**Latest Version**: 1.0.0  
**Release Date**: 2026-03-18  
**OpenClaw Compatibility**: 2026.3.13+
