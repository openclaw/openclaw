# Tetragon Setup Guide for OpenClaw

Step-by-step instructions for deploying Tetragon alongside OpenClaw and routing security events through the OTel Collector.

## Prerequisites

- Linux host (bare metal or VM) running OpenClaw
- Kernel 4.19+ (5.x+ recommended for full BPF feature support)
- OTel Collector installed (or planned; see step 4)

## 1. Install Tetragon

OpenClaw runs on bare metal or VMs (not Kubernetes), so install Tetragon as a systemd service.

```bash
# Debian/Ubuntu
# Detect architecture (amd64 or arm64)
ARCH=$(uname -m | sed "s/x86_64/amd64/" | sed "s/aarch64/arm64/")
curl -sL https://github.com/cilium/tetragon/releases/latest/download/tetragon-linux-${ARCH}.tar.gz \
  | sudo tar -xz -C /usr/local/bin/

# Create systemd unit
sudo tee /etc/systemd/system/tetragon.service > /dev/null <<'UNIT'
[Unit]
Description=Tetragon eBPF Security Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/tetragon \
  --export-filename /var/log/tetragon/tetragon.log \
  --btf /sys/kernel/btf/vmlinux
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

sudo mkdir -p /var/log/tetragon
sudo systemctl daemon-reload
sudo systemctl enable --now tetragon
```

### Verify installation

```bash
# Check Tetragon is running
sudo systemctl status tetragon

# Confirm events are being written
tail -1 /var/log/tetragon/tetragon.log | jq .
```

## 2. Apply TracingPolicies

Apply each policy from the `policies/` directory. On Kubernetes, use `kubectl apply`; on bare metal, place them in Tetragon's policy directory.

### Apply policies

```bash
sudo mkdir -p /etc/tetragon/tetragon.tp.d
sudo cp policies/*.yaml /etc/tetragon/tetragon.tp.d/
sudo systemctl restart tetragon
```

### Verify policies are loaded

```bash
# Trigger a test event
cat /etc/passwd > /dev/null
tail -5 /var/log/tetragon/tetragon.log | jq 'select(.process_kprobe != null)'
```

## 3. Configure log output

Tetragon writes JSON events to the configured export file. The default path used in this guide is `/var/log/tetragon/tetragon.log`.

For log rotation, configure logrotate:

```bash
sudo tee /etc/logrotate.d/tetragon > /dev/null <<'LOGROTATE'
/var/log/tetragon/tetragon.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE
```

## 4. Set up OTel Collector

Use the provided [collector-config.yaml](collector-config.yaml) as a starting point.

### Install the Collector

```bash
# Download the contrib distribution (includes filelog receiver)
ARCH=$(uname -m | sed "s/x86_64/amd64/" | sed "s/aarch64/arm64/")
curl -sL https://github.com/open-telemetry/opentelemetry-collector-releases/releases/latest/download/otelcol-contrib_linux_${ARCH}.tar.gz \
  | sudo tar -xz -C /usr/local/bin/
```

### Configure

Copy or merge the provided config into your collector configuration:

```bash
sudo mkdir -p /etc/otelcol
sudo cp collector-config.yaml /etc/otelcol/config.yaml
```

Set your backend endpoint:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-backend:4317"
export OTEL_EXPORTER_OTLP_HEADERS_AUTH="your-api-key"
```

### Run

```bash
otelcol-contrib --config /etc/otelcol/config.yaml
```

Create the environment file referenced by the systemd unit:

```bash
sudo tee /etc/otelcol/env > /dev/null <<'ENV'
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-backend:4317
OTEL_EXPORTER_OTLP_HEADERS_AUTH=your-api-key
ENV
sudo chmod 600 /etc/otelcol/env
```

Or as a systemd service:

```bash
sudo tee /etc/systemd/system/otelcol.service > /dev/null <<'UNIT'
[Unit]
Description=OpenTelemetry Collector
After=network.target

[Service]
EnvironmentFile=/etc/otelcol/env
ExecStart=/usr/local/bin/otelcol-contrib --config /etc/otelcol/config.yaml
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now otelcol
```

## 5. Verify events are flowing

### Check Tetragon events

```bash
# Trigger a test: read a sensitive file
cat /etc/passwd > /dev/null

# Verify it appears in the log
tail -20 /var/log/tetragon/tetragon.log | jq 'select(.process_kprobe != null) | {event: .process_kprobe.function_name, file: .process_kprobe.args[1].file_arg}'
```

### Check OTel Collector

```bash
# The collector logs should show successful exports
journalctl -u otelcol -f --no-pager | head -20
```

### Check your backend

Query for logs where `service.name = "openclaw-security"` in your observability backend. You should see Tetragon events appearing within a few seconds of the batch interval.

## 6. Tuning

The default policies are intentionally broad. In production you will want to reduce noise:

- **Narrow binary selectors.** The process-exec policy (`01-process-exec.yaml`) watches `/usr/bin/node` and `/usr/local/bin/node`. If OpenClaw runs from a different path (e.g. nvm, Homebrew, container image), update the `matchBinaries` values. Remove paths that do not apply to your setup.
- **Exclude known-safe file access.** If your application legitimately reads `.env` on every startup, add a `matchActions` with `action: NoPost` for that specific path, or remove the pattern from `02-sensitive-files.yaml`.
- **Rate-limit shell events.** The dangerous-commands policy fires on every `/bin/bash` and `/bin/sh` exec. On busy hosts this can be noisy. Consider removing the shell selector and relying on correlation with `curl`/`wget` events in your backend instead.
- **Adjust OTel Collector batch size.** If event volume is high, increase `send_batch_size` and `timeout` in `collector-config.yaml` to reduce export overhead.
- **Filter at the Collector.** Add a `filter` processor to drop low-value events before they reach your backend:

  ```yaml
  processors:
    filter/tetragon:
      logs:
        exclude:
          match_type: strict
          bodies:
            - '{"process_exec":null}'
  ```

## Combining with diagnostics-otel

For a complete picture, run the OpenClaw [diagnostics-otel](/gateway/logging) plugin alongside Tetragon:

- **diagnostics-otel** provides application-level spans: message processing, tool calls, token usage, and security pattern detection
- **Tetragon** provides kernel-level events: actual process execution, file access, privilege changes

Both can export to the same backend using the same OTel Collector instance. Use `service.name` to distinguish between `openclaw` (application) and `openclaw-security` (kernel) telemetry.
