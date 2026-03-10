package vm

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/openclaw/vm-runner/internal/config"
)

// snapshotAcquireTimeout is the maximum time to wait for a pre-warmed snapshot
// from the pool before falling back to cold boot.
const snapshotAcquireTimeout = 50 * time.Millisecond

// CreateRequest contains the parameters for creating a new sandbox VM.
type CreateRequest struct {
	// SandboxID is the unique identifier for the sandbox.
	SandboxID string

	// VcpuCount is the number of virtual CPUs (0 uses default).
	VcpuCount uint32

	// MemSizeMib is the memory allocation in MiB (0 uses default).
	MemSizeMib uint32

	// KernelImagePath overrides the service-level kernel path (empty uses default).
	KernelImagePath string

	// RootfsPath overrides the service-level rootfs path (empty uses default).
	RootfsPath string
}

// MachineFactory is a function type that creates a MachineEntry from a request
// and VM configuration. It can be swapped for testing to avoid requiring real
// Firecracker/KVM. The production factory (on Linux) calls firecracker.NewMachine.
type MachineFactory func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error)

// Manager manages a pool of Firecracker MicroVMs indexed by sandbox ID.
// It provides thread-safe Create, Destroy, Get, and List operations.
// When a Pool and Snapshotter are configured (via SetPool), Create() attempts
// snapshot-first restore before falling back to cold boot.
type Manager struct {
	mu         sync.RWMutex
	machines   map[string]*MachineEntry
	cidCounter uint32 // atomic; starts at 2 so first nextCID returns 3

	cfg         *config.ServiceConfig
	factory     MachineFactory
	pool        *Pool
	snapshotter *Snapshotter
	logger      *slog.Logger
}

// NewManager creates a new Manager with the given service configuration.
// The CID counter starts at 2, so the first allocated CID is 3 (0, 1, 2 are reserved).
func NewManager(cfg *config.ServiceConfig) *Manager {
	return &Manager{
		machines:   make(map[string]*MachineEntry),
		cidCounter: 2,
		cfg:        cfg,
	}
}

// SetMachineFactory sets the factory function used to create MachineEntry instances.
// This is the primary injection point for testing.
func (m *Manager) SetMachineFactory(f MachineFactory) {
	m.factory = f
}

// SetPool configures the snapshot pool and snapshotter for snapshot-first Create.
// When set, Create() attempts to acquire a pre-warmed snapshot before falling back
// to cold boot. Pass nil to disable the snapshot path.
func (m *Manager) SetPool(pool *Pool, snapshotter *Snapshotter) {
	m.pool = pool
	m.snapshotter = snapshotter
}

// SetLogger sets the structured logger for the Manager.
func (m *Manager) SetLogger(logger *slog.Logger) {
	m.logger = logger
}

// log returns the manager's logger, falling back to slog.Default() if nil.
func (m *Manager) log() *slog.Logger {
	if m.logger != nil {
		return m.logger
	}
	return slog.Default()
}

// nextCID atomically increments and returns the next unique Context ID for vsock.
func (m *Manager) nextCID() uint32 {
	return atomic.AddUint32(&m.cidCounter, 1)
}

// lastAssignedCID returns the most recently assigned CID (for testing).
func (m *Manager) lastAssignedCID() uint32 {
	return atomic.LoadUint32(&m.cidCounter)
}

// Create builds a VM configuration and creates a new sandbox. When a Pool and
// Snapshotter are configured, it first attempts to acquire a pre-warmed snapshot
// (with a 50ms timeout) and restore it. If snapshot acquisition or restore fails,
// it falls back to cold boot via the MachineFactory.
// Returns an error if a sandbox with the same ID already exists.
func (m *Manager) Create(ctx context.Context, req *CreateRequest) (*MachineEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.machines[req.SandboxID]; exists {
		return nil, fmt.Errorf("sandbox %s already exists", req.SandboxID)
	}

	// Try snapshot-first path if pool and snapshotter are configured
	if m.pool != nil && m.snapshotter != nil {
		entry, err := m.trySnapshotRestore(ctx, req)
		if err == nil {
			entry.CreatedAt = time.Now()
			entry.BootMethod = BootMethodSnapshot
			m.machines[req.SandboxID] = entry
			return entry, nil
		}
		m.log().Warn("snapshot restore failed, falling back to cold boot",
			"sandboxID", req.SandboxID, "error", err)
	}

	// Cold boot path
	return m.createColdLocked(ctx, req)
}

// trySnapshotRestore attempts to acquire a snapshot from the pool and restore it.
// Must be called with m.mu held. Returns the restored entry or an error.
func (m *Manager) trySnapshotRestore(ctx context.Context, req *CreateRequest) (*MachineEntry, error) {
	acquireCtx, cancel := context.WithTimeout(ctx, snapshotAcquireTimeout)
	defer cancel()

	snapDir, release, err := m.pool.Acquire(acquireCtx)
	if err != nil {
		return nil, fmt.Errorf("pool acquire: %w", err)
	}
	defer release()

	cid := m.nextCID()
	entry, err := m.snapshotter.RestoreEntry(ctx, snapDir, req.SandboxID, cid)
	if err != nil {
		return nil, fmt.Errorf("restore entry: %w", err)
	}

	return entry, nil
}

// createColdLocked performs cold boot via MachineFactory. Must be called with m.mu held.
func (m *Manager) createColdLocked(ctx context.Context, req *CreateRequest) (*MachineEntry, error) {
	kernelPath := m.cfg.KernelPath
	if req.KernelImagePath != "" {
		kernelPath = req.KernelImagePath
	}
	rootfsPath := m.cfg.RootfsPath
	if req.RootfsPath != "" {
		rootfsPath = req.RootfsPath
	}

	cid := m.nextCID()
	vmCfg := buildConfig(kernelPath, rootfsPath, m.cfg.SocketDir, req.SandboxID, req.VcpuCount, req.MemSizeMib, cid)

	if m.factory == nil {
		return nil, fmt.Errorf("no MachineFactory configured")
	}

	entry, err := m.factory(ctx, req, vmCfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create machine for sandbox %s: %w", req.SandboxID, err)
	}

	entry.CreatedAt = time.Now()
	entry.VMConfig = vmCfg
	entry.BootMethod = BootMethodCold
	m.machines[req.SandboxID] = entry

	return entry, nil
}

// CreateCold creates a new sandbox using cold boot only, bypassing the snapshot pool.
// This is used by the Pool's createVM callback to avoid infinite recursion
// (Pool.createVM -> Manager.Create -> Pool.Acquire -> ...).
func (m *Manager) CreateCold(ctx context.Context, req *CreateRequest) (*MachineEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.machines[req.SandboxID]; exists {
		return nil, fmt.Errorf("sandbox %s already exists", req.SandboxID)
	}

	return m.createColdLocked(ctx, req)
}

// Destroy shuts down and removes a sandbox by ID.
// Returns an error if the sandbox is not found.
func (m *Manager) Destroy(ctx context.Context, sandboxID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry, exists := m.machines[sandboxID]
	if !exists {
		return fmt.Errorf("sandbox %s not found", sandboxID)
	}

	// Attempt graceful shutdown, fall back to force stop
	if err := entry.Shutdown(ctx); err != nil {
		_ = entry.Stop()
	}

	// Cancel the machine context
	if entry.Cancel != nil {
		entry.Cancel()
	}

	// Clean up the socket file
	if entry.VMConfig != nil {
		os.Remove(entry.VMConfig.SocketPath)
	}

	delete(m.machines, sandboxID)
	return nil
}

// Get returns a MachineEntry by sandbox ID.
// Returns an error if not found.
func (m *Manager) Get(sandboxID string) (*MachineEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entry, exists := m.machines[sandboxID]
	if !exists {
		return nil, fmt.Errorf("sandbox %s not found", sandboxID)
	}
	return entry, nil
}

// List returns all MachineEntries currently managed.
func (m *Manager) List() []*MachineEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entries := make([]*MachineEntry, 0, len(m.machines))
	for _, entry := range m.machines {
		entries = append(entries, entry)
	}
	return entries
}

// Register adds an externally-created MachineEntry to the manager.
// Used by Snapshotter.Restore to register restored VMs.
// Returns error if sandboxID already exists.
func (m *Manager) Register(entry *MachineEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.machines[entry.ID]; exists {
		return fmt.Errorf("sandbox %s already exists", entry.ID)
	}
	m.machines[entry.ID] = entry
	return nil
}

// Config returns the service configuration used by this Manager.
func (m *Manager) Config() *config.ServiceConfig {
	return m.cfg
}

// Cleanup destroys all managed sandboxes (graceful shutdown).
func (m *Manager) Cleanup(ctx context.Context) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.machines))
	for id := range m.machines {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		_ = m.Destroy(ctx, id)
	}
}
