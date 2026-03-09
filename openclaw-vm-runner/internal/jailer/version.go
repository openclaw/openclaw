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

var versionRegexp = regexp.MustCompile(`(?i)firecracker\s+v(\d+\.\d+\.\d+)`)

// ValidateFirecrackerVersion parses the output of `firecracker --version`
// and returns an error if the version is below MinFirecrackerVersion.
func ValidateFirecrackerVersion(versionOutput string) error {
	matches := versionRegexp.FindStringSubmatch(versionOutput)
	if len(matches) < 2 {
		return fmt.Errorf("failed to parse Firecracker version from output: %q", versionOutput)
	}

	version := matches[1]
	if compareSemver(version, MinFirecrackerVersion) < 0 {
		return fmt.Errorf(
			"Firecracker version %s is below minimum required %s; upgrade to mitigate CVE-2026-1386 (Jailer symlink attack)",
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
