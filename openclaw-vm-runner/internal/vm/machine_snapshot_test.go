package vm

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMachineEntry_SnapshotFns_NilOnMock(t *testing.T) {
	// MachineEntry created by mockMachineFactory has nil PauseVMFn/ResumeVMFn/CreateSnapshotFn.
	factory := mockMachineFactory()
	ctx := context.Background()
	entry, err := factory(ctx, &CreateRequest{SandboxID: "snap-test"}, &VMConfig{})
	assert.NoError(t, err)

	assert.Nil(t, entry.PauseVMFn, "PauseVMFn should be nil for mock entries")
	assert.Nil(t, entry.ResumeVMFn, "ResumeVMFn should be nil for mock entries")
	assert.Nil(t, entry.CreateSnapshotFn, "CreateSnapshotFn should be nil for mock entries")
}

func TestMachineEntry_PauseVM_NilSafe(t *testing.T) {
	// PauseVM returns nil when PauseVMFn is nil (safe no-op).
	entry := &MachineEntry{}
	err := entry.PauseVM(context.Background())
	assert.NoError(t, err, "PauseVM with nil PauseVMFn should return nil")
}

func TestMachineEntry_ResumeVM_NilSafe(t *testing.T) {
	// ResumeVM returns nil when ResumeVMFn is nil (safe no-op).
	entry := &MachineEntry{}
	err := entry.ResumeVM(context.Background())
	assert.NoError(t, err, "ResumeVM with nil ResumeVMFn should return nil")
}

func TestMachineEntry_CreateSnapshot_NilSafe(t *testing.T) {
	// CreateSnapshot returns nil when CreateSnapshotFn is nil (safe no-op).
	entry := &MachineEntry{}
	err := entry.CreateSnapshot(context.Background(), "/tmp/mem.bin", "/tmp/vmstate.snap")
	assert.NoError(t, err, "CreateSnapshot with nil CreateSnapshotFn should return nil")
}

func TestMachineEntry_PauseVM_CallsFn(t *testing.T) {
	// PauseVM delegates to PauseVMFn when set.
	called := false
	entry := &MachineEntry{
		PauseVMFn: func(ctx context.Context) error {
			called = true
			return nil
		},
	}
	err := entry.PauseVM(context.Background())
	assert.NoError(t, err)
	assert.True(t, called, "PauseVMFn should have been called")
}

func TestMachineEntry_ResumeVM_CallsFn(t *testing.T) {
	// ResumeVM delegates to ResumeVMFn when set.
	called := false
	entry := &MachineEntry{
		ResumeVMFn: func(ctx context.Context) error {
			called = true
			return nil
		},
	}
	err := entry.ResumeVM(context.Background())
	assert.NoError(t, err)
	assert.True(t, called, "ResumeVMFn should have been called")
}

func TestMachineEntry_CreateSnapshot_CallsFn(t *testing.T) {
	// CreateSnapshot delegates to CreateSnapshotFn when set.
	var gotMem, gotSnap string
	entry := &MachineEntry{
		CreateSnapshotFn: func(ctx context.Context, memFilePath, snapshotPath string) error {
			gotMem = memFilePath
			gotSnap = snapshotPath
			return nil
		},
	}
	err := entry.CreateSnapshot(context.Background(), "/tmp/mem.bin", "/tmp/vmstate.snap")
	assert.NoError(t, err)
	assert.Equal(t, "/tmp/mem.bin", gotMem)
	assert.Equal(t, "/tmp/vmstate.snap", gotSnap)
}
