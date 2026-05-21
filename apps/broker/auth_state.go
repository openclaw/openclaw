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
//
// Issue #292 follow-up: in-flight gating fixed the race, but did not
// cover the symmetric case where a user "completed" a device-flow that
// silently failed (token exchange returned 400 because the code
// expired). In that state no /login is in flight, no auth.json exists,
// and every /chat invocation spawns codex which immediately hits HTTP
// 401 against wss://api.openai.com/v1/responses, retries five times,
// exits non-zero, and surfaces in the UI as "codex exited with: exit
// status 1" — eating ~8s per send and giving the user no actionable
// guidance. We add a cheap auth-file existence check (~/.codex/auth.json
// for codex, ~/.claude/.credentials.json for claude) on the same gate
// path. Missing → `auth_required` ndjson frame; the frontend renders a
// "sign in" CTA, same shape as `byok-key-missing`.
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

// loginState tracks whether a binary's interactive /login flow is
// currently in progress on this broker.
type loginState struct {
	mu        sync.Mutex
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
	if !s.loggingIn[binary] {
		return false
	}
	if authFileExists(binary) {
		delete(s.loggingIn, binary)
		return false
	}
	return true
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

// authFilePath returns the per-binary on-disk credential path. Codex
// writes ~/.codex/auth.json after a successful device-code exchange;
// claude writes ~/.claude/.credentials.json after `claude setup-token`
// or `claude /login` completes. Both are anchored at HOME, which the
// entrypoint pins to the per-tenant Fly volume mount so the file
// survives machine restarts. Returns "" if neither HOME nor a known
// binary mapping applies.
func authFilePath(binary string) string {
	home := os.Getenv("HOME")
	if home == "" {
		// Fall back to the tenant default. Both the multitenant image
		// and the tests run under /home/runtime; using a hardcoded
		// default lets the check still mean something if HOME got
		// scrubbed, rather than silently passing.
		home = "/home/runtime"
	}
	switch binary {
	case "codex":
		return filepath.Join(home, ".codex", "auth.json")
	case "claude":
		return filepath.Join(home, ".claude", ".credentials.json")
	}
	return ""
}

// authFileExists reports whether `binary`'s credential file is present
// and non-empty. Empty is treated as "missing" because codex writes the
// file as the *last* step of the device-code exchange — a 0-byte file
// would only exist mid-write, never as the final state. Errors are
// treated as "missing" too: the conservative direction here is to
// surface an actionable sign-in CTA, not to silently spawn a binary
// that will fail with HTTP 401 anyway.
func authFileExists(binary string) bool {
	p := authFilePath(binary)
	if p == "" {
		// Bash and any other binary we ever add: don't gate. The gate
		// is specifically about claude/codex subscription auth.
		return true
	}
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	return st.Size() > 0
}

// writeAuthRequiredFrame emits the broker's standard `auth_required`
// ndjson error frame. Same wire shape as `auth_in_progress`; the
// distinct `code` lets the frontend pick a "Sign in" CTA instead of
// "Wait, login is in progress" copy.
func writeAuthRequiredFrame(w http.ResponseWriter, binary string) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	frame := map[string]any{
		"type": "error",
		"code": "auth_required",
		"message": binary + " is not signed in on this tenant. " +
			"Go to /settings/token-source and sign in to use chat.",
	}
	bs, _ := json.Marshal(frame)
	_, _ = w.Write(bs)
	_, _ = w.Write([]byte{'\n'})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}
