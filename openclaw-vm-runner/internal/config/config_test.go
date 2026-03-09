package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDefaultServiceConfig_PoolFields(t *testing.T) {
	cfg := DefaultServiceConfig()

	assert.Equal(t, 5, cfg.SnapshotPoolSize, "default SnapshotPoolSize should be 5")
	assert.Equal(t, "/var/lib/openclaw/snapshots", cfg.SnapshotDir, "default SnapshotDir should be /var/lib/openclaw/snapshots")
}
