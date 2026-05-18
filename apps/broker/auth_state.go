// auth_state.go — per-binary auth-flow state for the broker.
//
// Codex `/login` and `claude setup-token` are long-running PTY sessions
// that talk to OAuth providers. While they run, the platform-context
// auth poller hits `/chat?binary=<X>` every few seconds to detect when
// auth flips to `ok`. Each /chat call spawns a fresh codex/claude
// process in the same tenant HOME directory, touching the same
// ~/.codex / ~/.claude state the login process is mid-flight on. The
// resulting interference manifested live (fleet-task #234) as a
// device-flow token-exchange landing HTTP 400 because the device code
// had expired by the time codex got to redeem it.
//
// Fix shape: the broker sniffs the /ws bash-PTY input stream. When it
// sees `codex login` or `claude setup-token` typed into the PTY, it
// marks the relevant binary as `logging_in`. /chat (and /chat-pty for
// the codex path, even though that endpoint already rejects codex)
// refuses to spawn while the flag is set, returning a clean
// `auth_in_progress` ndjson frame instead. The flag clears when the WS
// closes.
//
// State scope is process-local. The broker runs one-per-tenant on Fly,
// so process-local == per-tenant. No multi-broker coordination needed.
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sync"
)

// loginState tracks whether a binary's interactive /login flow is
// currently in progress on this broker.
type loginState struct {
	mu       sync.Mutex
	loggingIn map[string]bool
}

func newLoginState() *loginState {
	return &loginState{loggingIn: map[string]bool{}}
}

// mark sets binary as logging-in. Idempotent.
func (s *loginState) mark(binary string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loggingIn[binary] = true
}

// clear removes binary's logging-in flag. Idempotent.
func (s *loginState) clear(binary string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.loggingIn, binary)
}

// active reports whether binary is currently in a /login flow.
func (s *loginState) active(binary string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loggingIn[binary]
}

// globalLoginState is the singleton used by wsHandler + chatHandler.
var globalLoginState = newLoginState()

// loginTriggers maps a substring that, when typed into a /ws bash PTY,
// indicates a /login flow is starting for the given binary. Matched
// against the raw stdin payload of each frameStdin packet.
var loginTriggers = []struct {
	needle []byte
	binary string
}{
	{[]byte("codex login"), "codex"},
	{[]byte("claude setup-token"), "claude"},
	{[]byte("claude /login"), "claude"},
}

// sniffLoginTrigger scans a stdin payload for any login-flow trigger
// and returns the binary that the flow targets, or "" if none.
func sniffLoginTrigger(payload []byte) string {
	for _, t := range loginTriggers {
		if bytes.Contains(payload, t.needle) {
			return t.binary
		}
	}
	return ""
}

// writeAuthInProgressFrame emits the broker's standard
// `auth_in_progress` ndjson error frame and is the shared response
// shape used by both /chat and /chat-pty when they refuse to spawn a
// binary that has a /login flow in progress.
func writeAuthInProgressFrame(w http.ResponseWriter, binary string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	frame := map[string]any{
		"type":    "error",
		"code":    "auth_in_progress",
		"message": binary + " /login is in progress; chat blocked until login completes",
	}
	bs, _ := json.Marshal(frame)
	_, _ = w.Write(bs)
	_, _ = w.Write([]byte{'\n'})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}
