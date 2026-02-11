# Qwen DashScope API Key Support

Add DashScope API Key authentication for Qwen provider in OpenClaw.

## Summary

This PR enables users to authenticate with Qwen using DashScope API keys, complementing the existing OAuth flow. Supports both International (Singapore) and China regions with 9 verified models.

## Quick Start

```bash
# Interactive setup
openclaw models auth login --provider qwen-portal
# Select "Qwen API Key (DashScope)"
# Choose region: International or China
# Enter API key: sk-...

# Or use environment variable
export QWEN_API_KEY="sk-your-key"
openclaw restart
```

## Changes

### Modified Files (5)

1. **src/agents/model-auth.ts** - Added `QWEN_API_KEY` environment variable
2. **extensions/qwen-portal-auth/index.ts** - API key auth method with region selection
3. **src/commands/onboard-types.ts** - Added `qwen-api-key` type
4. **src/commands/auth-choice-options.ts** - Added API key option in wizard
5. **src/commands/auth-choice.apply.qwen-portal.ts** - Updated routing logic

**Total**: ~185 lines changed (163 added, 16 removed)

### New Features

- API Key authentication (paid tier)
- Region selection: International (Singapore) / China
- Auto-configuration of correct endpoint based on region
- 9 verified models (tested against live APIs)
- Environment variable support
- Onboard wizard integration

### Supported Models

All models verified in both International and China regions:

**Coding**: qwen3-coder-plus, qwen-coder-plus, qwen3-coder-flash  
**General**: qwen3-max, qwen-max, qwen-plus, qwen-turbo  
**Vision**: qwen3-vl-plus, qwen-vl-plus

## Region Configuration

### International (Singapore)

- **Endpoint**: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- **Get API Key**: https://www.alibabacloud.com/help/en/model-studio/

### China

- **Endpoint**: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **Get API Key**: https://dashscope.aliyuncs.com/

**Note**: API keys are region-specific and not interchangeable.

## Usage Examples

```bash
# Use default model
openclaw chat "Hello, write a quicksort algorithm"

# Specify model
openclaw chat --model qwen3-coder "Implement binary search"
openclaw chat --model qwen3-max "Explain quantum computing"

# Use model alias
openclaw chat --model qwen3-coder "Debug this code"  # alias for qwen3-coder-plus
```

## Testing

### Automated Test

```bash
./test-qwen-apikey.sh
```

### Verification Done

- International region tested with real API key
- China region tested with real API key
- All 9 models verified via API
- OAuth flow still works (no regression)
- Build passes without errors

## Configuration Example

After setup, your `~/.openclaw/openclaw.json` will contain:

```json
{
  "models": {
    "providers": {
      "qwen-portal": {
        "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "apiKey": "profile:qwen-portal:default",
        "api": "openai-completions",
        "models": [
          {"id": "qwen-plus", "name": "Qwen Plus", ...},
          {"id": "qwen3-coder-plus", "name": "Qwen3 Coder Plus", ...}
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "qwen-portal/qwen3-coder-plus"
      }
    }
  }
}
```

And `~/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "profiles": {
    "qwen-portal:default": {
      "type": "api_key",
      "provider": "qwen-portal",
      "key": "sk-your-key"
    }
  }
}
```

## Backwards Compatibility

- No breaking changes
- Existing OAuth users unaffected
- All existing tests pass
- Configurations remain valid

## Security

- API keys stored securely in auth-profiles.json
- Input validation (checks for `sk-` prefix)
- No secrets committed
- Environment variable support for CI/CD

## Troubleshooting

**Invalid API Key**: Verify key format and expiration  
**Wrong Region**: International keys don't work with China endpoint  
**Model Not Found**: Use correct model IDs (see supported models above)

## OAuth vs API Key

| Feature  | OAuth (Free)   | API Key (Paid)                 |
| -------- | -------------- | ------------------------------ |
| Setup    | Browser login  | Copy API key                   |
| Cost     | Free tier      | Pay per use                    |
| Endpoint | portal.qwen.ai | dashscope-intl/cn.aliyuncs.com |
| Models   | 2 models       | 9+ models                      |
| Best For | Testing        | Production                     |

## Technical Details

### Authentication Flow

```
User selects API Key → Choose region → Enter key → Validate format →
Auto-configure endpoint → Save to profile → Ready
```

### Implementation Pattern

Follows existing plugin authentication patterns:

- Uses `ctx.prompter.select` for region
- Uses `ctx.prompter.text` with validation for API key
- Returns standard `AuthResult` with profiles and configPatch
- Integrates with existing auth profile system

## Files Structure

```
src/
├── agents/model-auth.ts                      (env variable)
└── commands/
    ├── onboard-types.ts                      (type def)
    ├── auth-choice-options.ts                (wizard option)
    └── auth-choice.apply.qwen-portal.ts      (routing)
extensions/
└── qwen-portal-auth/
    └── index.ts                              (main implementation)
test-qwen-apikey.sh                           (automated test)
README_QWEN_API_KEY.md                        (this file)
```

## Contributing

To test this feature:

1. Run `./test-qwen-apikey.sh` to verify build
2. Get a DashScope API key (International or China)
3. Run `openclaw models auth login --provider qwen-portal`
4. Select "Qwen API Key" and follow prompts
5. Test with `openclaw chat "test message"`

## License

Same as OpenClaw project license.

---

**Status**: Ready for review  
**Version**: 1.0  
**Last Updated**: 2026-02-11  
**Tested Regions**: International (SG), China
