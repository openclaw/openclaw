#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/presidents_clone_b.sh 4
N="${1:-4}"

HARNESS_DIR="$(cd "$(dirname "$0")/../agents/president-b-harness" && pwd)"
BASE_DIR="/home/spryguy/openclaw-workspace/agents"
CFG="/home/spryguy/.openclaw/openclaw.json"

[[ -d "$HARNESS_DIR" ]] || { echo "ERROR: missing harness dir: $HARNESS_DIR" >&2; exit 1; }
[[ -f "$CFG" ]] || { echo "ERROR: missing config: $CFG" >&2; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp -a "$CFG" "${CFG}.bak_presbclone_${ts}"

# Create/overwrite workspaces from harness
for i in $(seq 1 "$N"); do
  dst="${BASE_DIR}/president-b${i}"
  mkdir -p "$dst"
  cp -a "${HARNESS_DIR}/." "$dst/"
done

# Patch openclaw.json to include president-b1..N (Codex 5.2, no fallbacks)
python3 - <<PY
import json, copy, sys

CFG="${CFG}"
N=int("${N}")

with open(CFG,"r") as f: cfg=json.load(f)
agents=cfg.setdefault("agents",{})
lst=agents.setdefault("list",[])

tmpl=None
for a in lst:
    if a.get("id")=="president-b":
        tmpl=a
        break
if tmpl is None:
    sys.exit("ERROR: president-b not found in agents.list")

existing={a.get("id") for a in lst}

for i in range(1, N+1):
    nid=f"president-b{i}"
    if nid in existing:
        continue
    a=copy.deepcopy(tmpl)
    a["id"]=nid
    a["name"]=f"Strike Team B President {i}"
    a.setdefault("identity",{})
    a["identity"]["name"]=f"PRESIDENT_B{i}"
    a["identity"]["emoji"]=f"🅱️{i}"
    a.setdefault("model",{})
    a["model"]["primary"]="openai-codex/gpt-5.2-codex"
    a["model"]["fallbacks"]=[]
    a["workspace"]=f"/home/spryguy/openclaw-workspace/agents/{nid}"
    lst.append(a)

with open(CFG,"w") as f: json.dump(cfg,f,indent=2,sort_keys=True)
print("OK ensured president-b1..president-b%d in openclaw.json" % N)
PY

systemctl --user restart openclaw-gateway.service
echo "OK restarted gateway"
