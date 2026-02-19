# ConsentGate v2 React artifact — SANDBOX_FLAGS fix

When running the OpenClaw ConsentGate v2 React component (e.g. as a Cursor artifact), the error **"SANDBOX_FLAGS is not defined"** happens because the attack card `payload` uses a **template literal** (backticks). In that string, `${SANDBOX_FLAGS}` is treated as JavaScript interpolation.

## Fix

In the **sandbox-flags-injection** attack object, change the `payload` so the shell variable is not interpolated:

- **Before:** `docker run ${SANDBOX_FLAGS} gemini-cli-sandbox`
- **After:** `docker run \${SANDBOX_FLAGS} gemini-cli-sandbox`

So the full payload should be (with the backslash before `$`):

```js
payload:
`// Attacker controls SANDBOX_FLAGS env var:
SANDBOX_FLAGS="-e MALICIOUS_VAR=payload --cap-add=SYS_ADMIN"

// Gemini CLI sandbox init (pre-patch):
docker run \${SANDBOX_FLAGS} gemini-cli-sandbox

// With SYS_ADMIN capability: full container escape
// PR #6901 fix: sanitize SANDBOX_FLAGS before interpolation`,
```

Any other **display-only** code in backtick strings that contains `${someVar}` (e.g. bash/shell snippets) should also use `\${someVar}` so JavaScript does not interpolate it.
