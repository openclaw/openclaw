#!/usr/bin/env bash
#
# prune-gateway-images.sh — free disk on an agent host by removing OLD, UNUSED
# gateway images. Runs LOCALLY on the agent host (uses the host's own docker).
#
# Each gateway image is ~8.5 G; every roll pulls a new one, so hosts accumulate
# tags until a `docker pull` fails with "no space left on device" (2026-06-18
# incident on the US host). This prunes the backlog safely.
#
# KEEP policy — a gateway tag is kept iff it is EITHER:
#   (a) referenced by any container, running or stopped (`docker ps -a`); or
#   (b) among the KEEP_RECENT most-recent tags by version (rollback depth).
# Everything else is removed with `docker rmi` (never -f — which refuses in-use
# images anyway). All tags are re-pullable from Artifact Registry, so deleting a
# local copy is non-destructive.
#
# Usage (on the host, or streamed: `ssh host 'bash -s -- 2' < prune-gateway-images.sh`):
#   prune-gateway-images.sh [KEEP_RECENT] [--dry-run]
#     KEEP_RECENT  most-recent tags to always keep (default 2)
#     --dry-run    report what would be removed; remove nothing
#
set -uo pipefail

REPO="europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway"

KEEP_RECENT=2
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    ''|*[!0-9]*) echo "prune: bad arg '$arg' (want KEEP_RECENT integer and/or --dry-run)" >&2; exit 2 ;;
    *) KEEP_RECENT="$arg" ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "prune: docker not found" >&2; exit 2; }

# All local gateway tags, oldest -> newest (version sort handles N>9 correctly).
mapfile -t ALL_TAGS < <(docker images "$REPO" --format '{{.Tag}}' | grep -vxE '<none>' | sort -uV)
if [[ "${#ALL_TAGS[@]}" -eq 0 ]]; then
  echo "prune: no gateway images present; nothing to do"
  exit 0
fi

# Tags referenced by ANY container (running or stopped) — never remove these.
mapfile -t INUSE_TAGS < <(docker ps -a --format '{{.Image}}' | grep -F "$REPO:" | sed "s#^$REPO:##" | sort -u)

# The KEEP_RECENT most-recent tags (rollback depth), regardless of use.
mapfile -t RECENT_TAGS < <(printf '%s\n' "${ALL_TAGS[@]}" | tail -n "$KEEP_RECENT")

declare -A KEEP=()
for t in "${INUSE_TAGS[@]:-}" "${RECENT_TAGS[@]:-}"; do
  [[ -n "$t" ]] && KEEP["$t"]=1
done

echo "prune-gateway-images: ${#ALL_TAGS[@]} local gateway tag(s); keep in-use (${#INUSE_TAGS[@]}) + ${KEEP_RECENT} most-recent$([[ $DRY_RUN -eq 1 ]] && echo ' [dry-run]')"
BEFORE=$(df -h / | awk 'NR==2{print $4" free, "$5" used"}')

removed=0
for t in "${ALL_TAGS[@]}"; do
  if [[ -n "${KEEP[$t]:-}" ]]; then
    echo "  keep         $t"
  elif [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  would remove $t"
  elif docker rmi "$REPO:$t" >/dev/null 2>&1; then
    echo "  removed      $t"
    removed=$((removed + 1))
  else
    echo "  skip         $t (in use or removal failed)"
  fi
done

AFTER=$(df -h / | awk 'NR==2{print $4" free, "$5" used"}')
echo "prune-gateway-images: removed ${removed} tag(s); disk: ${BEFORE} -> ${AFTER}"
