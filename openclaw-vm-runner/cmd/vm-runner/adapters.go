package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/openclaw/vm-runner/internal/jailer"
	"github.com/openclaw/vm-runner/internal/reaper"
	"github.com/openclaw/vm-runner/internal/vm"
)

// Compile-time interface compliance checks.
var (
	_ reaper.VMRegistry  = (*managerRegistry)(nil)
	_ reaper.VMDestroyer = (*jailDestroyer)(nil)
)

// managerRegistry adapts Manager + JailedLauncher to the reaper.VMRegistry
// interface so the OrphanSweeper can query active VMs.
type managerRegistry struct {
	mgr *vm.Manager
	jl  *jailer.JailedLauncher
}

// AllEntries returns a snapshot of all active VMs by combining Manager entries
// (which track sandbox lifecycle) with JailedLauncher entries (which track
// jail-level details: PID, UID, ChrootDir).
func (r *managerRegistry) AllEntries() []reaper.VMEntryInfo {
	mgrEntries := r.mgr.List()
	jlEntries := r.jl.ActiveVMs()

	result := make([]reaper.VMEntryInfo, 0, len(mgrEntries))
	for _, e := range mgrEntries {
		info := reaper.VMEntryInfo{
			ID:        e.ID,
			CreatedAt: e.CreatedAt,
		}
		if jlEntry, ok := jlEntries[e.ID]; ok {
			info.PID = jlEntry.PID
			info.UID = jlEntry.UID
			info.ChrootDir = jlEntry.ChrootDir
		}
		result = append(result, info)
	}
	return result
}

// Remove is a no-op. The jailDestroyer.DestroyVM already calls both
// Manager.Destroy and JailedLauncher.Destroy, so making Remove a
// separate operation would cause double-destroy errors.
func (r *managerRegistry) Remove(vmID string) {
	// No-op: see comment above.
}

// jailDestroyer adapts Manager + JailedLauncher to the reaper.VMDestroyer
// interface so the OrphanSweeper can destroy orphaned VMs.
type jailDestroyer struct {
	mgr *vm.Manager
	jl  *jailer.JailedLauncher
}

// DestroyVM destroys a VM through both Manager (stops process, cleans socket)
// and JailedLauncher (cleans chroot, releases UID). A JailedLauncher error
// alone is acceptable -- the VM might not have a jail entry if it was created
// without the jailer or was already partially cleaned up.
func (d *jailDestroyer) DestroyVM(ctx context.Context, vmID string) error {
	// Destroy in Manager first (stops VM process, cleans socket)
	mgrErr := d.mgr.Destroy(ctx, vmID)

	// Then destroy in JailedLauncher (cleans chroot, releases UID)
	jlErr := d.jl.Destroy(ctx, vmID)

	// Manager not-found is non-fatal: filesystem orphans (detected after
	// runner restart) won't exist in the in-memory manager, but their jail
	// artifacts still need cleanup.
	mgrNotFound := mgrErr != nil && strings.Contains(mgrErr.Error(), "not found")

	if mgrErr != nil && !mgrNotFound && jlErr != nil {
		return fmt.Errorf("manager: %w; jailer: %v", mgrErr, jlErr)
	}
	if mgrErr != nil && !mgrNotFound {
		return mgrErr
	}
	// jlErr alone is acceptable (VM might not have a jail entry)
	return nil
}
