package jailer

import (
	"fmt"
	"sync"
)

// UIDPool allocates and reclaims unique UID/GID pairs from a configurable range.
// Each Firecracker VM gets a unique UID/GID for jail escape containment.
type UIDPool struct {
	mu        sync.Mutex
	available []int
	allocated map[int]bool
}

// NewUIDPool creates a pool with UIDs in the range [minUID, maxUID] inclusive.
func NewUIDPool(minUID, maxUID int) *UIDPool {
	available := make([]int, 0, maxUID-minUID+1)
	for i := maxUID; i >= minUID; i-- {
		available = append(available, i)
	}
	return &UIDPool{
		available: available,
		allocated: make(map[int]bool),
	}
}

// Allocate returns a unique UID/GID pair (UID == GID for simplicity).
// Returns an error if the pool is exhausted.
func (p *UIDPool) Allocate() (uid int, gid int, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.available) == 0 {
		return 0, 0, fmt.Errorf("UID pool exhausted: all UIDs allocated")
	}

	uid = p.available[len(p.available)-1]
	p.available = p.available[:len(p.available)-1]
	p.allocated[uid] = true

	return uid, uid, nil
}

// Release returns a UID back to the available pool.
func (p *UIDPool) Release(uid int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.allocated[uid] {
		return fmt.Errorf("UID %d not allocated", uid)
	}

	delete(p.allocated, uid)
	p.available = append(p.available, uid)
	return nil
}

// InUse returns the number of currently allocated UIDs.
func (p *UIDPool) InUse() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.allocated)
}
