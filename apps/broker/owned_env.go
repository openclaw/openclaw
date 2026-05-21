package main

import (
	"os"
	"regexp"
	"strings"
)

var blockedOwnedChildEnvName = regexp.MustCompile(`(?i)(TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|API[_-]?KEY|BROKER[_-]?TENANT[_-]?TOKEN)`)

func tenantID() string {
	return strings.TrimSpace(os.Getenv("ROCKIELAB_TENANT_ID"))
}

func ownedChildEnv() []string {
	env := map[string]string{}
	copyAllowedEnv(env, []string{
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
		"ROCKIELAB_TENANT_ID",
		"BROKER_PORT",
	})
	if env["PATH"] == "" {
		env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	}
	if tid := tenantID(); tid != "" {
		env["ROCKIELAB_TENANT_ID"] = tid
		// Current in-machine CLIs use this header value for API compatibility.
		// Derive it only from ROCKIELAB_TENANT_ID; never copy a token fallback.
		env["ROCKIELAB_TENANT_TOKEN"] = tid
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		if key == "" || value == "" {
			continue
		}
		if key != "ROCKIELAB_TENANT_TOKEN" && blockedOwnedChildEnvName.MatchString(key) {
			continue
		}
		out = append(out, key+"="+value)
	}
	return out
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
