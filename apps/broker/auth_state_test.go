// auth_state_test.go — unit tests for the broker's per-binary
// login-flow gate (fleet-task #234) and missing-auth gate
// (fleet-task #292).
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLoginStateMarkAndClear(t *testing.T) {
	withTempHome(t)
	s := newLoginState()
	if s.active("codex") {
		t.Fatal("fresh state should not be active")
	}
	s.mark("codex")
	if !s.active("codex") {
		t.Fatal("after mark, codex should be active")
	}
	if s.active("claude") {
		t.Fatal("mark of codex must not leak to claude")
	}
	s.clear("codex")
	if s.active("codex") {
		t.Fatal("after clear, codex should not be active")
	}
}

func TestLoginStateClearsStaleMarkWhenAuthFileExists(t *testing.T) {
	withTempHome(t)
	writeAuthFile(t, "codex")

	s := newLoginState()
	s.mark("codex")

	if s.active("codex") {
		t.Fatal("auth file should clear stale codex login-in-progress mark")
	}
	if s.loggingIn["codex"] {
		t.Fatal("stale codex mark should be removed after auth file is present")
	}
}

func TestLoginStateConcurrentSafety(t *testing.T) {
	withTempHome(t)
	s := newLoginState()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); s.mark("codex") }()
		go func() { defer wg.Done(); _ = s.active("codex") }()
	}
	wg.Wait()
	if !s.active("codex") {
		t.Fatal("expected codex still active after concurrent marks")
	}
	s.clear("codex")
}

func TestSniffLoginTrigger(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"codex login --device-auth\r", "codex"},
		{"codex login\r", "codex"},
		{"claude setup-token\r", "claude"},
		{"claude /login\r", "claude"},
		{"echo hi\r", ""},
		{"\x03", ""},
		{"", ""},
		// Substring is enough — the sniff is intentionally permissive
		// since false-positives only block /chat while the WS is open.
		{"some prefix then codex login mid-line", "codex"},
	}
	for _, c := range cases {
		got := sniffLoginTrigger([]byte(c.in))
		if got != c.want {
			t.Errorf("sniffLoginTrigger(%q)=%q, want %q", c.in, got, c.want)
		}
	}
}

// TestChatHandlerRefusesDuringLogin asserts the broker returns an
// `auth_in_progress` ndjson frame (not 4xx, not a fresh codex spawn)
// when /chat is hit while a /login flow is marked active for that
// binary. This is the user-facing contract that fixes fleet-task #234.
func TestChatHandlerRefusesDuringLogin(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	withTempHome(t)

	// Mark codex as logging-in.
	globalLoginState.mark("codex")
	defer globalLoginState.clear("codex")

	req := httptest.NewRequest(http.MethodPost,
		"/chat?binary=codex&token=tt",
		strings.NewReader(`{"prompt":"ping"}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (ndjson body carries the error), got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "ndjson") {
		t.Fatalf("expected ndjson content-type, got %q", ct)
	}
	// One line, one frame.
	lines := strings.Split(strings.TrimRight(rec.Body.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one ndjson frame, got %d: %q", len(lines), rec.Body.String())
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &frame); err != nil {
		t.Fatalf("frame is not JSON: %v body=%q", err, lines[0])
	}
	if frame["type"] != "error" {
		t.Fatalf("expected type=error, got %v", frame["type"])
	}
	if frame["code"] != "auth_in_progress" {
		t.Fatalf("expected code=auth_in_progress, got %v", frame["code"])
	}
}

// withTempHome points HOME at a fresh tmpdir for the duration of the
// test so authFileExists isn't sniffing the developer's real
// ~/.codex/auth.json. Caller writes auth files into the returned dir.
func withTempHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	return dir
}

// writeAuthFile writes a non-empty placeholder credential file at the
// path authFilePath(binary) expects, creating parents.
func writeAuthFile(t *testing.T, binary string) {
	t.Helper()
	p := authFilePath(binary)
	if p == "" {
		t.Fatalf("no auth file path for binary=%s", binary)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"tokens":{"placeholder":true}}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAuthFilePath(t *testing.T) {
	t.Setenv("HOME", "/home/rt")
	if got := authFilePath("codex"); got != "/home/rt/.codex/auth.json" {
		t.Errorf("codex path: got %s", got)
	}
	if got := authFilePath("claude"); got != "/home/rt/.claude/.credentials.json" {
		t.Errorf("claude path: got %s", got)
	}
	if got := authFilePath("bash"); got != "" {
		t.Errorf("bash should return empty (no gate), got %s", got)
	}
}

func TestAuthFileExistsMissing(t *testing.T) {
	withTempHome(t)
	if authFileExists("codex") {
		t.Fatal("expected codex auth missing in empty HOME")
	}
	if authFileExists("claude") {
		t.Fatal("expected claude auth missing in empty HOME")
	}
	// Unknown binary: don't gate.
	if !authFileExists("bash") {
		t.Fatal("expected bash to pass the gate unconditionally")
	}
}

func TestAuthFileExistsPresent(t *testing.T) {
	withTempHome(t)
	writeAuthFile(t, "codex")
	if !authFileExists("codex") {
		t.Fatal("expected codex auth present after write")
	}
	if authFileExists("claude") {
		t.Fatal("writing codex auth must not satisfy claude gate")
	}
}

func TestAuthFileExistsZeroByteTreatedAsMissing(t *testing.T) {
	home := withTempHome(t)
	p := filepath.Join(home, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	if authFileExists("codex") {
		t.Fatal("zero-byte auth.json must be treated as missing (mid-write or corrupt)")
	}
}

// TestChatHandlerRefusesWhenAuthMissing asserts the broker returns an
// `auth_required` ndjson frame when /chat is hit with no on-disk
// credential file for the target binary. This is the fix for #292:
// without it, codex spawns, hits HTTP 401 against the OpenAI API,
// retries five times over ~8s, exits non-zero, and surfaces in the UI
// as a generic "codex exited with: exit status 1" — actionable for
// nobody.
func TestChatHandlerRefusesWhenAuthMissing(t *testing.T) {
	withTempHome(t)
	t.Setenv("BROKER_TENANT_TOKEN", "tt")

	req := httptest.NewRequest(http.MethodPost,
		"/chat?binary=codex&token=tt",
		strings.NewReader(`{"prompt":"ping"}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (ndjson body carries the error), got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "ndjson") {
		t.Fatalf("expected ndjson content-type, got %q", ct)
	}
	lines := strings.Split(strings.TrimRight(rec.Body.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one ndjson frame, got %d: %q", len(lines), rec.Body.String())
	}
	var frame map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &frame); err != nil {
		t.Fatalf("frame is not JSON: %v body=%q", err, lines[0])
	}
	if frame["type"] != "error" {
		t.Fatalf("expected type=error, got %v", frame["type"])
	}
	if frame["code"] != "auth_required" {
		t.Fatalf("expected code=auth_required, got %v", frame["code"])
	}
	msg, _ := frame["message"].(string)
	if !strings.Contains(msg, "/settings/token-source") {
		t.Errorf("expected message to point user at /settings/token-source, got %q", msg)
	}
}

// TestChatHandlerProceedsWhenAuthPresent confirms that when the
// auth file IS present, the gate passes through and we reach the
// downstream spawn path (which will fail with spawn_failed in CI
// because the codex binary isn't installed — that's how we know the
// gate didn't fire).
func TestChatHandlerProceedsWhenAuthPresent(t *testing.T) {
	withTempHome(t)
	writeAuthFile(t, "codex")
	t.Setenv("BROKER_TENANT_TOKEN", "tt")

	req := httptest.NewRequest(http.MethodPost,
		"/chat?binary=codex&token=tt",
		strings.NewReader(`{"prompt":"ping","timeout":1}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, `"auth_required"`) {
		t.Fatalf("gate fired when auth file existed; body=%s", body)
	}
}

// TestChatHandlerIsolatesBinariesDuringLogin confirms a `claude` /chat
// can still proceed when only `codex` is marked logging-in (and vice
// versa). Without the binary-scoped check we would deadlock both
// halves of the agent during one /login.
//
// We don't fully drive the spawn (would require a real claude binary),
// but we assert the gate did NOT short-circuit — the handler must
// progress past the gate and fail at the actual exec step instead.
// In CI the binary is absent, so cmd.Start() fails with `spawn_failed`,
// which serves as the proof the gate did not fire.
func TestChatHandlerIsolatesBinariesDuringLogin(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	// #292: also bypass the missing-auth gate so we exercise the
	// per-binary isolation of the login gate, not the auth file check.
	withTempHome(t)
	writeAuthFile(t, "claude")

	globalLoginState.mark("codex")
	defer globalLoginState.clear("codex")

	req := httptest.NewRequest(http.MethodPost,
		"/chat?binary=claude&token=tt",
		strings.NewReader(`{"prompt":"ping","timeout":1}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)

	body := rec.Body.String()
	// The login gate would have returned an `auth_in_progress` frame;
	// the actual spawn failure (or successful stream tail) won't carry
	// that code. Either status 200 (streaming success) or a
	// `spawn_failed` JSON error is acceptable — both mean we got past
	// the gate. We also assert no `auth_required` leakage from #292's
	// gate, since we've satisfied it with writeAuthFile above.
	if strings.Contains(body, `"auth_in_progress"`) {
		t.Fatalf("login gate fired for binary=claude when only codex was marked; body=%s", body)
	}
	if strings.Contains(body, `"auth_required"`) {
		t.Fatalf("auth-required gate fired despite writeAuthFile; body=%s", body)
	}
}
