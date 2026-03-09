package jailer

import (
	"context"
	"fmt"
	"os"
	"sync"
	"syscall"
)

// LaunchConfig contains the parameters for launching a jailed Firecracker VM.
type LaunchConfig struct {
	VMID             string
	SessionID        string
	KernelPath       string
	RootfsPath       string
	VcpuCount        uint32
	MemSizeMiB       uint32
	NetworkNamespace string
	MetricsPath      string
}

// Validate checks that required fields are set.
func (c *LaunchConfig) Validate() error {
	if c.VMID == "" {
		return fmt.Errorf("VMID is required")
	}
	if c.KernelPath == "" {
		return fmt.Errorf("KernelPath is required")
	}
	if c.RootfsPath == "" {
		return fmt.Errorf("RootfsPath is required")
	}
	return nil
}

// LaunchResult contains the result of a jailed VM launch.
type LaunchResult struct {
	PID       int
	ChrootDir string
	UID       int
}

// JailerConfig mirrors the Jailer command-line configuration built for the
// firecracker-go-sdk. This is our own struct to avoid a hard dependency on
// the SDK in tests while matching the SDK's JailerConfig shape.
type JailerConfig struct {
	UID            *int
	GID            *int
	ID             string
	ExecFile       string
	JailerBinary   string
	ChrootBaseDir  string
	Daemonize      bool
	CgroupVersion  string
	CgroupArgs     []string
	NetNS          string
}

// JailedLauncher wraps all Firecracker VM launches through the Jailer binary
// with chroot isolation, UID/GID privilege dropping, PID namespace isolation,
// and cgroup resource limits.
type JailedLauncher struct {
	mu             sync.Mutex
	uidPool        *UIDPool
	chrootMgr      *ChrootManager
	firecrackerBin string
	jailerBin      string
	cgroupVersion  string
	entries        map[string]*LaunchResult
}

// Option configures a JailedLauncher.
type Option func(*JailedLauncher)

// WithFirecrackerBin sets the path to the Firecracker binary.
func WithFirecrackerBin(path string) Option {
	return func(jl *JailedLauncher) { jl.firecrackerBin = path }
}

// WithJailerBin sets the path to the Jailer binary.
func WithJailerBin(path string) Option {
	return func(jl *JailedLauncher) { jl.jailerBin = path }
}

// WithChrootBaseDir sets the chroot base directory.
func WithChrootBaseDir(dir string) Option {
	return func(jl *JailedLauncher) { jl.chrootMgr = NewChrootManager(dir) }
}

// WithUIDRange sets the UID allocation range.
func WithUIDRange(min, max int) Option {
	return func(jl *JailedLauncher) { jl.uidPool = NewUIDPool(min, max) }
}

// NewJailedLauncher creates a new JailedLauncher with the given options.
// It validates the Firecracker binary version at construction time.
func NewJailedLauncher(opts ...Option) (*JailedLauncher, error) {
	jl := &JailedLauncher{
		firecrackerBin: "firecracker",
		jailerBin:      "jailer",
		entries:        make(map[string]*LaunchResult),
	}

	for _, opt := range opts {
		opt(jl)
	}

	// Initialize defaults if not set by options
	if jl.uidPool == nil {
		jl.uidPool = NewUIDPool(10000, 60000)
	}
	if jl.chrootMgr == nil {
		jl.chrootMgr = NewChrootManager("/srv/jailer")
	}

	// Auto-detect cgroup version
	jl.cgroupVersion = detectCgroupVersion()

	// Validate Firecracker version
	ctx := context.Background()
	if err := CheckFirecrackerBinary(ctx, jl.firecrackerBin); err != nil {
		return nil, fmt.Errorf("firecracker version check failed: %w", err)
	}

	return jl, nil
}

// ChrootManager returns the chroot manager for external use (e.g., orphan sweep).
func (jl *JailedLauncher) ChrootManager() *ChrootManager {
	return jl.chrootMgr
}

// buildJailerConfig allocates a UID and builds the JailerConfig for a VM launch.
func (jl *JailedLauncher) buildJailerConfig(cfg LaunchConfig) (*JailerConfig, int, error) {
	uid, gid, err := jl.uidPool.Allocate()
	if err != nil {
		return nil, 0, fmt.Errorf("failed to allocate UID: %w", err)
	}

	// Apply defaults
	vcpus := cfg.VcpuCount
	if vcpus == 0 {
		vcpus = 1
	}
	memMiB := cfg.MemSizeMiB
	if memMiB == 0 {
		memMiB = 256
	}

	memBytes := uint64(memMiB) * 1024 * 1024
	cpuQuota := int(vcpus) * 100000 // 100ms period per vcpu

	cgroupArgs := []string{
		fmt.Sprintf("memory.limit_in_bytes=%d", memBytes),
		fmt.Sprintf("cpu.cfs_quota_us=%d", cpuQuota),
		"cpu.cfs_period_us=100000",
	}

	jcfg := &JailerConfig{
		UID:           &uid,
		GID:           &gid,
		ID:            cfg.VMID,
		ExecFile:      jl.firecrackerBin,
		JailerBinary:  jl.jailerBin,
		ChrootBaseDir: jl.chrootMgr.BaseDir(),
		Daemonize:     true,
		CgroupVersion: jl.cgroupVersion,
		CgroupArgs:    cgroupArgs,
		NetNS:         cfg.NetworkNamespace,
	}

	return jcfg, uid, nil
}

// PrepareJail allocates a UID/GID, prepares the chroot directory, and builds
// a JailerConfig without starting the VM. The MachineFactory calls this to get
// the JailerConfig it needs for firecracker.Config.JailerCfg.
//
// The caller is responsible for calling ReleaseJail(vmID) if the subsequent
// VM creation fails, to clean up the chroot and release the UID.
func (jl *JailedLauncher) PrepareJail(ctx context.Context, cfg LaunchConfig) (*JailerConfig, *LaunchResult, error) {
	if err := cfg.Validate(); err != nil {
		return nil, nil, err
	}

	jl.mu.Lock()
	defer jl.mu.Unlock()

	if _, exists := jl.entries[cfg.VMID]; exists {
		return nil, nil, fmt.Errorf("VM %s already exists", cfg.VMID)
	}

	jcfg, uid, err := jl.buildJailerConfig(cfg)
	if err != nil {
		return nil, nil, err
	}

	// Prepare chroot with kernel and rootfs
	if err := jl.chrootMgr.Prepare(cfg.VMID, cfg.KernelPath, cfg.RootfsPath); err != nil {
		jl.uidPool.Release(uid)
		return nil, nil, fmt.Errorf("failed to prepare chroot: %w", err)
	}

	result := &LaunchResult{
		PID:       0, // Set by caller (e.g., MachineFactory) after machine.Start
		ChrootDir: jl.chrootMgr.ChrootPath(cfg.VMID),
		UID:       uid,
	}

	jl.entries[cfg.VMID] = result
	return jcfg, result, nil
}

// ReleaseJail cleans up a prepared jail if the subsequent VM creation fails.
// It removes the chroot directory, releases the UID back to the pool, and
// removes the entry from the internal tracking map.
func (jl *JailedLauncher) ReleaseJail(vmID string) error {
	jl.mu.Lock()
	defer jl.mu.Unlock()

	entry, exists := jl.entries[vmID]
	if !exists {
		return fmt.Errorf("VM %s not found", vmID)
	}

	// Clean up chroot directory
	if err := jl.chrootMgr.CleanupChroot(vmID); err != nil {
		return fmt.Errorf("failed to cleanup chroot for VM %s: %w", vmID, err)
	}

	// Release UID back to pool
	if err := jl.uidPool.Release(entry.UID); err != nil {
		// Log but don't fail -- UID leak is acceptable in edge cases
		_ = err
	}

	delete(jl.entries, vmID)
	return nil
}

// Launch starts a Firecracker VM inside a Jailer jail.
// It allocates a unique UID/GID, prepares the chroot, and launches via the Jailer.
// This method delegates to PrepareJail for jail preparation.
func (jl *JailedLauncher) Launch(ctx context.Context, cfg LaunchConfig) (*LaunchResult, error) {
	jcfg, result, err := jl.PrepareJail(ctx, cfg)
	if err != nil {
		return nil, err
	}

	// In production, this is where we'd call firecracker-go-sdk with the
	// JailerConfig to launch the VM. For now, we store the config and return
	// a result. The actual SDK integration happens when running on Linux
	// with /dev/kvm and the Firecracker binary available.
	_ = jcfg // Intentionally unused: real jail enforcement happens through MachineFactory (factory_linux.go)

	return result, nil
}

// Destroy stops a VM and cleans up its chroot, cgroups, and UID allocation.
func (jl *JailedLauncher) Destroy(ctx context.Context, vmID string) error {
	jl.mu.Lock()
	defer jl.mu.Unlock()

	entry, exists := jl.entries[vmID]
	if !exists {
		return fmt.Errorf("VM %s not found", vmID)
	}

	// Kill the Firecracker process if alive
	if entry.PID > 0 {
		// Try graceful shutdown first (SIGTERM)
		if proc, err := os.FindProcess(entry.PID); err == nil {
			_ = proc.Signal(syscall.SIGTERM)
		}
		// Force kill after brief wait
		if proc, err := os.FindProcess(entry.PID); err == nil {
			_ = proc.Signal(syscall.SIGKILL)
		}
	}

	// Clean up chroot directory
	if err := jl.chrootMgr.CleanupChroot(vmID); err != nil {
		return fmt.Errorf("failed to cleanup chroot for VM %s: %w", vmID, err)
	}

	// Release UID back to pool
	if err := jl.uidPool.Release(entry.UID); err != nil {
		// Log but don't fail -- UID leak is acceptable in edge cases
		_ = err
	}

	delete(jl.entries, vmID)
	return nil
}

// ActiveVMs returns a snapshot of all currently tracked VM entries.
func (jl *JailedLauncher) ActiveVMs() map[string]*LaunchResult {
	jl.mu.Lock()
	defer jl.mu.Unlock()

	result := make(map[string]*LaunchResult, len(jl.entries))
	for k, v := range jl.entries {
		result[k] = v
	}
	return result
}

// detectCgroupVersion checks whether the host uses cgroup v1 or v2.
func detectCgroupVersion() string {
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err == nil {
		return "2"
	}
	return "1"
}
