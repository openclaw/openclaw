# OpenClaw Security Audit - Consolidated Report

**Date:** 2026-02-06
**Scope:** Full codebase, dependencies, and extensions
**Method:** 6 parallel security review agents (373 tool calls, ~831K tokens analyzed)
**Domains:** Command Injection, Secrets & Tokens, Auth & Access Control, Dependency Supply Chain, Network Exposure & Input Validation, File System & Deserialization

---

## Executive Summary

| Severity     | Raw Count | After Dedup |
| ------------ | --------- | ----------- |
| **CRITICAL** | 13        | **11**      |
| **HIGH**     | 27        | **20**      |
| **MEDIUM**   | 34        | **27**      |
| **LOW**      | 22        | **18**      |
| **Total**    | 96        | **76**      |

**Overall Risk: HIGH** - The codebase has a strong security architecture (sandbox isolation, allowlists, SSRF guards, timing-safe auth on primary paths), but several critical gaps exist that could lead to host compromise, secret exfiltration, or unauthorized access.

---

## CRITICAL Findings (11) - Fix Immediately

### CRIT-1: Elevated `full` Mode Bypasses All Exec Approvals

- **Source:** CMD-001
- **File:** `src/agents/bash-tools.exec.ts:940-948`
- **Description:** When `elevated=full` is configured, the AI agent can pass `elevated: true` to completely disable the allowlist and approval system, enabling arbitrary command execution with no human oversight. A jailbroken or prompt-injected agent gets unrestricted shell access.
- **Code:**
  ```typescript
  if (elevatedRequested && elevatedMode === "full") {
    security = "full";
  }
  const bypassApprovals = elevatedRequested && elevatedMode === "full";
  if (bypassApprovals) {
    ask = "off";
  }
  ```
- **Impact:** Full arbitrary command execution on the gateway host with zero approval gates.
- **Mitigation:** The `full` level should require per-command human approval rather than blanket bypass. Consider removing the `full` option entirely, or implementing a secondary confirmation mechanism that cannot be bypassed by the AI agent. At minimum, `full` should still enforce the dangerous shell token analysis.

---

### CRIT-2: Hooks Token Comparison Is Not Timing-Safe

- **Source:** AUTH-001 / SEC-001
- **File:** `src/gateway/server-http.ts:86`
- **Description:** The hooks endpoint uses `!==` instead of `timingSafeEqual`. An attacker can progressively recover the token character-by-character via timing side-channel. The hooks endpoint controls agent execution, wake events, and arbitrary hook invocations. The main gateway auth correctly uses `timingSafeEqual` -- this is an inconsistency.
- **Code:**
  ```typescript
  if (!token || token !== hooksConfig.token) {
    res.statusCode = 401;
  ```
- **Impact:** An attacker on the network could recover the full hooks token byte-by-byte, then invoke the `wake` hook, the `agent` hook (execute arbitrary agent commands), and any configured hook mappings.
- **Mitigation:** Replace with the `safeEqual()` timing-safe comparison function already defined in `src/gateway/auth.ts:35-40`.

---

### CRIT-3: Browser Extension Relay Token Not Timing-Safe

- **Source:** SEC-002
- **File:** `src/browser/extension-relay.ts:368,514`
- **Description:** Both HTTP and WebSocket auth paths use `!==`. Recovering this token grants full Chrome DevTools Protocol access -- cookies, localStorage, page content, JavaScript execution across all open tabs.
- **Code:**

  ```typescript
  // Line 368 (HTTP path):
  if (!token || token !== relayAuthToken) {
    res.writeHead(401);

  // Line 514 (WebSocket upgrade):
  if (!token || token !== relayAuthToken) {
    rejectUpgrade(socket, 401, "Unauthorized");
  ```

- **Impact:** Full Chrome DevTools Protocol access enabling reading of cookies, localStorage, page content, and JavaScript execution across all open tabs.
- **Mitigation:** Use `crypto.timingSafeEqual` (wrapped in the `safeEqual` helper from `gateway/auth.ts`) for both comparison sites.

---

### CRIT-4: No Rate Limiting on Any Authentication Endpoint

- **Source:** AUTH-002 / NET-006
- **File:** `src/gateway/server-http.ts`, `openai-http.ts`, `tools-invoke-http.ts`
- **Description:** Zero rate limiting across all gateway HTTP endpoints and WebSocket auth. Brute-force attacks against tokens are unconstrained. An authenticated attacker can also exhaust upstream API quotas by flooding `/v1/chat/completions`.
- **Impact:** Even with timing-safe comparison on the main gateway auth, a short or low-entropy token can be brute-forced. Millions of attempts per second with no lockout, delay, or rate-limiting mechanism.
- **Mitigation:** Implement per-IP and per-token rate limiting on all gateway HTTP endpoints. A simple token-bucket or sliding-window limiter limiting failed authentication attempts to ~10/minute per IP, with exponential backoff.

---

### CRIT-5: Tar Extraction Vulnerable to Zip Slip (Path Traversal)

- **Source:** FS-001
- **File:** `src/infra/archive.ts:110-116`
- **Description:** Tar extraction via `tar.x()` has no path containment validation. A malicious plugin archive can write files anywhere on the host filesystem. The zip extractor in the same file correctly validates paths -- the tar path was missed.
- **Code:**
  ```typescript
  if (kind === "tar") {
    await withTimeout(
      tar.x({ file: params.archivePath, cwd: params.destDir }),
      params.timeoutMs,
      label,
    );
    return;
  }
  ```
- **Impact:** A malicious plugin archive submitted via `installPluginFromArchive` could overwrite arbitrary files on the host system, leading to remote code execution.
- **Mitigation:** Replicate the zip approach: resolve each entry path and check it stays within `destDir`. Alternatively, pass a `filter` option to reject entries containing `..`.

---

### CRIT-6: Prototype Pollution via Config `deepMerge`

- **Source:** FS-002
- **File:** `src/config/includes.ts:65-77`
- **Description:** The `deepMerge` function doesn't filter `__proto__` or `constructor` keys. A malicious config include file can pollute `Object.prototype`, potentially enabling privilege escalation or code execution depending on downstream consumers.
- **Code:**
  ```typescript
  export function deepMerge(target: unknown, source: unknown): unknown {
    if (isPlainObject(target) && isPlainObject(source)) {
      const result: Record<string, unknown> = { ...target };
      for (const key of Object.keys(source)) {
        result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
      }
      return result;
    }
    return source;
  }
  ```
- **Impact:** Prototype pollution can lead to denial of service, privilege escalation, or code execution depending on how downstream consumers use the polluted objects.
- **Mitigation:** Filter dangerous keys before merging:
  ```typescript
  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    // ...merge logic
  }
  ```

---

### CRIT-7: Docker Sandbox `setupCommand` Executed as Raw Shell String

- **Source:** CMD-002
- **File:** `src/agents/sandbox/docker.ts:242-243`
- **Description:** `cfg.setupCommand` is passed directly to `sh -lc` inside Docker with zero validation. Config file compromise leads to arbitrary code execution inside the sandbox (which mounts the host workspace).
- **Code:**
  ```typescript
  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand]);
  }
  ```
- **Impact:** Arbitrary code execution inside the Docker sandbox container. The sandbox mounts the host workspace directory, so data exfiltration from the workspace is possible.
- **Mitigation:** Validate `setupCommand` against an allowlist of known safe setup patterns, or require it to be a list of arguments (array form) rather than a shell string.

---

### CRIT-8: Matrix Extension Writes Credentials World-Readable

- **Source:** SEC-003
- **File:** `extensions/matrix/src/matrix/credentials.ts:57-82`
- **Description:** Matrix access tokens written with default umask (typically `0o644`). Any local user can read the bot's Matrix credentials. Every other credential store in the codebase correctly uses `0o600`.
- **Code:**
  ```typescript
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(toSave, null, 2), "utf-8");
  ```
- **Impact:** Any local user on the system can read the Matrix access token and impersonate the bot on the Matrix homeserver.
- **Mitigation:** Follow the pattern used throughout the core codebase:
  ```typescript
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credPath, ..., { mode: 0o600 });
  fs.chmodSync(credPath, 0o600);
  ```

---

### CRIT-9: Link Understanding Executes User-Supplied URLs via CLI

- **Source:** NET-001
- **File:** `src/link-understanding/runner.ts:56-68`
- **Description:** User-sent URLs are template-expanded into CLI command arguments. Combined with an incomplete SSRF filter (only blocks `127.0.0.1`, misses all other private ranges, cloud metadata endpoints), this enables SSRF and potential argument injection.
- **Code:**
  ```typescript
  const templCtx = {
    ...params.ctx,
    LinkUrl: params.url,
  };
  const argv = [command, ...args].map((part, index) =>
    index === 0 ? part : applyTemplate(part, templCtx),
  );
  const { stdout } = await runExec(argv[0], argv.slice(1), { ... });
  ```
- **Impact:** Remote code execution on the host machine depending on the configured link understanding command template. SSRF to internal services, potential exposure of cloud metadata credentials.
- **Mitigation:** Expand `isAllowedUrl` to use the comprehensive SSRF protection already in `src/infra/net/ssrf.ts`. Sanitize URL argument values to prevent argument injection (URLs starting with `--`).

---

### CRIT-10: Nextcloud Talk Webhook Has No Body Size Limit

- **Source:** NET-002
- **File:** `extensions/nextcloud-talk/src/monitor.ts:65-71`
- **Description:** Unlimited request body accumulation enables trivial memory exhaustion DoS. A single large POST crashes the entire gateway process.
- **Code:**
  ```typescript
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
  ```
- **Impact:** Denial of service. The gateway process runs out of memory and crashes, taking all connected channels offline.
- **Mitigation:** Add a `maxBodyBytes` limit consistent with the pattern used elsewhere (256KB in `src/gateway/hooks.ts`).

---

### CRIT-11: Deprecated `request` Package with SSRF Vulnerability

- **Source:** DEP-001
- **File:** `extensions/matrix/package.json` -> `@vector-im/matrix-bot-sdk` -> `request@2.88.2`
- **Advisory:** [GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6)
- **Description:** The `request` package is deprecated with no fix available. Also pulls in `uuid@3.4.0` which uses `Math.random()` for UUID generation.
- **Impact:** SSRF vulnerability in the Matrix extension's HTTP operations. Predictable UUIDs in certain code paths.
- **Mitigation:** Upgrade `@vector-im/matrix-bot-sdk` to a version that no longer depends on `request`, or fork the SDK to replace `request` with `undici`/native `fetch`.

---

## HIGH Findings (20)

### HIGH-1: Internal Error Messages Leaked to HTTP API Clients

- **Source:** AUTH-003 / NET-007
- **File:** `src/gateway/openai-http.ts:265,405`, `src/gateway/openresponses-http.ts:592`
- **Code:**
  ```typescript
  sendJson(res, 500, {
    error: { message: String(err), type: "api_error" },
  });
  ```
- **Impact:** Stack traces, file paths, configuration details, and potentially sensitive values exposed to external clients.
- **Mitigation:** Return generic error messages to clients. Log detailed errors server-side only.

---

### HIGH-2: Arbitrary Session Key Injection via HTTP Header

- **Source:** AUTH-004
- **File:** `src/gateway/http-utils.ts:65-79`
- **Description:** Any authenticated user can set `X-OpenClaw-Session-Key` to access any other user's session -- reading conversation history and injecting messages.
- **Impact:** Session hijacking in multi-user deployments.
- **Mitigation:** Validate session keys against the authenticated user's identity or scope them automatically.

---

### HIGH-3: Hooks Token Accepted in URL Query Parameter

- **Source:** AUTH-005 / SEC-004 / NET-016
- **File:** `src/gateway/hooks.ts:51-72`
- **Description:** Tokens in URLs appear in server logs, browser history, Referer headers, proxy logs, and shell history. A deprecation warning exists but acceptance is not blocked.
- **Impact:** Token leakage through infrastructure logging and HTTP headers.
- **Mitigation:** Remove query parameter token support entirely or add a config flag defaulting to rejection.

---

### HIGH-4: Default Scope Escalation -- Operators Get Admin by Default

- **Source:** AUTH-006
- **File:** `src/gateway/server/ws-connection/message-handler.ts:359-367`
- **Description:** Clients connecting without specifying scopes automatically receive `operator.admin`, granting access to ALL gateway methods.
- **Impact:** Privilege escalation. Even limited-access paired devices get full admin if they don't specify scopes.
- **Mitigation:** Default to `operator.read` instead of `operator.admin`.

---

### HIGH-5: Core Exec Tool Passes AI-Agent Commands to Shell

- **Source:** CMD-003
- **File:** `src/agents/bash-tools.exec.ts:544-547`
- **Description:** The core execution tool passes AI model output directly to `sh -c`. Security relies entirely on the allowlist/approval system, which CRIT-1 can bypass.
- **Impact:** Arbitrary command execution if allowlist is bypassed.
- **Mitigation:** Fix CRIT-1. Also consider hardcoding shell path to `/bin/sh` instead of using `process.env.SHELL`.

---

### HIGH-6: `new Function()` and `eval()` in Browser Tool

- **Source:** CMD-004
- **File:** `src/browser/pw-tools-core.interactions.ts:237-268`
- **Description:** The `fn` parameter is passed to `eval()` inside the browser page context via Playwright. Enables arbitrary JavaScript execution -- accessing cookies, localStorage, making network requests as the authenticated user.
- **Impact:** Full JavaScript execution in browser page context. Session token and cookie theft possible.
- **Mitigation:** Restrict `fn` to predefined safe operations or implement CSP restrictions.

---

### HIGH-7: Plugin System Loads Arbitrary Code Without Signing

- **Source:** CMD-005 / FS-005
- **File:** `src/plugins/loader.ts:296`, `src/plugins/discovery.ts:203-299`
- **Description:** `jiti` loads and executes arbitrary TypeScript/JavaScript from discoverable paths with no code signing, integrity verification, or permission model.
- **Impact:** Full arbitrary code execution with gateway process privileges.
- **Mitigation:** Implement plugin signature verification, a declared permission model, and sandboxed execution.

---

### HIGH-8: npm Spec Injection via Plugin Install

- **Source:** CMD-006
- **File:** `src/plugins/install.ts:413-417`
- **Description:** User-provided npm spec is passed to `npm pack` which can trigger lifecycle scripts from malicious packages.
- **Impact:** Arbitrary code execution via npm lifecycle scripts during plugin installation.
- **Mitigation:** Run `npm pack` and `npm install` with `--ignore-scripts` flag.

---

### HIGH-9: TUI Local Shell with `shell: true`

- **Source:** CMD-007
- **File:** `src/tui/tui-local-shell.ts:104-108`
- **Description:** The `!command` feature in TUI passes user input to `spawn` with `shell: true`. Session-wide consent is given once.
- **Impact:** Unrestricted shell access for the entire session after a single approval.
- **Mitigation:** Consider per-command confirmation for dangerous patterns (pipes, redirects, chaining).

---

### HIGH-10: CLI Passes Tokens as Command-Line Arguments

- **Source:** SEC-005
- **File:** Multiple CLI files (`tui-cli.ts`, `gateway-cli/register.ts`, `channels-cli.ts`, etc.)
- **Description:** `--token` and `--password` flags are visible to all local users via `ps aux` and `/proc/<pid>/cmdline`.
- **Impact:** Any local user or monitoring agent can capture gateway tokens and passwords.
- **Mitigation:** Prefer environment variables. Add help text recommending env vars over CLI flags for secrets.

---

### HIGH-11: Status Command Shows Token Previews by Default

- **Source:** SEC-006
- **File:** `src/commands/status.scan.ts:146-147`, `src/commands/status-all/channels.ts:64-74`
- **Description:** `showSecrets` defaults to `true`, exposing first/last 4 characters of every channel token in terminal output.
- **Impact:** Token fragments captured by screen recording, shoulder surfing, terminal scrollback, or log aggregation.
- **Mitigation:** Default `showSecrets` to `false`.

---

### HIGH-12: Hook Handler Loads Arbitrary Module Paths from Config

- **Source:** FS-003
- **File:** `src/hooks/loader.ts:110-143`
- **Description:** `hooks.internal.handlers[].module` accepts any filesystem path. Config compromise leads to arbitrary code execution.
- **Impact:** Full remote code execution via module loading.
- **Mitigation:** Restrict hook handler module paths to within known hooks directories.

---

### HIGH-13: Unrestricted Local File Read in Web Media

- **Source:** FS-004
- **File:** `src/web/media.ts:123-241`
- **Description:** `file:///etc/passwd` or any absolute path causes the gateway to read arbitrary files from the local filesystem.
- **Impact:** Information disclosure -- arbitrary file read of private keys, config files with API tokens, session data.
- **Mitigation:** Restrict local file reads to an allowlisted base directory.

---

### HIGH-14: SCP Command Injection via `remoteHost`

- **Source:** FS-006
- **File:** `src/auto-reply/reply/stage-sandbox-media.ts:167-197`
- **Description:** A `remoteHost` value like `-oProxyCommand=malicious_command` would be interpreted as an SCP flag.
- **Impact:** Command execution on the local system via SCP flag injection.
- **Mitigation:** Validate `remoteHost` against a hostname pattern. Prepend `--` before positional arguments.

---

### HIGH-15: `ensureDir` Missing Restrictive Permissions

- **Source:** FS-007
- **File:** `src/utils.ts:7-9`
- **Description:** Directories created with default umask (typically `0o755`), allowing other local users to read contents.
- **Impact:** Sensitive session data, configs, or media files readable by other local users.
- **Mitigation:** Add `mode: 0o700` to the `mkdir` call.

---

### HIGH-16: Canvas Host Defaults to 0.0.0.0

- **Source:** NET-003
- **File:** `src/canvas-host/server.ts:452`
- **Description:** Binds to all network interfaces by default, exposing user-generated HTML files to the LAN.
- **Mitigation:** Default to `127.0.0.1`.

---

### HIGH-17: Telegram Webhook Defaults to 0.0.0.0

- **Source:** NET-004
- **File:** `src/telegram/webhook.ts:36`
- **Description:** Binds to all interfaces with optional (not required) secret token.
- **Mitigation:** Default to `127.0.0.1`. Require secret when binding to `0.0.0.0`.

---

### HIGH-18: GitHub Tarball Dependency for Signal Crypto Library

- **Source:** DEP-002
- **Package:** `@whiskeysockets/libsignal-node`
- **Description:** Resolved from a GitHub tarball rather than npm registry. No npm integrity checks, no audit coverage. This is a cryptographic Signal protocol library.
- **Impact:** If the upstream repository is compromised, malicious code injected into the Signal protocol implementation.
- **Mitigation:** Verify integrity hash in lockfile. Advocate for npm publishing upstream.

---

### HIGH-19: `@isaacs/brace-expansion` ReDoS Vulnerability

- **Source:** DEP-003
- **Package:** `@isaacs/brace-expansion@5.0.0` (via `minimatch`)
- **Advisory:** [GHSA-7h2j-956f-4vf2](https://github.com/advisories/GHSA-7h2j-956f-4vf2)
- **Description:** Crafted glob patterns can cause excessive CPU usage.
- **Mitigation:** Add pnpm override: `"@isaacs/brace-expansion": ">=5.0.1"`.

---

### HIGH-20: Multiple Native Module Build Scripts

- **Source:** DEP-007
- **File:** `package.json:200-210`
- **Description:** 9 packages with build-time code execution, including `authenticate-pam` (system-level PAM access).
- **Mitigation:** Keep `onlyBuiltDependencies` allowlist minimal. Review whether `authenticate-pam` is needed.

---

## MEDIUM Findings (27)

### Auth & Access Control

| ID    | Finding                                                                      | File                             |
| ----- | ---------------------------------------------------------------------------- | -------------------------------- |
| MED-1 | `authorizeGatewayMethod` returns authorized when client is null              | `server-methods.ts:93-96`        |
| MED-2 | `dangerouslyDisableDeviceAuth` config persists without expiry                | `message-handler.ts:409`         |
| MED-3 | Self-requested scope and role accepted on WS connect when pairing is skipped | `message-handler.ts:339,359-367` |
| MED-4 | Pairing code brute-force feasible (no rate limit on approval)                | `pairing-store.ts:446-496`       |

### Secrets & Token Handling

| ID    | Finding                                                             | File                          |
| ----- | ------------------------------------------------------------------- | ----------------------------- |
| MED-5 | Token length exposed in security audit findings                     | `security/audit.ts:358`       |
| MED-6 | Telegram bot token stored directly in config file (no warning)      | `telegram/token.ts:68-93`     |
| MED-7 | Dashboard URL with token copied to system clipboard                 | `commands/dashboard.ts:36-38` |
| MED-8 | Logging redaction disableable via config (`redactSensitive: "off"`) | `logging/redact.ts:6-8`       |

### Network Exposure & Input Validation

| ID     | Finding                                                                                      | File                                           |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| MED-9  | Link understanding SSRF filter only blocks `127.0.0.1` (misses all RFC 1918, cloud metadata) | `link-understanding/detect.ts:18-31`           |
| MED-10 | WebSocket origin validation only for browser-identified clients                              | `message-handler.ts:369-399`                   |
| MED-11 | MS Teams extension binds `0.0.0.0` without host configuration                                | `extensions/msteams/src/monitor.ts:267`        |
| MED-12 | Media server binds `0.0.0.0` without configuration                                           | `media/server.ts:99`                           |
| MED-13 | Voice call WebSocket has no authentication on upgrade                                        | `extensions/voice-call/src/webhook.ts:176-187` |
| MED-14 | Open Responses endpoint accepts 20MB request bodies                                          | `openresponses-http.ts:65`                     |
| MED-15 | Canvas host uses `innerHTML` with controlled data                                            | `canvas-host/server.ts:113`                    |
| MED-16 | Nextcloud Talk webhook binds `0.0.0.0` by default                                            | `extensions/nextcloud-talk/src/monitor.ts:15`  |

### File System & Deserialization

| ID     | Finding                                                                | File                                                  |
| ------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| MED-17 | Session transcript path constructed from session ID without validation | `gateway/session-utils.fs.ts:38-57`                   |
| MED-18 | YAML parse without alias limit (billion laughs DoS)                    | `markdown/frontmatter.ts:37`                          |
| MED-19 | JSON files parsed without schema validation                            | `infra/archive.ts:131-134`, `infra/json-file.ts:4-14` |
| MED-20 | `saveMediaSource` reads arbitrary local files up to 5MB                | `media/store.ts:193-209`                              |
| MED-21 | `apply_patch` can write outside workspace when no sandbox root         | `agents/apply-patch.ts:215-236`                       |

### Command Injection

| ID     | Finding                                                          | File                                         |
| ------ | ---------------------------------------------------------------- | -------------------------------------------- |
| MED-22 | Docker PATH concatenation in shell context                       | `agents/bash-tools.shared.ts:80`             |
| MED-23 | iMessage `cliPath` unvalidated (arbitrary binary execution)      | `imessage/client.ts:53,70`                   |
| MED-24 | Node host allows PATH prepend for binary hijacking               | `node-host/runner.ts:220-233`                |
| MED-25 | `SHELL` env var not validated against known shells               | `agents/shell-utils.ts:35-49`                |
| MED-26 | `/exec` directive allows security mode change requests from chat | `auto-reply/reply/exec/directive.ts:189-239` |

### Dependencies

| ID     | Finding                                                      | Package           |
| ------ | ------------------------------------------------------------ | ----------------- |
| MED-27 | Outdated `protobufjs@6.8.8` (potential prototype pollution)  | Transitive        |
| MED-28 | `uuid@3.4.0` uses `Math.random()`                            | Via `request`     |
| MED-29 | Alpha `sqlite-vec@0.1.7-alpha.2` with native binaries        | Direct            |
| MED-30 | Beta `@lydell/node-pty@1.2.0-beta.3` (terminal emulation)    | Direct            |
| MED-31 | Incorrect `form-data@2.5.4` override (should be 2.5.5)       | pnpm override     |
| MED-32 | `tough-cookie` override needed due to deprecated `request`   | pnpm override     |
| MED-33 | Pre-release `@vector-im/matrix-bot-sdk@0.8.0-element.3` fork | Extension         |
| MED-34 | EOL `jose@4.15.9` in Slack OAuth flow                        | Via `@slack/bolt` |

---

## LOW Findings (18)

| ID     | Finding                                                          | File/Package                                                  |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| LOW-1  | Telegram webhook secret is optional                              | `telegram/webhook.ts:27`                                      |
| LOW-2  | Line webhook has no replay protection                            | `line/signature.ts:1-18`                                      |
| LOW-3  | Token SHA256 prefix + length in non-secrets status output        | `status-all/channels.ts:70`                                   |
| LOW-4  | `.env.example` contains real-looking Twilio phone number         | `.env.example:4`                                              |
| LOW-5  | Lobster tool Windows `shell: true` fallback                      | `extensions/lobster/src/lobster-tool.ts:120-126`              |
| LOW-6  | Gmail hook spawns external binaries by PATH lookup name          | `hooks/gmail-ops.ts:362`                                      |
| LOW-7  | ZCA binary profile argument not validated                        | `extensions/zalouser/src/zca.ts:10-16`                        |
| LOW-8  | `loadShellEnvFallback` executes login shell from `SHELL` env     | `infra/shell-env.ts:72-79`                                    |
| LOW-9  | Browser downloads save to user-specified path without validation | `browser/pw-tools-core.downloads.ts:183-189`                  |
| LOW-10 | Config backup rotation uses predictable naming (symlink attack)  | `config/io.ts:93-110`                                         |
| LOW-11 | `mkdtemp` prefix patterns reveal application identity            | `media/image-ops.ts:128`, `plugins/install.ts:272,411`        |
| LOW-12 | Windows session store write not atomic                           | `config/sessions/store.ts:203-216`                            |
| LOW-13 | OAuth callback servers lack CSRF beyond state parameter          | `commands/chutes-oauth.ts`, `google-gemini-cli-auth/oauth.ts` |
| LOW-14 | Gemini OAuth reflects error parameter in response body           | `extensions/google-gemini-cli-auth/oauth.ts:286`              |
| LOW-15 | Gateway bind fallback to `0.0.0.0` in multiple code paths        | `gateway/net.ts:140-178`                                      |
| LOW-16 | Broad caret ranges on security-sensitive dependencies            | `package.json`                                                |
| LOW-17 | `qrcode-terminal@0.12.0` unmaintained since 2018                 | Direct                                                        |
| LOW-18 | `@buape/carbon@0.14.0` frozen (never-update policy)              | Direct                                                        |

---

## Positive Security Findings

The codebase demonstrates genuinely strong security practices in many areas:

1. **Gateway WebSocket auth** uses `timingSafeEqual` with nonce-based challenge-response (`src/gateway/auth.ts:35-40`)
2. **Ed25519 device identity** with replay-protected signatures for pairing
3. **Comprehensive SSRF guard** with DNS pinning in `src/infra/net/ssrf.ts` -- blocks private IPs, localhost, performs DNS resolution checks
4. **Docker sandbox** with read-only root, dropped caps, no-new-privileges, seccomp, resource limits
5. **Dangerous env var blocking** (LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, BASH_ENV, IFS, etc.)
6. **Shell token analysis** with quote-aware tokenization and dangerous pattern detection
7. **`openFileWithinRoot`** (`src/infra/fs-safe.ts`) with O_NOFOLLOW, realpath validation, symlink detection, inode comparison
8. **`onlyBuiltDependencies`** allowlist restricting build-time code execution
9. **`minimumReleaseAge: 2880`** (2-day delay) protecting against supply chain attacks
10. **Built-in security audit** command (`openclaw security audit`) checking config, permissions, and channel policies
11. **Robust secret redaction** in logging (`src/logging/redact.ts`) covering API keys, tokens, PEM blocks, provider prefixes
12. **Config file** written with `0o600` permissions, directory with `0o700`
13. **SSH argument injection prevention** rejecting hostnames starting with `-`, using `--` separator
14. **Plugin install path traversal protection** validating resolved paths stay within extensions directory
15. **Zip extraction** correctly validates path containment
16. **Security headers** on Control UI (X-Frame-Options DENY, CSP frame-ancestors none, X-Content-Type-Options nosniff)
17. **Origin checking** for browser WebSocket clients
18. **WebSocket payload limits** (512KB frame, 1.5MB buffer)
19. **Nostr profile handler** -- exemplary implementation with rate limiting, SSRF validation, body size limits, mutex, Zod schema validation

---

## Prioritized Remediation Plan

### Phase 1: Critical Fixes (Week 1)

| Priority | ID       | Fix                                                                   | Effort |
| -------- | -------- | --------------------------------------------------------------------- | ------ |
| 1        | CRIT-1   | Remove `full` elevated mode or require per-command approval           | Medium |
| 2        | CRIT-2,3 | Replace `!==` with `safeEqual()` in hooks + browser relay (2 files)   | Low    |
| 3        | CRIT-4   | Add per-IP rate limiting on gateway HTTP + WS auth endpoints          | Medium |
| 4        | CRIT-5   | Add path containment check to tar extraction (match zip pattern)      | Low    |
| 5        | CRIT-6   | Filter `__proto__`/`constructor`/`prototype` keys in `deepMerge`      | Low    |
| 6        | CRIT-8   | Add `mode: 0o600` to Matrix credential writes                         | Low    |
| 7        | CRIT-10  | Add body size limit to Nextcloud Talk webhook                         | Low    |
| 8        | CRIT-7   | Validate/restrict `setupCommand` format                               | Medium |
| 9        | CRIT-9   | Expand link understanding SSRF filter to use existing `ssrf.ts` guard | Low    |

### Phase 2: High Priority (Weeks 2-3)

| Priority | Fix                                                                                            | Effort |
| -------- | ---------------------------------------------------------------------------------------------- | ------ |
| 10       | Sanitize error messages before returning to HTTP API clients                                   | Low    |
| 11       | Validate `X-OpenClaw-Session-Key` against authenticated user identity                          | Medium |
| 12       | Default all server bindings to `127.0.0.1` (canvas, telegram, media, msteams, nextcloud, etc.) | Medium |
| 13       | Default `showSecrets: false` in status commands                                                | Low    |
| 14       | Add `--ignore-scripts` to `npm pack`/`npm install` during plugin install                       | Low    |
| 15       | Validate `setupCommand`, hook module paths, iMessage `cliPath`                                 | Medium |
| 16       | Default operator scopes to `operator.read` instead of `operator.admin`                         | Low    |
| 17       | Remove query-parameter token acceptance (deprecation path)                                     | Medium |
| 18       | Prefer env vars over CLI flags for secrets (docs + help text)                                  | Low    |
| 19       | Restrict local file reads in web media to allowlisted paths                                    | Medium |
| 20       | Validate SCP `remoteHost` against hostname pattern                                             | Low    |

### Phase 3: Medium Priority (Weeks 3-4)

- Add `mode: 0o700` to `ensureDir`, audit all `mkdir` calls
- Upgrade/replace `@vector-im/matrix-bot-sdk` to eliminate `request`
- Verify `libsignal-node` tarball integrity, push for npm publishing
- Add pnpm overrides for `brace-expansion`, `protobufjs`
- Fix `workspace:*` in 4 extension `dependencies` fields
- Validate `SHELL` env var against known shell paths
- Add YAML `maxAliasCount` option to frontmatter parsing
- Add schema validation for JSON parsed from external sources
- Add rate limiting to pairing code approval
- Update `form-data` override from `2.5.4` to `2.5.5`

### Phase 4: Hardening & Long-Term (Ongoing)

- Implement plugin code signing and integrity verification
- Add plugin permission model (declared capabilities)
- Consider sandboxed plugin execution via worker threads
- Implement automatic expiry for `dangerouslyDisableDeviceAuth`
- Monitor pre-release dependencies (Baileys, sqlite-vec, node-pty) for stable releases
- Add `pnpm audit` to CI pipeline
- Establish lint rule for timing-safe secret comparisons

---

## General Recommendations

### 1. Defense in Depth for AI Agent Execution

The `elevated: full` mode is the single most dangerous configuration option. Consider requiring a physical confirmation (hardware key, separate channel approval) for unrestricted execution, not just a config flag. The multi-layered security (sandbox, allowlist, dangerous env blocking, shell token analysis) is excellent -- but `full` mode bypasses all of it.

### 2. Consistent Timing-Safe Comparison

Create a lint rule or code review checklist item: **every `===`/`!==` comparison against a secret must use `safeEqual()`**. Three instances were found where the existing `safeEqual` helper was not used. Consider an ESLint plugin or AST grep rule to detect `!==` comparisons against variables named `token`, `secret`, `password`, etc.

### 3. Default-Deny Network Binding

Establish a project convention: **all servers bind to `127.0.0.1` by default**. Users who need LAN/public access opt in explicitly. At least 6 services currently default to `0.0.0.0`. This is a simple, high-impact change.

### 4. Credential Storage Standard

Formalize the pattern already used by most of the codebase: `mkdir 0o700` + `writeFile 0o600` + `chmod 0o600`. Create a shared `saveCredentialFile()` helper and enforce its use in extensions via documentation and code review. The Matrix extension is the primary outlier.

### 5. Plugin Security Model

The plugin system is the largest attack surface. Consider adding:

- Plugin manifest signing (verify author identity)
- A declared permission model (what the plugin can access)
- Sandboxed execution via worker threads with limited API surface
- `--ignore-scripts` during npm-based installation
- An explicit user consent step when loading new/changed plugins

### 6. Dependency Hygiene

The `minimumReleaseAge` and `onlyBuiltDependencies` settings are excellent. Additionally:

- Eliminate the `request` dependency tree (the root cause of multiple transitive vulnerabilities)
- Pin exact versions for native modules
- Set up automated `pnpm audit` in CI
- Verify integrity of GitHub tarball dependencies
- Review `onlyBuiltDependencies` list periodically

### 7. Rate Limiting Layer

Add a lightweight rate limiter at the gateway HTTP server level. Even a simple in-memory token bucket (10 failed auth/min/IP, 100 requests/min/token) would dramatically reduce brute-force and API abuse risk. The Nostr profile handler already implements this pattern -- use it as a reference.

### 8. Secret Hygiene

- Never show token characters in CLI output by default
- Remove exact token lengths from audit/status output
- Deprecate and remove query-parameter token acceptance
- Document env var preference over CLI flags for all secrets
- Extend `collectSecretsInConfigFindings` to flag channel bot tokens stored inline in config
- Clear clipboard after copying token-bearing URLs

### 9. Error Message Sanitization

Establish a pattern for all HTTP-facing error handlers: return generic messages to clients, log details server-side. The current `String(err)` pattern can leak file paths, dependency versions, and internal architecture details.

### 10. Extension Security Review Process

Extensions (`extensions/*`) have a wider variance in security quality than core code. Consider:

- A security review checklist for extension contributions
- Shared helpers for credential storage, webhook validation, and body size limiting
- Default-secure templates for new extensions

---

## Appendix: Agent Execution Statistics

| Agent     | Domain                              | Duration     | Tool Calls | Tokens      |
| --------- | ----------------------------------- | ------------ | ---------- | ----------- |
| 1         | Command Injection & Code Execution  | 5m 56s       | 53         | 135,680     |
| 2         | Secrets & Token Handling            | 4m 31s       | 70         | 150,003     |
| 3         | Authentication & Access Control     | 3m 9s        | 48         | 162,466     |
| 4         | Dependency Supply Chain             | 4m 17s       | 104        | 74,315      |
| 5         | Network Exposure & Input Validation | 3m 37s       | 57         | 144,223     |
| 6         | File System & Deserialization       | 3m 1s        | 41         | 164,645     |
| **Total** |                                     | **~24m 31s** | **373**    | **831,332** |
