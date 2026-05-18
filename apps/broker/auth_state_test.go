// auth_state_test.go — unit tests for the broker's per-binary
// login-flow gate (fleet-task #234).
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestLoginStateMarkAndClear(t *testing.T) {
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

func TestLoginStateConcurrentSafety(t *testing.T) {
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

	globalLoginState.mark("codex")
	defer globalLoginState.clear("codex")

	req := httptest.NewRequest(http.MethodPost,
		"/chat?binary=claude&token=tt",
		strings.NewReader(`{"prompt":"ping","timeout":1}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)

	body := rec.Body.String()
	// The gate would have returned an `auth_in_progress` frame; the
	// actual spawn failure (or successful stream tail) won't carry that
	// code. Either status 200 (streaming success) or a `spawn_failed`
	// JSON error is acceptable — both mean we got past the gate.
	if strings.Contains(body, `"auth_in_progress"`) {
		t.Fatalf("gate fired for binary=claude when only codex was marked; body=%s", body)
	}
}
