package envd

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProcessTracker_StoreAndLoad(t *testing.T) {
	tracker := NewProcessTracker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	proc := &TrackedProcess{
		ProcessID: "test-123",
		Command:   "echo hello",
		Ctx:       ctx,
		Cancel:    cancel,
	}

	tracker.Store("test-123", proc)

	loaded, ok := tracker.Load("test-123")
	require.True(t, ok)
	assert.Equal(t, "test-123", loaded.ProcessID)
	assert.Equal(t, "echo hello", loaded.Command)
}

func TestProcessTracker_LoadNotFound(t *testing.T) {
	tracker := NewProcessTracker()

	_, ok := tracker.Load("nonexistent")
	assert.False(t, ok)
}

func TestProcessTracker_Delete(t *testing.T) {
	tracker := NewProcessTracker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	proc := &TrackedProcess{ProcessID: "del-1", Ctx: ctx, Cancel: cancel}
	tracker.Store("del-1", proc)

	tracker.Delete("del-1")

	_, ok := tracker.Load("del-1")
	assert.False(t, ok)
}

func TestProcessTracker_List(t *testing.T) {
	tracker := NewProcessTracker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	tracker.Store("a", &TrackedProcess{ProcessID: "a", Command: "cmd-a", Ctx: ctx, Cancel: cancel})
	tracker.Store("b", &TrackedProcess{ProcessID: "b", Command: "cmd-b", Ctx: ctx, Cancel: cancel})
	tracker.Store("c", &TrackedProcess{ProcessID: "c", Command: "cmd-c", Ctx: ctx, Cancel: cancel})

	procs := tracker.List()
	assert.Len(t, procs, 3)

	ids := make(map[string]bool)
	for _, p := range procs {
		ids[p.ProcessID] = true
	}
	assert.True(t, ids["a"])
	assert.True(t, ids["b"])
	assert.True(t, ids["c"])
}

func TestProcessTracker_ListEmpty(t *testing.T) {
	tracker := NewProcessTracker()
	procs := tracker.List()
	assert.Empty(t, procs)
}

func TestProcessTracker_ConcurrentAccess(t *testing.T) {
	tracker := NewProcessTracker()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	for i := 0; i < 100; i++ {
		go func(id string) {
			proc := &TrackedProcess{ProcessID: id, Ctx: ctx, Cancel: cancel}
			tracker.Store(id, proc)
			tracker.Load(id)
			tracker.List()
			tracker.Delete(id)
			done <- struct{}{}
		}(string(rune('A' + i%26)))
	}

	for i := 0; i < 100; i++ {
		<-done
	}
}
