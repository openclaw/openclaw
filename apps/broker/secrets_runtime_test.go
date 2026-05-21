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

func TestSecretAwareSpawnRejectsDisallowedKnownSecretUse(t *testing.T) {
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-test")
	withStubSecretsClient(t, stubSecretsClient{
		metadata: map[string]string{"DEPLOY_KEY": "ssh_key"},
	})
	_, handled, err := executeSecretAwareSpawnCommand(context.Background(), "printf %s $DEPLOY_KEY")
	if !handled || err == nil {
		t.Fatalf("expected disallowed secret reference rejection, handled=%v err=%v", handled, err)
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

func TestOwnedChildEnvDropsSecretsAndDerivesTenantTokenFromTenantID(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/home/runtime")
	t.Setenv("BROKER_TENANT_TOKEN", "broker-secret")
	t.Setenv("OPENAI_API_KEY", "sk-secret")
	t.Setenv("ROCKIELAB_TENANT_TOKEN", "legacy-token")
	t.Setenv("ROCKIELAB_TENANT_ID", "tenant-123")
	env := ownedChildEnv()
	if envContainsName(env, "BROKER_TENANT_TOKEN") || envContainsName(env, "OPENAI_API_KEY") {
		t.Fatalf("owned child env leaked blocked secret names: %v", env)
	}
	if !envContainsName(env, "ROCKIELAB_TENANT_ID") {
		t.Fatalf("owned child env missing tenant id: %v", env)
	}
	foundDerived := false
	for _, kv := range env {
		if kv == "ROCKIELAB_TENANT_TOKEN=tenant-123" {
			foundDerived = true
		}
	}
	if !foundDerived {
		t.Fatalf("owned child env should derive tenant token only from tenant id: %v", env)
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
