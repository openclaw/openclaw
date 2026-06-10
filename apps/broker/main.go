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
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// Framing scheme (binary WebSocket frames):
//
//	client -> server:
//	  0x01 <bytes...>            stdin write
//	  0x02 <rows:uint16><cols:uint16>   TTY resize (network byte order)
//
//	server -> client:
//	  0x01 <bytes...>            stdout/stderr (combined)
//	  0x03 <code:int32>          process exit (network byte order, signed)
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

var commandContext = exec.CommandContext

func resolveWSBinary(requested string) (string, bool) {
	if requested == "" {
		return "claude", true
	}
	if _, ok := allowedBinaries[requested]; ok {
		return requested, true
	}
	return "", false
}

func resolveChatBinary(requested string) (string, bool) {
	if requested == "" {
		return "claude", true
	}
	switch requested {
	case "claude", "codex":
		return requested, true
	default:
		return "", false
	}
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

// redact returns a fixed marker, never the value itself or its length.
func redact(s string) string {
	if s == "" {
		return "<empty>"
	}
	return "<redacted>"
}

func requireTenantID(w http.ResponseWriter) bool {
	if tenantID() != "" {
		return true
	}
	jsonError(w, http.StatusInternalServerError, "tenant_id_unset",
		"ROCKIELAB_TENANT_ID is required")
	return false
}

func isLoopbackRemoteAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func requestBrokerToken(r *http.Request) string {
	tok := r.URL.Query().Get("token")
	if tok != "" {
		return tok
	}
	ah := r.Header.Get("Authorization")
	if strings.HasPrefix(ah, "Bearer ") {
		return strings.TrimPrefix(ah, "Bearer ")
	}
	return ""
}

func requireBrokerRequest(w http.ResponseWriter, r *http.Request) bool {
	expected := brokerToken()
	if expected == "" {
		jsonError(w, http.StatusInternalServerError, "broker_token_unset",
			"BROKER_TENANT_TOKEN is not set on this machine")
		return false
	}
	if !constantTimeStringEq(requestBrokerToken(r), expected) {
		jsonError(w, http.StatusUnauthorized, "invalid_token",
			"missing or invalid token")
		return false
	}
	return requireTenantID(w)
}

// healthHandler returns 200 {"status":"ok"}.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

type fsEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Type  string `json:"type"`
	Size  *int64 `json:"size,omitempty"`
	Mtime string `json:"mtime"`
}

type fsTreeResponse struct {
	Root    string    `json:"root"`
	Path    string    `json:"path"`
	Entries []fsEntry `json:"entries"`
}

type fsFileResponse struct {
	Path      string `json:"path"`
	Type      string `json:"type"`
	Size      int64  `json:"size"`
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Truncated bool   `json:"truncated"`
}

const fsReadLimitBytes int64 = 1024 * 1024

func runtimeFSRoot() string {
	if root := os.Getenv("ROCKIELAB_RUNTIME_FS_ROOT"); root != "" {
		return root
	}
	if home := os.Getenv("HOME"); home != "" {
		return home
	}
	return "/home/runtime"
}

func cleanRuntimePath(root, requested string) (string, string, error) {
	if strings.ContainsRune(requested, '\x00') {
		return "", "", errors.New("invalid_path")
	}
	if requested == "" {
		requested = filepath.Join(root, "work")
	}
	var candidate string
	if filepath.IsAbs(requested) {
		candidate = requested
	} else {
		candidate = filepath.Join(root, requested)
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return "", "", err
	}
	cleanPath, err := filepath.Abs(filepath.Clean(candidate))
	if err != nil {
		return "", "", err
	}
	resolvedRoot, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil {
		return "", "", err
	}
	resolvedPath, err := filepath.EvalSymlinks(cleanPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", os.ErrNotExist
		}
		return "", "", err
	}
	if !pathIsUnderRoot(resolvedRoot, resolvedPath) {
		return "", "", errors.New("path_outside_runtime_root")
	}
	return resolvedRoot, resolvedPath, nil
}

func pathIsUnderRoot(root, path string) bool {
	if resolvedRoot, err := filepath.EvalSymlinks(root); err == nil {
		root = resolvedRoot
	}
	if resolvedPath, err := filepath.EvalSymlinks(path); err == nil {
		path = resolvedPath
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func fdResolvedPath(file *os.File) (string, error) {
	fd := file.Fd()
	procPath := fmt.Sprintf("/proc/self/fd/%d", fd)
	if target, err := filepath.EvalSymlinks(procPath); err == nil {
		return target, nil
	}
	if runtime.GOOS != "linux" {
		return filepath.EvalSymlinks(file.Name())
	}
	return "", errors.New("fd_resolution_unavailable")
}

func openContained(root, path string) (*os.File, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	resolved, err := fdResolvedPath(file)
	if err != nil {
		_ = file.Close()
		return nil, "", err
	}
	if !pathIsUnderRoot(root, resolved) {
		_ = file.Close()
		return nil, "", errors.New("path_outside_runtime_root")
	}
	return file, resolved, nil
}

func fsKind(info os.FileInfo) string {
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		return "symlink"
	case info.IsDir():
		return "directory"
	case info.Mode().IsRegular():
		return "file"
	default:
		return "other"
	}
}

func publicRuntimePath(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." {
		return filepath.ToSlash(root)
	}
	return filepath.ToSlash(filepath.Join(root, rel))
}

func runtimeFSTreeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only GET is allowed on /fs/tree")
		return
	}
	if !requireBrokerRequest(w, r) {
		return
	}
	root, path, err := cleanRuntimePath(runtimeFSRoot(), r.URL.Query().Get("path"))
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_path"
		if errors.Is(err, os.ErrNotExist) {
			status = http.StatusNotFound
			code = "not_found"
		} else if err.Error() == "path_outside_runtime_root" {
			status = http.StatusForbidden
			code = "path_outside_runtime_root"
		}
		jsonError(w, status, code, code)
		return
	}
	dir, resolvedDir, err := openContained(root, path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			jsonError(w, http.StatusNotFound, "not_found", "path not found")
		} else if err.Error() == "path_outside_runtime_root" {
			jsonError(w, http.StatusForbidden, "path_outside_runtime_root", "path_outside_runtime_root")
		} else {
			jsonError(w, http.StatusForbidden, "read_failed", "directory could not be read")
		}
		return
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		jsonError(w, http.StatusForbidden, "read_failed", "directory could not be read")
		return
	}
	if !info.IsDir() {
		jsonError(w, http.StatusBadRequest, "not_directory", "path is not a directory")
		return
	}
	dirEntries, err := dir.ReadDir(-1)
	if err != nil {
		jsonError(w, http.StatusForbidden, "read_failed", "directory could not be read")
		return
	}
	entries := make([]fsEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		entryInfo, err := entry.Info()
		if err != nil {
			continue
		}
		entryPath := filepath.Join(resolvedDir, entry.Name())
		var size *int64
		if entryInfo.Mode().IsRegular() {
			s := entryInfo.Size()
			size = &s
		}
		entries = append(entries, fsEntry{
			Name:  entry.Name(),
			Path:  publicRuntimePath(root, entryPath),
			Type:  fsKind(entryInfo),
			Size:  size,
			Mtime: entryInfo.ModTime().UTC().Format(time.RFC3339),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type == "directory" && entries[j].Type != "directory" {
			return true
		}
		if entries[i].Type != "directory" && entries[j].Type == "directory" {
			return false
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(fsTreeResponse{
		Root:    filepath.ToSlash(root),
		Path:    publicRuntimePath(root, resolvedDir),
		Entries: entries,
	})
}

func runtimeFSFileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only GET is allowed on /fs/file")
		return
	}
	if !requireBrokerRequest(w, r) {
		return
	}
	root, path, err := cleanRuntimePath(runtimeFSRoot(), r.URL.Query().Get("path"))
	if err != nil {
		status := http.StatusBadRequest
		code := "invalid_path"
		if errors.Is(err, os.ErrNotExist) {
			status = http.StatusNotFound
			code = "not_found"
		} else if err.Error() == "path_outside_runtime_root" {
			status = http.StatusForbidden
			code = "path_outside_runtime_root"
		}
		jsonError(w, status, code, code)
		return
	}
	file, resolvedFile, err := openContained(root, path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			jsonError(w, http.StatusNotFound, "not_found", "path not found")
		} else if err.Error() == "path_outside_runtime_root" {
			jsonError(w, http.StatusForbidden, "path_outside_runtime_root", "path_outside_runtime_root")
		} else {
			jsonError(w, http.StatusForbidden, "read_failed", "file could not be read")
		}
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		jsonError(w, http.StatusForbidden, "read_failed", "file could not be read")
		return
	}
	if info.IsDir() {
		jsonError(w, http.StatusBadRequest, "not_file", "path is not a file")
		return
	}
	if info.Size() > fsReadLimitBytes {
		jsonError(w, http.StatusRequestEntityTooLarge, "file_too_large", "file is too large")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, fsReadLimitBytes+1))
	if err != nil {
		jsonError(w, http.StatusForbidden, "read_failed", "file could not be read")
		return
	}
	if int64(len(data)) > fsReadLimitBytes {
		jsonError(w, http.StatusRequestEntityTooLarge, "file_too_large", "file is too large")
		return
	}
	if !utf8.Valid(data) {
		jsonError(w, http.StatusUnsupportedMediaType, "unsupported_file", "file is not valid UTF-8")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(fsFileResponse{
		Path:      filepath.ToSlash(resolvedFile),
		Type:      "file",
		Size:      info.Size(),
		Content:   string(data),
		Encoding:  "utf-8",
		Truncated: false,
	})
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
	if !requireTenantID(w) {
		return
	}

	binary, ok := resolveWSBinary(r.URL.Query().Get("binary"))
	if !ok {
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

	cmd.Env = ownedChildEnv()

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

	// Track any binary that gets `/login`-ed inside this session so we
	// can clear the global flag on WS close even if the user opens
	// multiple OAuth dances in one shell.
	markedDuringSession := map[string]struct{}{}
	defer func() {
		for b := range markedDuringSession {
			globalLoginState.clear(b)
			log("ws: cleared login-in-progress flag for binary=%s", b)
		}
	}()

	bridgePTY(conn, ptmx, cmd, markedDuringSession)
}

// bridgePTY shovels frames between the WS client and the PTY until either
// side closes or the child exits.
//
// markedDuringSession is the caller's record of which binaries this WS
// has flagged as `logging_in`; bridgePTY appends to it as it sniffs
// stdin frames. The caller is responsible for clearing those flags on
// session end.
func bridgePTY(conn *websocket.Conn, ptmx interface {
	io.Reader
	io.Writer
	io.Closer
}, cmd *exec.Cmd, markedDuringSession map[string]struct{}) {
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
				// Sniff for `codex login` / `claude setup-token`
				// trigger phrases — when one fires, mark the relevant
				// binary as logging-in so /chat refuses to spawn
				// competing processes that would race the OAuth flow
				// (fleet-task #234).
				if hit := sniffLoginTrigger(data[1:]); hit != "" {
					if _, already := markedDuringSession[hit]; !already {
						globalLoginState.mark(hit)
						markedDuringSession[hit] = struct{}{}
						log("ws: detected /login flow for binary=%s; blocking /chat spawns until WS close", hit)
					}
				}
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
	if !requireTenantID(w) {
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

	var commandSecrets resolvedCommandSecrets
	var hasCommandSecrets bool
	if req.Binary == "bash" && len(req.Args) == 2 && req.Args[0] == "-c" {
		if resp, handled, err := executeSecretAwareSpawnCommand(r.Context(), req.Args[1]); handled || err != nil {
			if err != nil {
				jsonError(w, http.StatusBadRequest, "secret_command_rejected", err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)
			log("spawn: exact secret form accepted name=redacted")
			return
		}
		resolved, handled, err := resolveSecretEnvForSpawnCommand(r.Context(), req.Args[1])
		if err != nil {
			jsonError(w, http.StatusBadRequest, "secret_command_rejected", err.Error())
			return
		}
		if handled {
			commandSecrets = resolved
			hasCommandSecrets = true
			defer commandSecrets.Redactor.Close()
		}
	} else if err := rejectDisallowedSecretReferences(r.Context(), strings.Join(req.Args, " ")); err != nil {
		jsonError(w, http.StatusBadRequest, "secret_command_rejected", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(req.TimeoutSec)*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Binary, req.Args...)
	cmd.Dir = req.Cwd
	cmd.Env = ownedChildEnv()
	if hasCommandSecrets {
		for name, value := range commandSecrets.Values {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	resp := spawnResponse{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if hasCommandSecrets {
		resp.Stdout = commandSecrets.Redactor.Redact(resp.Stdout)
		resp.Stderr = commandSecrets.Redactor.Redact(resp.Stderr)
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

	if hasCommandSecrets {
		log("spawn: binary=%s args=%v exit=%d timed_out=%v secret_env=resolved", req.Binary, req.Args, resp.ExitCode, resp.TimedOut)
	} else {
		log("spawn: binary=%s args=%v exit=%d timed_out=%v", req.Binary, req.Args, resp.ExitCode, resp.TimedOut)
	}
}

type materializeSecretRequest struct {
	Name string `json:"name"`
}

func materializeSecretHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method_not_allowed",
			"only POST is allowed on /materialize-secret")
		return
	}
	if !isLoopbackRemoteAddr(r.RemoteAddr) {
		jsonError(w, http.StatusForbidden, "loopback_required",
			"/materialize-secret is only available from localhost")
		return
	}
	if !requireTenantID(w) {
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var req materializeSecretRequest
	if err := decoder.Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "bad_request",
			"invalid JSON body")
		return
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		jsonError(w, http.StatusBadRequest, "bad_request",
			"invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		jsonError(w, http.StatusBadRequest, "invalid_secret_name",
			"name is required")
		return
	}

	resp, err := materializeSecret(r.Context(), req.Name)
	if err != nil {
		status := http.StatusBadRequest
		code := "materialize_secret_rejected"
		if errors.Is(err, errMaterializeSecretMissing) {
			status = http.StatusNotFound
			code = "secret_missing"
		}
		jsonError(w, status, code, err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
	log("materialize-secret: name=%s category=%s path=%s", resp.Name, resp.Category, resp.Path)
}

// chatRequest is the JSON body for POST /chat.
type chatRequest struct {
	Prompt  string     `json:"prompt"`
	History []chatTurn `json:"history"`
	Cwd     string     `json:"cwd"`     // optional; defaults to $HOME
	Timeout int        `json:"timeout"` // optional seconds; default 600
	// SessionID, when set, lets session-capable binaries resume instead
	// of starting fresh. The first turn omits it; the binary's stream
	// carries the new session/thread id which the client threads back on
	// subsequent turns.
	SessionID string `json:"session_id"`
}

type chatTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// flattenHistory builds a single string prompt from prior turns + the
// current prompt. Both `claude -p` and `codex exec` accept a single
// prompt string in fresh non-interactive mode; resumed turns pass only
// the latest prompt so history is not duplicated.
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
//
//	body:    {"prompt": str, "history": [...], "cwd": str?, "timeout": int?}
//	auth:    Bearer BROKER_TENANT_TOKEN OR ?token=
//	reply:   200 + Content-Type: application/x-ndjson, one JSON event
//	         per line, terminated when the binary exits.
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

// codexChatArgs builds the argv for the spawn-per-prompt codex path.
// The tenant Fly machine is the sandbox boundary; Codex's workspace
// sandbox blocks DNS/network inside shell tools.
func codexChatArgs(promptArg string) []string {
	return []string{
		"exec",
		"--json",
		"--sandbox", "danger-full-access",
		"--skip-git-repo-check",
		promptArg,
	}
}

func codexResumeChatArgs(sessionID, promptArg string) []string {
	return []string{
		"exec",
		"resume",
		"--json",
		"-c", `sandbox_mode="danger-full-access"`,
		"--skip-git-repo-check",
		sessionID,
		promptArg,
	}
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
	if !requireTenantID(w) {
		return
	}

	binary, ok := resolveChatBinary(r.URL.Query().Get("binary"))
	if !ok {
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

	// Gate: if a /login flow is active for this binary, refuse to spawn
	// a competing process. Returns a clean ndjson error frame instead
	// of an HTTP 4xx so platform-context's /auth probe (the loudest
	// caller) and the unified-agent router both interpret it as a
	// well-formed "pending-auth" turn rather than a transport failure.
	// fleet-task #234.
	if globalLoginState.active(binary) {
		writeAuthInProgressFrame(w, binary)
		log("chat: refused spawn binary=%s reason=auth_in_progress", binary)
		return
	}

	// Gate: codex/claude both refuse to talk to their upstream when no
	// auth file exists, and spend ~8s doing five-attempt retries
	// before exiting non-zero. Short-circuit that: if the on-disk
	// credential file is missing, return an actionable `auth_required`
	// frame so the frontend renders a sign-in CTA. fleet-task #292.
	if !authFileExists(binary) {
		writeAuthRequiredFrame(w, binary)
		log("chat: refused spawn binary=%s reason=auth_required path=%s",
			binary, authFilePath(binary))
		return
	}

	// When SessionID is set, session-capable binaries resume that
	// session. Flat-prompt flattening would duplicate history, so pass
	// just the new turn's prompt. Otherwise fall back to flattening for
	// the no-session case.
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
		// Codex CLI: fresh turns use `exec`; resumed turns use
		// `exec resume`. `--json` emits structured stream-json that
		// CodexBrokerBackend's translator parses. `--skip-git-repo-check`
		// is required because /home/runtime is not a git repo.
		if req.SessionID != "" {
			args = codexResumeChatArgs(req.SessionID, promptArg)
		} else {
			args = codexChatArgs(promptArg)
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(),
		time.Duration(req.Timeout)*time.Second)
	defer cancel()

	cmd := commandContext(ctx, binary, args...)
	cmd.Dir = req.Cwd
	cmd.Env = ownedChildEnv()

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
	mux.HandleFunc("/fs/tree", runtimeFSTreeHandler)
	mux.HandleFunc("/fs/file", runtimeFSFileHandler)
	mux.HandleFunc("/spawn", spawnHandler)
	mux.HandleFunc("/materialize-secret", materializeSecretHandler)
	mux.HandleFunc("/chat", chatHandler)
	mux.HandleFunc("/chat-pty", chatPTYHandler)
	mux.HandleFunc("/datasets", finalizedDatasets)
	mux.HandleFunc("/datasets/uploads", newDatasetUpload)
	mux.HandleFunc("/datasets/uploads/", datasetUploadByID)
	mux.HandleFunc("/datasets/", finalizedDatasetByID)

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
