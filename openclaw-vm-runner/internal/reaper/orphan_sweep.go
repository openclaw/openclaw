package reaper

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// VMEntryInfo contains the information needed by the orphan sweeper to
// determine if a VM is orphaned.
type VMEntryInfo struct {
	ID            string
	PID           int
	UID           int
	ChrootDir     string
	CreatedAt     time.Time
	LastHeartbeat time.Time
}

// VMRegistry provides access to the VM registry for orphan detection.
type VMRegistry interface {
	AllEntries() []VMEntryInfo
	Remove(vmID string)
}

// VMDestroyer destroys VMs via the JailedLauncher's cleanup path.
type VMDestroyer interface {
	DestroyVM(ctx context.Context, vmID string) error
}

// SweepConfig configures the orphan sweep loop.
type SweepConfig struct {
	// Interval between sweep iterations (default: 30s).
	Interval time.Duration
	// HeartbeatMultiplier: VM is stale if LastHeartbeat > Multiplier * Interval ago (default: 3).
	HeartbeatMultiplier int
	// MaxTTL: hard TTL safety net; VMs older than this are destroyed (default: 4h).
	MaxTTL time.Duration
	// ChrootBaseDir: directory scanned for filesystem orphans.
	ChrootBaseDir string
}

// SweepStats tracks orphan sweep statistics.
type SweepStats struct {
	OrphansDestroyed atomic.Int64
	SweepCount       atomic.Int64
}

// OrphanSweeper detects and destroys orphaned VMs via periodic scanning.
type OrphanSweeper struct {
	registry  VMRegistry
	destroyer VMDestroyer
	cfg       SweepConfig
	logger    *slog.Logger
	stats     SweepStats
	stopCh    chan struct{}
	wg        sync.WaitGroup
}

// NewOrphanSweeper creates a new orphan sweeper.
func NewOrphanSweeper(registry VMRegistry, destroyer VMDestroyer, cfg SweepConfig, logger *slog.Logger) *OrphanSweeper {
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Interval == 0 {
		cfg.Interval = 30 * time.Second
	}
	if cfg.HeartbeatMultiplier == 0 {
		cfg.HeartbeatMultiplier = 3
	}
	if cfg.MaxTTL == 0 {
		cfg.MaxTTL = 4 * time.Hour
	}

	return &OrphanSweeper{
		registry:  registry,
		destroyer: destroyer,
		cfg:       cfg,
		logger:    logger,
		stopCh:    make(chan struct{}),
	}
}

// Start launches the sweep goroutine.
func (s *OrphanSweeper) Start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(s.cfg.Interval)
		defer ticker.Stop()

		for {
			select {
			case <-s.stopCh:
				return
			case <-ticker.C:
				s.sweep()
			}
		}
	}()
}

// Stop cleanly stops the sweep goroutine and waits for it to exit.
func (s *OrphanSweeper) Stop() {
	close(s.stopCh)
	s.wg.Wait()
}

// Stats returns the sweep statistics.
func (s *OrphanSweeper) Stats() *SweepStats {
	return &s.stats
}

// sweep runs a single sweep iteration, checking all four orphan types.
func (s *OrphanSweeper) sweep() {
	s.stats.SweepCount.Add(1)
	now := time.Now()
	heartbeatThreshold := time.Duration(s.cfg.HeartbeatMultiplier) * s.cfg.Interval

	orphans := make(map[string]string) // vmID -> reason

	// Check registry entries
	entries := s.registry.AllEntries()
	for _, entry := range entries {
		// 1. Heartbeat staleness
		if !entry.LastHeartbeat.IsZero() && now.Sub(entry.LastHeartbeat) > heartbeatThreshold {
			orphans[entry.ID] = "heartbeat stale"
			continue
		}

		// 2. Process liveness (kill -0)
		if entry.PID > 0 && !isProcessAlive(entry.PID) {
			orphans[entry.ID] = "process dead"
			continue
		}

		// 3. TTL expiry
		if !entry.CreatedAt.IsZero() && now.Sub(entry.CreatedAt) > s.cfg.MaxTTL {
			orphans[entry.ID] = "TTL expired"
			continue
		}
	}

	// 4. Filesystem scan: find chroot dirs not in registry
	s.scanFilesystemOrphans(entries, orphans)

	// Destroy all detected orphans
	for vmID, reason := range orphans {
		s.logger.Warn("destroying orphan VM", "vm_id", vmID, "reason", reason)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := s.destroyer.DestroyVM(ctx, vmID)
		cancel()
		if err != nil {
			// Keep in registry so the next sweep retries cleanup.
			s.logger.Error("failed to destroy orphan VM, will retry next sweep", "vm_id", vmID, "error", err)
			continue
		}
		s.registry.Remove(vmID)
		s.stats.OrphansDestroyed.Add(1)
	}
}

// scanFilesystemOrphans checks the chroot base directory for VM directories
// not tracked in the registry.
func (s *OrphanSweeper) scanFilesystemOrphans(entries []VMEntryInfo, orphans map[string]string) {
	if s.cfg.ChrootBaseDir == "" {
		return
	}

	fcDir := filepath.Join(s.cfg.ChrootBaseDir, "firecracker")
	dirEntries, err := os.ReadDir(fcDir)
	if err != nil {
		// Directory may not exist yet
		return
	}

	// Build set of known VM IDs
	known := make(map[string]bool, len(entries))
	for _, e := range entries {
		known[e.ID] = true
	}

	for _, de := range dirEntries {
		if !de.IsDir() {
			continue
		}
		vmID := de.Name()
		if !known[vmID] {
			if _, alreadyOrphan := orphans[vmID]; !alreadyOrphan {
				orphans[vmID] = "filesystem orphan (not in registry)"
			}
		}
	}
}

// isProcessAlive checks if a process with the given PID is alive.
func isProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil
}
