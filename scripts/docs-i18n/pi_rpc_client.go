package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type docsPiClientOptions struct {
	SystemPrompt string
	Thinking     string
}

type docsPiClient struct {
	process    *exec.Cmd
	stdin      io.WriteCloser
	stderr     bytes.Buffer
	events     chan piEvent
	promptLock sync.Mutex
	closeOnce  sync.Once
	closed     chan struct{}
	requestID  uint64
}

type piEvent struct {
	Type string
	Raw  json.RawMessage
}

type agentEndPayload struct {
	Type     string         `json:"type,omitempty"`
	Messages []agentMessage `json:"messages"`
}

type rpcResponse struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Command string `json:"command,omitempty"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type agentMessage struct {
	Role         string          `json:"role"`
	Content      json.RawMessage `json:"content"`
	StopReason   string          `json:"stopReason,omitempty"`
	ErrorMessage string          `json:"errorMessage,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

func startDocsPiClient(ctx context.Context, options docsPiClientOptions) (*docsPiClient, error) {
	command, err := resolveDocsPiCommand(ctx)
	if err != nil {
		return nil, err
	}

	args := append([]string{}, command.Args...)
	args = append(args,
		"--mode", "rpc",
		"--provider", "anthropic",
		"--model", modelVersion,
		"--thinking", options.Thinking,
		"--no-session",
	)
	if strings.TrimSpace(options.SystemPrompt) != "" {
		args = append(args, "--system-prompt", options.SystemPrompt)
	}

	process := exec.Command(command.Executable, args...)
	agentDir, err := getDocsPiAgentDir()
	if err != nil {
		return nil, err
	}
	process.Env = append(os.Environ(), fmt.Sprintf("PI_CODING_AGENT_DIR=%s", agentDir))
	stdin, err := process.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := process.StderrPipe()
	if err != nil {
		return nil, err
	}

	client := &docsPiClient{
		process: process,
		stdin:   stdin,
		events:  make(chan piEvent, 256),
		closed:  make(chan struct{}),
	}

	if err := process.Start(); err != nil {
		return nil, err
	}

	go client.captureStderr(stderr)
	go client.readStdout(stdout)

	return client, nil
}

func (client *docsPiClient) Prompt(ctx context.Context, message string) (string, error) {
	client.promptLock.Lock()
	defer client.promptLock.Unlock()

	command := map[string]string{
		"type":    "prompt",
		"id":      fmt.Sprintf("req-%d", atomic.AddUint64(&client.requestID, 1)),
		"message": message,
	}
	payload, err := json.Marshal(command)
	if err != nil {
		return "", err
	}

	if _, err := client.stdin.Write(append(payload, '\n')); err != nil {
		return "", err
	}

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-client.closed:
			return "", errors.New("pi process closed")
		case event, ok := <-client.events:
			if !ok {
				return "", errors.New("pi event stream closed")
			}
			if event.Type == "response" {
				response, err := decodeRpcResponse(event.Raw)
				if err != nil {
					return "", err
				}
				if !response.Success {
					if strings.TrimSpace(response.Error) == "" {
						return "", errors.New("pi prompt failed")
					}
					return "", errors.New(strings.TrimSpace(response.Error))
				}
				continue
			}
			if event.Type == "agent_end" {
				return extractTranslationResult(event.Raw)
			}
		}
	}
}

func (client *docsPiClient) Stderr() string {
	return client.stderr.String()
}

func (client *docsPiClient) Close() error {
	client.closeOnce.Do(func() {
		close(client.closed)
		if client.stdin != nil {
			_ = client.stdin.Close()
		}
		if client.process != nil && client.process.Process != nil {
			_ = client.process.Process.Signal(syscall.SIGTERM)
		}

		done := make(chan struct{})
		go func() {
			if client.process != nil {
				_ = client.process.Wait()
			}
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(2 * time.Second):
			if client.process != nil && client.process.Process != nil {
				_ = client.process.Process.Kill()
			}
		}
	})
	return nil
}

func (client *docsPiClient) captureStderr(stderr io.Reader) {
	_, _ = io.Copy(&client.stderr, stderr)
}

func (client *docsPiClient) readStdout(stdout io.Reader) {
	defer close(client.events)

	reader := bufio.NewReader(stdout)
	for {
		line, err := reader.ReadBytes('\n')
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			var envelope struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(line, &envelope) == nil && envelope.Type != "" {
				select {
				case client.events <- piEvent{Type: envelope.Type, Raw: append([]byte{}, line...)}:
				case <-client.closed:
					return
				}
			}
		}
		if err != nil {
			return
		}
	}
}

func extractTranslationResult(raw json.RawMessage) (string, error) {
	var payload agentEndPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", err
	}
	for index := len(payload.Messages) - 1; index >= 0; index-- {
		message := payload.Messages[index]
		if message.Role != "assistant" {
			continue
		}
		if message.ErrorMessage != "" || strings.EqualFold(message.StopReason, "error") {
			msg := strings.TrimSpace(message.ErrorMessage)
			if msg == "" {
				msg = "unknown error"
			}
			return "", fmt.Errorf("pi error: %s", msg)
		}
		text, err := extractContentText(message.Content)
		if err != nil {
			return "", err
		}
		return text, nil
	}
	return "", errors.New("assistant message not found")
}

func extractContentText(content json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(content))
	if trimmed == "" {
		return "", nil
	}
	if strings.HasPrefix(trimmed, "\"") {
		var text string
		if err := json.Unmarshal(content, &text); err != nil {
			return "", err
		}
		return text, nil
	}

	var blocks []contentBlock
	if err := json.Unmarshal(content, &blocks); err != nil {
		return "", err
	}

	var parts []string
	for _, block := range blocks {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	return strings.Join(parts, ""), nil
}

func decodeRpcResponse(raw json.RawMessage) (rpcResponse, error) {
	var response rpcResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return rpcResponse{}, err
	}
	return response, nil
}

func getDocsPiAgentDir() (string, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = os.TempDir()
	}
	dir := filepath.Join(cacheDir, "openclaw", "docs-i18n", "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}
