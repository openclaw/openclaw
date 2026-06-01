package main

import (
	"os"
	"regexp"
	"strings"
)

var blockedOwnedChildEnvName = regexp.MustCompile(`(?i)(TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|API[_-]?KEY|BROKER[_-]?TENANT[_-]?TOKEN)`)

// forwardedConnectionEnv is the exact-name allowlist of user-connected
// credentials the broker forwards from the container PID-1 env into the
// spawned agent (codex / claude / bash) env.
//
// fleet-task #573: the broker spawns every agent child process with a
// scrubbed, allowlisted env (see ownedChildEnv) — NOT an inherited one.
// That is the correct posture: the broker must not hand the agent its
// own auth token (BROKER_TENANT_TOKEN) or the platform API password.
// Tenant-scoped runtime clients still need ROCKIELAB_TENANT_TOKEN
// because rockie-gpu / mcp-rockie use it as X-Tenant-Token while
// ROCKIELAB_TENANT_ID remains the tenant scope header.
// But it also means a user who connects GitHub / HuggingFace at
// /settings/connections — which lands GH_TOKEN / HF_TOKEN in the
// container env as Fly app secrets — never sees those tokens reach
// `gh` / `hf`, because the block regex below scrubs anything matching
// TOKEN.
//
// These names are user-connected credentials the agent is explicitly
// meant to use (the whole point of the Connections feature). They are
// forwarded here. Membership is EXACT-NAME set lookup, never a regex —
// so this carve-out can never accidentally widen to forward a
// platform-owned secret. BROKER_TENANT_TOKEN, ROCKIELAB_API_PASSWORD,
// CLAUDE_CODE_OAUTH_TOKEN, and every other secret-shaped env var stay
// scrubbed because they are not in this set.
//
// To add a new connection credential: add the connection in
// platform-context (routers/connections.py) AND add its exact env-var
// name here. Both halves are required — layer 1 (Fly app secret) lands
// it in the container env; layer 2 (this allowlist) forwards it to the
// agent.
var forwardedConnectionEnv = map[string]struct{}{
	"GH_TOKEN": {},
	"HF_TOKEN": {},
}

const (
	defaultRockielabAPIBase = "https://api.rockielab.com"
	defaultRuntimeBinary    = "codex"
)

func tenantID() string {
	return strings.TrimSpace(os.Getenv("ROCKIELAB_TENANT_ID"))
}

func ownedChildEnv() []string {
	env := map[string]string{}
	allowed := []string{
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TERM",
		"COLORTERM",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"TMPDIR",
		"TEMP",
		"TMP",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"ROCKIELAB_API_BASE",
		"ROCKIELAB_API_URL",
		"ROCKIELAB_TENANT_ID",
		"ROCKIELAB_TENANT_TOKEN",
		"BINARY",
		"BROKER_PORT",
	}
	// User-connected credentials (GH_TOKEN / HF_TOKEN) are copied from
	// the container PID-1 env the same way as the static allowlist
	// above; they are exempted from the block regex below by exact-name
	// lookup against forwardedConnectionEnv.
	for name := range forwardedConnectionEnv {
		allowed = append(allowed, name)
	}
	copyAllowedEnv(env, allowed)
	if env["PATH"] == "" {
		env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	if env["ROCKIELAB_API_BASE"] == "" {
		env["ROCKIELAB_API_BASE"] = defaultRockielabAPIBase
	}
	if env["ROCKIELAB_API_URL"] == "" {
		env["ROCKIELAB_API_URL"] = env["ROCKIELAB_API_BASE"]
	}
	if env["BINARY"] == "" {
		env["BINARY"] = defaultRuntimeBinary
	}
	if tid := tenantID(); tid != "" {
		env["ROCKIELAB_TENANT_ID"] = tid
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		if key == "" || value == "" {
			continue
		}
		if !isEnvNameAllowedForChild(key) {
			continue
		}
		out = append(out, key+"="+value)
	}
	return out
}

// isEnvNameAllowedForChild decides whether an env-var NAME may be passed
// to a spawned agent process. A name is allowed unless the block regex
// matches it — EXCEPT for two explicit, exact-name carve-outs:
//
//   - ROCKIELAB_TENANT_TOKEN: a tenant-scoped service token explicitly
//     staged for tenant runtime API calls. It is not the broker token or
//     platform API password.
//   - any name in forwardedConnectionEnv: user-connected credentials
//     the agent is explicitly meant to use.
//
// Both carve-outs are exact-string set membership — never a regex — so
// they cannot widen to cover a platform-owned secret.
func isEnvNameAllowedForChild(key string) bool {
	if key == "ROCKIELAB_TENANT_TOKEN" {
		return true
	}
	if _, ok := forwardedConnectionEnv[key]; ok {
		return true
	}
	return !blockedOwnedChildEnvName.MatchString(key)
}

func copyAllowedEnv(out map[string]string, keys []string) {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			out[key] = value
		}
	}
}

func envContainsName(env []string, name string) bool {
	prefix := name + "="
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			return true
		}
	}
	return false
}
