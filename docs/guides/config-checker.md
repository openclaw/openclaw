# Configuration Checker

Use the configuration checker to validate your `openclaw.json` setup and catch common mistakes before they cause issues in production.

## 1. What it is

The checker validates your configuration against security best practices and common pitfalls. It warns you about:

- Insecure passwords
- Exposed ports
- Permissive channel access
- Missing environment variables
- Costly model choices

## 2. Usage

You can run the checker using the npm script included with OpenClaw:

```bash
# Using npm
npm run check-config

# Using pnpm
pnpm check-config
```

Or you can run the script directly:

```bash
node scripts/check-common-mistakes.js
```

## 3. What it Checks

The script performs the following validation checks:

### Security Issues

- **Passwords**: Warns if using weak passwords like "admin" or "change-me".
- **AllowFrom**: Warns if `allowFrom` contains `"*"` (allow all) or is missing.
- **Gateway Binding**: Warns if `gateway.bind` is set to `0.0.0.0` (all interfaces) which exposes the gateway to the network.
- **Exec Tool**: Errors if `exec` is enabled without requiring approvals (`approvals: "off"`).

### Cost Optimization

- **Models**: Checks if expensive models (like Opus or large contexts) are configured and warns to monitor costs.
- **Tokens**: Warns if `maxTokens` is set extremely high.

### Environment Variables

- Scans the config for `${VAR_NAME}` patterns and reports any that are not set in the current environment.

### DM Policies

- Flag channels with specific misconfigurations like `dmPolicy: "open"` combined with `allowFrom: "*"`.

## 4. Example Output

```text
🦞 OpenClaw Configuration Checker
Reading config from: /Users/claw/.openclaw/openclaw.json

Running Configuration Checks...

⚠ Weak password detected: "change-me-please". Please change it.
⚠ Channel "whatsapp" allows EVERYONE ('*'). Highly insecure for production.
✔ Gateway bound to 127.0.0.1.
✔ Model selection seems cost-effective: anthropic/claude-3-haiku-20240307
✔ Exec tool requires approvals.

---------------------------------------------------
⚠ Found 2 potential issue(s). Please review above.
```

## 5. Running Automatically

You can add this to your CI/CD pipeline or as a pre-start hook to prevent bad configs from being deployed.

Example `package.json` script:

```json
"scripts": {
  "prestart": "node scripts/check-common-mistakes.js"
}
```
