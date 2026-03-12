package vm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openclaw/vm-runner/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockMachineFactory returns a MachineFactory that creates mock MachineEntry
// instances without requiring real Firecracker/KVM.
func mockMachineFactory() MachineFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		_, cancel := context.WithCancel(ctx)
		return &MachineEntry{
			ID:       req.SandboxID,
			State:    StateRunning,
			VMConfig: vmCfg,
			Cancel:   cancel,
		}, nil
	}
}

// failingMachineFactory returns a factory that always fails.
func failingMachineFactory() MachineFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		return nil, fmt.Errorf("mock machine creation failed")
	}
}

func newTestManager() *Manager {
	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = "/boot/vmlinux"
	cfg.RootfsPath = "/rootfs/rootfs.ext4"
	cfg.SocketDir = "/tmp/test-socks"
	m := NewManager(cfg)
	m.SetMachineFactory(mockMachineFactory())
	return m
}

func TestNewManager(t *testing.T) {
	m := newTestManager()
	assert.NotNil(t, m)

	entries := m.List()
	assert.Empty(t, entries)
}

func TestManager_Create(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	entry, err := m.Create(ctx, &CreateRequest{
		SandboxID:  "test-sandbox-1",
		VcpuCount:  2,
		MemSizeMib: 512,
	})
	require.NoError(t, err)
	assert.Equal(t, "test-sandbox-1", entry.ID)
	assert.Equal(t, StateRunning, entry.State)
}

func TestManager_CreateDuplicateID(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	_, err := m.Create(ctx, &CreateRequest{SandboxID: "dup-sandbox"})
	require.NoError(t, err)

	_, err = m.Create(ctx, &CreateRequest{SandboxID: "dup-sandbox"})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestManager_Destroy(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	_, err := m.Create(ctx, &CreateRequest{SandboxID: "destroy-me"})
	require.NoError(t, err)

	err = m.Destroy(ctx, "destroy-me")
	require.NoError(t, err)

	// Should not be found after destroy
	_, err = m.Get("destroy-me")
	assert.Error(t, err)
}

func TestManager_DestroyUnknown(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	err := m.Destroy(ctx, "nonexistent")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestManager_Get(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	_, err := m.Create(ctx, &CreateRequest{SandboxID: "get-me"})
	require.NoError(t, err)

	entry, err := m.Get("get-me")
	require.NoError(t, err)
	assert.Equal(t, "get-me", entry.ID)
}

func TestManager_GetUnknown(t *testing.T) {
	m := newTestManager()

	_, err := m.Get("does-not-exist")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestManager_List(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	_, err := m.Create(ctx, &CreateRequest{SandboxID: "list-1"})
	require.NoError(t, err)
	_, err = m.Create(ctx, &CreateRequest{SandboxID: "list-2"})
	require.NoError(t, err)
	_, err = m.Create(ctx, &CreateRequest{SandboxID: "list-3"})
	require.NoError(t, err)

	entries := m.List()
	assert.Len(t, entries, 3)

	ids := make(map[string]bool)
	for _, e := range entries {
		ids[e.ID] = true
	}
	assert.True(t, ids["list-1"])
	assert.True(t, ids["list-2"])
	assert.True(t, ids["list-3"])
}

func TestManager_CIDIncrement(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	// CID starts at 3 and increments
	_, err := m.Create(ctx, &CreateRequest{SandboxID: "cid-1"})
	require.NoError(t, err)
	cid1 := m.lastAssignedCID()

	_, err = m.Create(ctx, &CreateRequest{SandboxID: "cid-2"})
	require.NoError(t, err)
	cid2 := m.lastAssignedCID()

	_, err = m.Create(ctx, &CreateRequest{SandboxID: "cid-3"})
	require.NoError(t, err)
	cid3 := m.lastAssignedCID()

	assert.Equal(t, uint32(3), cid1)
	assert.Equal(t, uint32(4), cid2)
	assert.Equal(t, uint32(5), cid3)
}

func TestManager_Cleanup(t *testing.T) {
	m := newTestManager()
	ctx := context.Background()

	_, err := m.Create(ctx, &CreateRequest{SandboxID: "cleanup-1"})
	require.NoError(t, err)
	_, err = m.Create(ctx, &CreateRequest{SandboxID: "cleanup-2"})
	require.NoError(t, err)

	m.Cleanup(ctx)

	entries := m.List()
	assert.Empty(t, entries)
}

func TestManager_CreateWithFailingFactory(t *testing.T) {
	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = "/boot/vmlinux"
	cfg.RootfsPath = "/rootfs/rootfs.ext4"
	cfg.SocketDir = "/tmp/test-socks"
	m := NewManager(cfg)
	m.SetMachineFactory(failingMachineFactory())

	ctx := context.Background()
	_, err := m.Create(ctx, &CreateRequest{SandboxID: "fail-sandbox"})
	assert.Error(t, err)

	// Should not be stored in map
	entries := m.List()
	assert.Empty(t, entries)
}

// --- Snapshot-first Create path tests ---

// newTestManagerWithPool creates a Manager with pool and snapshotter for snapshot-first tests.
// snapshotDir must contain valid metadata.json + memory.bin + vmstate.snap.
func newTestManagerWithPool(t *testing.T, snapDir string, restoreFail bool) *Manager {
	t.Helper()
	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = "/boot/vmlinux"
	cfg.RootfsPath = "/rootfs/rootfs.ext4"
	cfg.SocketDir = "/tmp/test-socks"
	m := NewManager(cfg)
	m.SetMachineFactory(mockMachineFactory())

	var rf SnapshotRestoreFactory
	if restoreFail {
		rf = failingRestoreFactory()
	} else {
		rf = mockRestoreFactory()
	}
	snapshotter := NewSnapshotter(m, "/tmp/snapshots", rf)

	// Create a pool with size 1 and noop functions (we'll pre-fill the ready channel)
	pool := NewPool(1, "/tmp/snap", 0,
		func(ctx context.Context) (string, error) { return "", fmt.Errorf("unused") },
		func(ctx context.Context, sandboxID string) error { return nil },
		func(ctx context.Context, sandboxID, dir string) error { return nil },
		func(ctx context.Context, sandboxID string) error { return nil },
		nil,
	)

	// Pre-fill the pool's ready channel with the snapshot directory
	if snapDir != "" {
		pool.ready <- snapDir
	}

	m.SetPool(pool, snapshotter)
	return m
}

// setupSnapshotDir creates a valid snapshot directory with metadata.json, memory.bin, vmstate.snap.
func setupSnapshotDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	snapDir := filepath.Join(dir, "pool-test")
	require.NoError(t, os.MkdirAll(snapDir, 0755))

	// Write metadata.json
	meta := SnapshotMetadata{
		Version:    "testversion",
		RootfsHash: "abc",
		ConfigHash: "def",
		CreatedAt:  time.Now(),
		VsockCID:   99,
		MemSizeMib: 256,
		VcpuCount:  1,
	}
	metaBytes, err := json.Marshal(meta)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(snapDir, "metadata.json"), metaBytes, 0644))

	// Write artifact files
	require.NoError(t, os.WriteFile(filepath.Join(snapDir, "memory.bin"), []byte("mem"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(snapDir, "vmstate.snap"), []byte("snap"), 0644))

	return snapDir
}

func TestManager_Create_SnapshotFirst(t *testing.T) {
	// When pool has a ready snapshot, Create returns entry with BootMethod="snapshot"
	// and does NOT call the cold boot factory.
	snapDir := setupSnapshotDir(t)
	factoryCalled := false
	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = "/boot/vmlinux"
	cfg.RootfsPath = "/rootfs/rootfs.ext4"
	cfg.SocketDir = "/tmp/test-socks"
	m := NewManager(cfg)
	m.SetMachineFactory(func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		factoryCalled = true
		_, cancel := context.WithCancel(ctx)
		return &MachineEntry{
			ID:       req.SandboxID,
			State:    StateRunning,
			VMConfig: vmCfg,
			Cancel:   cancel,
		}, nil
	})

	snapshotter := NewSnapshotter(m, "/tmp/snapshots", mockRestoreFactory())
	pool := NewPool(1, "/tmp/snap", 0,
		func(ctx context.Context) (string, error) { return "", fmt.Errorf("unused") },
		func(ctx context.Context, sandboxID string) error { return nil },
		func(ctx context.Context, sandboxID, dir string) error { return nil },
		func(ctx context.Context, sandboxID string) error { return nil },
		nil,
	)
	pool.ready <- snapDir
	m.SetPool(pool, snapshotter)

	ctx := context.Background()
	entry, err := m.Create(ctx, &CreateRequest{SandboxID: "snap-first-1"})
	require.NoError(t, err)

	assert.Equal(t, "snap-first-1", entry.ID)
	assert.Equal(t, BootMethodSnapshot, entry.BootMethod)
	assert.False(t, factoryCalled, "cold boot factory should NOT be called when snapshot succeeds")
}

func TestManager_Create_ColdFallback_PoolEmpty(t *testing.T) {
	// When pool acquire times out (empty pool), Create falls back to cold boot.
	m := newTestManagerWithPool(t, "", false) // empty pool (no snapDir)

	ctx := context.Background()
	entry, err := m.Create(ctx, &CreateRequest{SandboxID: "cold-fallback-1"})
	require.NoError(t, err)

	assert.Equal(t, "cold-fallback-1", entry.ID)
	assert.Equal(t, BootMethodCold, entry.BootMethod)
}

func TestManager_Create_ColdFallback_RestoreFail(t *testing.T) {
	// When pool returns a snapshot dir but Snapshotter.RestoreEntry fails,
	// Create falls back to cold boot factory with BootMethod="cold".
	snapDir := setupSnapshotDir(t)
	m := newTestManagerWithPool(t, snapDir, true) // restoreFail=true

	ctx := context.Background()
	entry, err := m.Create(ctx, &CreateRequest{SandboxID: "cold-restore-fail-1"})
	require.NoError(t, err)

	assert.Equal(t, "cold-restore-fail-1", entry.ID)
	assert.Equal(t, BootMethodCold, entry.BootMethod)
}

func TestManager_Create_PoolTimeout(t *testing.T) {
	// When pool acquire context deadline exceeds 50ms, Create falls through to cold boot.
	// Use a pool with no ready snapshots -- acquire will time out.
	m := newTestManagerWithPool(t, "", false) // empty pool

	ctx := context.Background()
	entry, err := m.Create(ctx, &CreateRequest{SandboxID: "pool-timeout-1"})
	require.NoError(t, err)

	assert.Equal(t, "pool-timeout-1", entry.ID)
	assert.Equal(t, BootMethodCold, entry.BootMethod)
}

func TestManager_CreateCold_SkipsPool(t *testing.T) {
	// CreateCold always uses cold boot factory even when pool is set.
	snapDir := setupSnapshotDir(t)
	m := newTestManagerWithPool(t, snapDir, false)

	ctx := context.Background()
	entry, err := m.CreateCold(ctx, &CreateRequest{SandboxID: "cold-only-1"})
	require.NoError(t, err)

	assert.Equal(t, "cold-only-1", entry.ID)
	assert.Equal(t, BootMethodCold, entry.BootMethod)

	// Pool should still have the snapshot (not consumed)
	assert.Equal(t, 1, m.pool.Len(), "pool snapshot should not be consumed by CreateCold")
}

func TestManager_Create_NilPool_ColdBoot(t *testing.T) {
	// When pool is nil (not configured), Create uses cold boot as before (backward compatible).
	m := newTestManager()

	ctx := context.Background()
	entry, err := m.Create(ctx, &CreateRequest{SandboxID: "nil-pool-1"})
	require.NoError(t, err)

	assert.Equal(t, "nil-pool-1", entry.ID)
	assert.Equal(t, BootMethodCold, entry.BootMethod)
}
