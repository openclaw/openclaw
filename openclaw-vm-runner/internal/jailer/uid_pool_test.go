package jailer

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewUIDPool(t *testing.T) {
	pool := NewUIDPool(10000, 60000)
	require.NotNil(t, pool)
	assert.Equal(t, 0, pool.InUse())
}

func TestUIDPoolAllocate(t *testing.T) {
	pool := NewUIDPool(10000, 10002)

	uid1, gid1, err := pool.Allocate()
	require.NoError(t, err)
	assert.Equal(t, uid1, gid1, "UID and GID should be equal")
	assert.True(t, uid1 >= 10000 && uid1 <= 10002)
	assert.Equal(t, 1, pool.InUse())

	uid2, _, err := pool.Allocate()
	require.NoError(t, err)
	assert.NotEqual(t, uid1, uid2, "UIDs must be unique")
	assert.Equal(t, 2, pool.InUse())

	uid3, _, err := pool.Allocate()
	require.NoError(t, err)
	assert.NotEqual(t, uid1, uid3)
	assert.NotEqual(t, uid2, uid3)
	assert.Equal(t, 3, pool.InUse())
}

func TestUIDPoolExhaustion(t *testing.T) {
	pool := NewUIDPool(100, 101) // only 2 slots

	_, _, err := pool.Allocate()
	require.NoError(t, err)

	_, _, err = pool.Allocate()
	require.NoError(t, err)

	_, _, err = pool.Allocate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "exhausted")
}

func TestUIDPoolRelease(t *testing.T) {
	pool := NewUIDPool(100, 101)

	uid1, _, err := pool.Allocate()
	require.NoError(t, err)
	assert.Equal(t, 1, pool.InUse())

	err = pool.Release(uid1)
	require.NoError(t, err)
	assert.Equal(t, 0, pool.InUse())

	// Can allocate again after release
	uid2, _, err := pool.Allocate()
	require.NoError(t, err)
	assert.Equal(t, uid1, uid2, "released UID should be reusable")
}

func TestUIDPoolReleaseUnknown(t *testing.T) {
	pool := NewUIDPool(100, 200)

	err := pool.Release(999)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not allocated")
}

func TestUIDPoolConcurrency(t *testing.T) {
	pool := NewUIDPool(10000, 10099) // 100 slots

	var wg sync.WaitGroup
	allocated := make(chan int, 100)

	// Allocate 100 UIDs concurrently
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			uid, _, err := pool.Allocate()
			if err == nil {
				allocated <- uid
			}
		}()
	}

	wg.Wait()
	close(allocated)

	// Verify all UIDs are unique
	seen := make(map[int]bool)
	for uid := range allocated {
		assert.False(t, seen[uid], "duplicate UID: %d", uid)
		seen[uid] = true
	}
	assert.Equal(t, 100, len(seen))
	assert.Equal(t, 100, pool.InUse())
}
