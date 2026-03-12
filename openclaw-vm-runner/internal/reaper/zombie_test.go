package reaper

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStartZombieReaper(t *testing.T) {
	cancel, stats := StartZombieReaper(nil)
	require.NotNil(t, cancel)
	require.NotNil(t, stats)

	// Initial state: no zombies reaped
	assert.Equal(t, int64(0), stats.ZombiesReaped.Load())

	// Clean shutdown
	cancel()
}

func TestReaperStatsTracking(t *testing.T) {
	stats := &ReaperStats{}
	assert.Equal(t, int64(0), stats.ZombiesReaped.Load())

	stats.ZombiesReaped.Add(5)
	assert.Equal(t, int64(5), stats.ZombiesReaped.Load())
}
