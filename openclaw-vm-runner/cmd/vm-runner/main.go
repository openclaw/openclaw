// Package main provides the entry point for the openclaw-vm-runner service.
// It starts a gRPC server on a Unix domain socket, registers SandboxService,
// ExecService, FileService, and Health, and handles graceful shutdown on SIGTERM/SIGINT.
package main

import (
	"context"
	"expvar"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/config"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"github.com/openclaw/vm-runner/internal/jailer"
	"github.com/openclaw/vm-runner/internal/reaper"
	"github.com/openclaw/vm-runner/internal/server"
	"github.com/openclaw/vm-runner/internal/vm"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

func main() {
	cfg := config.DefaultServiceConfig()
	logger := slog.Default()

	// Parse CLI flags
	jailerBin := "jailer"
	flag.StringVar(&cfg.SocketPath, "socket", cfg.SocketPath, "Unix socket path for gRPC server")
	flag.StringVar(&cfg.KernelPath, "kernel", cfg.KernelPath, "Path to uncompressed Linux kernel ELF image")
	flag.StringVar(&cfg.RootfsPath, "rootfs", cfg.RootfsPath, "Path to ext4 rootfs image")
	flag.StringVar(&cfg.FirecrackerBin, "firecracker-bin", cfg.FirecrackerBin, "Path to Firecracker binary")
	flag.StringVar(&jailerBin, "jailer-bin", jailerBin, "Path to Jailer binary")
	flag.StringVar(&cfg.SocketDir, "socket-dir", cfg.SocketDir, "Directory for per-VM API sockets")
	flag.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "Logging verbosity (debug, info, warn, error)")
	flag.IntVar(&cfg.MaxVMs, "max-vms", cfg.MaxVMs, "Maximum number of concurrent VMs")
	flag.IntVar(&cfg.SnapshotPoolSize, "snapshot-pool-size", cfg.SnapshotPoolSize, "Number of pre-warmed VM snapshots (0 disables)")
	flag.StringVar(&cfg.SnapshotDir, "snapshot-dir", cfg.SnapshotDir, "Directory for snapshot artifacts")
	flag.IntVar(&cfg.VNCProxyPort, "vnc-proxy-port", cfg.VNCProxyPort, "TCP port for VNC WebSocket proxy (0 disables)")
	flag.IntVar(&cfg.SnapshotDiskLimitMB, "snapshot-disk-limit-mb", cfg.SnapshotDiskLimitMB, "Max disk space for snapshots in MB (0 disables)")
	flag.BoolVar(&cfg.EnableReflection, "enable-reflection", cfg.EnableReflection, "Enable gRPC reflection (for debugging only)")
	flag.Parse()

	// 1. Validate /dev/kvm exists
	if _, err := os.Stat("/dev/kvm"); os.IsNotExist(err) {
		log.Fatal("Firecracker requires KVM; /dev/kvm not found. Ensure KVM is enabled and accessible.")
	}

	// 2. Validate Firecracker version >= v1.14.1 (CVE-2026-1386)
	if err := jailer.CheckFirecrackerBinary(context.Background(), cfg.FirecrackerBin); err != nil {
		log.Fatalf("Firecracker version validation failed: %v", err)
	}

	// Validate kernel path exists
	if cfg.KernelPath == "" {
		log.Fatal("--kernel flag is required: path to uncompressed Linux kernel ELF image")
	}
	if _, err := os.Stat(cfg.KernelPath); os.IsNotExist(err) {
		log.Fatalf("Kernel image not found: %s", cfg.KernelPath)
	}

	// Validate rootfs path exists
	if cfg.RootfsPath == "" {
		log.Fatal("--rootfs flag is required: path to ext4 rootfs image")
	}
	if _, err := os.Stat(cfg.RootfsPath); os.IsNotExist(err) {
		log.Fatalf("Rootfs image not found: %s", cfg.RootfsPath)
	}

	// 3. Start zombie reaper (PR_SET_CHILD_SUBREAPER + SIGCHLD handler)
	cancelReaper, reaperStats := reaper.StartZombieReaper(logger)
	defer cancelReaper()

	// 4. Create JailedLauncher for jail enforcement
	jl, err := jailer.NewJailedLauncher(
		jailer.WithFirecrackerBin(cfg.FirecrackerBin),
		jailer.WithJailerBin(jailerBin),
		jailer.WithChrootBaseDir("/srv/jailer"),
	)
	if err != nil {
		log.Fatalf("Failed to create JailedLauncher: %v", err)
	}

	// 5. Create VM Manager with real MachineFactory
	mgr := vm.NewManager(cfg)
	mgr.SetMachineFactory(vm.NewRealMachineFactory(jl))
	mgr.SetLogger(logger)

	// Create envd connection cache for exec/file bridge
	connCache := envdclient.NewConnCache(func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		return envdclient.DialEnvd(ctx, vsockPath)
	})

	// 5a. Conditional snapshot pool setup
	var pool *vm.Pool
	if cfg.SnapshotPoolSize > 0 {
		snapshotter := vm.NewSnapshotter(mgr, cfg.SnapshotDir, vm.NewRealRestoreFactory(jl))
		diskLimitBytes := int64(cfg.SnapshotDiskLimitMB) * 1024 * 1024
		pool = vm.NewPool(
			cfg.SnapshotPoolSize,
			cfg.SnapshotDir,
			diskLimitBytes,
			// createVM: use CreateCold to avoid pool recursion
			func(ctx context.Context) (string, error) {
				goldenID := "golden-" + uuid.New().String()[:8]
				entry, err := mgr.CreateCold(ctx, &vm.CreateRequest{SandboxID: goldenID})
				if err != nil {
					return "", err
				}
				return entry.ID, nil
			},
			// destroyVM: evict from ConnCache before destroying to avoid leaking
			// stale gRPC connections (goroutines + FDs) for golden-* VMs.
			func(ctx context.Context, sandboxID string) error {
				connCache.Remove(sandboxID)
				return mgr.Destroy(ctx, sandboxID)
			},
			// createSnapshot
			func(ctx context.Context, sandboxID string, dir string) error {
				_, err := snapshotter.Create(ctx, sandboxID, dir, false)
				return err
			},
			// healthCheck: dial envd via ConnCache to verify envd is responsive
			func(ctx context.Context, sandboxID string) error {
				entry, err := mgr.Get(sandboxID)
				if err != nil {
					return err
				}
				_, err = connCache.GetOrDial(ctx, sandboxID, entry.VMConfig.VsockPath)
				return err
			},
			logger,
		)
		mgr.SetPool(pool, snapshotter)

		// Compute current snapshot version for stale detection.
		version, err := vm.CurrentVersion(cfg.RootfsPath, &vm.VMConfig{
			KernelImagePath: cfg.KernelPath,
			RootfsPath:      cfg.RootfsPath,
		})
		if err != nil {
			logger.Warn("failed to compute snapshot version", "error", err)
		} else {
			pool.SetCurrentVersion(version)
		}

		pool.Start(context.Background())
	}

	// 6. Create gRPC server
	s := grpc.NewServer()

	// Register services
	pb.RegisterSandboxServiceServer(s, server.NewSandboxServer(mgr, jl))
	pb.RegisterExecServiceServer(s, server.NewExecServer(mgr, connCache))
	pb.RegisterFileServiceServer(s, server.NewFileServer(mgr, connCache))
	pb.RegisterBrowserServiceServer(s, server.NewBrowserServer(mgr, connCache, cfg.VNCProxyPort))

	// Register health service (TypeScript client expects grpc.health.v1.Health)
	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(s, healthServer)
	healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	// Register reflection for grpcurl/grpc_cli debugging (only when explicitly enabled).
	if cfg.EnableReflection {
		reflection.Register(s)
	}

	// 7. Start orphan sweeper with adapters
	sweepCfg := reaper.SweepConfig{
		Interval:            30 * time.Second,
		HeartbeatMultiplier: 3,
		MaxTTL:              4 * time.Hour,
		ChrootBaseDir:       "/srv/jailer",
	}
	registry := &managerRegistry{mgr: mgr, jl: jl}
	destroyer := &jailDestroyer{mgr: mgr, jl: jl}
	sweeper := reaper.NewOrphanSweeper(registry, destroyer, sweepCfg, logger)
	sweeper.Start()
	defer sweeper.Stop()

	// 7a. Start VNC WebSocket proxy HTTP listener (separate from gRPC Unix socket)
	if cfg.VNCProxyPort > 0 {
		vncProxy := server.NewVNCProxy(mgr)
		httpMux := http.NewServeMux()
		httpMux.HandleFunc("/vnc", vncProxy.HandleWS)
		// Protect /debug/vars — only expose on loopback, not publicly.
		// Access is implicitly restricted since the server binds to 127.0.0.1.
		httpMux.Handle("/debug/vars", expvar.Handler())
		go func() {
			addr := fmt.Sprintf("127.0.0.1:%d", cfg.VNCProxyPort)
			log.Printf("VNC WebSocket proxy + metrics on %s", addr)
			if err := http.ListenAndServe(addr, httpMux); err != nil && err != http.ErrServerClosed {
				log.Printf("VNC proxy server error: %v", err)
			}
		}()
	}

	// Clean up stale socket file before listening
	if err := os.Remove(cfg.SocketPath); err != nil && !os.IsNotExist(err) {
		log.Fatalf("Failed to clean up stale socket %s: %v", cfg.SocketPath, err)
	}

	// 8. Listen on Unix domain socket
	lis, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log.Fatalf("Failed to listen on %s: %v", cfg.SocketPath, err)
	}
	// Restrict socket access to owner only (do not rely on umask).
	if err := os.Chmod(cfg.SocketPath, 0600); err != nil {
		log.Fatalf("Failed to set socket permissions on %s: %v", cfg.SocketPath, err)
	}

	// 9. Signal handling for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("Received signal %v, starting graceful shutdown...", sig)

		// Signal NOT_SERVING to health watchers before destroying VMs
		healthServer.Shutdown()

		// Shut down snapshot pool before destroying VMs
		if pool != nil {
			pool.Shutdown(context.Background())
		}

		// Close all envd connections before destroying VMs
		connCache.RemoveAll()

		// 10. Graceful shutdown sequence:
		// Stop accepting -> destroy VMs -> drain gRPC
		shutdownDeps := &mainShutdownDeps{mgr: mgr, jl: jl, grpcServer: s, connCache: connCache}
		shutdownCfg := reaper.DefaultShutdownConfig()
		ctx := context.Background()
		if err := reaper.RunGracefulShutdown(ctx, shutdownDeps, shutdownCfg, logger); err != nil {
			log.Printf("Graceful shutdown error: %v", err)
		}

		log.Printf("Shutdown complete. Zombies reaped: %d", reaperStats.ZombiesReaped.Load())
	}()

	// Log startup configuration
	log.Printf("openclaw-vm-runner listening on %s", cfg.SocketPath)
	log.Printf("  kernel:         %s", cfg.KernelPath)
	log.Printf("  rootfs:         %s", cfg.RootfsPath)
	log.Printf("  firecracker-bin: %s", cfg.FirecrackerBin)
	log.Printf("  jailer-bin:     %s", jailerBin)
	log.Printf("  chroot:         /srv/jailer")
	log.Printf("  socket-dir:     %s", cfg.SocketDir)
	log.Printf("  max-vms:        %d", cfg.MaxVMs)
	log.Printf("  log-level:      %s", cfg.LogLevel)
	log.Printf("  snapshot-pool:  %d (dir: %s)", cfg.SnapshotPoolSize, cfg.SnapshotDir)
	log.Printf("  disk-limit:     %d MB", cfg.SnapshotDiskLimitMB)
	log.Printf("  vnc-proxy-port: %d", cfg.VNCProxyPort)
	log.Printf("  services:       SandboxService, ExecService, FileService, BrowserService, Health, VNCProxy")

	// Serve gRPC requests (blocks until GracefulStop/Stop)
	if err := s.Serve(lis); err != nil {
		fmt.Fprintf(os.Stderr, "gRPC server error: %v\n", err)
		os.Exit(1)
	}
}

// mainShutdownDeps adapts the main package types to the reaper.ShutdownDeps interface.
// It destroys VMs through both Manager (stops process, cleans socket) and
// JailedLauncher (cleans chroot, releases UID) during shutdown.
type mainShutdownDeps struct {
	mgr        *vm.Manager
	jl         *jailer.JailedLauncher
	grpcServer *grpc.Server
	connCache  *envdclient.ConnCache
}

func (d *mainShutdownDeps) StopAccepting() {
	d.mgr.StopAccepting()
}

func (d *mainShutdownDeps) ActiveVMIDs() []string {
	entries := d.mgr.List()
	ids := make([]string, len(entries))
	for i, e := range entries {
		ids[i] = e.ID
	}
	return ids
}

func (d *mainShutdownDeps) DestroyVM(ctx context.Context, vmID string) error {
	// Close envd gRPC connection before destroying the VM
	d.connCache.Remove(vmID)

	mgrErr := d.mgr.Destroy(ctx, vmID)
	jlErr := d.jl.Destroy(ctx, vmID)
	if mgrErr != nil {
		return mgrErr
	}
	// Ignore jailer "not found" during shutdown -- VM may not have jail entry
	if jlErr != nil && !strings.Contains(jlErr.Error(), "not found") {
		return jlErr
	}
	return nil
}

func (d *mainShutdownDeps) DrainGRPC() {
	d.grpcServer.GracefulStop()
}
