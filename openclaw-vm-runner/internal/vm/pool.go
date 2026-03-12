package vm

import (
	"context"
	"expvar"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Expvar metrics for snapshot pool observability.
var (
	metricPoolTargetSize     = expvar.NewInt("snapshot_pool_target_size")
	metricPoolReadyCount     = expvar.NewInt("snapshot_pool_ready_count")
	metricPoolAcquireTotal   = expvar.NewInt("snapshot_pool_acquire_total")
	metricPoolReplenishTotal = expvar.NewInt("snapshot_pool_replenish_total")
	metricPoolEvictionTotal  = expvar.NewInt("snapshot_pool_eviction_total")
	metricPoolDiskUsageBytes = expvar.NewInt("snapshot_pool_disk_usage_bytes")
)

const (
	// defaultPoolSize is used when an invalid pool size is provided.
	defaultPoolSize = 5

	// maxPoolSize is the maximum allowed pool size.
	maxPoolSize = 20

	// replenishBackoff is the delay after a failed snapshot creation attempt.
	replenishBackoff = 5 * time.Second

	// replenishPollInterval is how often the replenisher checks if pool needs filling.
	replenishPollInterval = 1 * time.Second
)

// CreateVMFunc boots a golden VM and returns its sandbox ID.
type CreateVMFunc func(ctx context.Context) (sandboxID string, err error)

// DestroyVMFunc tears down a golden VM by sandbox ID.
type DestroyVMFunc func(ctx context.Context, sandboxID string) error

// CreateSnapshotFunc captures a VM snapshot to the given directory.
type CreateSnapshotFunc func(ctx context.Context, sandboxID, dir string) error

// HealthCheckFunc verifies a VM's envd agent is healthy.
type HealthCheckFunc func(ctx context.Context, sandboxID string) error

// Pool maintains a pool of pre-booted VM snapshots for instant restore.
// It uses a buffered channel of snapshot directory paths as the ready queue.
type Pool struct {
	size           int
	snapshotDir    string
	diskLimitBytes int64
	ready          chan string
	createVM       CreateVMFunc
	destroyVM      DestroyVMFunc
	createSnapshot CreateSnapshotFunc
	healthCheck    HealthCheckFunc
	cancel         context.CancelFunc
	done           chan struct{}
	logger         *slog.Logger
	evictMu        sync.Mutex
	currentVersion string
	leasedMu       sync.Mutex
	leased         map[string]struct{}
}

// NewPool creates a new Pool with the given configuration.
// Size is clamped: if < 1, set to 5 (default); if > 20, set to 20 (max).
// diskLimitBytes sets the maximum disk space for snapshot artifacts.
// When diskLimitBytes <= 0, disk limit enforcement is disabled.
func NewPool(size int, snapshotDir string, diskLimitBytes int64, createVM CreateVMFunc, destroyVM DestroyVMFunc, createSnapshot CreateSnapshotFunc, healthCheck HealthCheckFunc, logger *slog.Logger) *Pool {
	if size < 1 {
		size = defaultPoolSize
	}
	if size > maxPoolSize {
		size = maxPoolSize
	}

	if logger == nil {
		logger = slog.Default()
	}

	return &Pool{
		size:           size,
		snapshotDir:    snapshotDir,
		diskLimitBytes: diskLimitBytes,
		ready:          make(chan string, size),
		createVM:       createVM,
		destroyVM:      destroyVM,
		createSnapshot: createSnapshot,
		healthCheck:    healthCheck,
		done:           make(chan struct{}),
		logger:         logger,
		leased:         make(map[string]struct{}),
	}
}

// Size returns the target pool capacity.
func (p *Pool) Size() int {
	return p.size
}

// Len returns the current number of ready snapshots.
func (p *Pool) Len() int {
	return len(p.ready)
}

// Acquire returns a ready snapshot directory path from the pool.
// It blocks until a snapshot is available or the context is cancelled.
// The caller MUST call the returned release function when the snapshot
// is no longer needed (after restore completes or fails) to allow
// eviction to reclaim the directory if necessary.
func (p *Pool) Acquire(ctx context.Context) (string, func(), error) {
	select {
	case path := <-p.ready:
		metricPoolAcquireTotal.Add(1)
		metricPoolReadyCount.Set(int64(len(p.ready)))

		p.leasedMu.Lock()
		p.leased[path] = struct{}{}
		p.leasedMu.Unlock()

		release := func() {
			p.leasedMu.Lock()
			delete(p.leased, path)
			p.leasedMu.Unlock()
		}
		return path, release, nil
	case <-ctx.Done():
		return "", nil, fmt.Errorf("pool acquire: %w", ctx.Err())
	}
}

// Start initializes the pool by running warmUp synchronously (blocks until
// pool is pre-filled) and then launches replenishLoop as a background goroutine.
func (p *Pool) Start(ctx context.Context) {
	ctx, p.cancel = context.WithCancel(ctx)
	metricPoolTargetSize.Set(int64(p.size))
	p.warmUp(ctx)
	metricPoolReadyCount.Set(int64(len(p.ready)))
	p.updateDiskMetric()
	go p.replenishLoop(ctx)
}

// Shutdown stops the replenisher, waits for it to exit, drains the ready
// channel, and removes all snapshot artifacts from disk.
func (p *Pool) Shutdown(ctx context.Context) {
	p.cancel()
	<-p.done // wait for replenishLoop to exit

	// Drain ready channel and clean up snapshot directories.
	for {
		select {
		case snapDir := <-p.ready:
			if err := os.RemoveAll(snapDir); err != nil {
				p.logger.Warn("failed to remove snapshot dir during shutdown",
					"dir", snapDir, "error", err)
			} else {
				p.logger.Info("removed snapshot dir during shutdown", "dir", snapDir)
			}
		default:
			return
		}
	}
}

// createOneSnapshot is the atomic unit of pool replenishment.
// It boots a golden VM, health-checks it, takes a snapshot, and always
// tears down the golden VM (via defer) regardless of success or failure.
func (p *Pool) createOneSnapshot(ctx context.Context) (string, error) {
	// 1. Boot golden VM.
	sandboxID, err := p.createVM(ctx)
	if err != nil {
		return "", fmt.Errorf("create golden VM: %w", err)
	}

	// 2. ALWAYS tear down golden VM (no leak).
	defer func() {
		if dErr := p.destroyVM(ctx, sandboxID); dErr != nil {
			p.logger.Warn("failed to destroy golden VM",
				"sandboxID", sandboxID, "error", dErr)
		}
	}()

	// 3. Health check.
	if err := p.healthCheck(ctx, sandboxID); err != nil {
		return "", fmt.Errorf("health check golden VM %s: %w", sandboxID, err)
	}

	// 4. Generate unique snapshot directory.
	snapID := uuid.New().String()[:8]
	snapDir := filepath.Join(p.snapshotDir, "pool-"+snapID)
	if err := os.MkdirAll(snapDir, 0700); err != nil {
		return "", fmt.Errorf("create snapshot dir: %w", err)
	}

	// 5. Take snapshot.
	if err := p.createSnapshot(ctx, sandboxID, snapDir); err != nil {
		// Clean up the created directory on failure.
		os.RemoveAll(snapDir)
		return "", fmt.Errorf("create snapshot for %s: %w", sandboxID, err)
	}

	return snapDir, nil
}

// warmUp fills the pool to target capacity using parallel goroutines.
// It blocks until all goroutines complete. Failures are logged but not fatal
// (best-effort fill).
func (p *Pool) warmUp(ctx context.Context) {
	var wg sync.WaitGroup
	for i := 0; i < p.size; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			snapDir, err := p.createOneSnapshot(ctx)
			if err != nil {
				p.logger.Error("warm-up snapshot failed", "error", err)
				return
			}

			// Push to ready channel (non-blocking to handle overflow).
			select {
			case p.ready <- snapDir:
			default:
				p.logger.Warn("warm-up overflow, discarding snapshot", "dir", snapDir)
				os.RemoveAll(snapDir)
			}
		}()
	}
	wg.Wait()
}

// replenishLoop continuously refills the pool after Acquire drains it.
// It runs until the context is cancelled (via Shutdown).
func (p *Pool) replenishLoop(ctx context.Context) {
	defer close(p.done)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if len(p.ready) < p.size {
			// Before creating a new snapshot, clean up stale and enforce disk limits.
			if p.currentVersion != "" {
				p.removeStaleSnapshots(ctx, p.currentVersion)
			}
			p.evictIfOverLimit()

			snapDir, err := p.createOneSnapshot(ctx)
			if err != nil {
				// Check if we were cancelled.
				select {
				case <-ctx.Done():
					return
				default:
				}

				p.logger.Error("replenish snapshot failed, backing off",
					"error", err)

				// Backoff before retrying.
				select {
				case <-ctx.Done():
					return
				case <-time.After(replenishBackoff):
				}
				continue
			}

			// Push to ready channel.
			select {
			case p.ready <- snapDir:
				metricPoolReplenishTotal.Add(1)
				metricPoolReadyCount.Set(int64(len(p.ready)))
				p.logger.Info("replenished pool", "dir", snapDir,
					"len", len(p.ready), "size", p.size)
			case <-ctx.Done():
				os.RemoveAll(snapDir)
				return
			}
		} else {
			// Pool is full, wait before checking again.
			select {
			case <-ctx.Done():
				return
			case <-time.After(replenishPollInterval):
			}
		}
	}
}

// SetCurrentVersion sets the expected snapshot version string for stale detection.
// This should be called after computing CurrentVersion from rootfs + config.
func (p *Pool) SetCurrentVersion(version string) {
	p.currentVersion = version
}

// dirSize walks a directory and returns the total size in bytes of all regular files.
func dirSize(dir string) int64 {
	var total int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		total += info.Size()
	}
	return total
}

// snapshotDirEntry holds metadata for a pool snapshot directory, used for LRU eviction sorting.
type snapshotDirEntry struct {
	path      string
	createdAt time.Time
	size      int64
}

// evictIfOverLimit removes the oldest snapshot directories (by metadata CreatedAt)
// until total disk usage is within diskLimitBytes. Directories currently in the
// ready channel are never evicted. Returns the number of evicted directories.
// When diskLimitBytes <= 0, eviction is disabled and returns 0.
func (p *Pool) evictIfOverLimit() int {
	if p.diskLimitBytes <= 0 {
		return 0
	}

	p.evictMu.Lock()
	defer p.evictMu.Unlock()

	// Drain the ready channel to build a "protected" set, then re-add all entries.
	readySet := make(map[string]bool)
	var readyPaths []string
	for {
		select {
		case path := <-p.ready:
			readySet[path] = true
			readyPaths = append(readyPaths, path)
		default:
			goto drained
		}
	}
drained:
	for _, path := range readyPaths {
		p.ready <- path
	}

	// Collect all pool-* directories with metadata.
	entries, err := os.ReadDir(p.snapshotDir)
	if err != nil {
		return 0
	}

	var dirs []snapshotDirEntry
	var totalSize int64
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "pool-") {
			continue
		}
		dirPath := filepath.Join(p.snapshotDir, e.Name())
		meta, err := readMetadata(dirPath)
		if err != nil {
			continue
		}
		sz := dirSize(dirPath)
		dirs = append(dirs, snapshotDirEntry{
			path:      dirPath,
			createdAt: meta.CreatedAt,
			size:      sz,
		})
		totalSize += sz
	}

	// Sort oldest first.
	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i].createdAt.Before(dirs[j].createdAt)
	})

	evicted := 0
	for _, d := range dirs {
		if totalSize <= p.diskLimitBytes {
			break
		}
		if readySet[d.path] {
			continue // never evict ready snapshots
		}
		// Never evict leased (in-flight restore) snapshots.
		p.leasedMu.Lock()
		_, isLeased := p.leased[d.path]
		p.leasedMu.Unlock()
		if isLeased {
			continue
		}
		if err := os.RemoveAll(d.path); err != nil {
			p.logger.Warn("eviction failed", "dir", d.path, "error", err)
			continue
		}
		totalSize -= d.size
		evicted++
		metricPoolEvictionTotal.Add(1)
		p.logger.Info("evicted snapshot", "dir", d.path, "freed", d.size)
	}

	metricPoolDiskUsageBytes.Set(totalSize)
	return evicted
}

// removeStaleSnapshots scans pool-* directories and removes any whose version
// does not match expectedVersion. Returns the number of removed stale snapshots.
func (p *Pool) removeStaleSnapshots(ctx context.Context, expectedVersion string) int {
	if expectedVersion == "" {
		return 0
	}

	entries, err := os.ReadDir(p.snapshotDir)
	if err != nil {
		return 0
	}

	removed := 0
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "pool-") {
			continue
		}
		dirPath := filepath.Join(p.snapshotDir, e.Name())
		valid, err := IsVersionValid(dirPath, expectedVersion)
		if err != nil {
			// Can't read metadata -- treat as stale.
			p.logger.Warn("cannot read snapshot metadata, removing", "dir", dirPath, "error", err)
			os.RemoveAll(dirPath)
			removed++
			continue
		}
		if !valid {
			p.logger.Info("removing stale snapshot", "dir", dirPath)
			os.RemoveAll(dirPath)
			removed++
		}
	}
	return removed
}

// updateDiskMetric scans pool-* directories and updates the disk usage metric.
func (p *Pool) updateDiskMetric() {
	entries, err := os.ReadDir(p.snapshotDir)
	if err != nil {
		return
	}

	var totalSize int64
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "pool-") {
			continue
		}
		dirPath := filepath.Join(p.snapshotDir, e.Name())
		totalSize += dirSize(dirPath)
	}
	metricPoolDiskUsageBytes.Set(totalSize)
}

