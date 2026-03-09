//go:build linux

package vm

import (
	"context"
	"fmt"
	"time"

	firecracker "github.com/firecracker-microvm/firecracker-go-sdk"
	"github.com/firecracker-microvm/firecracker-go-sdk/client/models"
	"github.com/openclaw/vm-runner/internal/jailer"
)

// NewRealMachineFactory creates a MachineFactory that uses the firecracker-go-sdk
// to create real Firecracker VMs. It calls PrepareJail on the JailedLauncher to
// set up the chroot and get a JailerConfig, then creates and starts a Firecracker
// machine with the SDK.
func NewRealMachineFactory(jl *jailer.JailedLauncher) MachineFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig) (*MachineEntry, error) {
		// Build LaunchConfig from CreateRequest and VMConfig
		launchCfg := jailer.LaunchConfig{
			VMID:       req.SandboxID,
			KernelPath: vmCfg.KernelImagePath,
			RootfsPath: vmCfg.RootfsPath,
			VcpuCount:  uint32(vmCfg.VcpuCount),
			MemSizeMiB: uint32(vmCfg.MemSizeMib),
		}

		// Prepare the jail: allocate UID, create chroot, get JailerConfig
		jcfg, _, err := jl.PrepareJail(ctx, launchCfg)
		if err != nil {
			return nil, fmt.Errorf("failed to prepare jail for %s: %w", req.SandboxID, err)
		}

		// Convert our JailerConfig to firecracker SDK's JailerConfig
		fcJailerCfg := firecracker.JailerConfig{
			UID:            jcfg.UID,
			GID:            jcfg.GID,
			ID:             jcfg.ID,
			NumaNode:       firecracker.Int(0),
			ExecFile:       jcfg.ExecFile,
			JailerBinary:   jcfg.JailerBinary,
			ChrootBaseDir:  jcfg.ChrootBaseDir,
			ChrootStrategy: firecracker.NewNaiveChrootStrategy(vmCfg.KernelImagePath),
			Daemonize:      jcfg.Daemonize,
			CgroupVersion:  jcfg.CgroupVersion,
		}

		// Build firecracker.Config from VMConfig
		fcCfg := firecracker.Config{
			SocketPath:      vmCfg.SocketPath,
			KernelImagePath: vmCfg.KernelImagePath,
			KernelArgs:      vmCfg.KernelArgs,
			Drives:          firecracker.NewDrivesBuilder(vmCfg.RootfsPath).Build(),
			MachineCfg: models.MachineConfiguration{
				VcpuCount:  firecracker.Int64(vmCfg.VcpuCount),
				MemSizeMib: firecracker.Int64(vmCfg.MemSizeMib),
				Smt:        firecracker.Bool(vmCfg.SmtEnabled),
			},
			VsockDevices: []firecracker.VsockDevice{{
				Path: vmCfg.VsockPath,
				CID:  uint32(vmCfg.VsockCID),
			}},
			JailerCfg: &fcJailerCfg,
		}

		// Create machine context with cancel for lifecycle management
		machineCtx, cancel := context.WithCancel(ctx)

		// Create the Firecracker machine via the SDK
		machine, err := firecracker.NewMachine(machineCtx, fcCfg)
		if err != nil {
			cancel()
			_ = jl.ReleaseJail(req.SandboxID)
			return nil, fmt.Errorf("failed to create firecracker machine for %s: %w", req.SandboxID, err)
		}

		// Start the VM
		if err := machine.Start(machineCtx); err != nil {
			cancel()
			_ = jl.ReleaseJail(req.SandboxID)
			return nil, fmt.Errorf("failed to start firecracker machine for %s: %w", req.SandboxID, err)
		}

		return &MachineEntry{
			ID:         req.SandboxID,
			CreatedAt:  time.Now(),
			State:      StateRunning,
			VMConfig:   vmCfg,
			Cancel:     cancel,
			ShutdownFn: machine.Shutdown,
			StopFn:     machine.StopVMM,
			PauseVMFn: func(ctx context.Context) error {
				return machine.PauseVM(ctx)
			},
			ResumeVMFn: func(ctx context.Context) error {
				return machine.ResumeVM(ctx)
			},
			CreateSnapshotFn: func(ctx context.Context, memFilePath, snapshotPath string) error {
				return machine.CreateSnapshot(ctx, memFilePath, snapshotPath)
			},
		}, nil
	}
}

// NewRealRestoreFactory creates a SnapshotRestoreFactory that uses the firecracker-go-sdk
// to restore VMs from snapshot artifacts. It calls PrepareJail for the new VM identity,
// then creates a Firecracker machine with WithSnapshot option.
func NewRealRestoreFactory(jl *jailer.JailedLauncher) SnapshotRestoreFactory {
	return func(ctx context.Context, req *CreateRequest, vmCfg *VMConfig, memPath, snapPath string) (*MachineEntry, error) {
		// Build LaunchConfig from CreateRequest and VMConfig
		launchCfg := jailer.LaunchConfig{
			VMID:       req.SandboxID,
			KernelPath: vmCfg.KernelImagePath,
			RootfsPath: vmCfg.RootfsPath,
			VcpuCount:  uint32(vmCfg.VcpuCount),
			MemSizeMiB: uint32(vmCfg.MemSizeMib),
		}

		// Prepare the jail: allocate UID, create chroot, get JailerConfig
		jcfg, _, err := jl.PrepareJail(ctx, launchCfg)
		if err != nil {
			return nil, fmt.Errorf("failed to prepare jail for restore %s: %w", req.SandboxID, err)
		}

		// Convert to firecracker SDK's JailerConfig
		fcJailerCfg := firecracker.JailerConfig{
			UID:            jcfg.UID,
			GID:            jcfg.GID,
			ID:             jcfg.ID,
			NumaNode:       firecracker.Int(0),
			ExecFile:       jcfg.ExecFile,
			JailerBinary:   jcfg.JailerBinary,
			ChrootBaseDir:  jcfg.ChrootBaseDir,
			ChrootStrategy: firecracker.NewNaiveChrootStrategy(vmCfg.KernelImagePath),
			Daemonize:      jcfg.Daemonize,
			CgroupVersion:  jcfg.CgroupVersion,
		}

		// Build firecracker.Config with snapshot restore
		fcCfg := firecracker.Config{
			SocketPath:      vmCfg.SocketPath,
			KernelImagePath: vmCfg.KernelImagePath,
			KernelArgs:      vmCfg.KernelArgs,
			Drives:          firecracker.NewDrivesBuilder(vmCfg.RootfsPath).Build(),
			MachineCfg: models.MachineConfiguration{
				VcpuCount:  firecracker.Int64(vmCfg.VcpuCount),
				MemSizeMib: firecracker.Int64(vmCfg.MemSizeMib),
				Smt:        firecracker.Bool(vmCfg.SmtEnabled),
			},
			VsockDevices: []firecracker.VsockDevice{{
				Path: vmCfg.VsockPath,
				CID:  uint32(vmCfg.VsockCID),
			}},
			JailerCfg: &fcJailerCfg,
			Snapshot: firecracker.SnapshotConfig{
				MemFilePath:  memPath,
				SnapshotPath: snapPath,
				ResumeVM:     true,
			},
		}

		machineCtx, cancel := context.WithCancel(ctx)

		machine, err := firecracker.NewMachine(machineCtx, fcCfg)
		if err != nil {
			cancel()
			_ = jl.ReleaseJail(req.SandboxID)
			return nil, fmt.Errorf("failed to create firecracker machine for restore %s: %w", req.SandboxID, err)
		}

		// Start restores from snapshot (ResumeVM=true in SnapshotConfig)
		if err := machine.Start(machineCtx); err != nil {
			cancel()
			_ = jl.ReleaseJail(req.SandboxID)
			return nil, fmt.Errorf("failed to start restored machine %s: %w", req.SandboxID, err)
		}

		return &MachineEntry{
			ID:         req.SandboxID,
			CreatedAt:  time.Now(),
			State:      StateRunning,
			BootMethod: BootMethodSnapshot,
			VMConfig:   vmCfg,
			Cancel:     cancel,
			ShutdownFn: machine.Shutdown,
			StopFn:     machine.StopVMM,
			PauseVMFn: func(ctx context.Context) error {
				return machine.PauseVM(ctx)
			},
			ResumeVMFn: func(ctx context.Context) error {
				return machine.ResumeVM(ctx)
			},
			CreateSnapshotFn: func(ctx context.Context, memFilePath, snapshotPath string) error {
				return machine.CreateSnapshot(ctx, memFilePath, snapshotPath)
			},
		}, nil
	}
}
