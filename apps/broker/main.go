// Package main implements the per-tenant PTY-WebSocket broker for
// Rockielab / Pebble ML.
//
// The broker runs inside the rockielab-runtime-multitenant container and
// listens on :7681. It accepts WebSocket connections, validates a
// per-tenant token (constant-time compare), and bridges stdin/stdout/stderr
// of a binary spawned in a PTY (claude / codex / bash) to the WebSocket
// using a small framing protocol described in apps/broker/README.md.
//
// It also exposes /healthz for liveness probes and /spawn for headless
// (non-PTY) one-shot invocations.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// Framing scheme (binary WebSocket frames):
//
//   client -> server:
//     0x01 <bytes...>            stdin write
//     0x02 <rows:uint16><cols:uint16>   TTY resize (network byte order)
//
//   server -> client:
//     0x01 <bytes...>            stdout/stderr (combined)
//     0x03 <code:int32>          process exit (network byte order, signed)
const (
	frameStdin  = 0x01
	frameResize = 0x02
	frameStdout = 0x01
	frameExit   = 0x03
)

// allowedBinaries enumerates what /ws will spawn. Anything else is rejected.
var allowedBinaries = map[string]struct{}{
	"claude": {},
	"codex":  {},
	"bash":   {},
}

func brokerToken() string {
	return os.Getenv("BROKER_TENANT_TOKEN")
}

func brokerPort() string {
	if p := os.Getenv("BROKER_PORT"); p != "" {
		return p
	}
	return "7681"
}

// constantTimeStringEq compares two strings without leaking length-equal
// timing differences once both sides are the same length. We tolerate the
// length-mismatch fast-path because callers feed the expected token first.
func constantTimeStringEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// jsonError writes the platform's structured error envelope.
func jsonError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// redact returns a length-only summary, never the value itself.
func redact(s string) string {
	if s == "" {
		return "<empty>"
	}
	return "<redacted len=" + itoa(len(s)) + ">"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// healthHandler returns 200 {"status":"ok"}.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// upgrader is shared across /ws calls.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// The broker sits behind the platform-context proxy; cross-origin
		// is checked there. Accept all here.
		return true
	},
}

// wsHandler accepts a WebSocket, validates the token, and bridges to a PTY.
func wsHandler(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return
	}
	if !constantTimeStringEq(token, expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return
	}

	binary := r.URL.Query().Get("binary")
	if binary == "" {
		binary = "claude"
	}
	if _, ok := allowedBinaries[binary]; !ok {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"binary must be one of claude, codex, bash")
		return
	}

	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		cwd = os.Getenv("HOME")
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote a response.
		return
	}
	defer conn.Close()

	cmd := exec.Command(binary)
	cmd.Dir = cwd

	// Avoid leaking parent secrets into the child if requested. We pass
	// through the parent env intentionally so claude / codex can find their
	// auth state under HOME, but we strip BROKER_TENANT_TOKEN so the child
	// process never sees it.
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = conn.WriteMessage(websocket.TextMessage,
			[]byte(`{"error":{"code":"pty_start_failed","message":"failed to start PTY"}}`))
		return
	}
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	// We deliberately log without secrets.
	log("ws: started binary=%s cwd=%s pid=%d token=%s", binary, cwd, cmd.Process.Pid, redact(token))

	bridgePTY(conn, ptmx, cmd)
}

// bridgePTY shovels frames between the WS client and the PTY until either
// side closes or the child exits.
func bridgePTY(conn *websocket.Conn, ptmx interface {
	io.Reader
	io.Writer
	io.Closer
}, cmd *exec.Cmd) {
	var wg sync.WaitGroup
	done := make(chan struct{})
	closeOnce := sync.Once{}
	closeDone := func() { closeOnce.Do(func() { close(done) }) }

	// PTY -> WebSocket
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				frame := append([]byte{frameStdout}, buf[:n]...)
				if werr := conn.WriteMessage(websocket.BinaryMessage, frame); werr != nil {
					closeDone()
					return
				}
			}
			if err != nil {
				closeDone()
				return
			}
		}
	}()

	// WebSocket -> PTY
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			mt, data, err := conn.ReadMessage()
			if err != nil {
				closeDone()
				return
			}
			if mt != websocket.BinaryMessage || len(data) < 1 {
				continue
			}
			switch data[0] {
			case frameStdin:
				if _, werr := ptmx.Write(data[1:]); werr != nil {
					closeDone()
					return
				}
			case frameResize:
				if len(data) >= 5 {
					rows := binary.BigEndian.Uint16(data[1:3])
					cols := binary.BigEndian.Uint16(data[3:5])
					if f, ok := ptmx.(interface {
						Fd() uintptr
					}); ok {
						_ = pty.Setsize(asFile(f.Fd()), &pty.Winsize{
							Rows: rows,
							Cols: cols,
						})
					}
				}
			default:
				// Unknown frame type — ignore, don't crash.
			}
		}
	}()

	// Reap child. The exit frame should always be emitted if the child
	// exits, even if the PTY-read goroutine has already returned (which
	// would otherwise close `done` first when the PTY closes).
	exitCh := make(chan int, 1)
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		exitCh <- code
	}()

	// Wait up to 2s after the PTY closes for the child to be reaped, so
	// we can include the exit code in the frame. If the WS dies first,
	// we just bail without an exit frame.
	select {
	case code := <-exitCh:
		var frame [5]byte
		frame[0] = frameExit
		binary.BigEndian.PutUint32(frame[1:5], uint32(int32(code)))
		_ = conn.WriteMessage(websocket.BinaryMessage, frame[:])
	case <-done:
		// PTY/WS closed before we saw cmd.Wait; give the reaper a brief
		// grace period to deliver the exit code.
		select {
		case code := <-exitCh:
			var frame [5]byte
			frame[0] = frameExit
			binary.BigEndian.PutUint32(frame[1:5], uint32(int32(code)))
			_ = conn.WriteMessage(websocket.BinaryMessage, frame[:])
		case <-time.After(2 * time.Second):
		}
	}

	wg.Wait()
}

// asFile is a tiny helper so the non-portable os.NewFile call stays in one
// place. The PTY's Fd() returns the underlying file descriptor and pty.Setsize
// actually wants an *os.File. We construct it without taking ownership.
func asFile(fd uintptr) *os.File {
	return os.NewFile(fd, "pty")
}

// filteredEnv returns parent env with the named keys removed.
func filteredEnv(env []string, drop []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		i := indexByte(kv, '=')
		if i < 0 {
			out = append(out, kv)
			continue
		}
		k := kv[:i]
		skip := false
		for _, d := range drop {
			if k == d {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, kv)
		}
	}
	return out
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// spawnRequest is the body of POST /spawn.
type spawnRequest struct {
	Binary string   `json:"binary"`
	Args   []string `json:"args"`
	Cwd    string   `json:"cwd"`
	// TimeoutSec optionally bounds the run; defaults to 60s.
	TimeoutSec int `json:"timeout_sec"`
}

// spawnResponse is the JSON envelope returned by /spawn.
type spawnResponse struct {
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	TimedOut bool   `json:"timed_out"`
}

// spawnHandler runs a binary headless and returns combined output.
func spawnHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /spawn")
		return
	}
	// /spawn requires the same broker token, supplied as Bearer auth or
	// as ?token=, to keep it useful for both interactive and CI contexts.
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

	var req spawnRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad_request",
			"invalid JSON body")
		return
	}
	if _, ok := allowedBinaries[req.Binary]; !ok {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"binary must be one of claude, codex, bash")
		return
	}
	if req.TimeoutSec <= 0 {
		req.TimeoutSec = 60
	}
	if req.Cwd == "" {
		req.Cwd = os.Getenv("HOME")
	}

	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(req.TimeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Binary, req.Args...)
	cmd.Dir = req.Cwd
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	resp := spawnResponse{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		resp.TimedOut = true
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			resp.ExitCode = ee.ExitCode()
		} else {
			resp.ExitCode = -1
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)

	log("spawn: binary=%s args=%v exit=%d timed_out=%v", req.Binary, req.Args, resp.ExitCode, resp.TimedOut)
}

// chatRequest is the JSON body for POST /chat.
type chatRequest struct {
	Prompt  string        `json:"prompt"`
	History []chatTurn    `json:"history"`
	Cwd     string        `json:"cwd"`     // optional; defaults to $HOME
	Timeout int           `json:"timeout"` // optional seconds; default 600
	// SessionID, when set, causes claude to resume that session instead
	// of starting a fresh one. Preserves slash-command + MCP + skill
	// state + conversation history across turns. The first turn omits
	// it; the response's `system.subtype=init` event carries the new
	// session_id which the client threads back on subsequent turns.
	SessionID string `json:"session_id"`
}

type chatTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// flattenHistory builds a single string prompt from prior turns + the
// current prompt. Both `claude -p` and `codex exec` accept a single
// prompt string in non-interactive mode; richer multi-turn session
// support (--continue / --resume) is a v2 concern.
func flattenHistory(history []chatTurn, current string) string {
	if len(history) == 0 {
		return current
	}
	var b strings.Builder
	for _, t := range history {
		role := t.Role
		if role == "" {
			role = "user"
		}
		b.WriteString(fmt.Sprintf("[%s]\n%s\n\n", role, t.Content))
	}
	b.WriteString("[user]\n")
	b.WriteString(current)
	return b.String()
}

// chatHandler is the JSON-streaming endpoint used by the unified agent
// router in platform-context. Spawns the binary (claude/codex) in
// headless stream-json mode and streams stdout line-by-line as the
// HTTP response body.
//
// POST /chat?binary=claude|codex
//   body:    {"prompt": str, "history": [...], "cwd": str?, "timeout": int?}
//   auth:    Bearer BROKER_TENANT_TOKEN OR ?token=
//   reply:   200 + Content-Type: application/x-ndjson, one JSON event
//            per line, terminated when the binary exits.
//
// On invocation failure: 4xx/5xx with a JSON error body (not ndjson).
// Once streaming has started, errors are emitted as a final ndjson
// frame: {"type":"error","code":"...","message":"..."}.
// claudeChatArgs builds the argv for the spawn-per-prompt claude path.
// Extracted so the spawn-arg contract (especially the auto-execute
// flag) is testable. fleet-task #102.
func claudeChatArgs(promptArg, sessionID string) []string {
	args := []string{
		"-p", promptArg,
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		// Auto-execute tools — see chat_pty.go claudePTYArgs for the
		// rationale. fleet-task #102.
		"--dangerously-skip-permissions",
	}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	}
	return args
}

func chatHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /chat")
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
	if binary != "claude" && binary != "codex" {
		jsonError(w, http.StatusBadRequest, "invalid_binary",
			"binary must be claude or codex")
		return
	}

	var req chatRequest
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
	if req.Timeout <= 0 {
		req.Timeout = 600 // 10 min default; long enough for tool-using turns
	}
	if req.Cwd == "" {
		req.Cwd = os.Getenv("HOME")
	}

	// When SessionID is set, claude resumes that session — flat-prompt
	// flattening would duplicate history. Pass just the new turn's
	// prompt instead. Otherwise fall back to flattening for the
	// no-session case.
	var promptArg string
	if req.SessionID != "" {
		promptArg = req.Prompt
	} else {
		promptArg = flattenHistory(req.History, req.Prompt)
	}

	var args []string
	switch binary {
	case "claude":
		// Claude Code CLI: `-p` non-interactive, stream-json output.
		// --verbose ensures all events emit (system, assistant, tool_use,
		// tool_result, result). --include-partial-messages gives us
		// content_block_delta tokens as they stream.
		args = claudeChatArgs(promptArg, req.SessionID)
	case "codex":
		// Codex CLI: `exec` is the headless invocation. `--json`
		// emits structured stream-json that CodexBrokerBackend's
		// translator parses. `--skip-git-repo-check` is required —
		// /home/runtime is not a git repo, so codex refuses to start
		// without this flag (verified live: "Not inside a trusted
		// directory and --skip-git-repo-check was not specified").
		args = []string{"exec", "--json", "--skip-git-repo-check", promptArg}
	}

	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(req.Timeout)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = filteredEnv(os.Environ(), []string{"BROKER_TENANT_TOKEN"})

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "stdout_pipe_failed",
			"could not attach stdout pipe")
		return
	}
	stderrBuf := &strings.Builder{}
	cmd.Stderr = stderrBuf

	if err := cmd.Start(); err != nil {
		jsonError(w, http.StatusInternalServerError, "spawn_failed",
			fmt.Sprintf("could not spawn %s: %v", binary, err))
		return
	}

	// Streaming response. Each line of the binary's stdout is one
	// JSON event in stream-json format; we relay it verbatim.
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // nginx/CF passthrough hint
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(stdout)
	// Allow long lines — claude can emit large content_block_start
	// events with full message content blocks.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	lineCount := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		_, _ = w.Write(line)
		_, _ = w.Write([]byte{'\n'})
		if flusher != nil {
			flusher.Flush()
		}
		lineCount++
	}
	scanErr := scanner.Err()

	waitErr := cmd.Wait()

	// Emit a final synthesized error frame if the binary exited badly,
	// since the unified protocol on the platform-context side expects a
	// final `done` frame and won't get one if the binary just died.
	if waitErr != nil || scanErr != nil {
		errorMsg := ""
		if waitErr != nil {
			errorMsg = waitErr.Error()
		}
		if scanErr != nil {
			if errorMsg != "" {
				errorMsg += "; "
			}
			errorMsg += "scan: " + scanErr.Error()
		}
		// Truncate stderr to keep the wire payload bounded.
		stderrTail := stderrBuf.String()
		if len(stderrTail) > 1024 {
			stderrTail = stderrTail[len(stderrTail)-1024:]
		}
		errorFrame := map[string]any{
			"type":    "error",
			"code":    "broker_runner_failed",
			"message": fmt.Sprintf("%s exited with: %s", binary, errorMsg),
			"stderr":  stderrTail,
		}
		bs, _ := json.Marshal(errorFrame)
		_, _ = w.Write(bs)
		_, _ = w.Write([]byte{'\n'})
		if flusher != nil {
			flusher.Flush()
		}
	}

	log("chat: binary=%s lines=%d wait_err=%v", binary, lineCount, waitErr)
}

// log writes to stderr without ever including secrets. We intentionally
// keep this tiny rather than pulling in a logging library.
func log(format string, args ...any) {
	_, _ = os.Stderr.WriteString(time.Now().UTC().Format(time.RFC3339) + " [broker] " + fmt.Sprintf(format, args...) + "\n")
}

// run starts the HTTP server with graceful shutdown on SIGTERM/SIGINT.
func run() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler)
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/spawn", spawnHandler)
	mux.HandleFunc("/chat", chatHandler)
	mux.HandleFunc("/chat-pty", chatPTYHandler)

	// Persistent-session GC. Runs for the lifetime of the server; we tear
	// it down with the server's graceful-shutdown context.
	gcCtx, stopGC := context.WithCancel(context.Background())
	defer stopGC()
	globalPool.startGC(gcCtx)

	srv := &http.Server{
		Addr:              ":" + brokerPort(),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	idleConnsClosed := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log("shutdown: signal received")
		stopGC()
		globalPool.shutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		close(idleConnsClosed)
	}()

	log("listening on %s (token=%s)", srv.Addr, redact(brokerToken()))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	<-idleConnsClosed
	return nil
}

func main() {
	if err := run(); err != nil {
		log("fatal: %v", err)
		os.Exit(1)
	}
}
