// Package vm provides VM lifecycle management for Firecracker MicroVMs.
package vm

import (
	"context"
	"time"
)

// State constants for MachineEntry lifecycle.
const (
	StateCreating = "creating"
	StateRunning  = "running"
	StateStopped  = "stopped"
	StateError    = "error"
)

// BootMethod constants indicate how a MachineEntry was created.
const (
	BootMethodCold     = "cold"
	BootMethodSnapshot = "snapshot"
)

// MachineEntry tracks a running Firecracker VM along with its metadata.
type MachineEntry struct {
	// ID is the sandbox identifier.
	ID string

	// CreatedAt records when the sandbox was created.
	CreatedAt time.Time

	// State tracks the lifecycle state of the VM.
	State string

	// BootMethod indicates how this VM was created: "cold" or "snapshot".
	BootMethod string

	// VMConfig holds the VM configuration used to create this sandbox.
	VMConfig *VMConfig

	// Cancel cancels the machine context, stopping background goroutines.
	Cancel context.CancelFunc

	// ShutdownFn is called to gracefully shut down the VM.
	// Nil for mock entries. Set by the real MachineFactory on Linux.
	ShutdownFn func(ctx context.Context) error

	// StopFn is called to force-stop the VM.
	// Nil for mock entries. Set by the real MachineFactory on Linux.
	StopFn func() error

	// PauseVMFn pauses the VM for snapshotting. Nil on non-Linux or mock entries.
	PauseVMFn func(ctx context.Context) error

	// ResumeVMFn resumes a paused VM. Nil on non-Linux or mock entries.
	ResumeVMFn func(ctx context.Context) error

	// CreateSnapshotFn creates a snapshot to the given paths. Nil on non-Linux or mock entries.
	// memFilePath = path for memory dump, snapshotPath = path for VM state file.
	CreateSnapshotFn func(ctx context.Context, memFilePath, snapshotPath string) error
}

// Shutdown attempts a graceful shutdown. Falls back to no-op if ShutdownFn is nil.
func (e *MachineEntry) Shutdown(ctx context.Context) error {
	if e.ShutdownFn != nil {
		return e.ShutdownFn(ctx)
	}
	return nil
}

// Stop force-stops the VM. Falls back to no-op if StopFn is nil.
func (e *MachineEntry) Stop() error {
	if e.StopFn != nil {
		return e.StopFn()
	}
	return nil
}

// PauseVM pauses the VM for snapshotting. Falls back to no-op if PauseVMFn is nil.
func (e *MachineEntry) PauseVM(ctx context.Context) error {
	if e.PauseVMFn != nil {
		return e.PauseVMFn(ctx)
	}
	return nil
}

// ResumeVM resumes a paused VM. Falls back to no-op if ResumeVMFn is nil.
func (e *MachineEntry) ResumeVM(ctx context.Context) error {
	if e.ResumeVMFn != nil {
		return e.ResumeVMFn(ctx)
	}
	return nil
}

// CreateSnapshot creates a snapshot to the given paths. Falls back to no-op if CreateSnapshotFn is nil.
func (e *MachineEntry) CreateSnapshot(ctx context.Context, memFilePath, snapshotPath string) error {
	if e.CreateSnapshotFn != nil {
		return e.CreateSnapshotFn(ctx, memFilePath, snapshotPath)
	}
	return nil
}
