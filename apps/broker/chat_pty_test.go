package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubSession spins up a tiny shell script that mimics claude's
// stream-json behaviour: it reads JSON lines from stdin and for each
// `{"type":"user", ...}` line it emits a fake init (only on first
// turn), an `assistant` text frame echoing the prompt, and a `result`
// frame. This lets us exercise the pool's lifecycle, mutex, and
// terminator detection without depending on the real claude binary.
func stubSpawn(t *testing.T) func(ctx context.Context, sessionID, binary, cwd string, resume bool) (*ptySession, error) {
	t.Helper()
	// Use a bash one-liner instead of writing a file so the test stays
	// self-contained. The "init" frame is only emitted on the first line
	// of input so we can prove the session-warm path works. We parse the
	// prompt out of the input JSON via a crude content-capture so the
	// echoed text only contains the user's prompt (matches what claude
	// would do).
	script := `awk 'BEGIN{first=1} {
		match($0, /"content":"[^"]*"/);
		content = substr($0, RSTART+11, RLENGTH-12);
		if (first==1) {
			print "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"SID\"}";
			first=0;
		}
		print "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"echo: " content "\"}]}}";
		print "{\"type\":\"result\",\"is_error\":false,\"stop_reason\":\"end_turn\"}";
		fflush();
	}'`

	return func(ctx context.Context, sessionID, binary, cwd string, resume bool) (*ptySession, error) {
		s := strings.ReplaceAll(script, "SID", sessionID)
		cmd := exec.Command("bash", "-c", s)
		stdin, err := cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		stderr := &boundedBuffer{cap: 1024}
		cmd.Stderr = stderr
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		sess := &ptySession{
			sessionID: sessionID,
			binary:    binary,
			cwd:       cwd,
			cmd:       cmd,
			stdin:     stdin,
			outCh:     make(chan []byte, 64),
			stderrBuf: stderr,
			lastSeen:  time.Now(),
			done:      make(chan struct{}),
			resumed:   resume,
		}
		go func() {
			scanner := bufio.NewScanner(stdout)
			scanner.Buffer(make([]byte, 0, 4096), scanLineCap)
			for scanner.Scan() {
				b := make([]byte, len(scanner.Bytes()))
				copy(b, scanner.Bytes())
				sess.outCh <- b
			}
			close(sess.outCh)
		}()
		go func() {
			_ = cmd.Wait()
			close(sess.done)
		}()
		return sess, nil
	}
}

func TestNewSessionIDIsValidUUID(t *testing.T) {
	id := newSessionID()
	if len(id) != 36 {
		t.Fatalf("expected 36-char UUID, got %q", id)
	}
	parts := strings.Split(id, "-")
	if len(parts) != 5 {
		t.Fatalf("expected 5 hyphenated UUID parts, got %d in %q", len(parts), id)
	}
	if got := []rune(parts[2])[0]; got != '4' {
		t.Fatalf("expected v4 (group3[0]='4'), got %q in %q", got, id)
	}
}

func TestIsResultFrame(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"plain result", `{"type":"result","is_error":false}`, true},
		{"result with stop_reason", `{"type":"result","stop_reason":"end_turn"}`, true},
		{"assistant frame", `{"type":"assistant","message":{}}`, false},
		// Substring "result" appearing in a token text should not fool us.
		{"result-as-content", `{"type":"assistant","message":{"content":[{"type":"text","text":"the result is good"}]}}`, false},
		{"empty", ``, false},
		{"garbage", `not json`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isResultFrame([]byte(tc.in)); got != tc.want {
				t.Fatalf("isResultFrame(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestSessionPoolReuseAndRespawn(t *testing.T) {
	p := &sessionPool{sessions: make(map[string]*ptySession), known: make(map[string]struct{}), spawnFn: stubSpawn(t)}
	defer p.shutdown()

	ctx := context.Background()
	sess1, err := p.get(ctx, "sid-A", "claude", "/tmp", true)
	if err != nil {
		t.Fatalf("first get: %v", err)
	}
	if !sess1.alive() {
		t.Fatalf("first session should be alive")
	}

	// Asking for the same id should return the same session (no respawn).
	sess2, err := p.get(ctx, "sid-A", "claude", "/tmp", true)
	if err != nil {
		t.Fatalf("second get: %v", err)
	}
	if sess2 != sess1 {
		t.Fatalf("expected same session for same id; got different *ptySession")
	}

	// Asking for a different id should spawn a separate process.
	sess3, err := p.get(ctx, "sid-B", "claude", "/tmp", true)
	if err != nil {
		t.Fatalf("third get: %v", err)
	}
	if sess3 == sess1 {
		t.Fatalf("expected fresh session for new id")
	}

	// Kill the underlying process and ask for sid-A again — the pool
	// must detect the death and respawn.
	sess1.kill()
	// Wait briefly for the reaper goroutine to flip alive() false.
	deadline := time.Now().Add(2 * time.Second)
	for sess1.alive() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if sess1.alive() {
		t.Fatalf("expected sess1 to be dead after kill()")
	}

	sess4, err := p.get(ctx, "sid-A", "claude", "/tmp", true)
	if err != nil {
		t.Fatalf("fourth get (after kill): %v", err)
	}
	if sess4 == sess1 {
		t.Fatalf("expected respawned session for sid-A after death")
	}
	if !sess4.alive() {
		t.Fatalf("respawned session should be alive")
	}
}

func TestSessionPoolReapsIdle(t *testing.T) {
	p := &sessionPool{sessions: make(map[string]*ptySession), known: make(map[string]struct{}), spawnFn: stubSpawn(t)}
	defer p.shutdown()
	ctx := context.Background()

	sess, err := p.get(ctx, "sid-X", "claude", "/tmp", true)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(p.sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(p.sessions))
	}

	// Backdate lastSeen so reap considers it idle.
	p.mu.Lock()
	sess.lastSeen = time.Now().Add(-2 * sessionIdleTimeout)
	p.mu.Unlock()

	killed := p.reap(time.Now())
	if killed != 1 {
		t.Fatalf("expected 1 reaped, got %d", killed)
	}
	if len(p.sessions) != 0 {
		t.Fatalf("expected empty pool after reap, got %d", len(p.sessions))
	}
}

func TestSessionPoolShutdownKillsAll(t *testing.T) {
	p := &sessionPool{sessions: make(map[string]*ptySession), known: make(map[string]struct{}), spawnFn: stubSpawn(t)}
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		if _, err := p.get(ctx, id, "claude", "/tmp", true); err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
	}
	if len(p.sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(p.sessions))
	}
	p.shutdown()
	if len(p.sessions) != 0 {
		t.Fatalf("expected 0 after shutdown, got %d", len(p.sessions))
	}
}

// TestChatPTYEndToEndWithStub exercises the full HTTP handler against
// the stubbed claude binary: two sequential turns on the same session
// should both stream out a `result` frame and the second turn should
// reuse the warm process (no respawn).
func TestChatPTYEndToEndWithStub(t *testing.T) {
	setBrokerTestEnv(t, "tt")
	// The #292 auth_required gate runs before the spawn pool — point
	// HOME at a tmpdir and synthesise a credentials file so the test
	// exercises the actual end-to-end pool path rather than the gate.
	// The stubbed binary is fake; the gate doesn't read the file's
	// contents, only its size.
	withTempHome(t)
	writeAuthFile(t, "claude")

	// Swap the global pool's spawn function so /chat-pty uses the stub.
	prevSpawn := globalPool.spawnFn
	globalPool.mu.Lock()
	globalPool.spawnFn = stubSpawn(t)
	globalPool.mu.Unlock()
	defer func() {
		globalPool.shutdown()
		globalPool.spawnFn = prevSpawn
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/chat-pty", chatPTYHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	sendTurn := func(t *testing.T, sessionID, prompt string) (string, int) {
		t.Helper()
		url := srv.URL + "/chat-pty?token=tt&binary=claude"
		if sessionID != "" {
			url += "&session_id=" + sessionID
		}
		body := strings.NewReader(fmt.Sprintf(`{"prompt":%q}`, prompt))
		req, _ := http.NewRequest(http.MethodPost, url, body)
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()
		bs, _ := io.ReadAll(resp.Body)
		return string(bs), resp.StatusCode
	}

	// Turn 1: empty session_id means broker mints one. Body should
	// contain an `init` frame and a `result` frame.
	body1, code := sendTurn(t, "", "hello")
	if code != 200 {
		t.Fatalf("turn1 code = %d, body = %s", code, body1)
	}
	if !strings.Contains(body1, `"type":"system"`) || !strings.Contains(body1, `"subtype":"init"`) {
		t.Fatalf("turn1 missing init frame: %s", body1)
	}
	if !strings.Contains(body1, `"type":"result"`) {
		t.Fatalf("turn1 missing result frame: %s", body1)
	}
	// Extract session_id from init frame so turn 2 can target it.
	var sid string
	for _, line := range strings.Split(body1, "\n") {
		var p struct {
			Type      string `json:"type"`
			Subtype   string `json:"subtype"`
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal([]byte(line), &p) == nil && p.Type == "system" && p.Subtype == "init" {
			sid = p.SessionID
			break
		}
	}
	if sid == "" {
		t.Fatalf("could not find session_id in turn1 init frame: %s", body1)
	}

	if got := len(globalPool.sessions); got != 1 {
		t.Fatalf("expected 1 pooled session after turn1, got %d", got)
	}

	// Turn 2: same session_id reuses the warm process. With the stub
	// behavior, the init frame is only emitted on the FIRST input line,
	// so turn 2's body should NOT contain `init`.
	body2, code := sendTurn(t, sid, "again")
	if code != 200 {
		t.Fatalf("turn2 code = %d, body = %s", code, body2)
	}
	if strings.Contains(body2, `"subtype":"init"`) {
		t.Fatalf("turn2 unexpectedly re-init'd (was the session respawned?): %s", body2)
	}
	if !strings.Contains(body2, `"type":"result"`) {
		t.Fatalf("turn2 missing result frame: %s", body2)
	}
	if !strings.Contains(body2, "echo: ") {
		t.Fatalf("turn2 missing assistant echo: %s", body2)
	}

	if got := len(globalPool.sessions); got != 1 {
		t.Fatalf("expected still 1 pooled session after turn2, got %d", got)
	}
}

func TestChatPTYRequiresToken(t *testing.T) {
	setBrokerTestEnv(t, "tt")
	req := httptest.NewRequest(http.MethodPost, "/chat-pty?binary=claude",
		strings.NewReader(`{"prompt":"hi"}`))
	rec := httptest.NewRecorder()
	chatPTYHandler(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestChatPTYRejectsNonClaudeBinary(t *testing.T) {
	setBrokerTestEnv(t, "tt")
	req := httptest.NewRequest(http.MethodPost,
		"/chat-pty?binary=codex&token=tt",
		strings.NewReader(`{"prompt":"hi"}`))
	rec := httptest.NewRecorder()
	chatPTYHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_binary") {
		t.Fatalf("expected invalid_binary error, got %s", rec.Body.String())
	}
}

func TestChatPTYRejectsEmptyPrompt(t *testing.T) {
	setBrokerTestEnv(t, "tt")
	req := httptest.NewRequest(http.MethodPost,
		"/chat-pty?binary=claude&token=tt",
		strings.NewReader(`{"prompt":""}`))
	rec := httptest.NewRecorder()
	chatPTYHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestSessionMutexSerialisesConcurrentTurns confirms that two
// in-flight requests against the same session_id don't interleave
// their stdin writes. We sniff for "echo: A" and "echo: B" appearing
// in their own response bodies, not bled across.
func TestSessionMutexSerialisesConcurrentTurns(t *testing.T) {
	setBrokerTestEnv(t, "tt")
	// #292: bypass the auth-required gate so the test reaches the
	// session pool.
	withTempHome(t)
	writeAuthFile(t, "claude")

	prevSpawn := globalPool.spawnFn
	globalPool.mu.Lock()
	globalPool.spawnFn = stubSpawn(t)
	globalPool.mu.Unlock()
	defer func() {
		globalPool.shutdown()
		globalPool.spawnFn = prevSpawn
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/chat-pty", chatPTYHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Prime the session.
	sid := newSessionID()
	primeReq, _ := http.NewRequest(http.MethodPost,
		srv.URL+"/chat-pty?token=tt&binary=claude&session_id="+sid,
		strings.NewReader(`{"prompt":"prime"}`))
	primeResp, err := (&http.Client{Timeout: 5 * time.Second}).Do(primeReq)
	if err != nil {
		t.Fatalf("prime: %v", err)
	}
	io.Copy(io.Discard, primeResp.Body)
	primeResp.Body.Close()

	var wg sync.WaitGroup
	results := make([]string, 2)
	for i, prompt := range []string{"A", "B"} {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodPost,
				srv.URL+"/chat-pty?token=tt&binary=claude&session_id="+sid,
				strings.NewReader(fmt.Sprintf(`{"prompt":%q}`, p)))
			resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
			if err != nil {
				results[i] = "ERR:" + err.Error()
				return
			}
			defer resp.Body.Close()
			bs, _ := io.ReadAll(resp.Body)
			results[i] = string(bs)
		}(i, prompt)
	}
	wg.Wait()

	// Each response should contain exactly its own prompt's echo, not
	// the other's.
	for i, want := range []string{"echo: A", "echo: B"} {
		if !strings.Contains(results[i], want) {
			t.Fatalf("response %d missing own echo %q. body=%s", i, want, results[i])
		}
		// Belt-and-suspenders: response should also contain exactly one
		// result frame (serialization, not interleaving).
		if strings.Count(results[i], `"type":"result"`) != 1 {
			t.Fatalf("response %d has wrong number of result frames: %s", i, results[i])
		}
	}
}

func TestBoundedBufferCaps(t *testing.T) {
	b := &boundedBuffer{cap: 8}
	_, _ = b.Write([]byte("ABCDE"))
	_, _ = b.Write([]byte("FGHIJ"))
	got := b.String()
	if len(got) != 8 {
		t.Fatalf("expected len=8 after overflow, got %d (%q)", len(got), got)
	}
	if got != "CDEFGHIJ" {
		t.Fatalf("expected oldest-bytes dropped, got %q", got)
	}
}

// Auto-execute contract: the persistent-session claude must be spawned
// with --dangerously-skip-permissions so SaaS chat tool calls run
// without dead-end "approve in your permission settings" responses
// (fleet-task #102). --session-id must also be present so the broker
// can correlate stream-json frames back to the WS turn.
func TestClaudePTYArgsHasAutoExecuteAndSessionID(t *testing.T) {
	sid := "11111111-2222-4333-8444-555555555555"
	args := claudePTYArgs(sid, false)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--dangerously-skip-permissions") {
		t.Fatalf("expected --dangerously-skip-permissions in args, got %q", joined)
	}
	// Create mode: --session-id <id> (and NOT --resume).
	if !strings.Contains(joined, "--session-id "+sid) {
		t.Fatalf("expected --session-id %s in create-mode args, got %q", sid, joined)
	}
	if strings.Contains(joined, "--resume") {
		t.Fatalf("create-mode args must not contain --resume, got %q", joined)
	}
	if !strings.Contains(joined, "--output-format stream-json") {
		t.Fatalf("expected stream-json output, got %q", joined)
	}
}

// Resume mode must bind the id via --resume, NOT --session-id. Re-creating
// an existing session id makes the CLI exit with "Session ID already in
// use" and zero stdout — the chat-pty hang this fix closes. Proven against
// claude 2.1.170 and 2.1.178.
func TestClaudePTYArgsResumeUsesResumeFlag(t *testing.T) {
	sid := "11111111-2222-4333-8444-555555555555"
	args := claudePTYArgs(sid, true)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--resume "+sid) {
		t.Fatalf("expected --resume %s in resume-mode args, got %q", sid, joined)
	}
	if strings.Contains(joined, "--session-id") {
		t.Fatalf("resume-mode args must not contain --session-id (would re-create + collide), got %q", joined)
	}
	if !strings.Contains(joined, "--dangerously-skip-permissions") {
		t.Fatalf("expected --dangerously-skip-permissions in resume args, got %q", joined)
	}
}

// TestIsResumeMissResult covers the "No conversation found" signature: a
// result frame with is_error=true and num_turns=0. A normal turn's result
// (num_turns>=1) or a successful result must NOT be classed as a miss.
func TestIsResumeMissResult(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"resume miss", `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0}`, true},
		{"normal success", `{"type":"result","is_error":false,"num_turns":1}`, false},
		{"error mid-turn", `{"type":"result","is_error":true,"num_turns":2}`, false},
		{"not a result", `{"type":"assistant","is_error":true,"num_turns":0}`, false},
		{"garbage", `nope`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isResumeMissResult([]byte(tc.in)); got != tc.want {
				t.Fatalf("isResumeMissResult(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestChatPTYChildReceivesSafeTenantRuntimeEnv(t *testing.T) {
	withTempHome(t)
	writeAuthFile(t, "claude")
	setBrokerTestEnv(t, "tt")
	t.Setenv("ROCKIELAB_TENANT_TOKEN", "service-token")
	t.Setenv("ROCKIELAB_API_URL", "https://api.rockielab.test")
	t.Setenv("BINARY", "codex")
	t.Setenv("ROCKIELAB_API_PASSWORD", "platform-secret")

	cwd := t.TempDir()
	binDir := t.TempDir()
	script := `#!/bin/sh
{
  printf 'has_token=%s\n' "$([ -n "${ROCKIELAB_TENANT_TOKEN:-}" ] && echo yes || echo no)"
  printf 'token_distinct=%s\n' "$([ "${ROCKIELAB_TENANT_TOKEN:-}" != "${ROCKIELAB_TENANT_ID:-}" ] && echo yes || echo no)"
  printf 'tenant_id=%s\n' "${ROCKIELAB_TENANT_ID:-}"
  printf 'binary=%s\n' "${BINARY:-}"
  printf 'api=%s\n' "${ROCKIELAB_API_URL:-}"
  printf 'broker_token=%s\n' "${BROKER_TENANT_TOKEN:+leaked}"
  printf 'api_password=%s\n' "${ROCKIELAB_API_PASSWORD:+leaked}"
} > "$PWD/chat-pty-env.txt"
first=1
while IFS= read -r line; do
  if [ "$first" = 1 ]; then
    printf '{"type":"system","subtype":"init","session_id":"sid-env"}\n'
    first=0
  fi
  printf '{"type":"result","is_error":false,"stop_reason":"end_turn"}\n'
done
`
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte(script), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	t.Setenv("PATH", binDir)

	mux := http.NewServeMux()
	mux.HandleFunc("/chat-pty", chatPTYHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Post(
		srv.URL+"/chat-pty?token=tt&binary=claude&session_id=sid-env",
		"application/json",
		strings.NewReader(fmt.Sprintf(`{"prompt":"env probe","cwd":%q}`, cwd)),
	)
	if err != nil {
		t.Fatalf("post chat-pty: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", resp.StatusCode, body)
	}
	envProbe, err := os.ReadFile(filepath.Join(cwd, "chat-pty-env.txt"))
	if err != nil {
		t.Fatalf("read chat-pty env probe: %v body=%s", err, body)
	}
	for _, want := range []string{
		"has_token=yes",
		"token_distinct=yes",
		"tenant_id=tenant-test",
		"binary=codex",
		"api=https://api.rockielab.test",
		"broker_token=",
		"api_password=",
	} {
		if !strings.Contains(string(envProbe), want) {
			t.Fatalf("chat-pty child env missing %q in probe %q", want, envProbe)
		}
	}
	globalPool.mu.Lock()
	if sess := globalPool.sessions["sid-env"]; sess != nil {
		sess.kill()
		delete(globalPool.sessions, "sid-env")
	}
	globalPool.mu.Unlock()
}

// Sanity: spawnSession surfaces an error for unsupported binaries.
func TestSpawnSessionRejectsCodex(t *testing.T) {
	_, err := spawnSession(context.Background(), newSessionID(), "codex", os.TempDir(), false)
	if err == nil {
		t.Fatalf("expected error for codex; got nil")
	}
	if !strings.Contains(err.Error(), "claude") {
		t.Fatalf("expected error to mention claude-only support, got %v", err)
	}
}

// TestChatPTYRealCLIRespawnEmitsResult is the PROVEN-EXECUTION smoke test
// (#139): it drives the ACTUAL installed `claude` binary through the real
// chatPTYHandler — NOT the stub — and asserts a `result` frame arrives on
// the respawn path that produced the subscription_claude prod hang.
//
// The bug: the broker spawned every session with `--session-id <id>`. The
// CLI errors "Session ID <id> is already in use" (zero stdout, immediate
// exit) when <id> already exists on disk, which is exactly what happens on
// a respawn (idle-reaped / crashed warm process, or a client-threaded id
// after a broker restart). Result: `lines=0 result=false` → upstream 60s
// backend_timeout → "Rockie's response was interrupted." The stub test can
// never catch this because the stub does not enforce the CLI's session-id
// contract. This test does.
//
// Guarded: skips unless `claude` is on PATH AND a non-empty
// $HOME/.claude/.credentials.json exists (the broker's own auth gate). In
// CI without a subscription it skips; an operator (or the dogfood box)
// runs it with real auth. Run locally with:
//
//	ROCKIE_REAL_CLI_SMOKE=1 HOME=/path/with/.claude go test -run RealCLIRespawn -v
func TestChatPTYRealCLIRespawnEmitsResult(t *testing.T) {
	if os.Getenv("ROCKIE_REAL_CLI_SMOKE") == "" {
		t.Skip("set ROCKIE_REAL_CLI_SMOKE=1 to run the real-claude-CLI chat-pty smoke test")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("claude binary not on PATH; skipping real-CLI smoke test")
	}
	if !authFileExists("claude") {
		t.Skipf("no non-empty %s; skipping real-CLI smoke test", authFilePath("claude"))
	}

	setBrokerTestEnv(t, "tt")

	// Use the REAL spawnSession (default globalPool.spawnFn) — do NOT stub.
	prevSpawn := globalPool.spawnFn
	defer func() {
		globalPool.shutdown()
		globalPool.spawnFn = prevSpawn
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/chat-pty", chatPTYHandler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	send := func(t *testing.T, sessionID, prompt string) string {
		t.Helper()
		u := srv.URL + "/chat-pty?token=tt&binary=claude"
		if sessionID != "" {
			u += "&session_id=" + sessionID
		}
		body := strings.NewReader(fmt.Sprintf(`{"prompt":%q}`, prompt))
		req, _ := http.NewRequest(http.MethodPost, u, body)
		client := &http.Client{Timeout: 90 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		defer resp.Body.Close()
		bs, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d body=%s", resp.StatusCode, bs)
		}
		return string(bs)
	}

	assertRealResult := func(t *testing.T, label, body string) {
		t.Helper()
		var resultOK bool
		for _, line := range strings.Split(body, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			if isResultFrame([]byte(line)) {
				var probe struct {
					IsError bool `json:"is_error"`
				}
				_ = json.Unmarshal([]byte(line), &probe)
				if probe.IsError {
					t.Fatalf("%s: result frame is_error=true: %s", label, line)
				}
				resultOK = true
			}
		}
		if strings.Contains(body, "already in use") {
			t.Fatalf("%s: hit the session-id-collision bug: %s", label, body)
		}
		if !resultOK {
			t.Fatalf("%s: no successful result frame (the prod hang signature): %s", label, body)
		}
	}

	// Turn 1: fresh session (broker mints id, --session-id CREATE).
	body1 := send(t, "", "Reply with exactly: PONG1")
	assertRealResult(t, "turn1-fresh", body1)

	// Capture the minted session_id from the init frame.
	var sid string
	for _, line := range strings.Split(body1, "\n") {
		var p struct {
			Type      string `json:"type"`
			Subtype   string `json:"subtype"`
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal([]byte(line), &p) == nil && p.Type == "system" && p.Subtype == "init" {
			sid = p.SessionID
			break
		}
	}
	if sid == "" {
		t.Fatalf("no session_id in turn1 init frame: %s", body1)
	}

	// Force the broken path: kill the warm process so the NEXT turn on the
	// same id must respawn. Pre-fix that respawn used --session-id on an
	// existing id → "already in use" → lines=0. Post-fix it uses --resume.
	globalPool.mu.Lock()
	if s, ok := globalPool.sessions[sid]; ok {
		s.kill()
	}
	globalPool.mu.Unlock()
	deadline := time.Now().Add(3 * time.Second)
	for {
		globalPool.mu.Lock()
		s, ok := globalPool.sessions[sid]
		alive := ok && s.alive()
		globalPool.mu.Unlock()
		if !alive || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Turn 2: same id, warm process dead → respawn-via-resume. This is the
	// turn that hung in prod. It must now emit a real result.
	body2 := send(t, sid, "Reply with exactly: PONG2")
	assertRealResult(t, "turn2-respawn-resume", body2)
}
