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

	// resumed records whether this process was launched with --resume (vs
	// --session-id). Only a resumed process can hit the "No conversation
	// found" resume-miss, so the handler only watches the first frame for
	// that signature when resumed is true.
	resumed bool

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
	// for a new session. Indirected here so tests can stub it. `resume`
	// selects --resume (existing on-disk session) vs --session-id (create).
	spawnFn func(ctx context.Context, sessionID, binary, cwd string, resume bool) (*ptySession, error)
	// known tracks every session id this broker has ever spawned, so a
	// respawn (after the warm process dies/is reaped) resumes the on-disk
	// session instead of trying to re-CREATE it (which the CLI rejects with
	// "Session ID already in use"). Survives the session leaving p.sessions.
	known map[string]struct{}
}

// newSessionPool returns a pool wired to the real spawnSession.
func newSessionPool() *sessionPool {
	return &sessionPool{
		sessions: make(map[string]*ptySession),
		known:    make(map[string]struct{}),
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
// auto-execute flag + the create-vs-resume distinction) is testable
// without launching a real process.
//
// `resume` selects how the session id is bound to the CLI:
//   - false → `--session-id <id>`: CREATE a brand-new session. The CLI
//     errors "Session ID <id> is already in use" (zero stdout, immediate
//     exit) if <id> already exists on disk — so this is ONLY valid for an
//     id we are minting for the first time.
//   - true  → `--resume <id>`: RESUME an existing on-disk session. This is
//     the path for respawning a previously-spawned session whose warm
//     process died/was reaped, or a client-threaded id from a prior broker.
//
// Picking `--session-id` for an already-existing id is the chat-pty hang
// bug: the process emits nothing and the upstream 60s backend_timeout
// fires ("Rockie's response was interrupted"). /chat never hit this
// because it resumes via `--resume`. Proven against claude 2.1.170 AND
// 2.1.178 — this is a flag-contract bug, not a CLI version regression.
func claudePTYArgs(sessionID string, resume bool) []string {
	idFlag := "--session-id"
	if resume {
		idFlag = "--resume"
	}
	return []string{
		"-p",
		idFlag, sessionID,
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
// stream-json mode. The session_id is baked into the CLI args so claude
// emits it in the init frame and every subsequent event.
//
// `resume` picks the id-binding flag — see claudePTYArgs. The pool sets
// it: false when minting a brand-new session, true when respawning a
// session that already exists on disk.
func spawnSession(ctx context.Context, sessionID, binary, cwd string, resume bool) (*ptySession, error) {
	if binary != "claude" {
		// Codex doesn't expose a comparable stream-json input mode today;
		// we ship claude-only persistent sessions per the MVP scope.
		return nil, fmt.Errorf("persistent session only supports claude (got %q)", binary)
	}
	args := claudePTYArgs(sessionID, resume)
	cmd := exec.Command(binary, args...)
	cmd.Dir = cwd
	cmd.Env = ownedChildEnv()

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
//
// `mintedFresh` is true when the handler just minted this session_id for a
// brand-new conversation (no client-supplied id). It is the strongest
// signal that the id does NOT yet exist on disk, so the first spawn must
// CREATE (`--session-id`). Any other path — a dead in-pool session, or a
// client-threaded id we've spawned before, or any id we already know —
// RESUMES (`--resume`), because re-creating an existing id makes the CLI
// exit with "Session ID already in use" and zero output (the chat-pty
// hang). A client-supplied id we've never seen also resumes: it was minted
// by a prior broker and written to disk by that turn's init.
func (p *sessionPool) get(ctx context.Context, sessionID, binary, cwd string, mintedFresh bool) (*ptySession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if sess, ok := p.sessions[sessionID]; ok {
		if sess.alive() {
			sess.lastSeen = time.Now()
			return sess, nil
		}
		// Warm process gone (crash / idle-reap). Respawn must RESUME the
		// on-disk session, not re-create it.
		log("chat-pty: respawn dead session=%s pid=%d", sessionID, sess.cmd.Process.Pid)
		delete(p.sessions, sessionID)
	}

	_, seen := p.known[sessionID]
	resume := seen || !mintedFresh

	sess, err := p.spawnFn(ctx, sessionID, binary, cwd, resume)
	if err != nil {
		return nil, err
	}
	sess.resumed = resume
	sess.lastSeen = time.Now()
	p.sessions[sessionID] = sess
	p.known[sessionID] = struct{}{}
	return sess, nil
}

// recreateFresh drops a session that resume-missed (the on-disk session id
// did not exist, so `--resume` exited with a "No conversation found"
// error-result) and spawns a fresh CREATE under the same id. Called by the
// turn handler when it sees the resume-miss signature on the first frame,
// so a stale/foreign client id still yields a real answer instead of an
// error bubble. Holds poolMu; the caller must hold the session's own mu.
func (p *sessionPool) recreateFresh(ctx context.Context, sessionID, binary, cwd string) (*ptySession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if old, ok := p.sessions[sessionID]; ok {
		old.kill()
		delete(p.sessions, sessionID)
	}
	sess, err := p.spawnFn(ctx, sessionID, binary, cwd, false)
	if err != nil {
		return nil, err
	}
	sess.resumed = false
	sess.lastSeen = time.Now()
	p.sessions[sessionID] = sess
	p.known[sessionID] = struct{}{}
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

// chatPTYAuthGate runs the method + broker-token + binary gates. Returns
// binary and ok=false (after already replying) when a gate trips. Ordered
// FIRST so an unauthenticated / malformed request is rejected before any
// body parsing — same order as the original handler.
func chatPTYAuthGate(w http.ResponseWriter, r *http.Request) (binary string, ok bool) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /chat-pty")
		return "", false
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
		return "", false
	}
	if !constantTimeStringEq(tok, expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return "", false
	}
	if !requireTenantID(w) {
		return "", false
	}
	binary = r.URL.Query().Get("binary")
	if binary == "" {
		binary = "claude"
	}
	if binary != "claude" {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"/chat-pty only supports binary=claude")
		return "", false
	}
	return binary, true
}

// chatPTYSpawnGate runs the login-in-progress + auth-file gates that decide
// whether a session may be spawned at all. Ordered AFTER body validation
// (matching the original handler) so an empty-prompt request still 400s
// regardless of auth state. ok=false means a gate already replied.
func chatPTYSpawnGate(w http.ResponseWriter, binary string) bool {
	// Same login-flow gate as /chat: if a `claude setup-token` is
	// in flight on this broker, refuse to spawn a competing persistent
	// session that would race the OAuth state on disk. fleet-task #234.
	if globalLoginState.active(binary) {
		writeAuthInProgressFrame(w, binary)
		log("chat-pty: refused spawn binary=%s reason=auth_in_progress", binary)
		return false
	}
	// Same auth-file gate as /chat: a missing credentials file means
	// the persistent claude session will just emit "Not logged in" and
	// exit. Surface the same actionable `auth_required` frame so the
	// frontend can render a sign-in CTA instead of a generic error.
	// fleet-task #292.
	if !authFileExists(binary) {
		writeAuthRequiredFrame(w, binary)
		log("chat-pty: refused spawn binary=%s reason=auth_required path=%s",
			binary, authFilePath(binary))
		return false
	}
	return true
}

// chatPTYHandler runs one turn on the persistent session named by
// ?session_id=<uuid>. Empty/missing session_id means "mint a new one and
// spawn." The response is one ndjson stream per turn, terminated when
// claude emits its `result` frame.
//
// POST /chat-pty?session_id=<uuid>&binary=claude
//
//	body:    {"prompt": str, "cwd": str?}
//	auth:    Bearer BROKER_TENANT_TOKEN OR ?token=
//	reply:   200 + Content-Type: application/x-ndjson
//
// Concurrency: one turn at a time per session_id (the session's mu).
// Multiple session_ids stream in parallel.
func chatPTYHandler(w http.ResponseWriter, r *http.Request) {
	binary, ok := chatPTYAuthGate(w, r)
	if !ok {
		return
	}

	sessionID := r.URL.Query().Get("session_id")
	mintedFresh := sessionID == ""
	if mintedFresh {
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

	if !chatPTYSpawnGate(w, binary) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), turnTimeout)
	defer cancel()

	sess, err := globalPool.get(ctx, sessionID, binary, cwd, mintedFresh)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "spawn_failed",
			err.Error())
		return
	}

	// Serialize: at most one turn at a time per session.
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if err := writePTYPrompt(sess, req.Prompt); err != nil {
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

	res := streamTurn(ctx, w, flusher, sess)

	// Resume-miss recovery: streamTurn returns resumeMiss when a resumed
	// session's id did not exist on disk (the "No conversation found"
	// error-result). recoverResumeMiss recreates fresh under the same id,
	// replays the prompt, and re-streams so the user still gets a real
	// answer; ok=false means it already wrote an error reply.
	if res.resumeMiss {
		newSess, newRes, ok := recoverResumeMiss(ctx, w, flusher, sess, binary, cwd, req.Prompt)
		if !ok {
			return
		}
		sess, res = newSess, newRes
	}

	if !res.resultSeen {
		writeTurnErrorFrame(w, flusher, sess, res.deadlineHit)
	}

	log("chat-pty: session=%s lines=%d result=%v alive=%v", sess.sessionID, res.lineCount, res.resultSeen, sess.alive())
}

// recoverResumeMiss respawns a resume-missed session fresh under the same
// id, replays the prompt, and re-streams the turn, returning the fresh
// session and its result. ok=false means a spawn/stdin failure already
// wrote an error reply. It takes and releases the fresh session's mu for
// the duration of the replayed turn; this turn owns the request, so the
// handler's subsequent reads of the returned session are single-threaded.
func recoverResumeMiss(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, sess *ptySession, binary, cwd, prompt string) (*ptySession, turnResult, bool) {
	log("chat-pty: resume-miss session=%s; recreating fresh and replaying", sess.sessionID)
	fresh, ferr := globalPool.recreateFresh(ctx, sess.sessionID, binary, cwd)
	if ferr != nil {
		jsonError(w, http.StatusInternalServerError, "spawn_failed", ferr.Error())
		return nil, turnResult{}, false
	}
	fresh.mu.Lock()
	if werr := writePTYPrompt(fresh, prompt); werr != nil {
		fresh.mu.Unlock()
		jsonError(w, http.StatusInternalServerError, "stdin_write_failed",
			"could not write prompt to claude stdin")
		return nil, turnResult{}, false
	}
	res := streamTurn(ctx, w, flusher, fresh)
	fresh.mu.Unlock()
	return fresh, res, true
}

// writeTurnErrorFrame emits the synthetic error frame the upstream backend
// expects when a turn ended without a `result` (same contract as /chat),
// and drops a dead session from the pool so the next call respawns.
func writeTurnErrorFrame(w http.ResponseWriter, flusher http.Flusher, sess *ptySession, deadlineHit bool) {
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
	forwardFrame(w, flusher, bs)
	// If the process died, drop the session so the next call respawns.
	if !sess.alive() {
		globalPool.mu.Lock()
		if cur, ok := globalPool.sessions[sess.sessionID]; ok && cur == sess {
			delete(globalPool.sessions, sess.sessionID)
		}
		globalPool.mu.Unlock()
	}
}

// writePTYPrompt writes one stream-json `user` message line to the
// session's stdin (without closing it — the process stays warm for the
// next turn). Extracted so the prompt envelope is written identically on
// the initial turn and on a resume-miss replay.
func writePTYPrompt(sess *ptySession, prompt string) error {
	userMsg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": prompt,
		},
	}
	bs, _ := json.Marshal(userMsg)
	_, err := sess.stdin.Write(append(bs, '\n'))
	return err
}

// turnResult captures the outcome of streaming one turn's frames.
type turnResult struct {
	lineCount   int
	resultSeen  bool
	deadlineHit bool
	// resumeMiss is set when the session was launched with --resume and the
	// FIRST frame is the "No conversation found" error-result. The frame is
	// NOT forwarded in that case so the handler can recover transparently.
	resumeMiss bool
}

// streamTurn forwards stream-json frames from the warm session to the
// client until the terminal `result` frame, process exit, or ctx deadline.
// When the session was resumed, it inspects the first frame for the
// resume-miss signature; if matched it swallows that frame and returns
// resumeMiss=true without forwarding anything (the handler recreates the
// session fresh and replays).
func streamTurn(ctx context.Context, w http.ResponseWriter, flusher http.Flusher, sess *ptySession) turnResult {
	var res turnResult
	first := true
	for {
		line, ok := recvLine(ctx, sess)
		if !ok {
			// ctx deadline or reader-goroutine exit (process gone).
			res.deadlineHit = ctx.Err() != nil
			return res
		}
		if len(line) == 0 {
			continue
		}
		// On the FIRST frame of a resumed session, a "No conversation
		// found" error-result means the on-disk id was stale: do not
		// forward; signal the handler to recreate fresh and replay.
		if first {
			first = false
			if sess.resumed && isResumeMissResult(line) {
				res.resumeMiss = true
				return res
			}
		}
		forwardFrame(w, flusher, line)
		res.lineCount++
		// Terminal `result` frame closes the turn; the reader goroutine
		// keeps running for the next turn's input.
		if isResultFrame(line) {
			res.resultSeen = true
			return res
		}
	}
}

// recvLine blocks for the next stream-json line or the ctx deadline.
// ok=false means either the deadline fired or the reader goroutine closed
// the channel (process exited).
func recvLine(ctx context.Context, sess *ptySession) (line []byte, ok bool) {
	select {
	case <-ctx.Done():
		return nil, false
	case l, more := <-sess.outCh:
		return l, more
	}
}

// forwardFrame writes one ndjson frame to the client and flushes it.
func forwardFrame(w http.ResponseWriter, flusher http.Flusher, line []byte) {
	_, _ = w.Write(line)
	_, _ = w.Write([]byte{'\n'})
	if flusher != nil {
		flusher.Flush()
	}
}

// isResumeMissResult reports whether a frame is the immediate error-result
// claude emits when `--resume <id>` names a session that does not exist on
// disk ("No conversation found"): a result frame with is_error=true and
// num_turns=0. Distinct from a normal turn's result (num_turns>=1).
func isResumeMissResult(line []byte) bool {
	if !bytes.Contains(line, []byte(`"type":"result"`)) {
		return false
	}
	var probe struct {
		Type     string `json:"type"`
		IsError  bool   `json:"is_error"`
		NumTurns int    `json:"num_turns"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return false
	}
	return probe.Type == "result" && probe.IsError && probe.NumTurns == 0
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
