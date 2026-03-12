package reaper

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockShutdownDeps struct {
	mu            sync.Mutex
	stopCalled    bool
	drainCalled   bool
	activeVMs     []string
	destroyedVMs  []string
	destroyDelay  time.Duration
}

func (m *mockShutdownDeps) StopAccepting() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopCalled = true
}

func (m *mockShutdownDeps) ActiveVMIDs() []string {
	return m.activeVMs
}

func (m *mockShutdownDeps) DestroyVM(ctx context.Context, vmID string) error {
	if m.destroyDelay > 0 {
		time.Sleep(m.destroyDelay)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.destroyedVMs = append(m.destroyedVMs, vmID)
	return nil
}

func (m *mockShutdownDeps) DrainGRPC() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.drainCalled = true
}

func TestGracefulShutdownNormalSequence(t *testing.T) {
	deps := &mockShutdownDeps{
		activeVMs: []string{"vm-1", "vm-2", "vm-3"},
	}

	cfg := ShutdownConfig{Timeout: 5 * time.Second}
	err := RunGracefulShutdown(context.Background(), deps, cfg, nil)
	require.NoError(t, err)

	// Verify sequence
	assert.True(t, deps.stopCalled, "should stop accepting new VMs")
	assert.ElementsMatch(t, []string{"vm-1", "vm-2", "vm-3"}, deps.destroyedVMs)
	assert.True(t, deps.drainCalled, "should drain gRPC")
}

func TestGracefulShutdownEmptyRegistry(t *testing.T) {
	deps := &mockShutdownDeps{
		activeVMs: []string{},
	}

	cfg := ShutdownConfig{Timeout: 5 * time.Second}
	err := RunGracefulShutdown(context.Background(), deps, cfg, nil)
	require.NoError(t, err)

	assert.True(t, deps.stopCalled)
	assert.Empty(t, deps.destroyedVMs)
	assert.True(t, deps.drainCalled)
}

func TestGracefulShutdownTimeout(t *testing.T) {
	deps := &mockShutdownDeps{
		activeVMs:    []string{"slow-vm"},
		destroyDelay: 5 * time.Second, // much longer than timeout
	}

	// Use a very short timeout
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	cfg := ShutdownConfig{Timeout: 100 * time.Millisecond}
	_ = RunGracefulShutdown(ctx, deps, cfg, nil)

	// Should still complete (the context controls the timeout per-VM)
	assert.True(t, deps.stopCalled)
	assert.True(t, deps.drainCalled)
}

func TestShutdownConfigDefaults(t *testing.T) {
	cfg := DefaultShutdownConfig()
	assert.Equal(t, 30*time.Second, cfg.Timeout)
}
