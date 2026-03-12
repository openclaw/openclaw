// Package config provides service-level configuration for the vm-runner.
package config

// ServiceConfig holds configuration for the vm-runner service.
type ServiceConfig struct {
	// SocketPath is the path where the gRPC Unix socket is created.
	SocketPath string

	// KernelPath is the path to the uncompressed Linux kernel ELF image.
	KernelPath string

	// RootfsPath is the path to the ext4 rootfs image.
	RootfsPath string

	// FirecrackerBin is the path to the Firecracker binary.
	FirecrackerBin string

	// SocketDir is the directory for per-VM API sockets.
	SocketDir string

	// MaxVMs is the maximum number of concurrent VMs.
	MaxVMs int

	// LogLevel is the logging verbosity.
	LogLevel string

	// SnapshotPoolSize is the number of pre-booted VM snapshots to maintain
	// in the warm pool. Default 5, max 20. 0 disables the pool.
	SnapshotPoolSize int

	// SnapshotDir is the directory for snapshot artifact storage.
	SnapshotDir string

	// VNCProxyPort is the TCP port for the VNC WebSocket proxy.
	// Default 6080. 0 disables the proxy.
	VNCProxyPort int

	// SnapshotDiskLimitMB is the maximum disk space (in MB) for snapshot artifacts.
	// Default 5120 (5GB). 0 disables disk limit enforcement.
	SnapshotDiskLimitMB int
}

// DefaultServiceConfig returns a ServiceConfig with sensible defaults.
func DefaultServiceConfig() *ServiceConfig {
	return &ServiceConfig{
		SocketPath:       "/var/run/openclaw-vm-runner.sock",
		FirecrackerBin:   "firecracker",
		SocketDir:        "/tmp/openclaw-vms/",
		MaxVMs:           100,
		LogLevel:         "info",
		SnapshotPoolSize: 5,
		SnapshotDir:      "/var/lib/openclaw/snapshots",
		VNCProxyPort:        0,
		SnapshotDiskLimitMB: 5120,
	}
}
