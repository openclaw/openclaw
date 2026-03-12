package reaper

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// ShutdownConfig configures the graceful shutdown handler.
type ShutdownConfig struct {
	// Timeout for the entire shutdown sequence (default: 30s).
	Timeout time.Duration
}

// DefaultShutdownConfig returns a ShutdownConfig with sensible defaults.
func DefaultShutdownConfig() ShutdownConfig {
	return ShutdownConfig{Timeout: 30 * time.Second}
}

// ShutdownDeps provides the dependencies needed by the graceful shutdown handler.
type ShutdownDeps interface {
	// StopAccepting sets a flag to reject new VM creation requests.
	StopAccepting()
	// ActiveVMIDs returns the IDs of all currently active VMs.
	ActiveVMIDs() []string
	// DestroyVM destroys a single VM via the standard cleanup path.
	DestroyVM(ctx context.Context, vmID string) error
	// DrainGRPC gracefully stops the gRPC server.
	DrainGRPC()
}

// RunGracefulShutdown executes the multi-phase shutdown sequence:
// 1. Stop accepting new VM creation requests
// 2. Destroy all active VMs in parallel
// 3. Drain gRPC server
func RunGracefulShutdown(ctx context.Context, deps ShutdownDeps, cfg ShutdownConfig, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	logger.Info("starting graceful shutdown")

	// Phase 1: Stop accepting new VMs
	deps.StopAccepting()
	logger.Info("stopped accepting new VMs")

	// Phase 2: Destroy all active VMs in parallel
	vmIDs := deps.ActiveVMIDs()
	if len(vmIDs) > 0 {
		logger.Info("destroying active VMs", "count", len(vmIDs))

		timeoutCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
		defer cancel()

		var wg sync.WaitGroup
		for _, vmID := range vmIDs {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				if err := deps.DestroyVM(timeoutCtx, id); err != nil {
					logger.Error("failed to destroy VM during shutdown", "vm_id", id, "error", err)
				} else {
					logger.Info("destroyed VM", "vm_id", id)
				}
			}(vmID)
		}

		// Wait for all destroys or context cancellation
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()

		select {
		case <-done:
			logger.Info("all VMs destroyed successfully")
		case <-timeoutCtx.Done():
			logger.Warn("shutdown timeout reached, some VMs may not have been cleaned up")
		}
	}

	// Phase 3: Drain gRPC server
	deps.DrainGRPC()
	logger.Info("gRPC server drained, shutdown complete")

	return nil
}
