package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pi "github.com/joshp123/pi-golang"
)

type fakePromptRunner struct {
	run    func(context.Context, string) (pi.RunResult, error)
	stderr string
}

func (runner fakePromptRunner) Run(ctx context.Context, message string) (pi.RunResult, error) {
	return runner.run(ctx, message)
}

func (runner fakePromptRunner) Stderr() string {
	return runner.stderr
}

func TestRunPromptAddsTimeout(t *testing.T) {
	t.Parallel()

	var deadline time.Time
	client := fakePromptRunner{
		run: func(ctx context.Context, message string) (pi.RunResult, error) {
			var ok bool
			deadline, ok = ctx.Deadline()
			if !ok {
				t.Fatal("expected prompt deadline")
			}
			if message != "Translate me" {
				t.Fatalf("unexpected message %q", message)
			}
			return pi.RunResult{Text: "translated"}, nil
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
	if remaining <= time.Minute || remaining > translatePromptTimeout {
		t.Fatalf("unexpected timeout window %s", remaining)
	}
}

func TestRunPromptIncludesStderr(t *testing.T) {
	t.Parallel()

	rootErr := errors.New("context deadline exceeded")
	client := fakePromptRunner{
		run: func(context.Context, string) (pi.RunResult, error) {
			return pi.RunResult{}, rootErr
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
