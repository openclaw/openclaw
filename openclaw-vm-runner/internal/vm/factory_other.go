//go:build !linux

package vm

import (
	"context"
	"fmt"

	"github.com/openclaw/vm-runner/internal/jailer"
)

// NewRealMachineFactory returns a stub MachineFactory on non-Linux platforms.
// Firecracker requires Linux with /dev/kvm, so this stub ensures the code
// compiles on macOS/Windows for development while clearly indicating that
// real VM creation is not supported.
func NewRealMachineFactory(jl *jailer.JailedLauncher) MachineFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		return nil, fmt.Errorf("Firecracker MachineFactory requires Linux with /dev/kvm")
	}
}

// NewRealRestoreFactory returns a stub SnapshotRestoreFactory on non-Linux platforms.
// Firecracker snapshot restore requires Linux with /dev/kvm.
func NewRealRestoreFactory(jl *jailer.JailedLauncher) SnapshotRestoreFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig, memPath, snapPath string) (*MachineEntry, error) {
		return nil, fmt.Errorf("Firecracker SnapshotRestoreFactory requires Linux with /dev/kvm")
	}
}
