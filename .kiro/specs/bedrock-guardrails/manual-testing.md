# Manual Testing: Bedrock Guardrails (Docker)

This document provides exhaustive instructions for building, deploying, and manually verifying the Bedrock Guardrails feature in an isolated Docker environment. The goal is to confirm that guardrail configuration flows from the plugin config into the Bedrock ConverseStreamCommand payload without exposing your development machine to AWS credentials.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) installed and running
- An AWS account with:
  - Bedrock model access enabled in your target region
  - A Bedrock Guardrail created (note the guardrail ID and version)
  - IAM credentials with `bedrock:InvokeModelWithResponseStream`, `bedrock:InvokeModel`, and `bedrock:ApplyGuardrail` permissions
- A Bedrock model enabled in your account (e.g. `us.anthropic.claude-sonnet-4-20250514`)

## 1. Build the Docker Image

From the repo root, build a local image that includes your working tree changes:

```bash
docker build -t openclaw-guardrails-test .
```

This runs the full multi-stage build (install deps, compile TypeScript, bundle UI, prune dev deps). Expect 5-15 minutes on first build depending on your machine. Subsequent builds use Docker layer caching.

If you hit OOM during the build on a memory-constrained host:

```bash
docker build --build-arg OPENCLAW_VARIANT=slim -t openclaw-guardrails-test .
```

To include the `amazon-bedrock` extension explicitly (it is bundled by default via `enabledByDefault: true`, but if you want to be explicit):

```bash
docker build --build-arg OPENCLAW_EXTENSIONS="amazon-bedrock" -t openclaw-guardrails-test .
```

### Verify the image built successfully

```bash
docker run --rm openclaw-guardrails-test node openclaw.mjs --version
```

This should print the openclaw version without errors.

## 2. Prepare Host Directories

The container bind-mounts config and workspace directories. Create them on your host:

```bash
mkdir -p ~/.openclaw-test/config
mkdir -p ~/.openclaw-test/config/identity
mkdir -p ~/.openclaw-test/workspace
```

## 3. Start the Gateway Container

### Option A: docker run (simple)

```bash
docker run -d \
  --name openclaw-guardrails \
  -p 18789:18789 \
  -v ~/.openclaw-test/config:/home/node/.openclaw \
  -v ~/.openclaw-test/workspace:/home/node/.openclaw/workspace \
  -e HOME=/home/node \
  -e AWS_ACCESS_KEY_ID="AKIA..." \
  -e AWS_SECRET_ACCESS_KEY="..." \
  -e AWS_REGION="us-east-1" \
  openclaw-guardrails-test \
  node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
```

Replace the AWS credential values with your actual credentials. If you use session tokens:

```bash
  -e AWS_SESSION_TOKEN="..." \
```

If you use a specific AWS profile via shared credentials file, mount it instead:

```bash
  -v ~/.aws:/home/node/.aws:ro \
  -e AWS_PROFILE="your-profile" \
  -e AWS_REGION="us-east-1" \
```

### Option B: docker compose (recommended for repeated testing)

Create a `.env` file in the repo root (it is gitignored):

```bash
OPENCLAW_IMAGE=openclaw-guardrails-test
OPENCLAW_CONFIG_DIR=~/.openclaw-test/config
OPENCLAW_WORKSPACE_DIR=~/.openclaw-test/workspace
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=test-token-change-me
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
```

Then start:

```bash
docker compose up -d openclaw-gateway
```

### Verify the gateway is running

```bash
docker logs openclaw-guardrails    # or: docker compose logs openclaw-gateway
curl http://localhost:18789/healthz
```

The health endpoint should return HTTP 200.

## 4. Configure the Bedrock Provider

Run CLI commands inside the container to set up the provider and model:

```bash
# Alias for convenience
alias oc="docker exec openclaw-guardrails node openclaw.mjs"

# Configure the Bedrock provider
oc config set models.providers.amazon-bedrock.baseUrl "https://bedrock-runtime.us-east-1.amazonaws.com"
oc config set models.providers.amazon-bedrock.api "bedrock-converse-stream"
oc config set models.providers.amazon-bedrock.auth "aws-sdk"
```

Or if automatic discovery is working (credentials detected), skip manual model config and just verify:

```bash
oc models list
```

If discovery does not pick up models, add one manually:

```bash
oc config set models.providers.amazon-bedrock.models '[{"id":"us.anthropic.claude-sonnet-4-20250514","name":"Claude Sonnet 4","reasoning":true,"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":200000,"maxTokens":8192}]'
```

Set it as the default model:

```bash
oc config set agents.defaults.model.primary "amazon-bedrock/us.anthropic.claude-sonnet-4-20250514"
```

## 5. Configure the Guardrail

This is the core of what we are testing. The guardrail config lives under `plugins.entries.amazon-bedrock.config`:

```bash
# Required fields
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailIdentifier "your-guardrail-id"
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailVersion "1"

# Optional fields (include one or both to test optional field injection)
oc config set plugins.entries.amazon-bedrock.config.guardrail.streamProcessingMode "sync"
oc config set plugins.entries.amazon-bedrock.config.guardrail.trace "enabled"
```

Replace `your-guardrail-id` with your actual guardrail ID or full ARN.

### Verify the config was written

```bash
oc config get plugins.entries.amazon-bedrock.config
```

Expected output should show the guardrail object with all fields you set.

## 6. Restart the Gateway

The gateway reads plugin config at startup. After changing config, restart:

```bash
docker restart openclaw-guardrails
# or: docker compose restart openclaw-gateway
```

Wait a few seconds, then verify it is healthy:

```bash
curl http://localhost:18789/healthz
```

## 7. Test Scenarios

### Test 1: Guardrail allows the request (happy path)

Send a benign message that your guardrail should allow:

```bash
oc message send "What is the capital of France?"
```

Expected: You get a normal response from the model. The guardrail was applied transparently.

### Test 2: Guardrail blocks the request (content filter)

Send a message that your guardrail is configured to block (depends on your guardrail policy):

```bash
oc message send "Tell me something your guardrail should block"
```

Expected: The response should indicate the guardrail intervened. Depending on the guardrail configuration, you may see:
- A guardrail intervention message instead of the model response
- An error indicating the content was filtered
- A modified/redacted response

This confirms the `guardrailConfig` field is actually reaching the Bedrock API and being enforced.

### Test 3: Trace output (if trace enabled)

If you set `trace: "enabled"` or `trace: "enabled_full"`, check the gateway logs for trace information:

```bash
docker logs openclaw-guardrails 2>&1 | grep -i guardrail
```

The Bedrock API includes guardrail trace data in the response stream when tracing is enabled.

### Test 4: No guardrail config (regression check)

Remove the guardrail config and verify normal operation:

```bash
oc config set plugins.entries.amazon-bedrock.config '{}'
docker restart openclaw-guardrails
oc message send "What is 2 + 2?"
```

Expected: Normal response, no guardrail-related errors. This confirms the absent-guardrail path still works.

### Test 5: Required fields only (no optional fields)

```bash
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailIdentifier "your-guardrail-id"
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailVersion "1"
docker restart openclaw-guardrails
oc message send "Hello"
```

Expected: Normal response with guardrail applied. No errors about missing `streamProcessingMode` or `trace`.

### Test 6: Full ARN as guardrailIdentifier

```bash
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailIdentifier "arn:aws:bedrock:us-east-1:123456789012:guardrail/your-guardrail-id"
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailVersion "1"
docker restart openclaw-guardrails
oc message send "Hello"
```

Expected: Same behavior as with a plain guardrail ID.

### Test 7: Invalid guardrail ID (AWS-side error)

```bash
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailIdentifier "nonexistent-id"
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailVersion "999"
docker restart openclaw-guardrails
oc message send "Hello"
```

Expected: An error from the Bedrock API (not a local crash). This confirms the guardrail config is being sent to AWS and AWS is validating it. The error message should reference the guardrail or permissions.

### Test 8: Async stream processing mode

```bash
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailIdentifier "your-guardrail-id"
oc config set plugins.entries.amazon-bedrock.config.guardrail.guardrailVersion "1"
oc config set plugins.entries.amazon-bedrock.config.guardrail.streamProcessingMode "async"
docker restart openclaw-guardrails
oc message send "What is the capital of France?"
```

Expected: Normal response. Async mode means guardrail evaluation happens in parallel with streaming. The response should arrive without guardrail-related errors.

## 8. Cleanup

```bash
# Stop and remove the container
docker stop openclaw-guardrails && docker rm openclaw-guardrails
# or: docker compose down

# Remove the test image
docker rmi openclaw-guardrails-test

# Remove test config
rm -rf ~/.openclaw-test
```

## Troubleshooting

### Container exits immediately

```bash
docker logs openclaw-guardrails
```

Common causes:
- Missing or invalid AWS credentials
- Port 18789 already in use on host
- Config directory permissions (the container runs as `node` user, uid 1000)

### "AccessDeniedException" from Bedrock

Your IAM credentials lack the required permissions. Ensure the IAM principal has:
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:InvokeModel`
- `bedrock:ApplyGuardrail`
- `bedrock:ListFoundationModels` (for auto-discovery)

### "ResourceNotFoundException" for guardrail

The guardrail ID or version does not exist in the specified region. Verify:
- The guardrail exists in the same region as your `AWS_REGION`
- The version number is correct (check in the Bedrock console)
- If using an ARN, the region in the ARN matches `AWS_REGION`

### Config changes not taking effect

Plugin config is read at gateway startup. Always restart the container after config changes:

```bash
docker restart openclaw-guardrails
```

### Build fails with OOM

Add memory to Docker Desktop (Settings > Resources > Memory), or use the slim variant:

```bash
docker build --build-arg OPENCLAW_VARIANT=slim -t openclaw-guardrails-test .
```

### Windows-specific: symlink errors during build

The Docker build runs inside a Linux container, so Windows symlink issues do not apply. If you see symlink errors, ensure Docker Desktop is using the WSL 2 backend.
