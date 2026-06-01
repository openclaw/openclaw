package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

type stubSecretsClient struct {
	metadata map[string]string
	resolved resolvedSecretSet
}

func (s stubSecretsClient) CandidateMetadata(_ context.Context, _ string, names []string) (map[string]string, error) {
	out := map[string]string{}
	for _, name := range names {
		if category, ok := s.metadata[name]; ok {
			out[name] = category
		}
	}
	return out, nil
}

func (s stubSecretsClient) Resolve(_ context.Context, _ string, _ []string, _ string) (resolvedSecretSet, error) {
	return s.resolved, nil
}

func withStubSecretsClient(t *testing.T, client platformSecretsClient) {
	t.Helper()
	prevClient := brokerSecretsClient
	prevEntries := metadataCache.entries
	brokerSecretsClient = client
	metadataCache.Lock()
	metadataCache.entries = map[string]metadataCacheEntry{}
	metadataCache.Unlock()
	t.Cleanup(func() {
		brokerSecretsClient = prevClient
		metadataCache.Lock()
		metadataCache.entries = prevEntries
		metadataCache.Unlock()
	})
}

func TestParseExactEchoHeadCommand(t *testing.T) {
	got, ok := parseExactEchoHeadCommand(" echo   $DEPLOY_KEY | head -c 4 ")
	if !ok {
		t.Fatal("expected exact form to parse")
	}
	if got.Name != "DEPLOY_KEY" || got.Count != 4 {
		t.Fatalf("unexpected parse result: %+v", got)
	}
	got, ok = parseExactEchoHeadCommand(" echo   ${DEPLOY_KEY} | head -c 4 ")
	if !ok || got.Name != "DEPLOY_KEY" || got.Count != 4 {
		t.Fatalf("unexpected braced parse result: %+v ok=%v", got, ok)
	}
	for _, command := range []string{
		"echo '$DEPLOY_KEY' | head -c 4",
		"FOO=1 echo $DEPLOY_KEY | head -c 4",
		"echo $DEPLOY_KEY | head -c 0",
		"echo $DEPLOY_KEY | head -c 65",
		"echo $deploy_key | head -c 4",
		"echo $DEPLOY_KEY | head -c 4 | cat",
		"echo $DEPLOY_KEY | head -c 4 > out",
	} {
		if _, ok := parseExactEchoHeadCommand(command); ok {
			t.Fatalf("unexpectedly accepted %q", command)
		}
	}
}

func TestSecretAwareSpawnAllowsUnknownHomePath(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, stubSecretsClient{metadata: map[string]string{}})
	_, handled, err := executeSecretAwareSpawnCommand(context.Background(), "echo $HOME && echo $PATH")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if handled {
		t.Fatal("ordinary HOME/PATH refs should be left to the shell when not stored secrets")
	}
}

func TestSecretAwareSpawnExactFormReturnsOnlyMarker(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	secretValue := "CANARY_SECRET_VALUE_abcdef"
	withStubSecretsClient(t, stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": secretValue},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	})
	resp, handled, err := executeSecretAwareSpawnCommand(context.Background(), "echo $DEPLOY_KEY | head -c 17")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !handled {
		t.Fatal("expected exact form to be handled broker-natively")
	}
	if !strings.Contains(resp.Stdout, "<redacted:DEPLOY_KEY>") {
		t.Fatalf("expected redacted marker, got %q", resp.Stdout)
	}
	if strings.Contains(resp.Stdout, secretValue) || strings.Contains(resp.Stdout, secretValue[:4]) {
		t.Fatalf("secret-derived bytes leaked: %q", resp.Stdout)
	}
}

func TestSecretAwareSpawnLeavesNonExactKnownSecretUseForEnvInjection(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
	})
	_, handled, err := executeSecretAwareSpawnCommand(context.Background(), "printf %s $DEPLOY_KEY")
	if handled || err != nil {
		t.Fatalf("expected non-exact secret reference to fall through, handled=%v err=%v", handled, err)
	}
}

func TestResolveSecretEnvForSpawnCommandMaterializesKnownRefs(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	secretValue := "CANARY_SECRET_VALUE_abcdef"
	withStubSecretsClient(t, stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": secretValue},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	})
	resolved, handled, err := resolveSecretEnvForSpawnCommand(
		context.Background(),
		`mkdir -p ~/.ssh && printf '%s' "$DEPLOY_KEY" > ~/.ssh/deploy_key`,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !handled {
		t.Fatal("expected known secret ref to be resolved for bash env injection")
	}
	if resolved.Values["DEPLOY_KEY"] != secretValue {
		t.Fatalf("unexpected resolved value map: %v", resolved.Values)
	}
	if got := resolved.Redactor.Redact("prefix " + secretValue); strings.Contains(got, secretValue) {
		t.Fatalf("redactor leaked secret value: %q", got)
	}
}

func TestValidateResolvedExactSetRejectsBadEnvelope(t *testing.T) {
	metadata := map[string]string{"DEPLOY_KEY": "ssh_key"}
	base := resolvedSecretSet{
		Values:     map[string]string{"DEPLOY_KEY": "secret"},
		Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
	}
	if err := validateResolvedExactSet([]string{"DEPLOY_KEY"}, base, metadata); err != nil {
		t.Fatalf("valid envelope rejected: %v", err)
	}
	cases := []resolvedSecretSet{
		{Values: map[string]string{"DEPLOY_KEY": "secret", "EXTRA": "x"}, Categories: map[string]string{"DEPLOY_KEY": "ssh_key", "EXTRA": "token"}},
		{Values: map[string]string{}, Categories: map[string]string{}, Missing: []string{"DEPLOY_KEY"}},
		{Values: map[string]string{"DEPLOY_KEY": "secret"}, Categories: map[string]string{"DEPLOY_KEY": "token"}},
		{Values: map[string]string{"DEPLOY_KEY": "secret"}, Categories: map[string]string{}},
		{Values: map[string]string{"DEPLOY_KEY": "secret"}, Categories: map[string]string{"DEPLOY_KEY": "ssh_key"}, Missing: []string{"DEPLOY_KEY"}},
	}
	for idx, envelope := range cases {
		if err := validateResolvedExactSet([]string{"DEPLOY_KEY"}, envelope, metadata); err == nil {
			t.Fatalf("case %d unexpectedly passed", idx)
		}
	}
}

func TestOwnedChildEnvDropsSecretsAndForwardsTenantRuntimeContext(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("BROKER_TENANT_TOKEN", "broker-secret")
	t.Setenv("OPENAI_API_KEY", "sk-secret")
	t.Setenv("ROCKIELAB_API_URL", "https://api.rockielab.test")
	t.Setenv("BINARY", "codex")
	t.Setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-123")
	env := ownedChildEnv()
	if envContainsName(env, "BROKER_TENANT_TOKEN") || envContainsName(env, "OPENAI_API_KEY") {
		t.Fatalf("owned child env leaked blocked secret names: %v", env)
	}
	if !envContainsName(env, "ROCKIELAB_TENANT_ID") {
		t.Fatalf("owned child env missing tenant id: %v", env)
	}
	for _, want := range []string{
		"ROCKIELAB_TENANT_TOKEN=service-token",
		"ROCKIELAB_API_URL=https://api.rockielab.test",
		"BINARY=codex",
	} {
		found := false
		for _, kv := range env {
			if kv == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("owned child env missing %q: %v", want, env)
		}
	}
	for _, kv := range env {
		if kv == "ROCKIELAB_TENANT_TOKEN=tenant-123" {
			t.Fatalf("owned child env must not alias tenant token to tenant id: %v", env)
		}
	}
}

func TestOwnedChildEnvDoesNotInventTenantToken(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-123")
	env := ownedChildEnv()
	if envContainsName(env, "ROCKIELAB_TENANT_TOKEN") {
		t.Fatalf("owned child env must not invent tenant token from tenant id: %v", env)
	}
}

func TestOwnedChildEnvSuppliesSafeRuntimeDefaults(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-123")
	env := ownedChildEnv()
	for _, want := range []string{
		"ROCKIELAB_API_BASE=https://api.rockielab.com",
		"ROCKIELAB_API_URL=https://api.rockielab.com",
		"BINARY=codex",
	} {
		found := false
		for _, kv := range env {
			if kv == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("owned child env missing default %q: %v", want, env)
		}
	}
}

// TestOwnedChildEnvForwardsConnectionCredentials is the fleet-task #573
// layer-2 regression: a user who connects GitHub / HuggingFace lands
// GH_TOKEN / HF_TOKEN in the container PID-1 env (layer 1, Fly app
// secrets). The broker must forward those two — and ONLY those two —
// into the spawned agent env so `gh` / `hf` authenticate.
func TestOwnedChildEnvForwardsConnectionCredentials(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-573")
	t.Setenv("GH_TOKEN", "gho_connected_value")
	t.Setenv("HF_TOKEN", "hf_connected_value")
	env := ownedChildEnv()
	for _, want := range []string{"GH_TOKEN=gho_connected_value", "HF_TOKEN=hf_connected_value"} {
		found := false
		for _, kv := range env {
			if kv == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("owned child env must forward connection credential %q: %v", want, env)
		}
	}
}

// TestOwnedChildEnvStillBlocksPlatformSecretsAlongsideConnectionCreds
// proves the forward-allowlist is exact-name-scoped — it forwards the
// connection credentials WITHOUT widening to leak the broker's own auth
// token or the platform API password, even though all of them match the
// block regex.
func TestOwnedChildEnvStillBlocksPlatformSecretsAlongsideConnectionCreds(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-573")
	t.Setenv("GH_TOKEN", "gho_connected_value")
	t.Setenv("BROKER_TENANT_TOKEN", "broker-secret")
	t.Setenv("ROCKIELAB_API_PASSWORD", "api-pw-secret")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-secret")
	t.Setenv("OPENAI_API_KEY", "sk-secret")
	env := ownedChildEnv()
	if !envContainsName(env, "GH_TOKEN") {
		t.Fatalf("connection credential GH_TOKEN must still be forwarded: %v", env)
	}
	for _, blocked := range []string{
		"BROKER_TENANT_TOKEN",
		"ROCKIELAB_API_PASSWORD",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENAI_API_KEY",
	} {
		if envContainsName(env, blocked) {
			t.Fatalf("platform secret %q leaked into agent env: %v", blocked, env)
		}
	}
}

// TestIsEnvNameAllowedForChild pins the name-level decision directly so
// a future regex tweak or allowlist edit can't silently change which
// names reach the agent.
func TestIsEnvNameAllowedForChild(t *testing.T) {
	allowed := []string{
		"PATH",
		"HOME",
		"ROCKIELAB_TENANT_ID",
		"ROCKIELAB_TENANT_TOKEN",
		"ROCKIELAB_API_URL",
		"BINARY",
		"GH_TOKEN",
		"HF_TOKEN",
	}
	for _, name := range allowed {
		if !isEnvNameAllowedForChild(name) {
			t.Fatalf("%q must be allowed for the child env", name)
		}
	}
	blocked := []string{
		"BROKER_TENANT_TOKEN",
		"ROCKIELAB_API_PASSWORD",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"AWS_SECRET_ACCESS_KEY",
		"SOME_PRIVATE_KEY",
		"GITHUB_TOKEN", // NOT GH_TOKEN — not in the allowlist, must stay blocked
	}
	for _, name := range blocked {
		if isEnvNameAllowedForChild(name) {
			t.Fatalf("%q must be blocked from the child env", name)
		}
	}
}

func TestMetadataCacheIsTenantScoped(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-a")
	withStubSecretsClient(t, stubSecretsClient{metadata: map[string]string{"DEPLOY_KEY": "ssh_key"}})
	got, err := cachedCandidateMetadata(context.Background(), "tenant-a", []string{"DEPLOY_KEY"})
	if err != nil || got["DEPLOY_KEY"] != "ssh_key" {
		t.Fatalf("unexpected metadata: got=%v err=%v", got, err)
	}
	metadataCache.Lock()
	metadataCache.entries["tenant-b\x00DEPLOY_KEY"] = metadataCacheEntry{
		category: "token",
		known:    true,
		expires:  time.Now().Add(secretMetadataCacheTTL),
	}
	metadataCache.Unlock()
	got, err = cachedCandidateMetadata(context.Background(), "tenant-b", []string{"DEPLOY_KEY"})
	if err != nil || got["DEPLOY_KEY"] != "token" {
		t.Fatalf("tenant-scoped cache lookup failed: got=%v err=%v", got, err)
	}
}
