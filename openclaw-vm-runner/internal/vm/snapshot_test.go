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

// snapshotCallTracker records which snapshot closures were called and allows injecting errors.
type snapshotCallTracker struct {
	pauseCalled    bool
	resumeCalled   bool
	snapshotCalled bool
	pauseErr       error
	snapshotErr    error
	resumeErr      error
}

// mockMachineFactoryWithSnapshot returns a MachineFactory that populates snapshot closures
// wired to the given tracker for assertion.
func mockMachineFactoryWithSnapshot(tracker *snapshotCallTracker) MachineFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		_, cancel := context.WithCancel(ctx)
		return &MachineEntry{
			ID:       req.SandboxID,
			State:    StateRunning,
			VMConfig: vmCfg,
			Cancel:   cancel,
			PauseVMFn: func(ctx context.Context) error {
				tracker.pauseCalled = true
				return tracker.pauseErr
			},
			ResumeVMFn: func(ctx context.Context) error {
				tracker.resumeCalled = true
				return tracker.resumeErr
			},
			CreateSnapshotFn: func(ctx context.Context, memPath, snapPath string) error {
				tracker.snapshotCalled = true
				// Create dummy files so artifact validation passes
				os.WriteFile(memPath, []byte("mock-memory"), 0644)
				os.WriteFile(snapPath, []byte("mock-state"), 0644)
				return tracker.snapshotErr
			},
		}, nil
	}
}

// mockRestoreFactory returns a SnapshotRestoreFactory that creates a mock MachineEntry.
func mockRestoreFactory() SnapshotRestoreFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig, memPath, snapPath string) (*MachineEntry, error) {
		_, cancel := context.WithCancel(ctx)
		return &MachineEntry{
			ID:       req.SandboxID,
			State:    StateRunning,
			VMConfig: vmCfg,
			Cancel:   cancel,
		}, nil
	}
}

// failingRestoreFactory returns a SnapshotRestoreFactory that always fails.
func failingRestoreFactory() SnapshotRestoreFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig, memPath, snapPath string) (*MachineEntry, error) {
		return nil, fmt.Errorf("mock restore factory failed")
	}
}

// newTestManagerWithSnapshot creates a Manager with snapshot-enabled mock factory.
func newTestManagerWithSnapshot(tracker *snapshotCallTracker) *Manager {
	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = "/boot/vmlinux"
	cfg.RootfsPath = "/rootfs/rootfs.ext4"
	cfg.SocketDir = "/tmp/test-socks"
	m := NewManager(cfg)
	m.SetMachineFactory(mockMachineFactoryWithSnapshot(tracker))
	return m
}

func TestComputeVersion_Deterministic(t *testing.T) {
	// computeVersion produces deterministic SHA256 for same rootfs content + VMConfig.
	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content-v1"), 0644))

	cfg := &VMConfig{
		VcpuCount:  2,
		MemSizeMib: 512,
		RootfsPath: rootfs,
	}

	v1, err := computeVersion(rootfs, cfg)
	require.NoError(t, err)

	v2, err := computeVersion(rootfs, cfg)
	require.NoError(t, err)

	assert.Equal(t, v1, v2, "same inputs should produce same version hash")
	assert.Len(t, v1, 64, "SHA256 hex digest should be 64 chars")
}

func TestComputeVersion_DifferentRootfs(t *testing.T) {
	// computeVersion produces different hash when rootfs content changes.
	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	cfg := &VMConfig{VcpuCount: 2, MemSizeMib: 512}

	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content-v1"), 0644))
	v1, err := computeVersion(rootfs, cfg)
	require.NoError(t, err)

	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content-v2"), 0644))
	v2, err := computeVersion(rootfs, cfg)
	require.NoError(t, err)

	assert.NotEqual(t, v1, v2, "different rootfs content should produce different hash")
}

func TestComputeVersion_DifferentConfig(t *testing.T) {
	// computeVersion produces different hash when VMConfig changes (e.g. MemSizeMib).
	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content"), 0644))

	cfg1 := &VMConfig{VcpuCount: 2, MemSizeMib: 256}
	cfg2 := &VMConfig{VcpuCount: 2, MemSizeMib: 512}

	v1, err := computeVersion(rootfs, cfg1)
	require.NoError(t, err)

	v2, err := computeVersion(rootfs, cfg2)
	require.NoError(t, err)

	assert.NotEqual(t, v1, v2, "different VMConfig should produce different hash")
}

func TestWriteMetadata_CreatesFile(t *testing.T) {
	// writeMetadata creates metadata.json in given dir with correct fields.
	dir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)

	// Create a real rootfs file for hashing.
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("test-rootfs-content"), 0644))

	artifacts := &SnapshotArtifacts{
		MemFilePath:  filepath.Join(dir, "memory.bin"),
		SnapshotPath: filepath.Join(dir, "vmstate.snap"),
		RootfsPath:   rootfs,
		Version:      "abc123def456", // pragma: allowlist secret
		CreatedAt:    now,
	}
	cfg := &VMConfig{
		VcpuCount:  2,
		MemSizeMib: 512,
		VsockCID:   42,
		RootfsPath: rootfs,
	}

	err := writeMetadata(dir, artifacts, cfg)
	require.NoError(t, err)

	// Verify file exists
	metaPath := filepath.Join(dir, metadataFilename)
	_, err = os.Stat(metaPath)
	require.NoError(t, err, "metadata.json should exist")

	// Verify contents
	data, err := os.ReadFile(metaPath)
	require.NoError(t, err)

	var meta SnapshotMetadata
	require.NoError(t, json.Unmarshal(data, &meta))

	assert.Equal(t, "abc123def456", meta.Version)
	assert.Equal(t, uint32(42), meta.VsockCID)
	assert.Equal(t, int64(512), meta.MemSizeMib)
	assert.Equal(t, int64(2), meta.VcpuCount)
	assert.NotEmpty(t, meta.RootfsHash)
	assert.NotEmpty(t, meta.ConfigHash)
}

func TestMetadata_RoundTrip(t *testing.T) {
	// readMetadata reads back what writeMetadata wrote (round-trip).
	dir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)

	// Create a rootfs file so version hashing works
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("test-rootfs"), 0644))

	artifacts := &SnapshotArtifacts{
		MemFilePath:  filepath.Join(dir, "memory.bin"),
		SnapshotPath: filepath.Join(dir, "vmstate.snap"),
		RootfsPath:   rootfs,
		Version:      "deadbeef",
		CreatedAt:    now,
	}
	cfg := &VMConfig{
		VcpuCount:  4,
		MemSizeMib: 1024,
		VsockCID:   99,
		RootfsPath: rootfs,
	}

	require.NoError(t, writeMetadata(dir, artifacts, cfg))

	meta, err := readMetadata(dir)
	require.NoError(t, err)

	assert.Equal(t, "deadbeef", meta.Version)
	assert.Equal(t, uint32(99), meta.VsockCID)
	assert.Equal(t, int64(1024), meta.MemSizeMib)
	assert.Equal(t, int64(4), meta.VcpuCount)
	assert.NotEmpty(t, meta.RootfsHash)
	assert.NotEmpty(t, meta.ConfigHash)
}

func TestReadMetadata_MissingFile(t *testing.T) {
	// readMetadata returns error for missing metadata.json.
	dir := t.TempDir()

	_, err := readMetadata(dir)
	assert.Error(t, err, "readMetadata should fail when metadata.json is missing")
}

func TestReadMetadata_CorruptedJSON(t *testing.T) {
	// readMetadata returns error for corrupted JSON.
	dir := t.TempDir()
	metaPath := filepath.Join(dir, metadataFilename)
	require.NoError(t, os.WriteFile(metaPath, []byte("{corrupted json!!!"), 0644))

	_, err := readMetadata(dir)
	assert.Error(t, err, "readMetadata should fail on corrupted JSON")
}

func TestSnapshotArtifacts_Fields(t *testing.T) {
	// SnapshotArtifacts fields are populated correctly.
	now := time.Now()
	artifacts := SnapshotArtifacts{
		MemFilePath:  "/snap/memory.bin",
		SnapshotPath: "/snap/vmstate.snap",
		RootfsPath:   "/rootfs/rootfs.ext4",
		Version:      "v1hash",
		CreatedAt:    now,
	}

	assert.Equal(t, "/snap/memory.bin", artifacts.MemFilePath)
	assert.Equal(t, "/snap/vmstate.snap", artifacts.SnapshotPath)
	assert.Equal(t, "/rootfs/rootfs.ext4", artifacts.RootfsPath)
	assert.Equal(t, "v1hash", artifacts.Version)
	assert.Equal(t, now, artifacts.CreatedAt)
}

func TestNewSnapshotter(t *testing.T) {
	// NewSnapshotter creates a Snapshotter with the given Manager and baseDir.
	cfg := &VMConfig{}
	_ = cfg // prevent unused

	mgr := &Manager{}
	s := NewSnapshotter(mgr, "/var/snapshots", nil)
	assert.NotNil(t, s)
}

// --- Snapshotter.Create tests ---

func TestSnapshotter_Create(t *testing.T) {
	// Create pauses VM, calls CreateSnapshotFn with correct paths, writes metadata.json, returns SnapshotArtifacts with version.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	// Create a sandbox
	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-create-1", VcpuCount: 2, MemSizeMib: 256})
	require.NoError(t, err)

	// Create rootfs file for version hashing
	dir := t.TempDir()
	rootfsPath := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfsPath, []byte("test-rootfs-content"), 0644))

	// Point the entry's VMConfig.RootfsPath to the real rootfs
	entry, _ := mgr.Get("snap-create-1")
	entry.VMConfig.RootfsPath = rootfsPath

	snapDir := filepath.Join(dir, "snapshot-output")
	s := NewSnapshotter(mgr, dir, nil)

	artifacts, err := s.Create(ctx, "snap-create-1", snapDir, true)
	require.NoError(t, err)

	assert.True(t, tracker.pauseCalled, "PauseVM should be called")
	assert.True(t, tracker.snapshotCalled, "CreateSnapshot should be called")
	assert.True(t, tracker.resumeCalled, "ResumeVM should be called when resume=true")

	assert.Equal(t, filepath.Join(snapDir, "memory.bin"), artifacts.MemFilePath)
	assert.Equal(t, filepath.Join(snapDir, "vmstate.snap"), artifacts.SnapshotPath)
	assert.NotEmpty(t, artifacts.Version, "version hash should be set")
	assert.Len(t, artifacts.Version, 64, "SHA256 hex digest should be 64 chars")

	// Verify metadata.json was written
	meta, err := readMetadata(snapDir)
	require.NoError(t, err)
	assert.Equal(t, artifacts.Version, meta.Version)
}

func TestSnapshotter_Create_Resume(t *testing.T) {
	// Create with resume=true resumes VM after snapshot.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-resume"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-resume")
	entry.VMConfig.RootfsPath = rootfs

	s := NewSnapshotter(mgr, dir, nil)
	_, err = s.Create(ctx, "snap-resume", filepath.Join(dir, "out"), true)
	require.NoError(t, err)

	assert.True(t, tracker.resumeCalled, "ResumeVM should be called when resume=true")
}

func TestSnapshotter_Create_NoResume(t *testing.T) {
	// Create with resume=false does NOT resume VM.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-noresume"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-noresume")
	entry.VMConfig.RootfsPath = rootfs

	s := NewSnapshotter(mgr, dir, nil)
	_, err = s.Create(ctx, "snap-noresume", filepath.Join(dir, "out"), false)
	require.NoError(t, err)

	assert.False(t, tracker.resumeCalled, "ResumeVM should NOT be called when resume=false")
}

func TestSnapshotter_Create_PauseFails(t *testing.T) {
	// Create returns error when PauseVMFn fails and does NOT call CreateSnapshotFn.
	tracker := &snapshotCallTracker{pauseErr: fmt.Errorf("pause failed")}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-pause-fail"})
	require.NoError(t, err)

	dir := t.TempDir()
	s := NewSnapshotter(mgr, dir, nil)
	_, err = s.Create(ctx, "snap-pause-fail", filepath.Join(dir, "out"), true)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "pause")
	assert.False(t, tracker.snapshotCalled, "CreateSnapshot should NOT be called when Pause fails")
}

func TestSnapshotter_Create_SnapshotFails(t *testing.T) {
	// Create resumes VM on CreateSnapshotFn failure (best-effort recovery).
	tracker := &snapshotCallTracker{snapshotErr: fmt.Errorf("snapshot failed")}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-snap-fail"})
	require.NoError(t, err)

	dir := t.TempDir()
	s := NewSnapshotter(mgr, dir, nil)
	_, err = s.Create(ctx, "snap-snap-fail", filepath.Join(dir, "out"), true)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "snapshot")
	assert.True(t, tracker.resumeCalled, "ResumeVM should be called on CreateSnapshot failure (best-effort recovery)")
}

func TestSnapshotter_Create_SandboxNotFound(t *testing.T) {
	// Create returns error when sandbox not found in Manager.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	dir := t.TempDir()
	s := NewSnapshotter(mgr, dir, nil)
	_, err := s.Create(ctx, "nonexistent-sandbox", filepath.Join(dir, "out"), true)

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

// --- Snapshotter.Restore tests ---

func TestSnapshotter_Restore(t *testing.T) {
	// Restore reads metadata, calls restoreFactory, registers entry in Manager.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	// Create a sandbox and take a snapshot first
	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-orig"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-orig")
	entry.VMConfig.RootfsPath = rootfs

	snapDir := filepath.Join(dir, "snapshot")
	s := NewSnapshotter(mgr, dir, mockRestoreFactory())
	_, err = s.Create(ctx, "snap-orig", snapDir, false)
	require.NoError(t, err)

	// Restore from snapshot
	restored, err := s.Restore(ctx, snapDir, "snap-restored", 100)
	require.NoError(t, err)

	assert.Equal(t, "snap-restored", restored.ID)
	assert.Equal(t, StateRunning, restored.State)

	// Should be retrievable via Manager.Get
	got, err := mgr.Get("snap-restored")
	require.NoError(t, err)
	assert.Equal(t, "snap-restored", got.ID)
}

func TestSnapshotter_Restore_MissingArtifacts(t *testing.T) {
	// Restore returns error when metadata.json missing.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	dir := t.TempDir()
	s := NewSnapshotter(mgr, dir, mockRestoreFactory())

	_, err := s.Restore(ctx, dir, "snap-missing", 100)
	assert.Error(t, err, "Restore should fail when metadata.json is missing")
}

func TestSnapshotter_Restore_FactoryFails(t *testing.T) {
	// Restore returns error when restoreFactory fails.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	// Create a snapshot so metadata exists
	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-ff-orig"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-ff-orig")
	entry.VMConfig.RootfsPath = rootfs

	snapDir := filepath.Join(dir, "snapshot")
	s := NewSnapshotter(mgr, dir, nil)
	_, err = s.Create(ctx, "snap-ff-orig", snapDir, false)
	require.NoError(t, err)

	// Now try to restore with failing factory
	s2 := NewSnapshotter(mgr, dir, failingRestoreFactory())
	_, err = s2.Restore(ctx, snapDir, "snap-ff-restored", 100)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "restore")
}

func TestSnapshotter_Restore_NewCID(t *testing.T) {
	// Restore entry has correct newSandboxID and newCID.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-cid-orig"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-cid-orig")
	entry.VMConfig.RootfsPath = rootfs

	snapDir := filepath.Join(dir, "snapshot")
	s := NewSnapshotter(mgr, dir, mockRestoreFactory())
	_, err = s.Create(ctx, "snap-cid-orig", snapDir, false)
	require.NoError(t, err)

	restored, err := s.Restore(ctx, snapDir, "new-sandbox-id", 42)
	require.NoError(t, err)

	assert.Equal(t, "new-sandbox-id", restored.ID)
	assert.Equal(t, uint32(42), restored.VMConfig.VsockCID)
}

func TestSnapshotter_Restore_GetAfterRegister(t *testing.T) {
	// Restore entry is retrievable via Manager.Get after registration.
	tracker := &snapshotCallTracker{}
	mgr := newTestManagerWithSnapshot(tracker)
	ctx := context.Background()

	_, err := mgr.Create(ctx, &CreateRequest{SandboxID: "snap-get-orig"})
	require.NoError(t, err)

	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs"), 0644))
	entry, _ := mgr.Get("snap-get-orig")
	entry.VMConfig.RootfsPath = rootfs

	snapDir := filepath.Join(dir, "snapshot")
	s := NewSnapshotter(mgr, dir, mockRestoreFactory())
	_, err = s.Create(ctx, "snap-get-orig", snapDir, false)
	require.NoError(t, err)

	_, err = s.Restore(ctx, snapDir, "snap-registered", 77)
	require.NoError(t, err)

	got, err := mgr.Get("snap-registered")
	require.NoError(t, err)
	assert.Equal(t, "snap-registered", got.ID)
}

// --- Manager.Register tests ---

func TestManager_Register(t *testing.T) {
	// Register adds an externally-created MachineEntry.
	mgr := newTestManager()

	entry := &MachineEntry{
		ID:    "registered-sandbox",
		State: StateRunning,
	}
	err := mgr.Register(entry)
	require.NoError(t, err)

	got, err := mgr.Get("registered-sandbox")
	require.NoError(t, err)
	assert.Equal(t, "registered-sandbox", got.ID)
}

func TestManager_Register_DuplicateRejects(t *testing.T) {
	// Register rejects duplicate sandboxID.
	mgr := newTestManager()

	entry := &MachineEntry{ID: "dup-reg", State: StateRunning}
	require.NoError(t, mgr.Register(entry))

	entry2 := &MachineEntry{ID: "dup-reg", State: StateRunning}
	err := mgr.Register(entry2)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}
