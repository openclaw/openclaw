# Manual Testing: Bedrock Guardrails (Docker)

This document provides exhaustive instructions for building, deploying, and manually verifying the Bedrock Guardrails feature in an isolated Docker environment. The goal is to confirm that guardrail configuration flows from the plugin config into the Bedrock ConverseStreamCommand payload without exposing your development machine to AWS credentials.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin) installed and running
- AWS CLI configured with a principal that can call `sts:AssumeRole`
- An AWS account with the bedrock-obs infrastructure deployed:
  - Bedrock model access enabled in your target region
  - A Bedrock Guardrail created (note the guardrail ID and version)
  - Application inference profiles provisioned (e.g. `test-pipeline-sonnet46`)
  - An IAM role for openclaw testing with:
    - `bedrock:InvokeModelWithResponseStream` and `bedrock:InvokeModel` scoped to the test inference profiles
    - `bedrock:ApplyGuardrail` for the production guardrail
    - Guardrail deny enforcement (rejects any Bedrock call without the guardrail attached)
    - `bedrock:ListFoundationModels` (for auto-discovery, optional)
  - A trust policy on the role allowing your CLI principal to assume it

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

## 3. Obtain Temporary Credentials via STS

Assume the test role to get ephemeral credentials. These expire after the specified duration (default 1 hour, max depends on role config) and require no cleanup.

```bash
ROLE_ARN="arn:aws:iam::ACCOUNT_ID:role/your-openclaw-test-role"
REGION="us-east-1"

# Assume the role (adjust --duration-seconds as needed, max 3600 for most roles)
CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "openclaw-guardrail-test" \
  --duration-seconds 3600 \
  --output json)

# Extract the temporary credentials
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')
export AWS_REGION="$REGION"

# Verify the assumed identity
aws sts get-caller-identity
```

The output should show the assumed role ARN, confirming you have the right principal.

These credentials are temporary and scoped to the role's permissions. The guardrail
deny enforcement on the role means any Bedrock call without `guardrailConfig` attached
will be rejected by IAM — making a successful model response proof that the injection
is working end-to-end.

> If credentials expire mid-test, re-run the `aws sts assume-role` block and restart
> the container with fresh values.

## 4. Start the Gateway Container

### Option A: docker run (simple)

Pass the STS temporary credentials as environment variables:

```bash
docker run -d \
  --name openclaw-guardrails \
  -p 18789:18789 \
  -v ~/.openclaw-test/config:/home/node/.openclaw \
  -v ~/.openclaw-test/workspace:/home/node/.openclaw/workspace \
  -e HOME=/home/node \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
  -e AWS_REGION="$AWS_REGION" \
  openclaw-guardrails-test \
  node openclaw.mjs gateway --allow-unconfigured --bind lan --port 18789
```

### Option B: docker compose (recommended for repeated testing)

Create a `.env` file in the repo root (it is gitignored):

```bash
OPENCLAW_IMAGE=openclaw-guardrails-test
OPENCLAW_CONFIG_DIR=~/.openclaw-test/config
OPENCLAW_WORKSPACE_DIR=~/.openclaw-test/workspace
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=test-token-change-me
AWS_ACCESS_KEY_ID=<from STS output>
AWS_SECRET_ACCESS_KEY=<from STS output>
AWS_SESSION_TOKEN=<from STS output>
AWS_REGION=us-east-1
```

Then start:

```bash
docker compose up -d openclaw-gateway
```

> When credentials expire, update the `.env` file with fresh STS values and
> `docker compose up -d openclaw-gateway` to recreate the container.

### Option C: Pre-seed config with guardrail details

For a zero-touch start where the container boots with guardrails already configured,
write the config JSON before starting:

```bash
cat > ~/.openclaw-test/config/config.json << EOF
{
  "plugins": {
    "entries": {
      "amazon-bedrock": {
        "config": {
          "guardrail": {
            "guardrailIdentifier": "$GUARDRAIL_ID",
            "guardrailVersion": "$GUARDRAIL_VERSION"
          }
        }
      }
    }
  }
}
EOF
```

This skips the manual `config set` steps in section 6. The shell expands
`$GUARDRAIL_ID` and `$GUARDRAIL_VERSION` at write time, so set those in your
environment or replace them with literal values.

### Verify the gateway is running

```bash
docker logs openclaw-guardrails    # or: docker compose logs openclaw-gateway
curl http://localhost:18789/healthz
```

The health endpoint should return HTTP 200.

## 5. Configure the Bedrock Provider

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

## 6. Configure the Guardrail

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

## 7. Restart the Gateway

The gateway reads plugin config at startup. After changing config, restart:

```bash
docker restart openclaw-guardrails
# or: docker compose restart openclaw-gateway
```

Wait a few seconds, then verify it is healthy:

```bash
curl http://localhost:18789/healthz
```

## 8. Test Scenarios

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

Remove the guardrail config and verify behavior:

```bash
oc config set plugins.entries.amazon-bedrock.config '{}'
docker restart openclaw-guardrails
oc message send "What is 2 + 2?"
```

Expected behavior depends on your IAM setup:
- If the role has guardrail deny enforcement: the request is rejected with `AccessDeniedException` because no `guardrailConfig` is present in the payload. This is correct — the deny policy is doing its job.
- If the role does NOT have guardrail deny enforcement: normal response, no guardrail-related errors. This confirms the absent-guardrail code path still works.

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

## 9. Cleanup

```bash
# Stop and remove the container
docker stop openclaw-guardrails && docker rm openclaw-guardrails
# or: docker compose down

# Remove the test image
docker rmi openclaw-guardrails-test

# Remove test config
rm -rf ~/.openclaw-test

# STS temporary credentials expire automatically — no IAM cleanup needed.
# Unset them from your shell if desired:
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION
```

## Troubleshooting

### Container exits immediately

```bash
docker logs openclaw-guardrails
```

Common causes:
- Missing or expired STS credentials (re-run the assume-role block in section 3)
- Port 18789 already in use on host
- Config directory permissions (the container runs as `node` user, uid 1000)

### "AccessDeniedException" from Bedrock

Either the STS credentials expired or the role lacks required permissions. Check:
- Run `aws sts get-caller-identity` with the same env vars to confirm they are still valid
- If expired, re-run the assume-role block and restart the container with fresh values
- Ensure the role has `bedrock:InvokeModelWithResponseStream`, `bedrock:InvokeModel`, and `bedrock:ApplyGuardrail`
- If your role has guardrail deny enforcement and the request was rejected, this likely means the `guardrailConfig` was not injected — which is the bug you are looking for

### "AccessDeniedException" specifically mentioning guardrail deny

This is the IAM deny policy from your bedrock-obs infrastructure rejecting a call
that lacks `guardrailConfig`. If you see this when guardrail config IS set in openclaw,
it means the injection is not working correctly. Check:
- The guardrail config was written: `oc config get plugins.entries.amazon-bedrock.config`
- The gateway was restarted after config changes
- The guardrail ID and version match what the deny policy expects

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
