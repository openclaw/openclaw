package vm

import (
	"context"
	"encoding/json"
	"expvar"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewPool_SizeClamping(t *testing.T) {
	tests := []struct {
		name     string
		input    int
		expected int
	}{
		{"zero clamps to 5", 0, 5},
		{"negative clamps to 5", -1, 5},
		{"25 clamps to 20", 25, 20},
		{"10 keeps 10", 10, 10},
		{"1 keeps 1", 1, 1},
		{"20 keeps 20", 20, 20},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewPool(tt.input, "/tmp/snap", 0, nil, nil, nil, nil, nil)
			assert.Equal(t, tt.expected, p.Size())
		})
	}
}

func TestPool_Acquire(t *testing.T) {
	// Push a path into the ready channel, verify Acquire returns it.
	p := NewPool(5, "/tmp/snap", 0, nil, nil, nil, nil, nil)

	// Manually push a snapshot path.
	p.ready <- "/tmp/snap/pool-abc12345"

	ctx := context.Background()
	path, release, err := p.Acquire(ctx)
	require.NoError(t, err)
	assert.Equal(t, "/tmp/snap/pool-abc12345", path)
	release()
}

func TestPool_Acquire_Timeout(t *testing.T) {
	// Use context.WithTimeout(1ms), verify error on empty pool.
	p := NewPool(5, "/tmp/snap", 0, nil, nil, nil, nil, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	_, _, err := p.Acquire(ctx)
	assert.Error(t, err, "Acquire should fail when context is cancelled on empty pool")
}

// poolTestTracker records calls to mock functions for lifecycle verification.
type poolTestTracker struct {
	mu             sync.Mutex
	createVMCalls  []string // sandbox IDs created
	destroyCalls   []string // sandbox IDs destroyed
	snapshotCalls  []string // sandbox IDs snapshotted
	healthCalls    []string // sandbox IDs health-checked
	createVMErr    error
	snapshotErr    error
	healthErr      error
	nextID         int
}

func newPoolTestTracker() *poolTestTracker {
	return &poolTestTracker{}
}

func (pt *poolTestTracker) createVM(ctx context.Context) (string, error) {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	if pt.createVMErr != nil {
		return "", pt.createVMErr
	}
	pt.nextID++
	id := fmt.Sprintf("golden-%d", pt.nextID)
	pt.createVMCalls = append(pt.createVMCalls, id)
	return id, nil
}

func (pt *poolTestTracker) destroyVM(ctx context.Context, sandboxID string) error {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	pt.destroyCalls = append(pt.destroyCalls, sandboxID)
	return nil
}

func (pt *poolTestTracker) createSnapshot(ctx context.Context, sandboxID, dir string) error {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	pt.snapshotCalls = append(pt.snapshotCalls, sandboxID)
	if pt.snapshotErr != nil {
		return pt.snapshotErr
	}
	return nil
}

func (pt *poolTestTracker) healthCheck(ctx context.Context, sandboxID string) error {
	pt.mu.Lock()
	defer pt.mu.Unlock()
	pt.healthCalls = append(pt.healthCalls, sandboxID)
	if pt.healthErr != nil {
		return pt.healthErr
	}
	return nil
}

func TestPool_WarmUp(t *testing.T) {
	// Start() calls warmUp which fills pool to target capacity.
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	p := NewPool(3, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	p.Start(ctx)

	// Pool should be filled to capacity.
	assert.Equal(t, 3, p.Len(), "pool should be filled to target capacity")

	// createVM should be called 3 times.
	tracker.mu.Lock()
	assert.Len(t, tracker.createVMCalls, 3, "createVM should be called 3 times")
	assert.Len(t, tracker.destroyCalls, 3, "destroyVM should be called 3 times (golden VM teardown)")
	assert.Len(t, tracker.healthCalls, 3, "healthCheck should be called 3 times")
	assert.Len(t, tracker.snapshotCalls, 3, "createSnapshot should be called 3 times")
	tracker.mu.Unlock()

	p.Shutdown(context.Background())
}

func TestPool_Replenish(t *testing.T) {
	// After Acquire drains one, replenisher refills pool.
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	p := NewPool(2, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	p.Start(ctx)

	assert.Equal(t, 2, p.Len())

	// Acquire one to trigger replenishment.
	path, release, err := p.Acquire(ctx)
	require.NoError(t, err)
	assert.NotEmpty(t, path)
	release()

	// Wait for replenisher to refill.
	deadline := time.After(5 * time.Second)
	for {
		if p.Len() == 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("pool did not replenish within timeout; len=%d", p.Len())
		default:
			time.Sleep(50 * time.Millisecond)
		}
	}

	assert.Equal(t, 2, p.Len(), "pool should replenish after Acquire")

	p.Shutdown(context.Background())
}

func TestPool_Shutdown(t *testing.T) {
	// Shutdown drains ready channel and removes snapshot dirs from disk.
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	p := NewPool(3, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	p.Start(ctx)

	assert.Equal(t, 3, p.Len())

	// Collect the snapshot dir paths before shutdown.
	// We need to verify they exist before shutdown and are removed after.
	paths := make([]string, 0, 3)
	// Drain to collect paths, then re-add.
	for i := 0; i < 3; i++ {
		path, release, err := p.Acquire(ctx)
		require.NoError(t, err)
		paths = append(paths, path)
		release()
	}

	// Re-add them for shutdown to clean up.
	for _, path := range paths {
		// Create the dirs so Shutdown has something to clean.
		os.MkdirAll(path, 0755)
		p.ready <- path
	}

	p.Shutdown(context.Background())

	// done channel should be closed.
	select {
	case <-p.done:
		// ok, closed
	default:
		t.Fatal("done channel should be closed after Shutdown")
	}

	// All snapshot dirs should be removed.
	for _, path := range paths {
		_, err := os.Stat(path)
		assert.True(t, os.IsNotExist(err), "snapshot dir %s should be removed after Shutdown", path)
	}
}

func TestPool_GoldenCleanup(t *testing.T) {
	// destroyVM is called for every createVM call (no leaked golden VMs).
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	p := NewPool(3, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	p.Start(ctx)

	tracker.mu.Lock()
	createCount := len(tracker.createVMCalls)
	destroyCount := len(tracker.destroyCalls)
	tracker.mu.Unlock()

	assert.Equal(t, createCount, destroyCount, "every golden VM should be destroyed after snapshotting")

	// Verify the same set of IDs were created and destroyed (order may differ due to parallelism).
	tracker.mu.Lock()
	createSet := make(map[string]bool)
	for _, id := range tracker.createVMCalls {
		createSet[id] = true
	}
	destroySet := make(map[string]bool)
	for _, id := range tracker.destroyCalls {
		destroySet[id] = true
	}
	tracker.mu.Unlock()

	for id := range createSet {
		assert.True(t, destroySet[id], "created VM %s should also be destroyed", id)
	}

	p.Shutdown(context.Background())
}

func TestPool_CreateSnapshotFailure(t *testing.T) {
	// When snapshot creation fails, destroyVM is still called (defer).
	tracker := newPoolTestTracker()
	tracker.snapshotErr = fmt.Errorf("snapshot failed")
	dir := t.TempDir()

	p := NewPool(2, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	// Call createOneSnapshot directly.
	ctx := context.Background()
	_, err := p.createOneSnapshot(ctx)
	assert.Error(t, err)

	tracker.mu.Lock()
	assert.Len(t, tracker.createVMCalls, 1, "createVM should be called")
	assert.Len(t, tracker.destroyCalls, 1, "destroyVM should be called even on snapshot failure")
	tracker.mu.Unlock()
}

func TestPool_HealthCheckFailure(t *testing.T) {
	// When health check fails, createSnapshot is NOT called, but destroyVM IS called.
	tracker := newPoolTestTracker()
	tracker.healthErr = fmt.Errorf("health check failed")
	dir := t.TempDir()

	p := NewPool(2, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	_, err := p.createOneSnapshot(ctx)
	assert.Error(t, err)

	tracker.mu.Lock()
	assert.Len(t, tracker.createVMCalls, 1, "createVM should be called")
	assert.Len(t, tracker.healthCalls, 1, "healthCheck should be called")
	assert.Empty(t, tracker.snapshotCalls, "createSnapshot should NOT be called when healthCheck fails")
	assert.Len(t, tracker.destroyCalls, 1, "destroyVM should be called even on healthCheck failure")
	tracker.mu.Unlock()
}

func TestPool_CreateOneSnapshot_DirCreation(t *testing.T) {
	// createOneSnapshot creates a unique snapshot directory.
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	p := NewPool(2, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	snapDir, err := p.createOneSnapshot(ctx)
	require.NoError(t, err)

	// Verify directory was created under snapshotDir.
	assert.True(t, filepath.HasPrefix(snapDir, dir), "snapshot dir should be under snapshotDir")

	// Verify the directory exists.
	info, err := os.Stat(snapDir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

// --- Helper: create a fake pool-* directory with metadata.json ---

func createFakeSnapshotDir(t *testing.T, baseDir, name, version string, createdAt time.Time, dataSize int) string {
	t.Helper()
	dirPath := filepath.Join(baseDir, name)
	require.NoError(t, os.MkdirAll(dirPath, 0755))

	meta := SnapshotMetadata{
		Version:    version,
		RootfsHash: "fakehash",
		ConfigHash: "fakecfg",
		CreatedAt:  createdAt,
		VsockCID:   100,
		MemSizeMib: 256,
		VcpuCount:  1,
	}
	metaBytes, err := json.Marshal(meta)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dirPath, "metadata.json"), metaBytes, 0644))

	// Write a data file of the requested size to simulate disk usage.
	if dataSize > 0 {
		data := make([]byte, dataSize)
		require.NoError(t, os.WriteFile(filepath.Join(dirPath, "memory.bin"), data, 0644))
	}

	return dirPath
}

func TestPool_Eviction(t *testing.T) {
	// When total snapshot disk usage exceeds diskLimitBytes, evictIfOverLimit
	// removes oldest snapshot dirs (by metadata.CreatedAt) until under limit.
	dir := t.TempDir()

	// Create 3 fake snapshots: 1000 bytes each, total 3000.
	now := time.Now()
	oldest := createFakeSnapshotDir(t, dir, "pool-oldest", "v1", now.Add(-3*time.Hour), 1000)
	middle := createFakeSnapshotDir(t, dir, "pool-middle", "v1", now.Add(-2*time.Hour), 1000)
	newest := createFakeSnapshotDir(t, dir, "pool-newest", "v1", now.Add(-1*time.Hour), 1000)

	// Disk limit = 2500 bytes => must evict at least oldest (1000 bytes) to get under.
	p := NewPool(5, dir, 2500, nil, nil, nil, nil, nil)

	evicted := p.evictIfOverLimit()
	assert.Equal(t, 1, evicted, "should evict exactly 1 (oldest) snapshot")

	// oldest should be removed.
	_, err := os.Stat(oldest)
	assert.True(t, os.IsNotExist(err), "oldest snapshot should be evicted")

	// middle and newest should remain.
	_, err = os.Stat(middle)
	assert.NoError(t, err, "middle snapshot should remain")
	_, err = os.Stat(newest)
	assert.NoError(t, err, "newest snapshot should remain")
}

func TestPool_StaleCleanup(t *testing.T) {
	// When a snapshot's version doesn't match the expected version,
	// removeStaleSnapshots deletes it.
	dir := t.TempDir()

	now := time.Now()
	stale := createFakeSnapshotDir(t, dir, "pool-stale", "old-version", now.Add(-1*time.Hour), 500)
	valid := createFakeSnapshotDir(t, dir, "pool-valid", "current-version", now, 500)

	p := NewPool(5, dir, 0, nil, nil, nil, nil, nil)

	removed := p.removeStaleSnapshots(context.Background(), "current-version")
	assert.Equal(t, 1, removed, "should remove 1 stale snapshot")

	// stale dir should be gone.
	_, err := os.Stat(stale)
	assert.True(t, os.IsNotExist(err), "stale snapshot should be removed")

	// valid dir should remain.
	_, err = os.Stat(valid)
	assert.NoError(t, err, "valid snapshot should remain")
}

func TestPool_Metrics(t *testing.T) {
	// After Start, Acquire, and replenish, expvar counters reflect correct values.
	// NOTE: expvar counters are global, so we capture baselines before each operation.
	tracker := newPoolTestTracker()
	dir := t.TempDir()

	// Capture baselines before Start.
	acquireBefore := expvar.Get("snapshot_pool_acquire_total").(*expvar.Int).Value()

	p := NewPool(2, dir, 0, tracker.createVM, tracker.destroyVM, tracker.createSnapshot, tracker.healthCheck, nil)

	ctx := context.Background()
	p.Start(ctx)

	// Check target size metric (Set overwrites, so absolute check is OK).
	targetSize := expvar.Get("snapshot_pool_target_size").(*expvar.Int)
	assert.Equal(t, int64(2), targetSize.Value(), "target size metric should be 2")

	// Check ready count metric (Set overwrites after warmup).
	readyCount := expvar.Get("snapshot_pool_ready_count").(*expvar.Int)
	assert.Equal(t, int64(2), readyCount.Value(), "ready count should be 2 after warmup")

	// Acquire one.
	_, release, err := p.Acquire(ctx)
	require.NoError(t, err)
	release()

	// Acquire total should have incremented by 1.
	acquireAfter := expvar.Get("snapshot_pool_acquire_total").(*expvar.Int).Value()
	assert.Equal(t, int64(1), acquireAfter-acquireBefore, "acquire total should increment by 1")

	// Ready count should now be 1 (Set overwrites).
	assert.Equal(t, int64(1), readyCount.Value(), "ready count should be 1 after acquire")

	p.Shutdown(context.Background())
}

func TestPool_EvictionSafety(t *testing.T) {
	// Eviction never removes a snapshot dir that is in the ready channel.
	dir := t.TempDir()

	now := time.Now()
	oldest := createFakeSnapshotDir(t, dir, "pool-oldest", "v1", now.Add(-3*time.Hour), 2000)
	_ = createFakeSnapshotDir(t, dir, "pool-newer", "v1", now.Add(-1*time.Hour), 2000)

	// Disk limit = 2500 bytes => needs to evict 1 of 2.
	// But oldest is in the ready channel, so it must NOT be evicted.
	p := NewPool(5, dir, 2500, nil, nil, nil, nil, nil)
	p.ready <- oldest // protect oldest by putting it in ready channel

	evicted := p.evictIfOverLimit()
	// The newer one is NOT in the ready channel, so it gets evicted.
	// The oldest IS in the ready channel, so it's protected.
	assert.Equal(t, 1, evicted, "should evict 1 snapshot (the unprotected one)")

	// oldest must still exist (it's protected by ready channel).
	_, err := os.Stat(oldest)
	assert.NoError(t, err, "oldest snapshot should NOT be evicted (in ready channel)")
}

func TestPool_DiskLimitZeroDisabled(t *testing.T) {
	// When diskLimitBytes=0, eviction is disabled.
	dir := t.TempDir()

	now := time.Now()
	createFakeSnapshotDir(t, dir, "pool-a", "v1", now.Add(-1*time.Hour), 5000)
	createFakeSnapshotDir(t, dir, "pool-b", "v1", now, 5000)

	// diskLimitBytes=0 => eviction disabled, even though 10000 bytes of data.
	p := NewPool(5, dir, 0, nil, nil, nil, nil, nil)

	evicted := p.evictIfOverLimit()
	assert.Equal(t, 0, evicted, "eviction should be disabled when diskLimitBytes=0")

	// Both dirs should still exist.
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	count := 0
	for _, e := range entries {
		if e.IsDir() {
			count++
		}
	}
	assert.Equal(t, 2, count, "both snapshot dirs should remain")
}
