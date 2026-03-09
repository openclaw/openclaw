package envd

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
)

// TrackedProcess holds references to a running process and its I/O pipes.
type TrackedProcess struct {
	Cmd       *exec.Cmd
	Stdin     io.WriteCloser
	Pgid      int
	Ctx       context.Context
	Cancel    context.CancelFunc
	ProcessID string
	Command   string
	running   atomic.Bool
	mu        sync.Mutex
}

// SetRunning atomically sets the running state.
func (p *TrackedProcess) SetRunning(v bool) { p.running.Store(v) }

// IsRunning atomically reads the running state.
func (p *TrackedProcess) IsRunning() bool { return p.running.Load() }

// ProcessTracker manages concurrent process tracking using sync.Map.
type ProcessTracker struct {
	m sync.Map
}

// NewProcessTracker creates a new ProcessTracker.
func NewProcessTracker() *ProcessTracker {
	return &ProcessTracker{}
}

// Store registers a tracked process.
func (t *ProcessTracker) Store(id string, proc *TrackedProcess) {
	t.m.Store(id, proc)
}

// Load retrieves a tracked process by ID.
func (t *ProcessTracker) Load(id string) (*TrackedProcess, bool) {
	v, ok := t.m.Load(id)
	if !ok {
		return nil, false
	}
	return v.(*TrackedProcess), true
}

// Delete removes a tracked process by ID.
func (t *ProcessTracker) Delete(id string) {
	t.m.Delete(id)
}

// List returns all tracked processes.
func (t *ProcessTracker) List() []*TrackedProcess {
	var procs []*TrackedProcess
	t.m.Range(func(_, value any) bool {
		procs = append(procs, value.(*TrackedProcess))
		return true
	})
	return procs
}
