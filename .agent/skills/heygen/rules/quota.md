---
name: quota
description: Credit system, usage limits, and checking remaining quota for HeyGen
metadata:
  tags: quota, credits, limits, usage, billing
---

# HeyGen Quota and Credits

HeyGen uses a credit-based system for video generation. Understanding quota management helps prevent failed video generation requests.

## Checking Remaining Quota

### curl

```bash
curl -X GET "https://api.heygen.com/v1/video_generate.quota" \
  -H "X-Api-Key: $HEYGEN_API_KEY"
```

### TypeScript

```typescript
interface QuotaResponse {
  error: null | string;
  data: {
    remaining_quota: number;
    used_quota: number;
  };
}

const response = await fetch("https://api.heygen.com/v1/video_generate.quota", {
  headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! },
});

const { data }: QuotaResponse = await response.json();
console.log(`Remaining credits: ${data.remaining_quota}`);
```

### Python

```python
import requests
import os

response = requests.get(
    "https://api.heygen.com/v1/video_generate.quota",
    headers={"X-Api-Key": os.environ["HEYGEN_API_KEY"]}
)

data = response.json()["data"]
print(f"Remaining credits: {data['remaining_quota']}")
```

## Response Format

```json
{
  "error": null,
  "data": {
    "remaining_quota": 450,
    "used_quota": 50
  }
}
```

## Credit Consumption

Different operations consume different amounts of credits:

| Operation | Credit Cost | Notes |
|-----------|-------------|-------|
| Standard video (1 min) | ~1 credit per minute | Varies by resolution |
| 720p video | Base rate | Standard quality |
| 1080p video | ~1.5x base rate | Higher quality |
| Video translation | Varies | Depends on video length |
| Streaming avatar | Per session | Real-time usage |

## Pre-Generation Quota Check

Always verify sufficient quota before generating videos:

```typescript
async function generateVideoWithQuotaCheck(videoConfig: VideoConfig) {
  // Check quota first
  const quotaResponse = await fetch(
    "https://api.heygen.com/v1/video_generate.quota",
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const { data: quota } = await quotaResponse.json();

  // Estimate required credits (rough estimate: 1 credit per minute)
  const estimatedMinutes = videoConfig.estimatedDuration / 60;
  const requiredCredits = Math.ceil(estimatedMinutes);

  if (quota.remaining_quota < requiredCredits) {
    throw new Error(
      `Insufficient credits. Need ${requiredCredits}, have ${quota.remaining_quota}`
    );
  }

  // Proceed with video generation
  return generateVideo(videoConfig);
}
```

## Quota Management Best Practices

### 1. Monitor Usage Regularly

```typescript
async function logQuotaUsage() {
  const response = await fetch(
    "https://api.heygen.com/v1/video_generate.quota",
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const { data } = await response.json();

  console.log({
    remaining: data.remaining_quota,
    used: data.used_quota,
    percentUsed: (
      (data.used_quota / (data.remaining_quota + data.used_quota)) *
      100
    ).toFixed(1),
  });
}
```

### 2. Set Up Alerts

```typescript
const QUOTA_WARNING_THRESHOLD = 50;

async function checkQuotaWithAlert() {
  const response = await fetch(
    "https://api.heygen.com/v1/video_generate.quota",
    { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY! } }
  );

  const { data } = await response.json();

  if (data.remaining_quota < QUOTA_WARNING_THRESHOLD) {
    // Send alert (email, Slack, etc.)
    await sendAlert(`Low HeyGen quota: ${data.remaining_quota} credits remaining`);
  }

  return data;
}
```

### 3. Use Test Mode for Development

When available, use test mode to avoid consuming credits during development:

```typescript
const videoConfig = {
  test: true, // Use test mode during development
  video_inputs: [...],
};

// Test videos may have watermarks but don't consume credits
```

## Subscription Tiers

Different subscription tiers have different quota allocations and features:

| Tier | Features |
|------|----------|
| Free | Limited credits, basic features |
| Creator | More credits, standard avatars |
| Team | Higher limits, team collaboration |
| Enterprise | Custom limits, API access, priority support |

API access typically requires Enterprise tier or higher.

## Error Handling for Quota Issues

```typescript
async function handleQuotaError(error: any) {
  if (error.message.includes("quota") || error.message.includes("credit")) {
    console.error("Quota exceeded. Consider:");
    console.error("1. Upgrading your subscription");
    console.error("2. Waiting for quota reset");
    console.error("3. Purchasing additional credits");

    // Check current quota
    const quota = await getQuota();
    console.error(`Current remaining: ${quota.remaining_quota}`);
  }

  throw error;
}
```
