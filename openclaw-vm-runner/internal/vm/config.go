package vm

import (
	"path/filepath"
)

// VMConfig holds all the configuration parameters for a Firecracker VM.
// This is a platform-independent representation that maps to firecracker.Config
// on Linux. It allows unit testing on any platform without the firecracker-go-sdk
// build dependency (which requires Linux-only packages).
type VMConfig struct {
	// SocketPath is the Firecracker API Unix socket path.
	SocketPath string

	// KernelImagePath is the path to the kernel image.
	KernelImagePath string

	// KernelArgs are the kernel boot arguments.
	KernelArgs string

	// RootfsPath is the path to the rootfs image.
	RootfsPath string

	// VcpuCount is the number of virtual CPUs.
	VcpuCount int64

	// MemSizeMib is the memory allocation in MiB.
	MemSizeMib int64

	// SmtEnabled indicates whether simultaneous multithreading is enabled.
	SmtEnabled bool

	// VsockCID is the unique Context ID for the vsock device.
	VsockCID uint32

	// VsockPath is the host-side Unix socket path for vsock communication.
	VsockPath string
}

// DefaultKernelArgs is the standard kernel boot arguments for Firecracker VMs.
const DefaultKernelArgs = "reboot=k panic=1 pci=off nomodules i8042.noaux"

// DefaultVcpuCount is the default number of vCPUs if not specified.
const DefaultVcpuCount = int64(1)

// DefaultMemSizeMib is the default memory in MiB if not specified.
const DefaultMemSizeMib = int64(256)

// buildConfig creates a VMConfig from the given parameters with sensible defaults.
func buildConfig(kernelPath, rootfsPath, socketDir, sandboxID string, vcpuCount, memSizeMib uint32, cid uint32) *VMConfig {
	vcpu := DefaultVcpuCount
	if vcpuCount > 0 {
		vcpu = int64(vcpuCount)
	}

	mem := DefaultMemSizeMib
	if memSizeMib > 0 {
		mem = int64(memSizeMib)
	}

	return &VMConfig{
		SocketPath:      filepath.Join(socketDir, sandboxID+".sock"),
		KernelImagePath: kernelPath,
		KernelArgs:      DefaultKernelArgs,
		RootfsPath:      rootfsPath,
		VcpuCount:       vcpu,
		MemSizeMib:      mem,
		SmtEnabled:      false,
		VsockCID:        cid,
		VsockPath:       filepath.Join(socketDir, sandboxID+"-vsock.sock"),
	}
}
