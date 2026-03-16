# Fix for AWS Bedrock Application Inference Profile Support

## Issue #5290

When configuring an Application Inference Profile ARN or short ID as the model identifier in `openclaw.json` under the `amazon-bedrock` provider, the Bedrock ConverseStream API returns "The provided model identifier is invalid."

## Root Cause

The `isAnthropicBedrockModel()` function in `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts` only checked if the modelId contains "anthropic.claude" or "anthropic/claude". This logic failed for Application Inference Profile ARNs like:
- `arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile`
- Short IDs like `my-claude-profile`

When the function returned false for these IDs, the `createBedrockNoCacheWrapper` was applied, which disabled prompt caching for what are actually Anthropic Claude models accessed through inference profiles.

## Solution

Updated the `isAnthropicBedrockModel` function to:

1. **Accept an optional `modelName` parameter**: This allows checking the model configuration name in addition to the ID.

2. **Check for Claude in model names**: When using Application Inference Profile ARNs or short IDs that don't contain "anthropic.claude", the function now checks if the model name contains "claude" (case-insensitive).

3. **Detect Application Inference Profile ARNs**: The function now recognizes ARNs in the format `arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>`.

## Changes Made

### 1. Updated `src/agents/pi-embedded-runner/anthropic-stream-wrappers.ts`

- Modified `isAnthropicBedrockModel` to accept an optional `modelName` parameter
- Added logic to check model names for "claude" when dealing with inference profiles
- Added detection for Application Inference Profile ARN format

### 2. Updated `src/agents/pi-embedded-runner/extra-params.ts`

- Modified the call to `isAnthropicBedrockModel` to pass the model name from configuration
- Attempts to get the model name from:
  - Agent defaults model configuration (`cfg?.agents?.defaults?.models`)
  - Provider models configuration (`cfg?.models?.providers`)

### 3. Added comprehensive tests

- Created `src/agents/pi-embedded-runner/anthropic-stream-wrappers.test.ts` with extensive test coverage
- Tests cover standard model IDs, Application Inference Profile ARNs, short IDs, and edge cases

## Example Configuration

```json
{
  "models": {
    "providers": {
      "amazon-bedrock": {
        "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
        "api": "bedrock-converse-stream",
        "auth": "aws-sdk",
        "models": [
          {
            "id": "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile",
            "name": "Claude 3 Opus via Application Inference Profile",
            "reasoning": true,
            "input": ["text", "image"],
            "cost": { "input": 15, "output": 75, "cacheRead": 1.875, "cacheWrite": 18.75 },
            "contextWindow": 200000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "amazon-bedrock/arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile"
      }
    }
  }
}
```

## Benefits

1. **Enables Application Inference Profile support**: Users can now use AWS Bedrock Application Inference Profiles for cost tracking and multi-region routing.

2. **Preserves prompt caching**: Anthropic Claude models accessed through inference profiles will retain prompt caching capabilities.

3. **Backward compatible**: The change doesn't affect existing configurations using standard Bedrock model IDs.

## Testing

Run the unit tests:
```bash
pnpm test -- src/agents/pi-embedded-runner/anthropic-stream-wrappers.test.ts
```

Or use the standalone test script:
```bash
node test-bedrock-inference-profile.mjs
```