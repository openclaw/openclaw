# PDF Pipeline Docker Setup

## Goal

Make the autonomous PDF extraction pipeline fully self-contained and reliable inside Docker, with no manual intervention needed.

---

## What We Built

### New Docker image layer (`OPENCLAW_INSTALL_PIPELINE`)

Enabled via build arg `OPENCLAW_INSTALL_PIPELINE=1`. Installs:

- Java 17 JRE (`openjdk-17-jre-headless`)
- Python venv at `/opt/ocpipeline`
- `opendataloader-pdf[hybrid]==2.2.1` with CPU-only torch pre-installed
- `libgl1` (required by OpenCV/EasyOCR)
- `ripgrep`, `git`, `curl`

The `OPENCLAW_PIPELINE_PY_PKG` build arg allows pinning override without editing the Dockerfile.

### New scripts

| File                                    | Purpose                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scripts/preflight-pipeline.sh`         | Fail-fast at startup: checks Java 17+, `opendataloader_pdf` importable, all artifact/log paths writable |
| `scripts/entrypoint-pipeline-runner.sh` | Secrets loader + preflight + PID-based concurrency lock + retry loop + structured JSONL alert output    |

### New compose services (`docker-compose.secrets-canary.yml`)

**`pdf-hybrid`** — Docling Fast HTTP server

- Binds to `0.0.0.0:5002` inside the container
- `expose: ["5002"]` — internal to the compose network only, not published to host
- Healthcheck on `GET /health`
- `restart: unless-stopped`
- Accessible from all services at `http://pdf-hybrid:5002`

**`pdf-pipeline`** — Non-interactive pipeline scheduler

- Depends on both gateway and `pdf-hybrid` being healthy before starting
- Runs `linear_eng_pipeline.py` via the venv Python in a retry loop
- Exit code 1 = fatal (no retry); other non-zero = transient (retries up to `PIPELINE_MAX_RETRIES`)
- Writes structured alerts to `logs/pipeline/pipeline-alerts.jsonl`

### Boot persistence

`~/.config/systemd/user/openclaw-stack.service` is enabled with `loginctl linger` active.  
The full stack starts automatically on reboot via `docker compose up -d --remove-orphans`.

### Routing

`OPENCLAW_PDF_OCR_ROUTE_MAP` is set in both gateway and pdf-pipeline environments:

```
{"*":{"hybrid":"docling-fast","hybrid_url":"http://pdf-hybrid:5002"}}
```

---

## Issues Hit and Fixed

| Problem                                   | Root Cause                                                                                                       | Fix                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Build OOM / disk full                     | `[hybrid]` extra pulls PyTorch + full CUDA stack (~8 GB)                                                         | Pre-install CPU-only torch via PyTorch CPU index before the hybrid package                                                        |
| Named volumes root-owned                  | Docker creates mount-point dirs as root, blocking node (UID 1000) writes                                         | Removed named volumes; host bind mount handles persistence; fixed dir ownership via alpine container                              |
| `opendataloader_pdf` has no `__version__` | Package doesn't expose that attribute                                                                            | Changed preflight to import `convert` and check callable; version read from `pip show`                                            |
| POST `/v1/convert/file` → 500             | `libGL.so.1` missing — docling always initialises the EasyOCR model on first request even with `force_ocr=False` | Installed `libgl1`; baked into Dockerfile                                                                                         |
| `pdf-pipeline` always `unhealthy`         | Service inherits Dockerfile `HEALTHCHECK` which probes gateway port 18789 — not running in this container        | Added compose-level `healthcheck` override: checks lockfile `mtime` < 10 min (written by `linear_eng_pipeline.py` each run cycle) |

---

## Current Stack State

```
openclaw-gateway-secrets   healthy   127.0.0.1:18789
openclaw-pdf-hybrid-1      healthy   pdf-hybrid:5002 (internal only)
openclaw-pdf-pipeline-1    healthy   cycling every 5m, alerts log empty
```

Preflight output on every start:

```
OK   java openjdk version "17.0.18"
OK   opendataloader_pdf 2.2.1
OK   writable .../shared/raw/papers
OK   writable .../shared/raw/assets
OK   writable .../workspace-engineering/.eng/pipeline
OK   writable .../logs/pipeline
preflight passed
```

End-to-end extraction confirmed working:

```
ok: True
markdown_bytes: 7944
json_bytes: 64674
image_count: 31
route: opendataloader-hybrid
hybrid_backend: docling-fast
```

---

## Rebuild Reference

After any Dockerfile change:

```bash
docker compose -f docker-compose.secrets-canary.yml build
docker compose -f docker-compose.secrets-canary.yml up -d
```

To check all service statuses:

```bash
docker compose -f docker-compose.secrets-canary.yml ps
```

To follow all logs:

```bash
docker compose -f docker-compose.secrets-canary.yml logs -f
```
