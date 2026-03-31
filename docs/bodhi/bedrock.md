# AWS Bedrock — Recommended Model Provider

## Why Bedrock

For bodhi1 (personal) and OpenBodhi (product), Bedrock is the recommended model provider once AWS is configured.

| What you get | Direct Anthropic API | AWS Bedrock |
|---|---|---|
| Token pricing | Base | Identical |
| Prompt caching | ✅ Full support | ✅ Full support (GA April 2025) |
| Data retention guarantee | Policy (7-day logs) | Contract (zero retention by default) |
| Anthropic can see prompts | Yes | **No** — isolated AWS deployment |
| HIPAA BAA available | No | **Yes** |
| IAM / rotating credentials | No (static key) | **Yes** |
| CloudTrail audit log | No | **Yes** |
| New models | Immediate | Same generation, days lag |
| PrivateLink (VPC, zero public internet) | No | Yes (requires AWS-hosted infra) |
| Latency (off-AWS) | ~11s avg | ~17s avg (extra hop) |
| Latency (on-AWS EC2/Lightsail) | N/A | Equivalent to direct |

**Bottom line:** If bodhi1 runs on a home Ubuntu box, latency is ~6s worse per cold call. If it ever moves to an EC2 or Lightsail instance, all advantages activate with zero latency penalty.

For the OpenBodhi product, Bedrock is the right default — HIPAA eligibility, contractual data isolation, and rotating IAM credentials are correct for a product handling user health data.

---

## Configuration

### 1. AWS credentials (never in files, env vars only)

```bash
# Add to ~/.openclaw/.env or the systemd service override
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="us-east-1"   # or us-west-2
```

Best practice: use an IAM role with `bedrock:InvokeModel` permission only. No other AWS access needed.

### 2. Model IDs

| OpenClaw model name | Bedrock model ID |
|---|---|
| `anthropic/claude-sonnet-4-6` | `us.anthropic.claude-sonnet-4-6` |
| `anthropic/claude-haiku-4-5` | `us.anthropic.claude-haiku-4-5-20251001` |
| `anthropic/claude-opus-4-6` | `us.anthropic.claude-opus-4-6` |

Use the `us.` cross-region inference prefix for higher throughput and automatic failover across US regions.

### 3. openclaw.json — switch to Bedrock

Change the `agents.defaults.model` and `agents.defaults.models` block:

```json
"defaults": {
  "model": "bedrock/us.anthropic.claude-sonnet-4-6",
  "models": {
    "bedrock/us.anthropic.claude-sonnet-4-6": {
      "params": { "cacheRetention": "short" }
    },
    "bedrock/us.anthropic.claude-haiku-4-5-20251001": {
      "params": { "cacheRetention": "short" }
    },
    "bedrock/us.anthropic.claude-opus-4-6": {
      "params": { "cacheRetention": "short" }
    }
  }
}
```

The `bedrock/` prefix tells OpenClaw's gateway to route via the AWS Bedrock SDK instead of the Anthropic SDK. AWS credentials are read from environment.

### 4. IAM policy (minimal)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
      ]
    }
  ]
}
```

---

## Prompt Caching on Bedrock

Prompt caching works identically to direct Anthropic API. The `cacheRetention: "short"` config in openclaw.json maps to the `cache_control` API parameter with a 5-minute TTL.

Cache write: same cost as input tokens.
Cache hit: up to 90% discount on cached tokens.

No changes needed to the caching logic — same config, same savings.

---

## PrivateLink (when on AWS infrastructure)

If bodhi1 is ever migrated to EC2 or Lightsail:

1. Create a Bedrock PrivateLink endpoint in your VPC
2. All model inference stays within the AWS network — never touches the public internet
3. Update `AWS_DEFAULT_REGION` to match the endpoint region

This is the full security picture: LUKS on disk → Tailscale for LAN → PrivateLink for model calls → IAM for auth → CloudTrail for audit.

---

## Current Status (bodhi1)

bodhi1 is on a home Ubuntu desktop (not AWS). Running Bedrock from here adds ~6s latency per cold call with no PrivateLink benefit.

**Recommendation:** Keep direct Anthropic API until April 1 (API limit resets), then evaluate moving bodhi1 to Lightsail if latency penalty is acceptable. The data isolation and HIPAA path of Bedrock are worth it as OpenBodhi approaches product readiness.
