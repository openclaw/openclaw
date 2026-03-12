package vm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCurrentVersion_Deterministic(t *testing.T) {
	// Calling CurrentVersion twice with same rootfs and VMConfig returns same hash.
	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content-deterministic"), 0644))

	cfg := &VMConfig{
		VcpuCount:  2,
		MemSizeMib: 512,
		RootfsPath: rootfs,
	}

	v1, err := CurrentVersion(rootfs, cfg)
	require.NoError(t, err)

	v2, err := CurrentVersion(rootfs, cfg)
	require.NoError(t, err)

	assert.Equal(t, v1, v2, "same inputs should produce same version hash")
	assert.Len(t, v1, 64, "SHA256 hex digest should be 64 chars")
}

func TestCurrentVersion_DifferentRootfs(t *testing.T) {
	// Different rootfs content produces different hash.
	dir := t.TempDir()
	rootfs1 := filepath.Join(dir, "rootfs1.ext4")
	rootfs2 := filepath.Join(dir, "rootfs2.ext4")
	require.NoError(t, os.WriteFile(rootfs1, []byte("rootfs-content-v1"), 0644))
	require.NoError(t, os.WriteFile(rootfs2, []byte("rootfs-content-v2"), 0644))

	cfg := &VMConfig{VcpuCount: 2, MemSizeMib: 512}

	v1, err := CurrentVersion(rootfs1, cfg)
	require.NoError(t, err)

	v2, err := CurrentVersion(rootfs2, cfg)
	require.NoError(t, err)

	assert.NotEqual(t, v1, v2, "different rootfs content should produce different hash")
}

func TestCurrentVersion_DifferentConfig(t *testing.T) {
	// Same rootfs but different VMConfig (e.g., different MemSizeMib) produces different hash.
	dir := t.TempDir()
	rootfs := filepath.Join(dir, "rootfs.ext4")
	require.NoError(t, os.WriteFile(rootfs, []byte("rootfs-content-same"), 0644))

	cfg1 := &VMConfig{VcpuCount: 2, MemSizeMib: 256}
	cfg2 := &VMConfig{VcpuCount: 2, MemSizeMib: 512}

	v1, err := CurrentVersion(rootfs, cfg1)
	require.NoError(t, err)

	v2, err := CurrentVersion(rootfs, cfg2)
	require.NoError(t, err)

	assert.NotEqual(t, v1, v2, "different VMConfig should produce different hash")
}

func TestIsVersionValid_Match(t *testing.T) {
	// Write metadata.json with version X, IsVersionValid with expected=X returns true.
	dir := t.TempDir()

	meta := SnapshotMetadata{
		Version:    "abc123",
		RootfsHash: "hash1",
		ConfigHash: "hash2",
		CreatedAt:  time.Now(),
		VsockCID:   42,
		MemSizeMib: 512,
		VcpuCount:  2,
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "metadata.json"), data, 0644))

	valid, err := IsVersionValid(dir, "abc123")
	require.NoError(t, err)
	assert.True(t, valid, "IsVersionValid should return true when versions match")
}

func TestIsVersionValid_Mismatch(t *testing.T) {
	// Write metadata.json with version X, IsVersionValid with expected=Y returns false.
	dir := t.TempDir()

	meta := SnapshotMetadata{
		Version:    "abc123",
		RootfsHash: "hash1",
		ConfigHash: "hash2",
		CreatedAt:  time.Now(),
		VsockCID:   42,
		MemSizeMib: 512,
		VcpuCount:  2,
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "metadata.json"), data, 0644))

	valid, err := IsVersionValid(dir, "xyz789")
	require.NoError(t, err)
	assert.False(t, valid, "IsVersionValid should return false when versions mismatch")
}

func TestIsVersionValid_MissingMetadata(t *testing.T) {
	// Call IsVersionValid on dir without metadata.json, returns error.
	dir := t.TempDir()

	_, err := IsVersionValid(dir, "any-version")
	assert.Error(t, err, "IsVersionValid should return error when metadata.json is missing")
}
