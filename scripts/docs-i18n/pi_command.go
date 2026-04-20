package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	envDocsPiExecutable     = "OPENCLAW_DOCS_I18N_PI_EXECUTABLE"
	envDocsPiArgs           = "OPENCLAW_DOCS_I18N_PI_ARGS"
	envDocsPiPackageVersion = "OPENCLAW_DOCS_I18N_PI_PACKAGE_VERSION"
	envDocsPiOmitProvider   = "OPENCLAW_DOCS_I18N_PI_OMIT_PROVIDER"
	defaultPiPackageVersion = "0.58.3"
)

type docsPiCommand struct {
	Executable string
	Args       []string
}

var (
	materializedPiRuntimeMu      sync.Mutex
	materializedPiRuntimeCommand docsPiCommand
	materializedPiRuntimeErr     error
)

func resolveDocsPiCommand(ctx context.Context) (docsPiCommand, error) {
	if executable := strings.TrimSpace(os.Getenv(envDocsPiExecutable)); executable != "" {
		return docsPiCommand{
			Executable: executable,
			Args:       strings.Fields(os.Getenv(envDocsPiArgs)),
		}, nil
	}

	piPath, err := exec.LookPath("pi")
	if err == nil && !shouldMaterializePiRuntime(piPath) {
		return docsPiCommand{Executable: piPath}, nil
	}

	return ensureMaterializedPiRuntime(ctx)
}

func shouldMaterializePiRuntime(piPath string) bool {
	realPath, err := filepath.EvalSymlinks(piPath)
	if err != nil {
		realPath = piPath
	}
	return strings.Contains(filepath.ToSlash(realPath), "/Projects/pi-mono/")
}

func ensureMaterializedPiRuntime(ctx context.Context) (docsPiCommand, error) {
	materializedPiRuntimeMu.Lock()
	defer materializedPiRuntimeMu.Unlock()

	if materializedPiRuntimeErr == nil && materializedPiRuntimeCommand.Executable != "" {
		return materializedPiRuntimeCommand, nil
	}

	runtimeDir, err := getMaterializedPiRuntimeDir()
	if err != nil {
		materializedPiRuntimeErr = err
		return docsPiCommand{}, err
	}
	cliPath := filepath.Join(runtimeDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js")
	if _, err := os.Stat(cliPath); errors.Is(err, os.ErrNotExist) {
		installCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()

		if err := os.MkdirAll(runtimeDir, 0o755); err != nil {
			materializedPiRuntimeErr = err
			return docsPiCommand{}, err
		}

		packageVersion := getMaterializedPiPackageVersion()
		install := exec.CommandContext(
			installCtx,
			"npm",
			"install",
			"--silent",
			"--no-audit",
			"--no-fund",
			fmt.Sprintf("@mariozechner/pi-coding-agent@%s", packageVersion),
		)
		install.Dir = runtimeDir
		install.Env = os.Environ()
		output, err := install.CombinedOutput()
		if err != nil {
			materializedPiRuntimeErr = fmt.Errorf("materialize pi runtime: %w (%s)", err, strings.TrimSpace(string(output)))
			return docsPiCommand{}, materializedPiRuntimeErr
		}
	}

	materializedPiRuntimeCommand = docsPiCommand{
		Executable: "node",
		Args:       []string{cliPath},
	}
	materializedPiRuntimeErr = nil
	return materializedPiRuntimeCommand, nil
}

func getMaterializedPiRuntimeDir() (string, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = os.TempDir()
	}
	return filepath.Join(cacheDir, "openclaw", "docs-i18n", "pi-runtime", getMaterializedPiPackageVersion()), nil
}

func getMaterializedPiPackageVersion() string {
	if version := strings.TrimSpace(os.Getenv(envDocsPiPackageVersion)); version != "" {
		return version
	}
	return defaultPiPackageVersion
}

func docsPiOmitProvider() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envDocsPiOmitProvider))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
