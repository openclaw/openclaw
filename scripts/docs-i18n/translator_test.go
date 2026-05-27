package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakePromptRunner struct {
	prompt func(context.Context, string) (string, error)
	stderr string
}

func (runner fakePromptRunner) Prompt(ctx context.Context, message string) (string, error) {
	return runner.prompt(ctx, message)
}

func (runner fakePromptRunner) Stderr() string {
	return runner.stderr
}

func TestRunPromptAddsTimeout(t *testing.T) {
	t.Parallel()

	var deadline time.Time
	client := fakePromptRunner{
		prompt: func(ctx context.Context, message string) (string, error) {
			var ok bool
			deadline, ok = ctx.Deadline()
			if !ok {
				t.Fatal("expected prompt deadline")
			}
			if message != "Translate me" {
				t.Fatalf("unexpected message %q", message)
			}
			return "translated", nil
		},
	}

	got, err := runPrompt(context.Background(), client, "Translate me")
	if err != nil {
		t.Fatalf("runPrompt returned error: %v", err)
	}
	if got != "translated" {
		t.Fatalf("unexpected translation %q", got)
	}

	remaining := time.Until(deadline)
	if remaining <= time.Minute || remaining > docsI18nPromptTimeout() {
		t.Fatalf("unexpected timeout window %s", remaining)
	}
}

func TestDocsI18nPromptTimeoutUsesEnvOverride(t *testing.T) {
	t.Setenv(envDocsI18nPromptTimeout, "5m")

	if got := docsI18nPromptTimeout(); got != 5*time.Minute {
		t.Fatalf("expected 5m timeout, got %s", got)
	}
}

func TestIsRetryableTranslateErrorRejectsDeadlineExceeded(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(context.DeadlineExceeded) {
		t.Fatal("deadline exceeded should not retry")
	}
}

func TestIsRetryableTranslateErrorRejectsAuthenticationFailures(t *testing.T) {
	t.Parallel()

	if isRetryableTranslateError(errors.New(`Authentication failed for "openai"`)) {
		t.Fatal("auth failures should not retry")
	}
}

func TestRunPromptIncludesStderr(t *testing.T) {
	t.Parallel()

	rootErr := errors.New("context deadline exceeded")
	client := fakePromptRunner{
		prompt: func(context.Context, string) (string, error) {
			return "", rootErr
		},
		stderr: "boom",
	}

	_, err := runPrompt(context.Background(), client, "Translate me")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, rootErr) {
		t.Fatalf("expected wrapped root error, got %v", err)
	}
	if !strings.Contains(err.Error(), "pi stderr: boom") {
		t.Fatalf("expected stderr in error, got %v", err)
	}
}

func TestDecoratePromptErrorLeavesCleanErrorsAlone(t *testing.T) {
	t.Parallel()

	rootErr := errors.New("plain failure")
	got := decoratePromptError(rootErr, "  ")
	if !errors.Is(got, rootErr) {
		t.Fatalf("expected original error, got %v", got)
	}
	if got.Error() != rootErr.Error() {
		t.Fatalf("expected unchanged message, got %v", got)
	}
}

func TestResolveDocsPiCommandUsesOverrideEnv(t *testing.T) {
	t.Setenv(envDocsPiExecutable, "/tmp/custom-pi")
	t.Setenv(envDocsPiArgs, "--mode rpc --foo bar")

	command, err := resolveDocsPiCommand(context.Background())
	if err != nil {
		t.Fatalf("resolveDocsPiCommand returned error: %v", err)
	}

	if command.Executable != "/tmp/custom-pi" {
		t.Fatalf("unexpected executable %q", command.Executable)
	}
	if strings.Join(command.Args, " ") != "--mode rpc --foo bar" {
		t.Fatalf("unexpected args %v", command.Args)
	}
}

func TestShouldMaterializePiRuntimeForPiMonoWrapper(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	sourceDir := filepath.Join(root, "Projects", "pi-mono", "packages", "coding-agent", "dist")
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatalf("mkdir source dir: %v", err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin dir: %v", err)
	}

	target := filepath.Join(sourceDir, "cli.js")
	if err := os.WriteFile(target, []byte("console.log('pi');\n"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	link := filepath.Join(binDir, "pi")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if !shouldMaterializePiRuntime(link) {
		t.Fatal("expected pi-mono wrapper to materialize runtime")
	}
}
