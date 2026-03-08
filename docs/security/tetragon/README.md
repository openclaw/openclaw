# Tetragon Runtime Security for OpenClaw

## What is Tetragon

[Tetragon](https://tetragon.io/) is an eBPF-based runtime security observability tool from the Cilium project. It hooks directly into the Linux kernel to monitor process execution, file access, network connections, and privilege changes with negligible overhead and no application-level instrumentation.

## Why use Tetragon with OpenClaw

OpenClaw agents execute tool calls, run shell commands, and access files on behalf of users. While the application layer provides guardrails, kernel-level visibility gives defense-in-depth:

- **Process execution monitoring** -- see every command an agent spawns, including nested child processes
- **Sensitive file access detection** -- alert when agents read credentials, SSH keys, or system files
- **Privilege escalation detection** -- catch setuid/setgid changes and capability modifications
- **Dangerous command detection** -- flag destructive operations like `rm -rf` or piped remote code execution

Tetragon operates below the application, so it cannot be bypassed by prompt injection or tool-call manipulation.

## Architecture

```
  OpenClaw Gateway
        |
        v
  Linux Kernel (eBPF hooks)
        |
        v
  Tetragon Agent  -->  JSON event logs (/var/log/tetragon/tetragon.log)
                              |
                              v
                    OTel Collector (filelog receiver)
                              |
                              v
                    Observability Backend (Grafana, Datadog, etc.)
```

1. **Tetragon** runs as a DaemonSet (Kubernetes) or system service, loading TracingPolicy CRDs that define what kernel events to capture.
2. **JSON logs** are written to `/var/log/tetragon/tetragon.log` (configurable).
3. **OTel Collector** ingests the JSON logs via the `filelog` receiver, parses them, and forwards to your observability backend.
4. The same backend can receive OpenClaw application-level OTel data from the `diagnostics-otel` plugin, giving a unified view of agent behavior from application to kernel.

## Contents

| File                                                                           | Description                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| [policies/01-process-exec.yaml](policies/01-process-exec.yaml)                 | Monitor all process execution by OpenClaw |
| [policies/02-sensitive-files.yaml](policies/02-sensitive-files.yaml)           | Alert on access to sensitive files        |
| [policies/03-privilege-escalation.yaml](policies/03-privilege-escalation.yaml) | Detect privilege escalation attempts      |
| [policies/04-dangerous-commands.yaml](policies/04-dangerous-commands.yaml)     | Monitor dangerous command patterns        |
| [collector-config.yaml](collector-config.yaml)                                 | OTel Collector config for Tetragon logs   |
| [SETUP.md](SETUP.md)                                                           | Step-by-step setup guide                  |

## Next Steps

1. Follow the [Setup Guide](SETUP.md) to deploy Tetragon and the OTel Collector.
2. Apply the TracingPolicies from the `policies/` directory.
3. Pair with the [diagnostics-otel](/gateway/logging) plugin for application-level span enrichment.
