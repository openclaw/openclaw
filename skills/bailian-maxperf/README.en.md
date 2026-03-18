# Bailian MaxPerf - Alibaba Bailian Full Performance Optimization

[中文](README.md) | **English**

## Overview

Optimize Alibaba Bailian (Alibaba Cloud Model Studio) to achieve **100% performance** in OpenClaw, including:
- ✅ Accurate token usage statistics
- ✅ Precise model context window configuration
- ✅ Optimized timeout settings
- ✅ Performance tuning

## Problem Statement

When using Alibaba Bailian with OpenClaw, `/status` shows incorrect token statistics:
- `Context: 0/128k` or `Context: ?/1.0m`
- `/compact` may fail due to inaccurate usage data

### Root Causes

1. **Token Usage Field Mismatch**
   - Bailian returns: `prompt_tokens`, `completion_tokens`, `total_tokens`
   - OpenClaw expects: `input_tokens`, `output_tokens`

2. **Missing Streaming Usage Flag**
   - Streaming requests need `stream_options.include_usage: true`

3. **Outdated Model Configuration**
   - Some model context windows are not up-to-date with official docs

## Quick Start

```bash
cd /home/wayne/.openclaw/workspace/skills/bailian-maxperf
./scripts/maxperf.sh
openclaw gateway restart
```

## What This Skill Does

### 1. Token Usage Compatibility Fix

**Configuration**: Adds `compat.supportsUsageInStreaming: true` to all Bailian models

**Runtime Patch**: Updates OpenClaw dist files to map Bailian fields:
```javascript
// Before
input: response.usage?.input_tokens ?? 0
output: response.usage?.output_tokens ?? 0

// After
input: response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0
output: response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0
```

### 2. Model Window Optimization

Updates all Bailian models to official 2026 specifications:

| Model | Context Window | Max Tokens |
|-------|---------------|------------|
| qwen3.5-plus | 262,144 | 65,536 |
| qwen3-max-2026-01-23 | 262,144 | 65,536 |
| qwen3-coder-next | 262,144 | 65,536 |
| qwen3-coder-plus | 262,144 | 65,536 |
| MiniMax-M2.5 | 204,800 | 131,072 |
| glm-5 | 202,752 | 16,384 |
| glm-4.7 | 202,752 | 16,384 |
| kimi-k2.5 | 262,144 | 32,768 |

### 3. Configuration Validation

Automatically validates configuration after applying changes.

## Before & After

### Before Optimization
```
❌ Token Stats: unknown
❌ Context: 0/128k (?%)
❌ Long text: prone to timeout
```

### After Optimization
```
✅ Token Stats: 172k/262k (66%)
✅ Context: precise match to official specs
✅ Long text: stable generation
```

## Verification

```bash
# 1. Validate configuration
openclaw status

# 2. Call Bailian model
/chat Use qwen3.5-plus to generate long text

# 3. Check token statistics
openclaw status
# Should show: 🧮 Tokens: XXX in / XX out
```

## Important Notes

⚠️ **After OpenClaw Upgrade**: If you run `npm install -g openclaw@...`, the runtime patches will be overwritten. Re-run the script:

```bash
cd /home/wayne/.openclaw/workspace/skills/bailian-maxperf
./scripts/maxperf.sh
openclaw gateway restart
```

## Files

- `SKILL.md` - Skill documentation
- `README.md` - Chinese documentation
- `README.en.md` - English documentation (this file)
- `scripts/maxperf.sh` - Automated optimization script
- `configs/bailian-models-official.json` - Official model configuration reference

## Compatibility

- **OpenClaw Version**: 2026.3.13+
- **Provider**: Alibaba Bailian (dashscope.aliyuncs.com)
- **Models**: All Bailian models listed above

## Troubleshooting

### Issue: Configuration validation fails
```bash
openclaw status
# Shows configuration error

# Solution: Check openclaw.json syntax
python3 -m json.tool ~/.openclaw/openclaw.json > /dev/null
```

### Issue: Token stats still show unknown
```bash
# Check if dist files were patched
grep "prompt_tokens" ~/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-*.js

# If no results, re-run the script
./scripts/maxperf.sh
openclaw gateway restart
```

### Issue: Model window still incorrect
```bash
# Check if configuration is applied
grep -A5 '"qwen3.5-plus"' ~/.openclaw/openclaw.json

# contextWindow should be 262144
```

## Version History

- **v1.0** (2026-03-18) - Initial release
  - Token usage compatibility fix
  - Model window optimization
  - Automated script

## License

MIT License - See LICENSE file

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Support

- OpenClaw Docs: https://docs.openclaw.ai
- Community: https://discord.com/invite/clawd
- ClawHub: https://clawhub.com
