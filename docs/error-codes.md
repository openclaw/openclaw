# OpenClaw CLI Error Codes Reference

This document provides a comprehensive reference of all error codes used by the OpenClaw CLI, along with their meanings, causes, and solutions.

## Error Code Format

All error codes follow the format: `ERR_CATEGORY_SPECIFIC`

Examples:
- `ERR_AUTH_FAILED` - Authentication category, failed sub-category
- `ERR_CONFIG_INVALID` - Configuration category, invalid sub-category
- `ERR_GATEWAY_TIMEOUT` - Gateway category, timeout sub-category

## Error Categories

### Authentication Errors (`ERR_AUTH_*`)

These errors occur when authentication or authorization fails.

#### ERR_AUTH_FAILED
**Severity**: ERROR  
**What it means**: Your credentials could not be verified by the gateway.

**Common causes**:
- API key or token is incorrect
- Token has been revoked or invalidated
- Gateway server is rejecting valid tokens
- Three-layer authentication mismatch (local, gateway, upstream)

**How to fix**:
1. Verify your API key or token is copied correctly
2. Run `openclaw auth refresh` to refresh credentials
3. Check that `openclaw gateway status` shows the gateway is running
4. If using a remote gateway, verify network connectivity

**Learn more**: https://docs.openclaw.ai/getting-started/authentication

---

#### ERR_AUTH_TOKEN_EXPIRED
**Severity**: WARN  
**What it means**: Your authentication token has expired and is no longer valid.

**How to fix**:
1. Run `openclaw auth refresh` to refresh your token
2. If refresh fails, log out and log in again:
   ```bash
   openclaw auth logout
   openclaw auth login
   ```
3. Check that your system clock is synchronized (time skew can cause this)

---

#### ERR_AUTH_TOKEN_INVALID
**Severity**: ERROR  
**What it means**: The provided token is malformed or not recognized.

**How to fix**:
1. Verify the token was copied correctly (no extra spaces, characters, or newlines)
2. Run `openclaw auth login` to generate a new token
3. Ensure you're using the correct authentication method for your setup

---

#### ERR_AUTH_MISSING
**Severity**: ERROR  
**What it means**: No authentication credentials found. OpenClaw couldn't locate your API key or token.

**How to fix**:
1. Run `openclaw auth login` to authenticate
2. Or set your API key as an environment variable: `export OPENCLAW_AUTH_TOKEN=your_token`
3. Check that `~/.openclaw/config/auth.json` exists and is readable
4. Verify file permissions: `ls -la ~/.openclaw/config/`

---

#### ERR_AUTH_PAIRING_REQUIRED
**Severity**: WARN  
**What it means**: Your device is not yet paired with the OpenClaw gateway.

**How to fix**:
1. Run `openclaw device pair` to initiate pairing
2. Scan the QR code with your device's OpenClaw app
3. Ensure your gateway server is accessible from your device
4. If pairing fails, check your network connectivity

---

### Configuration Errors (`ERR_CONFIG_*`)

These errors occur when configuration files are missing, invalid, or malformed.

#### ERR_CONFIG_INVALID
**Severity**: ERROR  
**What it means**: Your configuration file contains invalid values or is malformed.

**How to fix**:
1. Check your configuration: `cat ~/.openclaw/config/config.json`
2. Run `openclaw config validate` to identify specific issues
3. Run `openclaw config doctor --fix` to auto-repair common issues
4. Review the configuration documentation

**Learn more**: https://docs.openclaw.ai/configuration

---

#### ERR_CONFIG_MISSING
**Severity**: ERROR  
**What it means**: A required configuration value is missing.

**How to fix**:
1. Run `openclaw config init` to initialize configuration
2. Run `openclaw config doctor --fix` to auto-fill missing values
3. Manually add the missing value to `~/.openclaw/config/config.json`

---

#### ERR_CONFIG_PARSE
**Severity**: ERROR  
**What it means**: The configuration file is corrupted or contains invalid JSON.

**How to fix**:
1. Validate JSON: `jq . ~/.openclaw/config/config.json`
2. If validation fails, back up the file: `mv ~/.openclaw/config/config.json ~/.openclaw/config/config.json.bak`
3. Run `openclaw config init` to create fresh configuration
4. Restore any custom settings from the backup

---

#### ERR_CONFIG_FILE_NOT_FOUND
**Severity**: WARN  
**What it means**: Configuration file not found at the expected location.

**How to fix**:
1. Run `openclaw config init` to create the default configuration
2. Ensure `~/.openclaw/config/` directory exists: `mkdir -p ~/.openclaw/config/`
3. Check file permissions in home directory

---

### Gateway/Connection Errors (`ERR_GATEWAY_*`)

These errors occur when the gateway is unavailable or unreachable.

#### ERR_GATEWAY_UNAVAILABLE
**Severity**: ERROR  
**What it means**: The OpenClaw gateway is not responding or not running.

**How to fix**:
1. Check gateway status: `openclaw gateway status`
2. Start the gateway: `openclaw gateway start`
3. Check gateway is listening: `netstat -tuln | grep LISTEN | grep openclaw` or similar
4. If using a remote gateway, verify network connectivity
5. Check firewall rules allow connection to gateway port

**Learn more**: https://docs.openclaw.ai/gateway/troubleshooting

---

#### ERR_GATEWAY_TIMEOUT
**Severity**: WARN  
**What it means**: The gateway took too long to respond to your request.

**How to fix**:
1. Check your network connection speed and stability
2. Try the command again (may be temporary)
3. Use `--timeout <ms>` flag if available to increase timeout
4. Check gateway logs: `openclaw logs --follow`
5. Restart the gateway if it's unresponsive: `openclaw gateway restart`

---

#### ERR_GATEWAY_CONNECTION_FAILED
**Severity**: ERROR  
**What it means**: Failed to establish connection to the gateway.

**How to fix**:
1. Verify gateway is running: `openclaw gateway status`
2. Check gateway URL is correct: `openclaw config get gateway.remote.url`
3. Test network connectivity to gateway host
4. Verify firewall rules allow outbound connections
5. Check gateway logs for errors: `openclaw logs --follow gateway`

---

#### ERR_GATEWAY_UNAUTHORIZED
**Severity**: ERROR  
**What it means**: The gateway rejected your request due to insufficient permissions.

**How to fix**:
1. Verify your gateway token: `openclaw config get gateway.token`
2. Run `openclaw auth refresh` to get fresh credentials
3. Check user role and permissions
4. Ensure connecting to the correct gateway instance

---

### Permission Errors (`ERR_PERMISSION_*`)

These errors occur when you lack necessary permissions for an operation.

#### ERR_PERMISSION_DENIED
**Severity**: ERROR  
**What it means**: You don't have permission to perform this operation.

**How to fix**:
1. Check your user role: `openclaw auth whoami`
2. Contact your administrator to request access
3. Log in with a different account that has the necessary permissions
4. Check that you're using the correct authentication context

**Learn more**: https://docs.openclaw.ai/security/permissions

---

#### ERR_PERMISSION_INSUFFICIENT
**Severity**: WARN  
**What it means**: Your current role doesn't have the required permissions.

**How to fix**:
1. Request higher permissions from an administrator
2. Use a different account with the necessary permissions
3. Check if this is an admin-only operation

---

### Resource Errors (`ERR_RESOURCE_*`)

These errors occur when working with resources (agents, skills, models, etc.).

#### ERR_RESOURCE_NOT_FOUND
**Severity**: WARN  
**What it means**: The requested resource doesn't exist or couldn't be found.

**How to fix**:
1. Verify the resource ID or name is correct
2. List available resources to find the right one
3. Check the resource hasn't been deleted
4. Ensure you're searching in the correct scope/workspace

---

#### ERR_RESOURCE_INVALID
**Severity**: ERROR  
**What it means**: The resource data is malformed or invalid.

**How to fix**:
1. Check resource definition against the schema
2. Verify all required fields are present
3. Review documentation for correct resource format
4. Use `--help` on the command to see examples

---

### Rate Limiting (`ERR_RATE_LIMIT_*`)

#### ERR_RATE_LIMIT_EXCEEDED
**Severity**: WARN  
**What it means**: Too many requests were made in a short time. Please wait before trying again.

**How to fix**:
1. Wait a few moments before retrying
2. Reduce the frequency of requests
3. Serialize parallel operations instead of running them concurrently
4. Consider using batch operations if available

**Learn more**: https://docs.openclaw.ai/rate-limiting

---

### Provider/Model Errors

#### ERR_MODEL_NOT_FOUND
**Severity**: WARN  
**What it means**: The specified AI model is not available.

**How to fix**:
1. Check model name spelling
2. List available models: `openclaw models list`
3. Verify the model is enabled in configuration
4. Check that your provider has this model in their catalog

---

#### ERR_PROVIDER_UNAVAILABLE
**Severity**: WARN  
**What it means**: The AI provider is not responding or temporarily unavailable.

**How to fix**:
1. Check the provider's status page for outages
2. Verify your provider credentials are still valid
3. Try a different model or provider
4. Retry after a few moments (may be temporary)

---

#### ERR_PROVIDER_INVALID
**Severity**: ERROR  
**What it means**: The specified provider is not recognized or not installed.

**How to fix**:
1. Check provider name spelling
2. List available providers: `openclaw providers list`
3. Ensure the provider is installed: `openclaw provider install <name>`
4. Verify provider configuration

---

### Network Errors

#### ERR_NETWORK_ERROR
**Severity**: ERROR  
**What it means**: A network error occurred preventing communication.

**How to fix**:
1. Check your internet connection
2. Verify firewall and proxy settings
3. Try the command again
4. If using a proxy, ensure it's properly configured

**Learn more**: https://docs.openclaw.ai/troubleshooting/network

---

#### ERR_NETWORK_TIMEOUT
**Severity**: WARN  
**What it means**: Network request timed out.

**How to fix**:
1. Check network connection quality
2. Try again (may be temporary)
3. Increase timeout if the flag is available
4. Try wired connection if on WiFi

---

### Input Validation Errors

#### ERR_INVALID_INPUT
**Severity**: ERROR  
**What it means**: The provided input doesn't meet expected format or constraints.

**How to fix**:
1. Check command syntax: `openclaw <command> --help`
2. Verify all required parameters are provided
3. Check for invalid characters or encoding
4. Review specific validation error details

**Learn more**: https://docs.openclaw.ai/cli/usage

---

#### ERR_INVALID_ARGUMENT
**Severity**: ERROR  
**What it means**: Unrecognized or invalid command line argument.

**How to fix**:
1. Check argument spelling
2. Use `--help` to see valid arguments
3. Verify argument format (--key=value vs --key value)
4. Quote arguments containing spaces: `--arg "value with spaces"`

---

### Internal Errors

#### ERR_INTERNAL_ERROR
**Severity**: FATAL  
**What it means**: An unexpected error occurred (likely a bug).

**How to fix**:
1. Try running the command again
2. Check logs: `openclaw logs --follow`
3. If problem persists, report on GitHub with:
   - Full error message and stack trace
   - OpenClaw version: `openclaw --version`
   - Your system info: `uname -a`
   - Command that triggered the error
   - Any relevant configuration (redacted)

---

## Error Message Format

When OpenClaw displays an error, it uses a consistent format:

```
❌ ERR_CODE
📝 What happened: Description of the error
💡 How to fix: Numbered steps to resolve the issue
🔗 Learn more: URL to relevant documentation
```

### Example

```
❌ ERR_AUTH_FAILED
📝 What happened: Authentication failed. Your credentials could not be verified by the gateway.
💡 How to fix:
  1. Verify your API key or token is correct and not expired
  2. Try running `openclaw auth refresh` to refresh credentials
  3. Check that your gateway server is running: `openclaw gateway status`
  4. If using token auth, ensure the token hasn't been revoked
🔗 Learn more: https://docs.openclaw.ai/getting-started/authentication
```

## Severity Levels

- **INFO** (ℹ️): Informational message
- **WARN** (⚠️): Warning - operation may not behave as expected
- **ERROR** (❌): Error - operation failed
- **FATAL** (🔴): Fatal error - process cannot continue

## Getting Help

If you encounter an error not documented here:

1. Check the error code format - all codes start with `ERR_`
2. Search the documentation: https://docs.openclaw.ai/
3. Check GitHub issues: https://github.com/openclaw/openclaw/issues
4. Open a new issue with:
   - Error code and full error message
   - Steps to reproduce
   - OpenClaw version and system info
   - Relevant configuration (redacted)

## For Developers

### Adding New Error Codes

1. Add the code to `CLI_ERROR_CODES` in `src/errors/error-codes.ts`
2. Add entry to `ERROR_MESSAGES` in `src/errors/error-messages.ts`
3. Include clear description and actionable suggestions
4. Provide documentation URL
5. Update this reference document
6. Add unit test cases for the new error

### Using FormattedError in Your Code

```typescript
import { createFormattedError } from "../src/errors/error-messages.js";

// Create error from catalog
const error = createFormattedError("ERR_AUTH_FAILED", {
  message: "Token validation failed",
  context: {
    command: "agent",
  },
});

throw error;
```

### Displaying Errors

```typescript
import { ErrorFormatter } from "../src/errors/error-formatter.js";

try {
  // ... your code
} catch (error) {
  console.error(ErrorFormatter.formatForDisplay(error));
  process.exit(1);
}
```
