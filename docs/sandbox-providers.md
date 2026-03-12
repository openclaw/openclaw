# Pluggable Sandbox Provider Architecture

## Overview

This PR introduces a pluggable sandbox backend system with three isolation tiers and full browser automation support. The system auto-detects the strongest available isolation backend on the host.

| Tier     | Backend     | Isolation                  | Requirement                       |
| -------- | ----------- | -------------------------- | --------------------------------- |
| Tier 1   | Docker      | Container namespaces       | Docker installed                  |
| Tier 1.5 | gVisor      | User-space kernel (Sentry) | `runsc` OCI runtime               |
| Tier 2   | Firecracker | Hardware KVM               | `/dev/kvm` + `firecracker` binary |

Auto-detection order: Firecracker > gVisor > Docker (strongest available wins).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │              ISandboxProvider interface                  │  │
│  │  ensureSandbox() | exec() | destroy() | status()        │  │
│  │  + IBrowserCapable (optional duck-typed interface)      │  │
│  └────────┬──────────────────┬────────────────┬────────────┘  │
│           │                  │                │               │
│  ┌────────▼──────┐  ┌───────▼────────┐  ┌───▼────────────┐  │
│  │ DockerProvider │  │ GVisorProvider │  │ Firecracker    │  │
│  │               │  │  --runtime=    │  │ Provider       │  │
│  │ wraps existing│  │    runsc       │  │                │  │
│  │ docker.ts     │  │               │  │  gRPC/vsock    │  │
│  └───────────────┘  └───────────────┘  └──────┬─────────┘  │
│                                                │             │
└────────────────────────────────────────────────┼─────────────┘
                                                 │ gRPC over vsock
                                    ┌────────────▼────────────┐
                                    │   openclaw-vm-runner     │
                                    │   (Go, host-side)        │
                                    │                          │
                                    │   SandboxService (gRPC)  │
                                    │   BrowserService (gRPC)  │
                                    │   Snapshot Pool Manager  │
                                    └────────────┬────────────┘
                                                 │ Firecracker API
                                    ┌────────────▼────────────┐
                                    │   Firecracker MicroVM    │
                                    │   (separate Linux kernel)│
                                    │                          │
                                    │   envd (guest agent)     │
                                    │   ├── ProcessService     │
                                    │   ├── FileService        │
                                    │   ├── BrowserService     │
                                    │   └── HealthService      │
                                    └─────────────────────────┘
```

## Components

### TypeScript (src/agents/sandbox/)

| File                                | Purpose                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `provider.ts`                       | `ISandboxProvider` interface, `IBrowserCapable` interface, `SandboxBackend` type |
| `provider-resolver.ts`              | Auto-detection logic, provider caching, health checks                            |
| `providers/docker-provider.ts`      | Docker backend — wraps existing `docker.ts`                                      |
| `providers/gvisor-provider.ts`      | gVisor backend — Docker with `--runtime=runsc`                                   |
| `providers/firecracker-provider.ts` | Firecracker backend — gRPC to vm-runner                                          |
| `grpc/channel.ts`                   | gRPC channel management for vsock/TCP                                            |
| `grpc/client.ts`                    | Typed gRPC client for SandboxService                                             |
| `grpc/errors.ts`                    | gRPC error mapping to provider errors                                            |
| `grpc/health.ts`                    | gRPC health check client                                                         |
| `hardening/resource-limits.ts`      | CPU, memory, PID, disk limits                                                    |
| `hardening/network-isolation.ts`    | Network namespace and firewall rules                                             |
| `hardening/filesystem.ts`           | Read-only root, tmpfs, bind mount validation                                     |
| `hardening/secret-filter.ts`        | Environment variable secret filtering                                            |
| `hardening/browser-security.ts`     | URL validation, SSRF protection                                                  |
| `browser/exec-browser.ts`           | Browser automation via Playwright exec (Docker/gVisor)                           |

### Go (openclaw-vm-runner/)

Host-side daemon managing Firecracker MicroVMs.

| Package               | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `cmd/vm-runner`       | Main entry point, gRPC server, CLI flags  |
| `cmd/envd`            | Guest agent binary (runs inside MicroVM)  |
| `internal/vm`         | VM lifecycle, snapshot pool, LRU eviction |
| `internal/envd`       | Guest-side service implementations        |
| `internal/envdclient` | Host-to-guest gRPC client over vsock      |
| `internal/server`     | Host-side gRPC service (proxy to envd)    |
| `internal/config`     | Configuration management                  |
| `internal/jailer`     | Firecracker jailer integration            |
| `internal/reaper`     | Zombie process reaper (PID 1 in VM)       |

### Proto definitions (proto/)

| Proto                               | Services                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| `openclaw/sandbox/v1/sandbox.proto` | SandboxService — CreateSandbox, DestroySandbox, ExecCommand    |
| `openclaw/sandbox/v1/exec.proto`    | ExecService — Exec, ExecStream                                 |
| `openclaw/sandbox/v1/file.proto`    | FileService — ReadFile, WriteFile, ListDir                     |
| `openclaw/sandbox/v1/browser.proto` | BrowserService — Navigate, Click, Screenshot, EvaluateJS, etc. |
| `envd/v1/process.proto`             | ProcessService (guest) — StartProcess, Signal, Wait            |
| `envd/v1/filesystem.proto`          | FileSystemService (guest) — Read, Write, Stat, List            |
| `envd/v1/browser.proto`             | BrowserService (guest) — chromedp-based browser control        |
| `envd/v1/health.proto`              | HealthService (guest) — health checks                          |

## Security Model

### Isolation Comparison

| Attack Vector            | Docker                | gVisor                            | Firecracker                   |
| ------------------------ | --------------------- | --------------------------------- | ----------------------------- |
| Kernel CVE escape        | Host kernel exposed   | Sentry blocks (Go, memory-safe)   | Separate kernel per VM        |
| Docker socket escalation | Root on host          | Same risk if socket mounted       | No docker.sock                |
| Shared kernel            | Yes (1 kernel)        | Sentry intercepts (~274 syscalls) | No (separate kernel per VM)   |
| io_uring/eBPF exploit    | Possible              | Disabled in Sentry                | Contained in VM               |
| Attack surface           | ~350 syscalls to host | ~70 host syscalls via Sentry      | ~25 host syscalls via seccomp |

### SSRF Protection (Browser)

URL validation blocks:

- Private IPs: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`
- Cloud metadata: `169.254.169.254`, `fd00:ec2::254`
- Protocols: only `http://` and `https://` allowed
- Decimal/hex IP obfuscation detection

### Browser Automation

10 RPCs across all three backends:

| Backend     | Engine               | Method                                     |
| ----------- | -------------------- | ------------------------------------------ |
| Firecracker | chromedp (Go, in-VM) | Native CDP via envd BrowserService         |
| Docker      | Playwright (Node.js) | `node -e` exec with stdout marker protocol |
| gVisor      | Playwright (Node.js) | Same as Docker with `--runtime=runsc`      |

Operations: Navigate, Click, Type, Screenshot, EvaluateJS, ExtractContent, WaitForSelector, GetPageInfo, LaunchBrowser, CloseBrowser.

### Snapshot Pool (Firecracker)

- Golden snapshot: envd running, no browser (stateless)
- Warm pool: pre-booted VMs ready for instant assignment (~3ms restore vs ~125ms cold boot)
- LRU eviction with configurable disk limit (default: 5GB)
- SHA256 versioning for stale snapshot detection
- Background replenishment keeps pool at target size
- expvar metrics at `/debug/vars`

## Configuration

New fields added to `SandboxConfig`:

```typescript
{
  // Existing fields unchanged...
  backend: "auto" | "docker" | "gvisor" | "firecracker",  // default: "auto"
  resourceLimits?: {
    cpus?: number;           // default: 1
    memoryMB?: number;       // default: 512
    pidsLimit?: number;      // default: 256
    diskMB?: number;         // default: 1024
  },
  networkMode?: "bridge" | "none" | "host",  // default: "bridge"
  env?: Record<string, string>  // filtered through secret-filter
}
```

## Related Issues

- #27342 — Proposal: Optional BoxLite sandbox backend
- #34124 — Allow sandbox browser to access dev servers via network namespace sharing
- #26980 — Proposal: Native Plugin Sandboxing with WASM
- #41300 — Add web agent tool for multi-step browser automation
- #41308 — feat(exec): add cloud execution provider (host="cloud")
