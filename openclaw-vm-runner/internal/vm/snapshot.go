package vm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// metadataFilename is the name of the snapshot metadata file written alongside artifacts.
const metadataFilename = "metadata.json"

// SnapshotArtifacts holds the paths and metadata for a VM snapshot.
type SnapshotArtifacts struct {
	// MemFilePath is the path to the memory dump file (memory.bin).
	MemFilePath string

	// SnapshotPath is the path to the VM state file (vmstate.snap).
	SnapshotPath string

	// RootfsPath is the path to the original rootfs image (managed separately).
	RootfsPath string

	// Version is the SHA256 hash of rootfs content + VMConfig for cache invalidation.
	Version string

	// CreatedAt is the timestamp when the snapshot was created.
	CreatedAt time.Time
}

// SnapshotMetadata is the JSON-serializable metadata written alongside snapshot artifacts.
type SnapshotMetadata struct {
	Version    string    `json:"version"`
	RootfsHash string    `json:"rootfs_hash"`
	ConfigHash string    `json:"config_hash"`
	CreatedAt  time.Time `json:"created_at"`
	VsockCID   uint32    `json:"vsock_cid"`
	MemSizeMib int64     `json:"mem_size_mib"`
	VcpuCount  int64     `json:"vcpu_count"`
}

// SnapshotRestoreFactory creates a MachineEntry from snapshot artifacts.
// On Linux, this uses firecracker.NewMachine with WithSnapshot option.
// For testing, a mock can be injected.
type SnapshotRestoreFactory func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig, memPath, snapPath string) (*MachineEntry, error)

// Snapshotter manages snapshot create/restore operations for VMs.
type Snapshotter struct {
	mgr            *Manager
	baseDir        string
	restoreFactory SnapshotRestoreFactory
}

// NewSnapshotter creates a new Snapshotter that uses the given Manager, stores
// snapshots under baseDir, and uses rf to restore VMs from snapshot artifacts.
func NewSnapshotter(mgr *Manager, baseDir string, rf SnapshotRestoreFactory) *Snapshotter {
	return &Snapshotter{
		mgr:            mgr,
		baseDir:        baseDir,
		restoreFactory: rf,
	}
}

// Create captures a running VM's state to disk.
// It pauses the VM, creates snapshot artifacts (memory + vmstate), computes a version
// hash, writes metadata.json, and optionally resumes the VM.
// On CreateSnapshot failure, the VM is resumed best-effort before returning the error.
func (s *Snapshotter) Create(ctx context.Context, sandboxID string, dir string, resume bool) (*SnapshotArtifacts, error) {
	// 1. Get entry from manager
	entry, err := s.mgr.Get(sandboxID)
	if err != nil {
		return nil, fmt.Errorf("sandbox %s not found: %w", sandboxID, err)
	}

	// 2. Ensure output directory exists
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create snapshot directory: %w", err)
	}

	// 3. Build artifact paths
	memPath := filepath.Join(dir, "memory.bin")
	snapPath := filepath.Join(dir, "vmstate.snap")

	// 4. Pause VM
	if err := entry.PauseVM(ctx); err != nil {
		return nil, fmt.Errorf("failed to pause VM %s: %w", sandboxID, err)
	}

	// 5. Create snapshot
	if err := entry.CreateSnapshot(ctx, memPath, snapPath); err != nil {
		_ = entry.ResumeVM(ctx) // best-effort recovery
		return nil, fmt.Errorf("failed to create snapshot for %s: %w", sandboxID, err)
	}

	// 6. Resume if requested
	if resume {
		if err := entry.ResumeVM(ctx); err != nil {
			return nil, fmt.Errorf("failed to resume VM %s after snapshot: %w", sandboxID, err)
		}
	}

	// 7. Compute version hash
	version, err := computeVersion(entry.VMConfig.RootfsPath, entry.VMConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to compute snapshot version: %w", err)
	}

	// 8. Build SnapshotArtifacts
	artifacts := &SnapshotArtifacts{
		MemFilePath:  memPath,
		SnapshotPath: snapPath,
		RootfsPath:   entry.VMConfig.RootfsPath,
		Version:      version,
		CreatedAt:    time.Now(),
	}

	// 9. Write metadata
	if err := writeMetadata(dir, artifacts, entry.VMConfig); err != nil {
		return nil, fmt.Errorf("failed to write snapshot metadata: %w", err)
	}

	return artifacts, nil
}

// RestoreEntry recreates a VM from snapshot artifacts with a new identity WITHOUT
// registering it in the Manager. This is used by Manager.Create() to avoid deadlock:
// Manager.Create holds m.mu and inserts the entry into m.machines directly.
// Callers that do NOT hold the Manager lock should use Restore() instead.
func (s *Snapshotter) RestoreEntry(ctx context.Context, dir string, newSandboxID string, newCID uint32) (*MachineEntry, error) {
	// 1. Read metadata
	meta, err := readMetadata(dir)
	if err != nil {
		return nil, fmt.Errorf("failed to read snapshot metadata: %w", err)
	}

	// 2. Validate metadata ranges to prevent negative values wrapping to huge uint32.
	if meta.VcpuCount < 1 || meta.VcpuCount > 32 {
		return nil, fmt.Errorf("invalid snapshot metadata: vcpu_count %d out of range [1, 32]", meta.VcpuCount)
	}
	if meta.MemSizeMib < 128 || meta.MemSizeMib > 65536 {
		return nil, fmt.Errorf("invalid snapshot metadata: mem_size_mib %d out of range [128, 65536]", meta.MemSizeMib)
	}

	// 3. Build artifact paths
	memPath := filepath.Join(dir, "memory.bin")
	snapPath := filepath.Join(dir, "vmstate.snap")

	// 4. Validate artifact files exist
	if _, err := os.Stat(memPath); err != nil {
		return nil, fmt.Errorf("snapshot memory file missing: %w", err)
	}
	if _, err := os.Stat(snapPath); err != nil {
		return nil, fmt.Errorf("snapshot vmstate file missing: %w", err)
	}

	// 5. Build CreateRequest and VMConfig for the restore factory
	mgrCfg := s.mgr.Config()
	req := &CreateRequest{
		SandboxID:  newSandboxID,
		VcpuCount:  uint32(meta.VcpuCount),
		MemSizeMib: uint32(meta.MemSizeMib),
	}
	vmCfg := &VMConfig{
		SocketPath:      filepath.Join(mgrCfg.SocketDir, newSandboxID+".sock"),
		KernelImagePath: mgrCfg.KernelPath,
		KernelArgs:      DefaultKernelArgs,
		RootfsPath:      mgrCfg.RootfsPath,
		VcpuCount:       meta.VcpuCount,
		MemSizeMib:      meta.MemSizeMib,
		VsockCID:        newCID,
		VsockPath:       filepath.Join(mgrCfg.SocketDir, newSandboxID+"-vsock.sock"),
	}

	// 6. Call restore factory
	entry, err := s.restoreFactory(ctx, req, vmCfg, memPath, snapPath)
	if err != nil {
		return nil, fmt.Errorf("failed to restore VM %s: %w", newSandboxID, err)
	}

	return entry, nil
}

// Restore recreates a VM from snapshot artifacts with a new identity.
// It calls RestoreEntry to create the MachineEntry, then registers it in the Manager.
func (s *Snapshotter) Restore(ctx context.Context, dir string, newSandboxID string, newCID uint32) (*MachineEntry, error) {
	entry, err := s.RestoreEntry(ctx, dir, newSandboxID, newCID)
	if err != nil {
		return nil, err
	}

	// Register in manager
	if err := s.mgr.Register(entry); err != nil {
		// cleanup: try to stop the restored VM
		if entry.StopFn != nil {
			_ = entry.StopFn()
		}
		if entry.Cancel != nil {
			entry.Cancel()
		}
		return nil, fmt.Errorf("failed to register restored VM %s: %w", newSandboxID, err)
	}

	return entry, nil
}

// computeVersion produces a deterministic SHA256 hash from the rootfs file content
// and the VMConfig JSON. This enables snapshot version invalidation when either
// the rootfs or the VM configuration changes.
func computeVersion(rootfsPath string, cfg *VMConfig) (string, error) {
	h := sha256.New()

	// Hash rootfs file content via streaming.
	f, err := os.Open(rootfsPath)
	if err != nil {
		return "", fmt.Errorf("open rootfs for hashing: %w", err)
	}
	defer f.Close()

	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash rootfs content: %w", err)
	}

	// Hash VMConfig as deterministic JSON.
	cfgBytes, err := json.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("marshal VMConfig for hashing: %w", err)
	}
	h.Write(cfgBytes)

	return hex.EncodeToString(h.Sum(nil)), nil
}

// hashBytes returns the hex-encoded SHA256 of the given byte slice.
func hashBytes(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// hashFile returns the hex-encoded SHA256 of the file at path using streaming
// I/O to avoid loading the entire file into memory.
func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// writeMetadata writes a metadata.json file into dir containing snapshot metadata
// derived from the artifacts and VMConfig.
func writeMetadata(dir string, artifacts *SnapshotArtifacts, cfg *VMConfig) error {
	// Compute rootfs hash using streaming I/O to avoid loading entire rootfs into memory.
	rootfsHash, err := hashFile(cfg.RootfsPath)
	if err != nil {
		// If rootfs is not at cfg.RootfsPath, try artifacts.RootfsPath.
		rootfsHash, err = hashFile(artifacts.RootfsPath)
		if err != nil {
			return fmt.Errorf("hash rootfs for metadata: %w", err)
		}
	}

	// Compute config hash.
	cfgBytes, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal VMConfig for metadata: %w", err)
	}
	configHash := hashBytes(cfgBytes)

	meta := SnapshotMetadata{
		Version:    artifacts.Version,
		RootfsHash: rootfsHash,
		ConfigHash: configHash,
		CreatedAt:  artifacts.CreatedAt,
		VsockCID:   cfg.VsockCID,
		MemSizeMib: cfg.MemSizeMib,
		VcpuCount:  cfg.VcpuCount,
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata JSON: %w", err)
	}

	metaPath := filepath.Join(dir, metadataFilename)
	if err := os.WriteFile(metaPath, data, 0644); err != nil {
		return fmt.Errorf("write metadata file: %w", err)
	}

	return nil
}

// readMetadata reads and unmarshals the metadata.json file from dir.
func readMetadata(dir string) (*SnapshotMetadata, error) {
	metaPath := filepath.Join(dir, metadataFilename)

	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("read metadata file: %w", err)
	}

	var meta SnapshotMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("unmarshal metadata JSON: %w", err)
	}

	return &meta, nil
}
