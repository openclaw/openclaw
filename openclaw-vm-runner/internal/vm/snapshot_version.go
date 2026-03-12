package vm

import "fmt"

// CurrentVersion computes a deterministic SHA256 hash from the rootfs file content
// and the VMConfig JSON. This enables snapshot version invalidation when either
// the rootfs or the VM configuration changes.
//
// It delegates to the internal computeVersion function (defined in snapshot.go).
func CurrentVersion(rootfsPath string, cfg *VMConfig) (string, error) {
	return computeVersion(rootfsPath, cfg)
}

// IsVersionValid reads the snapshot metadata from snapshotDir and compares
// its Version field against expectedVersion. Returns true if they match,
// false if they differ, or an error if the metadata cannot be read.
//
// This is used by the warm pool to detect stale snapshots that need
// re-creation due to rootfs or VMConfig changes.
func IsVersionValid(snapshotDir string, expectedVersion string) (bool, error) {
	meta, err := readMetadata(snapshotDir)
	if err != nil {
		return false, fmt.Errorf("read snapshot metadata: %w", err)
	}

	return meta.Version == expectedVersion, nil
}
