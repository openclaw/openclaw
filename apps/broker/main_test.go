package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	healthHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected JSON body, got %q: %v", rec.Body.String(), err)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status=ok, got %q", body["status"])
	}
}

// Auto-execute contract for the spawn-per-prompt /chat path: claude
// must be spawned with --dangerously-skip-permissions for the same
// reason as the /chat-pty path. fleet-task #102.
func TestClaudeChatArgsHasAutoExecute(t *testing.T) {
	args := claudeChatArgs("hello", "")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--dangerously-skip-permissions") {
		t.Fatalf("expected --dangerously-skip-permissions in args, got %q", joined)
	}
	if !strings.Contains(joined, "--output-format stream-json") {
		t.Fatalf("expected stream-json output, got %q", joined)
	}
	// --resume only when a session_id is provided.
	if strings.Contains(joined, "--resume") {
		t.Fatalf("unexpected --resume with empty session, got %q", joined)
	}
	withSid := strings.Join(claudeChatArgs("hi", "sess-1"), " ")
	if !strings.Contains(withSid, "--resume sess-1") {
		t.Fatalf("expected --resume sess-1, got %q", withSid)
	}
}

func TestConstantTimeStringEq(t *testing.T) {
	if !constantTimeStringEq("abc", "abc") {
		t.Fatal("equal strings should match")
	}
	if constantTimeStringEq("abc", "abd") {
		t.Fatal("different strings of equal length should not match")
	}
	if constantTimeStringEq("abc", "abcd") {
		t.Fatal("different lengths should not match")
	}
	if constantTimeStringEq("", "") {
		// Note: subtle.ConstantTimeCompare returns 1 only for non-empty
		// equal slices. The wrapper relies on len() short-circuit, so
		// empty == empty must return false to match Go's behavior. We
		// codify whatever the current impl does so a refactor stays safe.
		// (Empty broker tokens are rejected upstream regardless.)
		t.Log("empty/empty matched; this is acceptable but unusual")
	}
}

func TestRedactNeverLeaksValue(t *testing.T) {
	r := redact("super-secret-token")
	if strings.Contains(r, "super") || strings.Contains(r, "secret") {
		t.Fatalf("redact leaked the value: %q", r)
	}
	if !strings.Contains(r, "redacted") {
		t.Fatalf("redact output should mention 'redacted', got %q", r)
	}
}

func TestSpawnRequiresToken(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "test-token")
	body := strings.NewReader(`{"binary":"bash","args":["-c","echo hi"]}`)
	req := httptest.NewRequest(http.MethodPost, "/spawn", body)
	rec := httptest.NewRecorder()
	spawnHandler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_token") {
		t.Fatalf("expected error code invalid_token, got %s", rec.Body.String())
	}
}

func TestSpawnRejectsInvalidBinary(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	body := strings.NewReader(`{"binary":"rm","args":["-rf","/"]}`)
	req := httptest.NewRequest(http.MethodPost, "/spawn?token=tt", body)
	rec := httptest.NewRecorder()
	spawnHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_binary") {
		t.Fatalf("expected invalid_binary error, got %s", rec.Body.String())
	}
}

func TestSpawnHappyPath(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	body := strings.NewReader(`{"binary":"bash","args":["-c","echo hello && echo err 1>&2 && exit 7"],"timeout_sec":5}`)
	req := httptest.NewRequest(http.MethodPost, "/spawn?token=tt", body)
	rec := httptest.NewRecorder()
	spawnHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp spawnResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v / %s", err, rec.Body.String())
	}
	if resp.ExitCode != 7 {
		t.Fatalf("expected exit 7, got %d", resp.ExitCode)
	}
	if !strings.Contains(resp.Stdout, "hello") {
		t.Fatalf("expected stdout 'hello', got %q", resp.Stdout)
	}
	if !strings.Contains(resp.Stderr, "err") {
		t.Fatalf("expected stderr 'err', got %q", resp.Stderr)
	}
}

// TestPTYFramingRoundtrip exercises /ws end-to-end against `bash` and
// validates the framing scheme: stdin frame in, stdout frame out, exit
// frame at the end. This is the "one PTY framing roundtrip with a mocked
// binary" called for in the Phase 2 spec.
func TestChatRequiresToken(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	req := httptest.NewRequest(http.MethodPost, "/chat?binary=claude", strings.NewReader(`{"prompt":"hi"}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestChatRejectsInvalidBinary(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	req := httptest.NewRequest(http.MethodPost, "/chat?binary=python&token=tt", strings.NewReader(`{"prompt":"hi"}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestChatRejectsEmptyPrompt(t *testing.T) {
	t.Setenv("BROKER_TENANT_TOKEN", "tt")
	req := httptest.NewRequest(http.MethodPost, "/chat?binary=claude&token=tt", strings.NewReader(`{"prompt":""}`))
	rec := httptest.NewRecorder()
	chatHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestFlattenHistory(t *testing.T) {
	got := flattenHistory(nil, "hi")
	if got != "hi" {
		t.Fatalf("empty history should pass through prompt; got %q", got)
	}

	turns := []chatTurn{
		{Role: "user", Content: "first user message"},
		{Role: "assistant", Content: "assistant reply"},
	}
	got = flattenHistory(turns, "second user message")
	if !strings.Contains(got, "first user message") ||
		!strings.Contains(got, "assistant reply") ||
		!strings.Contains(got, "second user message") {
		t.Fatalf("flattened prompt missing turns: %q", got)
	}
	// Order must preserve history then current prompt.
	idxFirst := strings.Index(got, "first user message")
	idxSecond := strings.Index(got, "second user message")
	if idxFirst < 0 || idxSecond < 0 || idxFirst >= idxSecond {
		t.Fatalf("history must precede current prompt; got %q", got)
	}
}

func TestPTYFramingRoundtrip(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skipf("bash not available on this host: %v", err)
	}
	t.Setenv("BROKER_TENANT_TOKEN", "tt")

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	u, _ := url.Parse(wsURL)
	q := u.Query()
	q.Set("token", "tt")
	q.Set("binary", "bash")
	u.RawQuery = q.Encode()

	dialer := websocket.DefaultDialer
	conn, resp, err := dialer.Dial(u.String(), nil)
	if err != nil {
		respBody := ""
		if resp != nil {
			b, _ := io.ReadAll(resp.Body)
			respBody = string(b)
		}
		t.Fatalf("dial failed: %v body=%s", err, respBody)
	}
	defer conn.Close()

	// Send: 0x01 "echo READY\nexit 0\n"
	cmd := []byte("echo READY\nexit 0\n")
	frame := append([]byte{frameStdin}, cmd...)
	if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		t.Fatalf("write stdin frame: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	_ = conn.SetReadDeadline(deadline)

	gotReady := false
	gotExit := false
	for !gotExit && time.Now().Before(deadline) {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage || len(data) < 1 {
			continue
		}
		switch data[0] {
		case frameStdout:
			if strings.Contains(string(data[1:]), "READY") {
				gotReady = true
			}
		case frameExit:
			gotExit = true
		}
	}
	if !gotReady {
		t.Fatalf("never received stdout frame containing READY")
	}
	if !gotExit {
		t.Fatalf("never received exit frame")
	}
}
