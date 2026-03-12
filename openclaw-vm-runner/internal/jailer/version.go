// Package jailer provides Jailer enforcement for Firecracker VM launches.
// Every Firecracker MicroVM must be launched through the Jailer binary with
// chroot isolation, seccomp enforcement, UID/GID privilege dropping,
// PID namespace isolation, and cgroup resource limits.
package jailer

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// MinFirecrackerVersion is the minimum required Firecracker version.
// Versions below this are vulnerable to CVE-2026-1386 (Jailer symlink attack).
const MinFirecrackerVersion = "1.14.1"

// versionRegexp captures the full version string including optional prerelease suffix.
var versionRegexp = regexp.MustCompile(`(?i)firecracker\s+v(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)`)

// ValidateFirecrackerVersion parses the output of `firecracker --version`
// and returns an error if the version is below MinFirecrackerVersion.
// Prerelease versions (e.g. 1.14.1-rc1) are rejected because they may
// not contain the security fixes present in the final release.
func ValidateFirecrackerVersion(versionOutput string) error {
	matches := versionRegexp.FindStringSubmatch(versionOutput)
	if len(matches) < 2 {
		return fmt.Errorf("failed to parse Firecracker version from output: %q", versionOutput)
	}

	version := matches[1]

	// Split off prerelease suffix if present.
	base := version
	prerelease := ""
	if idx := strings.IndexByte(version, '-'); idx >= 0 {
		base = version[:idx]
		prerelease = version[idx:]
	}

	if compareSemver(base, MinFirecrackerVersion) < 0 {
		return fmt.Errorf(
			"Firecracker version %s is below minimum required %s; upgrade to mitigate CVE-2026-1386 (Jailer symlink attack)",
			version, MinFirecrackerVersion,
		)
	}

	// Reject prerelease builds even if the base version matches, because
	// a prerelease (e.g. 1.14.1-rc1) semantically precedes 1.14.1 and
	// may not contain the security fix.
	if prerelease != "" && compareSemver(base, MinFirecrackerVersion) == 0 {
		return fmt.Errorf(
			"Firecracker prerelease version %s is not accepted; the minimum required stable release is %s",
			version, MinFirecrackerVersion,
		)
	}

	return nil
}

// CheckFirecrackerBinary runs `firecracker --version` and validates the version.
func CheckFirecrackerBinary(ctx context.Context, binaryPath string) error {
	if binaryPath == "" {
		binaryPath = "firecracker"
	}
	out, err := exec.CommandContext(ctx, binaryPath, "--version").CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to run %s --version: %w", binaryPath, err)
	}
	return ValidateFirecrackerVersion(string(out))
}

// compareSemver compares two semver strings (major.minor.patch).
// Returns -1 if a < b, 0 if a == b, 1 if a > b.
func compareSemver(a, b string) int {
	ap := parseSemver(a)
	bp := parseSemver(b)
	for i := 0; i < 3; i++ {
		if ap[i] < bp[i] {
			return -1
		}
		if ap[i] > bp[i] {
			return 1
		}
	}
	return 0
}

func parseSemver(s string) [3]int {
	var result [3]int
	parts := strings.SplitN(s, ".", 3)
	for i, p := range parts {
		if i >= 3 {
			break
		}
		result[i], _ = strconv.Atoi(p)
	}
	return result
}
