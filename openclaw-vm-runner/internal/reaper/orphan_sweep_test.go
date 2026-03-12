package reaper

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mockVMEntry represents a VM in the mock registry.
type mockVMEntry struct {
	ID            string
	PID           int
	UID           int
	ChrootDir     string
	CreatedAt     time.Time
	LastHeartbeat time.Time
}

// mockRegistry implements VMRegistry for testing.
type mockRegistry struct {
	entries map[string]*mockVMEntry
}

func newMockRegistry() *mockRegistry {
	return &mockRegistry{entries: make(map[string]*mockVMEntry)}
}

func (r *mockRegistry) AllEntries() []VMEntryInfo {
	result := make([]VMEntryInfo, 0, len(r.entries))
	for _, e := range r.entries {
		result = append(result, VMEntryInfo{
			ID:            e.ID,
			PID:           e.PID,
			UID:           e.UID,
			ChrootDir:     e.ChrootDir,
			CreatedAt:     e.CreatedAt,
			LastHeartbeat: e.LastHeartbeat,
		})
	}
	return result
}

func (r *mockRegistry) Remove(vmID string) {
	delete(r.entries, vmID)
}

// mockDestroyer tracks destroy calls for testing.
type mockDestroyer struct {
	destroyed []string
	failOn    map[string]bool
}

func newMockDestroyer() *mockDestroyer {
	return &mockDestroyer{failOn: make(map[string]bool)}
}

func (d *mockDestroyer) DestroyVM(ctx context.Context, vmID string) error {
	d.destroyed = append(d.destroyed, vmID)
	return nil
}

func TestOrphanSweepHeartbeatStale(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	// VM with stale heartbeat (10 minutes old, threshold is 3 * 30s = 90s)
	reg.entries["stale-vm"] = &mockVMEntry{
		ID:            "stale-vm",
		PID:           99999999, // doesn't exist
		CreatedAt:     time.Now().Add(-5 * time.Minute),
		LastHeartbeat: time.Now().Add(-10 * time.Minute),
	}

	// VM with fresh heartbeat
	reg.entries["fresh-vm"] = &mockVMEntry{
		ID:            "fresh-vm",
		PID:           os.Getpid(), // current process, definitely alive
		CreatedAt:     time.Now(),
		LastHeartbeat: time.Now(),
	}

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	assert.Contains(t, destroyer.destroyed, "stale-vm")
	assert.NotContains(t, destroyer.destroyed, "fresh-vm")
}

func TestOrphanSweepProcessDead(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	// VM with dead process (PID that doesn't exist)
	reg.entries["dead-vm"] = &mockVMEntry{
		ID:            "dead-vm",
		PID:           99999999,
		CreatedAt:     time.Now(),
		LastHeartbeat: time.Now(),
	}

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	assert.Contains(t, destroyer.destroyed, "dead-vm")
}

func TestOrphanSweepTTLExpired(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	// VM that has exceeded TTL
	reg.entries["old-vm"] = &mockVMEntry{
		ID:            "old-vm",
		PID:           os.Getpid(), // alive
		CreatedAt:     time.Now().Add(-5 * time.Hour),
		LastHeartbeat: time.Now(), // fresh heartbeat
	}

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	assert.Contains(t, destroyer.destroyed, "old-vm")
}

func TestOrphanSweepFilesystemOrphans(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	// Create a chroot directory for a VM not in the registry
	baseDir := t.TempDir()
	orphanDir := filepath.Join(baseDir, "firecracker", "ghost-vm", "root")
	require.NoError(t, os.MkdirAll(orphanDir, 0755))

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        baseDir,
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	assert.Contains(t, destroyer.destroyed, "ghost-vm")
}

func TestOrphanSweepHealthyVMUntouched(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	// Healthy VM: alive process, fresh heartbeat, within TTL
	reg.entries["healthy-vm"] = &mockVMEntry{
		ID:            "healthy-vm",
		PID:           os.Getpid(),
		CreatedAt:     time.Now(),
		LastHeartbeat: time.Now(),
	}

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	assert.Empty(t, destroyer.destroyed)
}

func TestOrphanSweeperStartStop(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	cfg := SweepConfig{
		Interval:             50 * time.Millisecond,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.Start()

	// Let it run a couple of cycles
	time.Sleep(150 * time.Millisecond)

	sweeper.Stop()
	// Verify it stopped without panic
}

func TestOrphanSweeperStats(t *testing.T) {
	reg := newMockRegistry()
	destroyer := newMockDestroyer()

	reg.entries["stale-vm"] = &mockVMEntry{
		ID:            "stale-vm",
		PID:           99999999,
		CreatedAt:     time.Now().Add(-10 * time.Minute),
		LastHeartbeat: time.Now().Add(-10 * time.Minute),
	}

	cfg := SweepConfig{
		Interval:             30 * time.Second,
		HeartbeatMultiplier:  3,
		MaxTTL:               4 * time.Hour,
		ChrootBaseDir:        t.TempDir(),
	}

	sweeper := NewOrphanSweeper(reg, destroyer, cfg, nil)
	sweeper.sweep()

	stats := sweeper.Stats()
	assert.Equal(t, int64(1), stats.OrphansDestroyed.Load())
}
