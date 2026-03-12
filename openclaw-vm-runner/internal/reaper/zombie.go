// Package reaper provides zombie process reaping, orphan VM cleanup,
// and graceful shutdown for the openclaw-vm-runner service.
package reaper

import (
	"log/slog"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
)

// ReaperStats tracks zombie reaping statistics.
type ReaperStats struct {
	ZombiesReaped atomic.Int64
}

// StartZombieReaper registers the process as a child subreaper (Linux only)
// and starts a goroutine that reaps zombie child processes on SIGCHLD.
// Returns a cancel function to stop the reaper and a stats handle.
func StartZombieReaper(logger *slog.Logger) (cancel func(), stats *ReaperStats) {
	if logger == nil {
		logger = slog.Default()
	}

	stats = &ReaperStats{}

	// Set PR_SET_CHILD_SUBREAPER on Linux so orphaned grandchildren
	// are re-parented to this process instead of PID 1.
	setChildSubreaper(logger)

	sigCh := make(chan os.Signal, 32)
	signal.Notify(sigCh, syscall.SIGCHLD)

	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			_, ok := <-sigCh
			if !ok {
				return
			}
			reapZombies(logger, stats)
		}
	}()

	cancel = func() {
		signal.Stop(sigCh)
		close(sigCh)
		<-done
	}

	return cancel, stats
}

// reapZombies calls wait4(-1, WNOHANG) in a loop to reap all available zombies.
func reapZombies(logger *slog.Logger, stats *ReaperStats) {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			break
		}
		stats.ZombiesReaped.Add(1)
		logger.Info("reaped zombie process",
			"pid", pid,
			"exit_status", status.ExitStatus(),
			"total_reaped", stats.ZombiesReaped.Load(),
		)
	}
}
