// chat_pty.go — persistent-process variant of /chat for claude.
//
// Spawn-per-prompt /chat works but pays the claude CLI's cold-start cost
// (~1–2s of MCP server init + skill loadout + scratchpad setup) on every
// turn. /chat-pty keeps the same `claude` process warm across turns by
// piping additional prompts into the same stdin and reading more
// stream-json output from the same stdout.
//
// claude supports this natively:
//
//   claude -p --input-format stream-json --output-format stream-json --verbose
//
// reads JSON-line user messages from stdin and emits stream-json events
// on stdout. Each turn terminates with a `{"type":"result",...}` frame.
// The same session_id flows through, so MCP servers / skills / scratchpad
// stay loaded.
//
// We track one session per UUID. The broker generates the UUID on first
// use and passes it as --session-id; the same id appears in the init
// frame, which the upstream client (platform-context's ClaudeBrokerBackend)
// already sniffs and threads back as ?session_id= on subsequent turns.
//
// No real PTY is needed (stream-json is line-oriented and doesn't care
// about TTY control codes); plain os.Pipe stdin/stdout is enough and
// avoids PTY-zombie failure modes on Fly-machine restart. The endpoint
// name `/chat-pty` is kept because the spec uses it; under the hood it's
// a persistent-process pool.

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// sessionIdleTimeout bounds how long a persistent session can sit
// unused before the GC reaps it. Generous because skill / MCP warm-up
// is the whole point of keeping it around.
const sessionIdleTimeout = 15 * time.Minute

// gcInterval is how often the GC goroutine scans for idle sessions.
const gcInterval = 1 * time.Minute

// turnTimeout bounds one prompt's wait for a terminating `result` frame.
// Tool-using turns can take a while; aligned with /chat's default.
const turnTimeout = 10 * time.Minute

// scanLineCap is the max length of a single stream-json line. Claude can
// emit large content_block_start frames with full message content.
const scanLineCap = 8 * 1024 * 1024

// ptySession holds one warm claude process and the plumbing to talk to
// it. We do NOT use creack/pty here — stream-json is line-oriented and
// works fine over an ordinary stdin pipe, and we avoid the PTY-zombie
// failure mode entirely.
type ptySession struct {
	sessionID string
	binary    string
	cwd       string

	cmd   *exec.Cmd
	stdin io.WriteCloser

	// outCh receives every stream-json output line, fed by a single
	// background reader goroutine started in spawnSession. Per-turn
	// handlers consume from this channel under sess.mu (one turn at a
	// time per session) and stop after the terminal `result` frame.
	outCh chan []byte

	// stderrBuf captures the tail of stderr in case the process dies and
	// we need to surface why. Bounded.
	stderrBuf *boundedBuffer

	mu       sync.Mutex // serializes turns on this session
	lastSeen time.Time  // wall-clock of the last turn (read under poolMu only)

	// done closes when the underlying process exits. Reading after this
	// closes will return immediately.
	done chan struct{}
}

// boundedBuffer is a stderr tail buffer that drops the oldest bytes once
// it reaches a soft cap. Keeps memory bounded without losing the most
// recent (typically most relevant) failure context.
type boundedBuffer struct {
	mu  sync.Mutex
	buf []byte
	cap int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.cap {
		// Keep the last cap bytes; drop the oldest.
		b.buf = b.buf[len(b.buf)-b.cap:]
	}
	return len(p), nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// sessionPool tracks all live persistent sessions on this broker. Keyed
// by session_id (a UUID minted by the broker on first use).
type sessionPool struct {
	mu       sync.Mutex
	sessions map[string]*ptySession
	// spawnFn is the function that actually starts the underlying process
	// for a new session. Indirected here so tests can stub it.
	spawnFn func(ctx context.Context, sessionID, binary, cwd string) (*ptySession, error)
}

// newSessionPool returns a pool wired to the real spawnSession.
func newSessionPool() *sessionPool {
	return &sessionPool{
		sessions: make(map[string]*ptySession),
		spawnFn:  spawnSession,
	}
}

// globalPool is the singleton pool used by chatPTYHandler. Exposed via a
// package variable so tests can swap in their own.
var globalPool = newSessionPool()

// newSessionID returns a freshly-minted RFC 4122 v4 UUID string. Claude's
// --session-id flag requires a valid UUID.
func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	// Set version (4) and variant bits.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

// alive reports whether the underlying process is still running. Used by
// the pool to decide whether to respawn on the next turn.
func (s *ptySession) alive() bool {
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

// kill terminates the underlying process and waits briefly for it. Safe
// to call multiple times.
func (s *ptySession) kill() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	if s.stdin != nil {
		_ = s.stdin.Close()
	}
}

// claudePTYArgs builds the argv for the persistent-session claude
// process. Extracted so the spawn-arg contract (especially the
// auto-execute flag) is testable without launching a real process.
func claudePTYArgs(sessionID string) []string {
	return []string{
		"-p",
		"--session-id", sessionID,
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		// Auto-execute tools. The tenant's runtime image already isolates
		// the process to that tenant's Fly machine + volume; prompting for
		// per-tool confirmation in the SaaS chat path produces dead-end
		// "approve this in your permission settings" responses (fleet-task
		// #102). The agent fleet uses this flag everywhere for the same
		// reason.
		"--dangerously-skip-permissions",
	}
}

// spawnSession starts a new `claude` (or other binary) process in
// stream-json mode with a fresh UUID. The session_id is baked into the
// CLI args so claude emits it in the init frame and every subsequent
// event.
func spawnSession(ctx context.Context, sessionID, binary, cwd string) (*ptySession, error) {
	if binary != "claude" {
		// Codex doesn't expose a comparable stream-json input mode today;
		// we ship claude-only persistent sessions per the MVP scope.
		return nil, fmt.Errorf("persistent session only supports claude (got %q)", binary)
	}
	args := claudePTYArgs(sessionID)
	cmd := exec.Command(binary, args...)
	cmd.Dir = cwd
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr := &boundedBuffer{cap: 4096}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("spawn %s: %w", binary, err)
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
	}

	// Single reader goroutine for the lifetime of the process. Per-turn
	// handlers consume from outCh and stop at the result frame. This is
	// the only owner of `stdout` after spawn.
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), scanLineCap)
		for scanner.Scan() {
			b := make([]byte, len(scanner.Bytes()))
			copy(b, scanner.Bytes())
			sess.outCh <- b
		}
		close(sess.outCh)
	}()

	// Reap the child in a goroutine so `alive()` flips promptly on exit.
	go func() {
		_ = cmd.Wait()
		close(sess.done)
	}()

	log("chat-pty: spawned binary=%s session=%s pid=%d", binary, sessionID, cmd.Process.Pid)
	return sess, nil
}

// get returns the existing session for sessionID, or spawns a new one if
// missing / dead. The pool's mu protects the map; the returned session's
// mu is what serializes turns. Sets lastSeen.
func (p *sessionPool) get(ctx context.Context, sessionID, binary, cwd string) (*ptySession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if sess, ok := p.sessions[sessionID]; ok {
		if sess.alive() {
			sess.lastSeen = time.Now()
			return sess, nil
		}
		// Dead process — drop and respawn under the same id. Note that
		// `claude --session-id X` will resume from disk if X exists,
		// which is the recovery we want.
		log("chat-pty: respawn dead session=%s pid=%d", sessionID, sess.cmd.Process.Pid)
		delete(p.sessions, sessionID)
	}

	sess, err := p.spawnFn(ctx, sessionID, binary, cwd)
	if err != nil {
		return nil, err
	}
	sess.lastSeen = time.Now()
	p.sessions[sessionID] = sess
	return sess, nil
}

// reap kills any session idle longer than sessionIdleTimeout. Called
// periodically by the GC goroutine.
func (p *sessionPool) reap(now time.Time) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	killed := 0
	for id, sess := range p.sessions {
		if now.Sub(sess.lastSeen) > sessionIdleTimeout || !sess.alive() {
			sess.kill()
			delete(p.sessions, id)
			killed++
			log("chat-pty: reaped session=%s idle=%s", id, now.Sub(sess.lastSeen).Round(time.Second))
		}
	}
	return killed
}

// shutdown kills every session. Called on broker shutdown.
func (p *sessionPool) shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, sess := range p.sessions {
		sess.kill()
		delete(p.sessions, id)
	}
}

// startGC spawns the reaper goroutine. The caller's ctx cancellation
// stops it.
func (p *sessionPool) startGC(ctx context.Context) {
	go func() {
		t := time.NewTicker(gcInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				p.reap(now)
			}
		}
	}()
}

// chatPTYRequest is the JSON body for POST /chat-pty. Same prompt
// contract as /chat; history is intentionally absent because the
// persistent session preserves it process-side.
type chatPTYRequest struct {
	Prompt string `json:"prompt"`
	Cwd    string `json:"cwd"`
}

// chatPTYHandler runs one turn on the persistent session named by
// ?session_id=<uuid>. Empty/missing session_id means "mint a new one and
// spawn." The response is one ndjson stream per turn, terminated when
// claude emits its `result` frame.
//
// POST /chat-pty?session_id=<uuid>&binary=claude
//   body:    {"prompt": str, "cwd": str?}
//   auth:    Bearer BROKER_TENANT_TOKEN OR ?token=
//   reply:   200 + Content-Type: application/x-ndjson
//
// Concurrency: one turn at a time per session_id (the session's mu).
// Multiple session_ids stream in parallel.
func chatPTYHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /chat-pty")
		return
	}

	tok := r.URL.Query().Get("token")
	if tok == "" {
		ah := r.Header.Get("Authorization")
		if strings.HasPrefix(ah, "Bearer ") {
			tok = strings.TrimPrefix(ah, "Bearer ")
		}
	}
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return
	}
	if !constantTimeStringEq(tok, expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return
	}

	binary := r.URL.Query().Get("binary")
	if binary == "" {
		binary = "claude"
	}
	if binary != "claude" {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"/chat-pty only supports binary=claude")
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		sessionID = newSessionID()
	}

	var req chatPTYRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad_request",
			"invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		jsonError(w, http.StatusBadRequest, "empty_prompt",
			"prompt is required")
		return
	}
	cwd := req.Cwd
	if cwd == "" {
		cwd = os.Getenv("HOME")
	}

	ctx, cancel := context.WithTimeout(r.Context(), turnTimeout)
	defer cancel()

	sess, err := globalPool.get(ctx, sessionID, binary, cwd)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "spawn_failed",
			err.Error())
		return
	}

	// Serialize: at most one turn at a time per session.
	sess.mu.Lock()
	defer sess.mu.Unlock()

	// Write the prompt as one stream-json `user` message line.
	userMsg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": req.Prompt,
		},
	}
	bs, _ := json.Marshal(userMsg)
	if _, err := sess.stdin.Write(append(bs, '\n')); err != nil {
		jsonError(w, http.StatusInternalServerError, "stdin_write_failed",
			"could not write prompt to claude stdin")
		return
	}

	// Stream stdout until we see a `result` frame (turn terminator) or
	// the process dies / context expires.
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	lineCount := 0
	resultSeen := false
	deadlineHit := false
loop:
	for {
		select {
		case <-ctx.Done():
			deadlineHit = true
			break loop
		case line, ok := <-sess.outCh:
			if !ok {
				// Reader goroutine exited — process is gone.
				break loop
			}
			if len(line) == 0 {
				continue
			}
			_, _ = w.Write(line)
			_, _ = w.Write([]byte{'\n'})
			if flusher != nil {
				flusher.Flush()
			}
			lineCount++
			// Terminal `result` frame closes the turn. The reader goroutine
			// keeps running for the next turn's input.
			if isResultFrame(line) {
				resultSeen = true
				break loop
			}
		}
	}

	if !resultSeen {
		// Synthesize an error frame so the upstream backend doesn't hang
		// waiting for tokens. This is the same contract /chat uses.
		stderrTail := sess.stderrBuf.String()
		if len(stderrTail) > 1024 {
			stderrTail = stderrTail[len(stderrTail)-1024:]
		}
		code := "no_result_frame"
		msg := "claude stream ended without a result frame"
		if deadlineHit {
			code = "turn_timeout"
			msg = fmt.Sprintf("turn exceeded %s without a result frame", turnTimeout)
		} else if !sess.alive() {
			code = "process_died"
			msg = "claude process exited mid-turn"
		}
		errFrame := map[string]any{
			"type":    "error",
			"code":    code,
			"message": msg,
			"stderr":  stderrTail,
		}
		bs, _ := json.Marshal(errFrame)
		_, _ = w.Write(bs)
		_, _ = w.Write([]byte{'\n'})
		if flusher != nil {
			flusher.Flush()
		}
		// If the process died, drop the session so the next call respawns.
		if !sess.alive() {
			globalPool.mu.Lock()
			if cur, ok := globalPool.sessions[sess.sessionID]; ok && cur == sess {
				delete(globalPool.sessions, sess.sessionID)
			}
			globalPool.mu.Unlock()
		}
	}

	log("chat-pty: session=%s lines=%d result=%v alive=%v", sess.sessionID, lineCount, resultSeen, sess.alive())
}

// isResultFrame reports whether a stream-json line is the per-turn
// terminator. claude emits one `result` frame per turn whether or not
// tool use happened.
func isResultFrame(line []byte) bool {
	// Fast path: substring check rules out 99% of frames.
	if !bytes.Contains(line, []byte(`"type":"result"`)) {
		return false
	}
	// Confirm via JSON parse — the substring could in theory appear
	// inside a string literal in another frame.
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return false
	}
	return probe.Type == "result"
}

