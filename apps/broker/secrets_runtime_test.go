package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type stubSecretsClient struct {
	metadata      map[string]string
	list          []secretMetadata
	resolved      resolvedSecretSet
	resolveTenant string
	resolveNames  []string
	resolveTool   string
	resolveCalls  int
	listTenant    string
	listCalls     int
}

func (s *stubSecretsClient) ListMetadata(_ context.Context, tenant string) ([]secretMetadata, error) {
	s.listTenant = tenant
	s.listCalls++
	return append([]secretMetadata{}, s.list...), nil
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

func (s *stubSecretsClient) Resolve(_ context.Context, tenant string, names []string, tool string) (resolvedSecretSet, error) {
	s.resolveTenant = tenant
	s.resolveNames = append([]string{}, names...)
	s.resolveTool = tool
	s.resolveCalls++
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

func TestRejectDisallowedSecretReferencesAllowsUnknownHomePath(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, &stubSecretsClient{metadata: map[string]string{}})
	if err := rejectDisallowedSecretReferences(context.Background(), "echo $HOME && echo $PATH"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRejectDisallowedSecretReferencesRejectsKnownStoredSecretWithoutResolve(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	client := &stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": "CANARY_SECRET_VALUE_abcdef"},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	}
	withStubSecretsClient(t, client)
	for _, command := range []string{
		"echo $DEPLOY_KEY | head -c 17",
		`mkdir -p ~/.ssh && printf '%s' "$DEPLOY_KEY" > ~/.ssh/deploy_key`,
	} {
		err := rejectDisallowedSecretReferences(context.Background(), command)
		if err == nil {
			t.Fatalf("expected known stored secret ref to be rejected for %q", command)
		}
		if !strings.Contains(err.Error(), "materialize_secret") {
			t.Fatalf("unexpected rejection error: %v", err)
		}
	}
	if client.resolveCalls != 0 {
		t.Fatalf("non-materialize rejection must not call Resolve, got %d", client.resolveCalls)
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
	withStubSecretsClient(t, &stubSecretsClient{metadata: map[string]string{"DEPLOY_KEY": "ssh_key"}})
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

func TestHTTPPlatformSecretsClientListMetadataUsesBrokerListEndpoint(t *testing.T) {
	t.Setenv("ROCKIELAB_BROKER_TOKEN", "broker-token")
	var gotPath, gotAuth, gotTenant, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotTenant = r.Header.Get("X-Tenant-Id")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"name":"DEPLOY_KEY","category":"ssh_key","description":"deploy key","created_at":"2026-06-12T12:00:00Z"}]`))
	}))
	defer srv.Close()
	t.Setenv("ROCKIELAB_API_BASE", srv.URL)

	client := httpPlatformSecretsClient{httpClient: srv.Client()}
	got, err := client.ListMetadata(context.Background(), "tenant-test")
	if err != nil {
		t.Fatalf("ListMetadata failed: %v", err)
	}
	if gotPath != "/api/secrets/list" || gotAuth != "Bearer broker-token" || gotTenant != "tenant-test" || gotBody != "{}" {
		t.Fatalf("unexpected request path=%q auth=%q tenant=%q body=%q", gotPath, gotAuth, gotTenant, gotBody)
	}
	if len(got) != 1 || got[0].Name != "DEPLOY_KEY" || got[0].Category != "ssh_key" {
		t.Fatalf("unexpected metadata response: %+v", got)
	}
}

func TestMaterializeSecretWritesSSHKeyWithSafeMetadataOnly(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	secretValue := "CANARY_SECRET_VALUE_abcdef"
	client := &stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": secretValue},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	}
	withStubSecretsClient(t, client)

	resp, err := materializeSecret(context.Background(), "DEPLOY_KEY")
	if err != nil {
		t.Fatalf("materializeSecret failed: %v", err)
	}
	if client.resolveTenant != "tenant-test" || client.resolveTool != "materialize_secret" {
		t.Fatalf("unexpected resolve call tenant=%q tool=%q", client.resolveTenant, client.resolveTool)
	}
	if len(client.resolveNames) != 1 || client.resolveNames[0] != "DEPLOY_KEY" {
		t.Fatalf("unexpected resolve names: %v", client.resolveNames)
	}
	wantPath := filepath.Join(home, ".ssh", "rockie-secrets", "deploy_key-c50c61b0ec3c")
	if resp != (materializeSecretResponse{Name: "DEPLOY_KEY", Category: "ssh_key", Path: wantPath, Mode: "0600"}) {
		t.Fatalf("unexpected materialize response: %+v", resp)
	}
	body, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("secret file missing: %v", err)
	}
	if string(body) != secretValue {
		t.Fatal("secret file content mismatch")
	}
	sshInfo, err := os.Stat(filepath.Join(home, ".ssh"))
	if err != nil {
		t.Fatalf("ssh dir missing: %v", err)
	}
	if sshInfo.Mode().Perm() != 0o700 {
		t.Fatalf("ssh dir mode = %o, want 0700", sshInfo.Mode().Perm())
	}
	secretsInfo, err := os.Stat(filepath.Join(home, ".ssh", "rockie-secrets"))
	if err != nil {
		t.Fatalf("rockie secrets dir missing: %v", err)
	}
	if secretsInfo.Mode().Perm() != 0o700 {
		t.Fatalf("rockie secrets dir mode = %o, want 0700", secretsInfo.Mode().Perm())
	}
	fileInfo, err := os.Stat(wantPath)
	if err != nil {
		t.Fatalf("secret file stat failed: %v", err)
	}
	if fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("secret file mode = %o, want 0600", fileInfo.Mode().Perm())
	}

	encoded, _ := json.Marshal(resp)
	if strings.Contains(string(encoded), secretValue) || strings.Contains(string(encoded), "abcdef") {
		t.Fatalf("materialize response leaked secret-derived data: %s", encoded)
	}
}

func TestMaterializeSecretUsesBrokerNamespaceForReservedSSHNames(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	reservedPath := filepath.Join(sshDir, "authorized_keys")
	if err := os.WriteFile(reservedPath, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	withStubSecretsClient(t, &stubSecretsClient{
		metadata: map[string]string{"AUTHORIZED_KEYS": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"AUTHORIZED_KEYS": "secret-value"},
			Categories: map[string]string{"AUTHORIZED_KEYS": "ssh_key"},
		},
	})

	resp, err := materializeSecret(context.Background(), "AUTHORIZED_KEYS")
	if err != nil {
		t.Fatalf("materializeSecret failed: %v", err)
	}
	if resp.Path != filepath.Join(home, ".ssh", "rockie-secrets", "authorized_keys-f805a504851e") {
		t.Fatalf("unexpected path: %q", resp.Path)
	}
	body, err := os.ReadFile(reservedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "existing" {
		t.Fatalf("reserved .ssh file was clobbered: %q", body)
	}
}

func TestMaterializeSecretUsesHashSuffixAndOverwritesSameSecretPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	secretsDir := filepath.Join(home, ".ssh", "rockie-secrets")
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(secretsDir, "deploy_key-c50c61b0ec3c")
	if err := os.WriteFile(path, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	withStubSecretsClient(t, &stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": "secret-value"},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	})

	resp, err := materializeSecret(context.Background(), "DEPLOY_KEY")
	if err != nil {
		t.Fatalf("materializeSecret failed: %v", err)
	}
	if resp.Path != path {
		t.Fatalf("unexpected path: %q", resp.Path)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "secret-value" {
		t.Fatalf("materialized path was not updated: %q", body)
	}
}

func TestSanitizedSecretFilenameDisambiguatesCollisions(t *testing.T) {
	if sanitizedSecretFilename("A") != "a-559aead08264" {
		t.Fatalf("unexpected sanitized filename for A: %q", sanitizedSecretFilename("A"))
	}
	if sanitizedSecretFilename("A_") != "a-ada8d598e51a" {
		t.Fatalf("unexpected sanitized filename for A_: %q", sanitizedSecretFilename("A_"))
	}
	if sanitizedSecretFilename("A") == sanitizedSecretFilename("A_") {
		t.Fatal("sanitized filenames collided")
	}
}

func TestMaterializeSecretRejectsNonSSHKey(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	client := &stubSecretsClient{
		metadata: map[string]string{"API_TOKEN": "token"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"API_TOKEN": "secret-value"},
			Categories: map[string]string{"API_TOKEN": "token"},
		},
	}
	withStubSecretsClient(t, client)
	if _, err := materializeSecret(context.Background(), "API_TOKEN"); err == nil {
		t.Fatal("expected non-ssh_key materialization to fail")
	}
	if len(client.resolveNames) != 0 {
		t.Fatalf("non-ssh_key materialization should not call resolve, got %v", client.resolveNames)
	}
}

func TestMaterializeSecretRejectsBadNameAndMissingSecret(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	client := &stubSecretsClient{
		resolved: resolvedSecretSet{
			Values:     map[string]string{},
			Categories: map[string]string{},
			Missing:    []string{"DEPLOY_KEY"},
		},
	}
	withStubSecretsClient(t, client)

	if _, err := materializeSecret(context.Background(), "deploy_key"); err == nil {
		t.Fatal("expected lowercase secret name to fail validation")
	}
	if len(client.resolveNames) != 0 {
		t.Fatalf("bad name should not call resolve, got %v", client.resolveNames)
	}
	if _, err := materializeSecret(context.Background(), "DEPLOY_KEY"); !errors.Is(err, errMaterializeSecretMissing) {
		t.Fatalf("expected missing sentinel, got %v", err)
	}
	if len(client.resolveNames) != 0 {
		t.Fatalf("missing metadata should not call resolve, got %v", client.resolveNames)
	}
}

func TestMaterializeSecretHandlerRequiresLoopbackAndPOST(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, &stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": "secret-value"},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/materialize-secret", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	materializeSecretHandler(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", rr.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/materialize-secret", bytes.NewBufferString(`{"name":"DEPLOY_KEY"}`))
	req.RemoteAddr = "203.0.113.10:12345"
	rr = httptest.NewRecorder()
	materializeSecretHandler(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("non-loopback status = %d, want 403", rr.Code)
	}
}

func TestMaterializeSecretHandlerAcceptsLoopbackAndRejectsExtraFields(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, &stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
		resolved: resolvedSecretSet{
			Values:     map[string]string{"DEPLOY_KEY": "secret-value"},
			Categories: map[string]string{"DEPLOY_KEY": "ssh_key"},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/materialize-secret", bytes.NewBufferString(`{"name":"DEPLOY_KEY","path":"/tmp/x"}`))
	req.RemoteAddr = "[::1]:12345"
	rr := httptest.NewRecorder()
	materializeSecretHandler(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("extra field status = %d, want 400", rr.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/materialize-secret", bytes.NewBufferString(`{"name":"DEPLOY_KEY"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	rr = httptest.NewRecorder()
	materializeSecretHandler(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("loopback status = %d, body=%s", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "secret-value") {
		t.Fatalf("handler response leaked secret: %s", rr.Body.String())
	}
}

func TestMaterializeSecretHandlerRequiresTenantID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	withStubSecretsClient(t, &stubSecretsClient{})
	req := httptest.NewRequest(http.MethodPost, "/materialize-secret", bytes.NewBufferString(`{"name":"DEPLOY_KEY"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	materializeSecretHandler(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("missing tenant status = %d, want 500", rr.Code)
	}
}
