#!/usr/bin/env bash
# Make the upstream OpenClaw Dockerfile build on Railway's builder.
#
# Railway's Metal builder rejects BuildKit `--mount=type=bind` entirely and only
# accepts `--mount=type=cache` with its own `s/<service>-` id prefix. So we:
#   1) strip all cache mounts and convert bind mounts to COPY (idempotent), then
#   2) append the PaaS Control UI config + the volume-fix entrypoint wiring.
# Standard `docker build` accepts the mounts (that's why the CI build-gate passed
# while Railway failed) — this makes the image build on BOTH.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f Dockerfile ] || { echo "no Dockerfile, nothing to patch"; exit 0; }

# 1) Strip Railway-incompatible BuildKit mounts.
if grep -q -- '--mount=' Dockerfile; then
  python3 <<'PY'
import re
path = "Dockerfile"
lines = open(path).read().split("\n")
out, i, n = [], 0, len(lines)
def binds(block):
    cs = []
    blob = " ".join(block)
    for m in re.finditer(r'--mount=type=bind,(\S+)', blob):
        kv = dict(p.split("=", 1) for p in m.group(1).split(",") if "=" in p)
        s, t = kv.get("source"), kv.get("target")
        if s and t:
            cs.append(f"COPY {s} {t}")
    return cs
while i < n:
    line = lines[i]
    if re.match(r'^RUN\s+--mount=', line):
        blk, j = [], i
        while j < n and re.search(r'--mount=', lines[j]) and lines[j].rstrip().endswith("\\"):
            blk.append(lines[j]); j += 1
        out.extend(binds(blk)); out.append("RUN \\"); i = j; continue
    out.append(line); i += 1
res = "\n".join(out)
assert "--mount=" not in res, "mounts remain after strip"
open(path, "w").write(res)
PY
  echo "patched: stripped Railway-incompatible mounts (cache removed, bind -> COPY)"
else
  echo "patched: no BuildKit mounts to strip"
fi

# 2) Append PaaS Control UI config + volume entrypoint (marker-guarded).
MARKER_START="# >>> railway-paas-control-ui >>>"
if grep -qF "$MARKER_START" Dockerfile; then
  echo "patched: PaaS block already present (idempotent no-op)"
  exit 0
fi
cat >> Dockerfile <<'BLOCK'

# >>> railway-paas-control-ui >>>
# Railway/Render/Fly proxy traffic through their own domains, so allow the
# Control UI host-header origin fallback and skip device auth. Appended by
# scripts/railway-patch-dockerfile.sh (marker-guarded; safe to re-run).
USER root
RUN mkdir -p /app/.openclaw \
 && printf '{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}}}\n' > /app/.openclaw/openclaw.json \
 && chown -R node:node /app/.openclaw
ENV OPENCLAW_CONFIG_PATH=/app/.openclaw/openclaw.json
# Railway volumes mount root-owned; this entrypoint (run as root) chowns the
# mounted state dir, then drops to the unprivileged node user to start the gateway.
COPY scripts/railway-entrypoint.sh /usr/local/bin/railway-entrypoint.sh
RUN chmod +x /usr/local/bin/railway-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/railway-entrypoint.sh"]
CMD []
# <<< railway-paas-control-ui <<<
BLOCK
echo "patched: appended Railway PaaS config + volume-perms entrypoint"
