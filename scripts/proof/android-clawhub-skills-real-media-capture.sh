#!/usr/bin/env bash
set -euo pipefail

mkdir -p proof-output
: "${AVD_NAME:=OpenClaw_ClawHub_Skills_API35}"
APP_ID="ai.openclaw.app"
SETTINGS_TEXT="Settings"
SKILLS_TEXT="Skills"
CLAW_HUB_TEXT="Find on ClawHub"
REVIEW_TITLE="Review ClawHub skill"
PROOF_SKILL_TITLE="Proof Clean Skill"
REVIEW_SKILL_TITLE="Proof Review Skill"
MALICIOUS_SKILL_TITLE="Proof Malicious Skill"
GATEWAY_PORT="18789"
CLAW_HUB_PORT="18880"
GATEWAY_DEVICE_HOST="10.0.2.2"
STATE_DIR="$(pwd)/proof-output/openclaw-state"
CONFIG_PATH="$(pwd)/proof-output/openclaw-proof-config.json"
GATEWAY_PID=""
CLAW_HUB_PID=""
EMU_PID=""

APK="$(find apps/android/app/build/outputs/apk/play/debug -maxdepth 1 -type f -name '*.apk' | sort | head -n 1)"
if [ -z "${APK}" ] || [ ! -f "${APK}" ]; then
  echo "No Play debug APK found under apps/android/app/build/outputs/apk/play/debug" >&2
  exit 1
fi
printf '%s\n' "${APK}" > proof-output/apk-path.txt

cleanup() {
  if [ -n "${GATEWAY_PID}" ]; then
    kill "${GATEWAY_PID}" >/dev/null 2>&1 || true
    wait "${GATEWAY_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${CLAW_HUB_PID}" ]; then
    kill "${CLAW_HUB_PID}" >/dev/null 2>&1 || true
    wait "${CLAW_HUB_PID}" >/dev/null 2>&1 || true
  fi
  timeout 5 adb emu kill >/dev/null 2>&1 || true
  if [ -n "${EMU_PID}" ]; then
    wait "${EMU_PID}" >/dev/null 2>&1 || true
  fi
}

dump_debug() {
  local exit_code="$?"
  {
    echo "capture_exit_code=${exit_code}"
    echo "gateway_pid=${GATEWAY_PID:-unset}"
    [ -n "${GATEWAY_PID}" ] && ps -fp "${GATEWAY_PID}" || true
    echo "clawhub_pid=${CLAW_HUB_PID:-unset}"
    [ -n "${CLAW_HUB_PID}" ] && ps -fp "${CLAW_HUB_PID}" || true
    echo "emulator_pid=${EMU_PID:-unset}"
    [ -n "${EMU_PID}" ] && ps -fp "${EMU_PID}" || true
    echo "adb_devices:"; adb devices || true
    echo "gateway_log_tail:"; tail -240 proof-output/gateway.log || true
    echo "clawhub_log_tail:"; tail -200 proof-output/clawhub-mock.log || true
    echo "emulator_log_tail:"; tail -200 proof-output/emulator.log || true
    echo "capture_log_tail:"; tail -200 proof-output/capture.log || true
  } > proof-output/capture-debug.txt 2>&1
  cat proof-output/capture-debug.txt >&2 || true
  exit "${exit_code}"
}
trap dump_debug ERR
trap cleanup EXIT

run_openclaw() {
  OPENCLAW_STATE_DIR="${STATE_DIR}" \
  OPENCLAW_CONFIG_PATH="${CONFIG_PATH}" \
  OPENCLAW_CLAWHUB_URL="http://127.0.0.1:${CLAW_HUB_PORT}" \
  OPENCLAW_SKIP_CHANNELS=1 \
  NODE_DISABLE_COMPILE_CACHE=1 \
  node openclaw.mjs "$@"
}

run_openclaw_gateway_call() {
  run_openclaw gateway call "$@"
}

redact_json_file() {
  local input_path="$1"
  local output_path="$2"
  python3 - "$input_path" "$output_path" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dest = Path(sys.argv[2])

try:
    data = json.loads(src.read_text(encoding="utf-8"))
except Exception:
    dest.write_text(src.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8")
    raise SystemExit(0)

def redact(value):
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if "token" in str(key).lower() or "secret" in str(key).lower():
                result[key] = "<redacted>"
            else:
                result[key] = redact(child)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value

dest.write_text(json.dumps(redact(data), ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
PY
}

write_gateway_config() {
  mkdir -p "${STATE_DIR}"
  cat > "${CONFIG_PATH}" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "bind": "loopback",
    "auth": { "mode": "none" }
  }
}
JSON
}

start_clawhub_fixture() {
  python3 - <<'PY'
import io
import zipfile
from pathlib import Path

for slug, title in {
    "proof-clean-skill": "Proof Clean Skill",
    "proof-review-skill": "Proof Review Skill",
}.items():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("SKILL.md", f"---\nname: {slug}\ndescription: {title} installed by the PR 101864 exact-head media proof.\n---\n")
    Path(f"proof-output/{slug}.zip").write_bytes(buf.getvalue())
PY
  cat > proof-output/clawhub-fixture-server.py <<'PY'
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 18880
LOG = "proof-output/clawhub-fixture.jsonl"
SKILLS = {
    "proof-clean-skill": {"displayName": "Proof Clean Skill", "verdict": "clean"},
    "proof-review-skill": {"displayName": "Proof Review Skill", "verdict": "review"},
    "proof-malicious-skill": {"displayName": "Proof Malicious Skill", "verdict": "malicious"},
}
VERSION = "1.2.3"
OWNER = "openclaw"
COUNTS = {slug: {"detail": 0, "verdict": 0, "download": 0} for slug in SKILLS}

def log(event, **data):
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": time.time(), "event": event, **data}, sort_keys=True) + "\n")

class Handler(BaseHTTPRequestHandler):
    server_version = "ClawHubProof/1.0"

    def _send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_bytes(self, payload, content_type="application/zip", status=200):
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _skill_payload(self, slug):
        skill = SKILLS[slug]
        return {
            "slug": slug,
            "displayName": skill["displayName"],
            "summary": f"Deterministic {skill['verdict']} ClawHub fixture for Android media proof.",
            "version": VERSION,
            "ownerHandle": OWNER,
        }

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        log("GET", path=parsed.path, query=qs)
        if parsed.path == "/api/v1/search":
            self._send_json({"results": [self._skill_payload(slug) for slug in SKILLS]})
            return
        if parsed.path.startswith("/api/v1/skills/") and parsed.path.count("/") == 4:
            slug = parsed.path.rsplit("/", 1)[-1]
            if slug not in SKILLS:
                self._send_json({"error": "not_found"}, status=404)
                return
            COUNTS[slug]["detail"] += 1
            skill = self._skill_payload(slug)
            self._send_json({
                "skill": {
                    "slug": slug,
                    "displayName": skill["displayName"],
                    "summary": skill["summary"],
                    "description": "Proof skill used to capture the Android ClawHub install-review dialog.",
                    "topics": ["proof", "android", "clawhub"],
                    "tags": {"latest": VERSION},
                    "stats": {"downloads": 42, "installs": 7, "versions": 1},
                    "createdAt": 1700000000000,
                    "updatedAt": 1700000000000,
                },
                "owner": {
                    "handle": OWNER,
                    "displayName": "OpenClaw Proof",
                    "image": "https://example.invalid/openclaw-proof.png",
                },
                "latestVersion": {
                    "version": VERSION,
                    "createdAt": 1700000000000,
                    "changelog": "Proof release for Android media capture.",
                    "license": "MIT",
                },
            })
            return
        if parsed.path.endswith("/install"):
            slug = parsed.path.split("/")[-2]
            if slug not in SKILLS:
                self._send_json({"error": "not_found"}, status=404)
                return
            self._send_json({
                "ok": True,
                "slug": slug,
                "installKind": "archive",
                "archive": {
                    "version": VERSION,
                    "downloadUrl": f"http://127.0.0.1:{PORT}/api/v1/download?slug={slug}&version={VERSION}",
                },
            })
            return
        if parsed.path == "/api/v1/download":
            slug = (qs.get("slug") or [""])[0]
            if slug not in ("proof-clean-skill", "proof-review-skill"):
                self._send_json({"error": "blocked"}, status=403)
                return
            COUNTS[slug]["download"] += 1
            log("download", slug=slug, count=COUNTS[slug]["download"])
            self._send_bytes(open(f"proof-output/{slug}.zip", "rb").read())
            return
        self._send_json({"error": "not_found", "path": parsed.path}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("content-length") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception:
            payload = {}
        log("POST", path=parsed.path, payload=payload)
        if parsed.path == "/api/v1/skills/-/security-verdicts":
            items = []
            for request_item in payload.get("items", []):
                slug = request_item.get("slug")
                skill = SKILLS.get(slug)
                if not skill:
                    continue
                COUNTS[slug]["verdict"] += 1
                mode = skill["verdict"]
                clean = mode == "clean"
                malicious = mode == "malicious"
                items.append({
                    "ok": clean,
                    "decision": "blocked" if malicious else ("pass" if clean else "fail"),
                    "reasons": ["malware_detected"] if malicious else ([] if clean else ["static_scan_failed"]),
                    "requestedSlug": slug,
                    "requestedVersion": request_item.get("version"),
                    "slug": slug,
                    "version": VERSION,
                    "displayName": skill["displayName"],
                    "publisherHandle": OWNER,
                    "publisherDisplayName": "OpenClaw Proof",
                    "createdAt": 1700000000000,
                    "checkedAt": 1700000001000,
                    "skillUrl": f"http://127.0.0.1:{PORT}/openclaw/skills/{slug}",
                    "securityAuditUrl": f"http://127.0.0.1:{PORT}/openclaw/skills/{slug}/security-audit?version={VERSION}",
                    "security": {"status": "malicious" if malicious else ("clean" if clean else "suspicious"), "passed": clean},
                })
                log("verdict", slug=slug, mode=mode, count=COUNTS[slug]["verdict"])
            self._send_json({"schema": "clawhub.skill.security-verdicts.v1", "items": items})
            return
        self._send_json({"error": "not_found", "path": parsed.path}, status=404)

    def log_message(self, format, *args):
        log("access", message=format % args)

if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log("listening", port=PORT)
    server.serve_forever()
PY
  python3 -m py_compile proof-output/clawhub-fixture-server.py
  python3 -u proof-output/clawhub-fixture-server.py > proof-output/clawhub-mock.log 2>&1 &
  CLAW_HUB_PID="$!"
  for attempt in $(seq 1 40); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${CLAW_HUB_PORT}/api/v1/search?q=proof&limit=3" > proof-output/clawhub-search-smoke.json 2> proof-output/clawhub-health.err; then
      printf 'fixture_pid=running\nfixture_health=ok\n' > proof-output/fixture-startup.txt
      return 0
    fi
    if ! kill -0 "${CLAW_HUB_PID}" >/dev/null 2>&1; then
      {
        echo "fixture_pid=exited"
        echo "fixture_log:"
        sed -n '1,120p' proof-output/clawhub-mock.log
      } > proof-output/fixture-startup.txt
      echo "ClawHub fixture exited before becoming healthy" >&2
      return 1
    fi
    sleep 1
  done
  {
    echo "fixture_pid=running"
    echo "fixture_health=timeout"
    echo "fixture_log:"
    sed -n '1,120p' proof-output/clawhub-mock.log
    echo "health_error:"
    sed -n '1,40p' proof-output/clawhub-health.err
  } > proof-output/fixture-startup.txt
  echo "Timed out waiting for ClawHub fixture" >&2
  return 1
}

wait_for_gateway() {
  for attempt in $(seq 1 90); do
    if run_openclaw_gateway_call health --timeout 5000 --json > proof-output/gateway-health.json 2> proof-output/gateway-health.err; then
      return 0
    fi
    if [ -n "${GATEWAY_PID}" ] && ! kill -0 "${GATEWAY_PID}" >/dev/null 2>&1; then
      echo "Gateway exited before becoming healthy" >&2
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for Gateway health" >&2
  return 1
}

approve_pending_device_pairings() {
  local attempts="${1:-90}"
  local require_pending="${2:-false}"
  local approved_count=0
  local raw_list="proof-output/device-pair-list.raw.json"
  local ids_file="proof-output/device-pair-pending-ids.txt"
  for attempt in $(seq 1 "${attempts}"); do
    if run_openclaw devices list --json > "${raw_list}" 2> proof-output/device-pair-list.err; then
      redact_json_file "${raw_list}" proof-output/device-pair-list.json
      python3 - "${raw_list}" > "${ids_file}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
pending = data.get("pending") if isinstance(data, dict) else []
for item in pending or []:
    request_id = str(item.get("requestId") or "").strip()
    if request_id:
        print(request_id)
PY
      if [ ! -s "${ids_file}" ]; then
        if [ "${approved_count}" -gt 0 ] || [ "${require_pending}" != "true" ]; then
          rm -f "${raw_list}"
          return 0
        fi
      else
        while IFS= read -r request_id; do
          [ -z "${request_id}" ] && continue
          local safe_id
          safe_id="$(printf '%s' "${request_id}" | tr -c 'A-Za-z0-9_.-' '_')"
          local raw_approve="proof-output/device-pair-approve-${safe_id}.raw.json"
          echo "[proof] approve pending device pairing ${request_id}" | tee -a proof-output/capture.log
          run_openclaw devices approve "${request_id}" --json > "${raw_approve}" 2> "proof-output/device-pair-approve-${safe_id}.err"
          redact_json_file "${raw_approve}" "proof-output/device-pair-approve-${safe_id}.json"
          rm -f "${raw_approve}"
          approved_count=$((approved_count + 1))
        done < "${ids_file}"
        sleep 2
      fi
    fi
    sleep 1
  done
  rm -f "${raw_list}"
  if [ "${approved_count}" -gt 0 ]; then
    return 0
  fi
  echo "Timed out waiting for a pending Android device pairing request" >&2
  return 1
}

android_operator_admin_paired() {
  local input_path="$1"
  python3 - "$input_path" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for device in data.get("paired", []) if isinstance(data, dict) else []:
    fields = " ".join(str(device.get(key) or "").lower() for key in ("platform", "deviceFamily", "clientId", "displayName"))
    scopes = {str(scope) for scope in device.get("scopes", [])}
    roles = {str(role) for role in device.get("roles", [])}
    if "android" in fields and "operator" in roles and "operator.admin" in scopes:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

wait_for_android_operator_pairing() {
  local attempts="${1:-90}"
  local raw_list="proof-output/device-pair-list.raw.json"
  local ids_file="proof-output/device-pair-pending-ids.txt"
  for attempt in $(seq 1 "${attempts}"); do
    if run_openclaw devices list --json > "${raw_list}" 2> proof-output/device-pair-list.err; then
      redact_json_file "${raw_list}" proof-output/device-pair-list.json
      if android_operator_admin_paired "${raw_list}"; then
        rm -f "${raw_list}"
        return 0
      fi
      python3 - "${raw_list}" > "${ids_file}" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for item in data.get("pending", []) if isinstance(data, dict) else []:
    request_id = str(item.get("requestId") or "").strip()
    if request_id:
        print(request_id)
PY
      while IFS= read -r request_id; do
        [ -z "${request_id}" ] && continue
        local safe_id
        safe_id="$(printf '%s' "${request_id}" | tr -c 'A-Za-z0-9_.-' '_')"
        local raw_approve="proof-output/device-pair-approve-${safe_id}.raw.json"
        echo "[proof] approve Android pairing ${request_id}" | tee -a proof-output/capture.log
        run_openclaw devices approve "${request_id}" --json > "${raw_approve}" 2> "proof-output/device-pair-approve-${safe_id}.err"
        redact_json_file "${raw_approve}" "proof-output/device-pair-approve-${safe_id}.json"
        rm -f "${raw_approve}"
      done < "${ids_file}"
    fi
    if (( attempt % 3 == 0 )); then
      if wait_for_text "Reconnect" 1 || wait_for_text "Reconnect gateway" 1; then
        tap_text "Reconnect" "570 1070" || tap_text "Reconnect gateway" "570 1070" || true
      fi
    fi
    if (( attempt % 15 == 0 )); then
      echo "[proof] relaunch Android app to renew pairing request (attempt ${attempt})" | tee -a proof-output/capture.log
      adb shell am force-stop "$APP_ID" || true
      timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >> proof-output/monkey-launch.log || true
    fi
    sleep 2
  done
  rm -f "${raw_list}"
  echo "Timed out waiting for Android operator.admin pairing" >&2
  return 1
}

wait_for_text_absent() {
  local needle="$1"
  local attempts="${2:-45}"
  local out="proof-output/openclaw-ui.xml"
  for _ in $(seq 1 "${attempts}"); do
    timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
    timeout 20 adb pull /sdcard/openclaw-ui.xml "${out}" >/dev/null 2>&1 || true
    if [ -f "${out}" ] && ! grep -Fq "${needle}" "${out}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text to disappear: ${needle}" >&2
  return 1
}

start_real_gateway() {
  write_gateway_config
  start_clawhub_fixture
  run_openclaw gateway run \
    --port "${GATEWAY_PORT}" \
    --bind loopback \
    --auth none \
    --allow-unconfigured \
    --force \
    --compact \
    --cli-backend-logs \
    > proof-output/gateway.log 2>&1 &
  GATEWAY_PID="$!"
  wait_for_gateway

  run_openclaw_gateway_call skills.search \
    --params '{"query":"proof","limit":3}' \
    --timeout 20000 \
    --json > proof-output/gateway-skills-search.json 2> proof-output/gateway-skills-search.err
  run_openclaw_gateway_call skills.detail \
    --params '{"slug":"proof-clean-skill"}' \
    --timeout 20000 \
    --json > proof-output/gateway-skills-detail.json 2> proof-output/gateway-skills-detail.err
  python3 - <<'PY'
from pathlib import Path
needles = ["Proof Clean Skill", "proof-clean-skill", "latestVersion"]
combined = "\n".join(Path(p).read_text(encoding="utf-8", errors="ignore") for p in [
    "proof-output/gateway-skills-search.json",
    "proof-output/gateway-skills-detail.json",
    "proof-output/clawhub-fixture.jsonl",
])
missing = [needle for needle in needles if needle not in combined]
if missing:
    raise SystemExit(f"Missing expected Gateway/ClawHub proof output: {missing}")
PY
}

wait_for_text() {
  local needle="$1"
  local attempts="${2:-45}"
  local out="proof-output/openclaw-ui.xml"
  for _ in $(seq 1 "${attempts}"); do
    timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
    timeout 20 adb pull /sdcard/openclaw-ui.xml "${out}" >/dev/null 2>&1 || true
    if [ -f "${out}" ] && grep -Fq "${needle}" "${out}"; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text: ${needle}" >&2
  return 1
}

reveal_text_above() {
  local needle="$1"
  for _ in $(seq 1 10); do
    if wait_for_text "$needle" 2; then
      return 0
    fi
    adb shell input swipe 540 750 540 2050 500 || true
    sleep 1
  done
  wait_for_text "$needle" 60
}

reveal_text_below() {
  local needle="$1"
  for _ in $(seq 1 10); do
    if wait_for_text "$needle" 2; then
      return 0
    fi
    adb shell input swipe 540 2050 540 750 500 || true
    sleep 1
  done
  wait_for_text "$needle" 60
}

copy_ui_xml() {
  local local_path="$1"
  timeout 20 adb shell uiautomator dump /sdcard/openclaw-ui.xml >/dev/null 2>&1 || true
  timeout 20 adb pull /sdcard/openclaw-ui.xml "${local_path}" >/dev/null 2>&1 || true
}

text_center() {
  local needle="$1"
  local occurrence="${2:-0}"
  local match_mode="${3:-contains}"
  copy_ui_xml proof-output/openclaw-ui.xml >/dev/null 2>&1 || true
  python3 - "$needle" "$occurrence" "$match_mode" proof-output/openclaw-ui.xml <<'PY'
import html
import re
import sys
from pathlib import Path
needle = sys.argv[1]
occurrence = sys.argv[2]
match_mode = sys.argv[3]
xml = Path(sys.argv[4]).read_text(encoding='utf-8', errors='ignore')
matches = []
for node in re.findall(r'<node\b[^>]*/?>', xml):
    text_match = re.search(r'text="([^"]*)"', node)
    desc_match = re.search(r'content-desc="([^"]*)"', node)
    text = html.unescape(text_match.group(1) if text_match else '')
    desc = html.unescape(desc_match.group(1) if desc_match else '')
    matched = (text == needle or desc == needle) if match_mode == 'exact' else (needle in text or needle in desc)
    if not matched:
        continue
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if not bounds:
        continue
    left, top, right, bottom = map(int, bounds.groups())
    if right <= left or bottom <= top:
        continue
    matches.append(((left + right) // 2, (top + bottom) // 2, text, desc))
if not matches:
    sys.exit(1)
index = -1 if occurrence == 'last' else int(occurrence)
x, y, _, _ = matches[index]
print(x, y)
PY
}

tap_exact_text() {
  local needle="$1"
  local fallback_coords="${2:-}"
  local coords=""
  if coords="$(text_center "$needle" 0 exact 2>/dev/null)" && [ -n "$coords" ]; then
    echo "[proof] tap exact '${needle}' at ${coords}" | tee -a proof-output/capture.log
    adb shell input tap $coords
    sleep 1
    return 0
  fi
  if [ -n "$fallback_coords" ]; then
    echo "[proof] tap exact fallback '${needle}' at ${fallback_coords}" | tee -a proof-output/capture.log
    adb shell input tap $fallback_coords
    sleep 1
    return 0
  fi
  echo "Unable to find exact UI text: ${needle}" >&2
  return 1
}

tap_text() {
  local needle="$1"
  local fallback_coords="${2:-}"
  local occurrence="${3:-0}"
  local coords=""
  if coords="$(text_center "$needle" "$occurrence" 2>/dev/null)" && [ -n "$coords" ]; then
    echo "[proof] tap '${needle}' at ${coords}" | tee -a proof-output/capture.log
    adb shell input tap $coords
    sleep 1
    return 0
  fi
  if [ -n "$fallback_coords" ]; then
    echo "[proof] tap fallback '${needle}' at ${fallback_coords}" | tee -a proof-output/capture.log
    adb shell input tap $fallback_coords
    sleep 1
    return 0
  fi
  echo "Could not find tappable UI text: ${needle}" >&2
  return 1
}

tap_review_for_skill() {
  local skill_title="$1"
  local coords=""
  for attempt in $(seq 1 10); do
    copy_ui_xml proof-output/openclaw-ui.xml >/dev/null 2>&1 || true
    if coords="$(python3 - "$skill_title" proof-output/openclaw-ui.xml <<'PY'
import html
import re
import sys
from pathlib import Path

title = sys.argv[1]
xml = Path(sys.argv[2]).read_text(encoding="utf-8", errors="ignore")
nodes = []
for node in re.findall(r'<node\b[^>]*/?>', xml):
    text_match = re.search(r'text="([^"]*)"', node)
    bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
    if not bounds:
        continue
    text = html.unescape(text_match.group(1) if text_match else "")
    left, top, right, bottom = map(int, bounds.groups())
    nodes.append((text, left, top, right, bottom))
skill_nodes = [node for node in nodes if node[0] == title]
if len(skill_nodes) != 1:
    raise SystemExit(f"expected one skill title {title!r}, found {len(skill_nodes)}")
_, _, skill_top, _, skill_bottom = skill_nodes[0]
buttons = [node for node in nodes if node[0] == "Review" and not (node[4] < skill_top - 80 or node[2] > skill_bottom + 80)]
if len(buttons) != 1:
    raise SystemExit(f"expected one Review near {title!r}, found {len(buttons)}")
_, left, top, right, bottom = buttons[0]
print((left + right) // 2, (top + bottom) // 2)
PY
)" && [ -n "$coords" ]; then
      echo "[proof] tap Review for '${skill_title}' at ${coords} (attempt ${attempt})" | tee -a proof-output/capture.log
      adb shell input tap $coords
      sleep 1
      return 0
    fi
    echo "[proof] '${skill_title}' card is not fully actionable; scroll for adjacent Review (attempt ${attempt})" | tee -a proof-output/capture.log
    adb shell input swipe 540 2050 540 1450 400 || true
    sleep 1
  done
  copy_ui_xml "proof-output/install-target-${skill_title// /-}-failure-ui.xml"
  echo "Unable to find one actionable Review button for skill: ${skill_title}" >&2
  return 1
}

capture_png() {
  local remote="$1"
  local local_path="$2"
  adb shell screencap -p "$remote"
  timeout 20 adb pull "$remote" "$local_path" >/dev/null
}

record_screen() {
  local remote="$1"
  local local_path="$2"
  local seconds="${3:-6}"
  timeout $((seconds + 8)) adb shell screenrecord --time-limit "$seconds" "$remote" >/dev/null 2>&1 || true
  timeout 20 adb pull "$remote" "$local_path" >/dev/null 2>&1 || true
}

start_interaction_record() {
  local remote="$1"
  local seconds="${2:-20}"
  adb shell rm -f "$remote" >/dev/null 2>&1 || true
  adb shell screenrecord --time-limit "$seconds" "$remote" >/dev/null 2>&1 &
  RECORD_PID="$!"
}

finish_interaction_record() {
  local remote="$1"
  local local_path="$2"
  wait "${RECORD_PID}" || true
  timeout 20 adb pull "$remote" "$local_path" >/dev/null
  RECORD_PID=""
}

assert_fixture_download_count() {
  local slug="$1"
  local expected="$2"
  local label="$3"
  python3 - "$slug" "$expected" "$label" <<'PY'
import json
import sys
from pathlib import Path

slug, expected, label = sys.argv[1], int(sys.argv[2]), sys.argv[3]
events = [json.loads(line) for line in Path('proof-output/clawhub-fixture.jsonl').read_text().splitlines() if line.strip()]
actual = sum(1 for event in events if event.get('event') == 'download' and event.get('slug') == slug)
if actual != expected:
    raise SystemExit(f'{label}: download count for {slug} was {actual}, expected {expected}')
Path(f'proof-output/{label}-download-count.txt').write_text(f'slug={slug}\nexpected={expected}\nactual={actual}\n')
PY
}

replace_installed_filter() {
  local current_text="$1"
  local replacement_input="$2"
  local expected_title="$3"
  for _ in $(seq 1 12); do
    if wait_for_text "$current_text" 1; then break; fi
    adb shell input swipe 540 700 540 2100 500 || true
    sleep 1
  done
  wait_for_text "$current_text" 30
  tap_exact_text "$current_text"
  adb shell input keyevent 123
  for _ in $(seq 1 40); do adb shell input keyevent 67; done
  adb shell input text "$replacement_input"
  adb shell input keyevent 4 || true
  wait_for_text "$expected_title" 60
}

start_real_gateway

: "${PROOF_SKILL_TITLE:?missing clean proof skill title}"
: "${REVIEW_SKILL_TITLE:?missing review-required proof skill title}"
: "${MALICIOUS_SKILL_TITLE:?missing malicious proof skill title}"
: "${REVIEW_TITLE:?missing review dialog title}"

emulator -avd "$AVD_NAME" -no-window -no-snapshot -no-snapshot-save -no-audio -no-boot-anim -gpu swiftshader_indirect -memory 2048 -cores 2 > proof-output/emulator.log 2>&1 &
EMU_PID="$!"

sleep 15
if ! kill -0 "$EMU_PID" >/dev/null 2>&1; then
  echo "Emulator process exited before adb wait-for-device" >&2
  false
fi

timeout 240 adb wait-for-device
for _ in $(seq 1 180); do
  boot_completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$boot_completed" = "1" ] && break
  sleep 1
done
adb shell wm size 1080x2400 || true
adb shell wm density 420 || true
adb shell settings put global window_animation_scale 0 || true
adb shell settings put global transition_animation_scale 0 || true
adb shell settings put global animator_duration_scale 0 || true

# Install the actual Play debug APK produced from this repository head.
timeout 120 adb install -r "$APK" > proof-output/adb-install.log

# Seed only completed onboarding plus a manual loopback Gateway endpoint. ClawHub result data is
# still retrieved from the live proof Gateway through WebSocket RPC and Gateway HTTP fetches.
cat > proof-output/openclaw.node.xml <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <boolean name="onboarding.completed" value="true" />
  <boolean name="gateway.manual.enabled" value="true" />
  <string name="gateway.manual.host">${GATEWAY_DEVICE_HOST}</string>
  <int name="gateway.manual.port" value="${GATEWAY_PORT}" />
  <boolean name="gateway.manual.tls" value="false" />
</map>
XML
adb push proof-output/openclaw.node.xml /data/local/tmp/openclaw.node.xml >/dev/null
adb shell chmod 644 /data/local/tmp/openclaw.node.xml >/dev/null 2>&1 || true
adb shell run-as "$APP_ID" mkdir -p shared_prefs
adb shell run-as "$APP_ID" cp /data/local/tmp/openclaw.node.xml shared_prefs/openclaw.node.xml

# Launch through the normal launcher entry point. ScreenshotMode is intentionally not used.
adb shell am force-stop "$APP_ID" || true
timeout 30 adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 > proof-output/monkey-launch.log || true
wait_for_text "$SETTINGS_TEXT" 90
if wait_for_text "Reconnect" 8; then
  tap_text "Reconnect" "570 1070" || true
  sleep 4
fi
if wait_for_text "Pairing needed" 15 || wait_for_text "Waiting for pairing" 5; then
  approve_pending_device_pairings 90 true
  tap_text "Reconnect" "570 1070" || tap_text "Reconnect gateway" "570 1070" || true
  sleep 8
fi
# Drain pending device-pairing requests observed after the Android app starts and wait for the
# emulator-backed Android device to hold an operator.admin pairing. Do not require a visible
# "Connected" label: once the operator socket is connected, the app may navigate to a
# settings/detail surface where the home connection label is not part of the current UI tree.
wait_for_android_operator_pairing 120
if wait_for_text "Reconnect" 3 || wait_for_text "Reconnect gateway" 3; then
  tap_text "Reconnect" "570 1070" || tap_text "Reconnect gateway" "570 1070" || true
  sleep 8
fi
capture_png /sdcard/openclaw-01-launch.png proof-output/01-real-launch-connected-gateway.png
copy_ui_xml proof-output/01-launch-ui.xml

# Navigate through the production bottom navigation to Settings, then into the Skills settings row.
tap_text "$SETTINGS_TEXT" "945 2290" "last"
wait_for_text "$SKILLS_TEXT" 60
capture_png /sdcard/openclaw-02-settings-list.png proof-output/02-settings-list.png
copy_ui_xml proof-output/02-settings-list-ui.xml
record_screen /sdcard/openclaw-settings-list.mp4 proof-output/settings-list.mp4 4

tap_text "$SKILLS_TEXT" "230 1560"
wait_for_text "Search installed skills" 90
wait_for_text_absent "Connect the gateway to load and manage skills." 90
capture_png /sdcard/openclaw-03-skills-entry.png proof-output/03-real-skills-entry.png
copy_ui_xml proof-output/03-skills-entry-ui.xml

# Collapse the long installed-skills list first, then bring the ClawHub panel into view.
# This keeps the capture deterministic on Gateways with many bundled skills while still using
# the production Settings -> Skills screen and its real installed-skill search field.
tap_text "Search installed skills" "420 1110"
adb shell input text 'zzzzzzzz'
adb shell input keyevent 4 || true
sleep 1
capture_png /sdcard/openclaw-04-installed-filter.png proof-output/04-installed-filter-no-matches.png
copy_ui_xml proof-output/04-installed-filter-ui.xml

# Bring the ClawHub panel/search field into view, enter a query, and run the actual Gateway search.
for _ in $(seq 1 8); do
  if wait_for_text "Search ClawHub" 2; then
    break
  fi
  adb shell input swipe 540 2200 540 600 800 || true
  sleep 1
done
wait_for_text "Search ClawHub" 45
tap_text "Search ClawHub" "420 1580"
adb shell input text 'proof%sclean'
adb shell input keyevent 4 || true
# The search field can land at the bottom edge after filtering installed skills; reveal the
# action row before tapping so we exercise the real button instead of a coordinate guess.
for _ in $(seq 1 4); do
  if wait_for_text "Search" 2; then
    break
  fi
  adb shell input swipe 540 2150 540 1720 350 || true
  sleep 1
done
wait_for_text "Search" 30
capture_png /sdcard/openclaw-05-clawhub-query.png proof-output/05-clawhub-query-before-search.png
copy_ui_xml proof-output/05-clawhub-query-ui.xml

tap_exact_text "Search" "300 1720"
# Search results render below the ClawHub action row; scroll them into the visible UI tree before
# asserting/capturing so the media proof contains the result row and install CTA.
for _ in $(seq 1 10); do
  if wait_for_text "$PROOF_SKILL_TITLE" 3; then
    break
  fi
  adb shell input swipe 540 2100 540 1250 500 || true
  sleep 1
done
wait_for_text "$PROOF_SKILL_TITLE" 90
capture_png /sdcard/openclaw-06-clawhub-results.png proof-output/06-real-clawhub-search-results.png
copy_ui_xml proof-output/06-clawhub-results-ui.xml
record_screen /sdcard/openclaw-clawhub-results.mp4 proof-output/clawhub-results.mp4 6

# Open the clean install review dialog by binding the target title to its adjacent Install action.
tap_review_for_skill "$PROOF_SKILL_TITLE"
wait_for_text "$REVIEW_TITLE" 120
capture_png /sdcard/openclaw-07-clawhub-review-dialog.png proof-output/07-real-clawhub-review-dialog.png
copy_ui_xml proof-output/07-clawhub-review-dialog-ui.xml
record_screen /sdcard/openclaw-clawhub-review-dialog.mp4 proof-output/clawhub-review-dialog.mp4 6

# Clean path: record the real confirm action, Gateway download/install, success message, and
# the installed-skill refresh that follows the successful RPC.
start_interaction_record /sdcard/openclaw-clean-install.mp4 20
tap_exact_text "Verify and install"
reveal_text_above "Installed proof-clean-skill@1.2.3"
capture_png /sdcard/openclaw-08-clean-installed.png proof-output/08-clean-install-success.png
copy_ui_xml proof-output/08-clean-install-success-ui.xml
finish_interaction_record /sdcard/openclaw-clean-install.mp4 proof-output/clean-install-and-refresh.mp4

# Clear the installed-skills filter and prove that the refreshed installed section contains the skill.
replace_installed_filter "zzzzzzzz" "proof%sclean" "$PROOF_SKILL_TITLE"
capture_png /sdcard/openclaw-09-clean-refresh.png proof-output/09-clean-post-install-refresh.png
copy_ui_xml proof-output/09-clean-post-install-refresh-ui.xml

# Return to the ClawHub result list and exercise the review-required acknowledgement path.
for _ in $(seq 1 8); do
  if wait_for_text "$REVIEW_SKILL_TITLE" 2; then break; fi
  adb shell input swipe 540 2050 540 850 500 || true
  sleep 1
done
wait_for_text "$REVIEW_SKILL_TITLE" 60
tap_review_for_skill "$REVIEW_SKILL_TITLE"
wait_for_text "$REVIEW_TITLE" 120
tap_exact_text "Verify and install"
reveal_text_below "Acknowledge Gateway warning and install"
capture_png /sdcard/openclaw-10-review-required.png proof-output/10-review-required-dialog.png
copy_ui_xml proof-output/10-review-required-dialog-ui.xml
assert_fixture_download_count "proof-review-skill" 0 "review-before-ack"
start_interaction_record /sdcard/openclaw-review-install.mp4 20
tap_exact_text "Acknowledge Gateway warning and install"
reveal_text_above "Installed proof-review-skill@1.2.3"
capture_png /sdcard/openclaw-11-review-installed.png proof-output/11-review-required-install-success.png
copy_ui_xml proof-output/11-review-required-install-success-ui.xml
finish_interaction_record /sdcard/openclaw-review-install.mp4 proof-output/review-required-install-and-refresh.mp4

# Prove the post-install refresh for the acknowledged review path in the installed section.
replace_installed_filter "proof clean" "proof%sreview" "$REVIEW_SKILL_TITLE"
capture_png /sdcard/openclaw-12-review-refresh.png proof-output/12-review-required-post-install-refresh.png
copy_ui_xml proof-output/12-review-required-post-install-refresh-ui.xml

# Exercise the malicious path. The dialog itself must expose only Close; no Install or
# acknowledgement action is permitted and the fixture must observe zero downloads.
for _ in $(seq 1 8); do
  if wait_for_text "$MALICIOUS_SKILL_TITLE" 2; then break; fi
  adb shell input swipe 540 2050 540 850 500 || true
  sleep 1
done
wait_for_text "$MALICIOUS_SKILL_TITLE" 60
tap_review_for_skill "$MALICIOUS_SKILL_TITLE"
wait_for_text "$REVIEW_TITLE" 120
tap_exact_text "Verify and install"
reveal_text_below "install was not started"
capture_png /sdcard/openclaw-13-malicious-blocked.png proof-output/13-malicious-blocked.png
copy_ui_xml proof-output/13-malicious-blocked-ui.xml
record_screen /sdcard/openclaw-malicious-blocked.mp4 proof-output/malicious-blocked.mp4 8
assert_fixture_download_count "proof-malicious-skill" 0 "malicious-ui-blocked"

run_openclaw_gateway_call skills.install \
  --params '{"source":"clawhub","slug":"proof-malicious-skill","version":"1.2.3","acknowledgeClawHubRisk":true,"timeoutMs":20000}' \
  --timeout 30000 \
  --json > proof-output/malicious-gateway-install.json 2> proof-output/malicious-gateway-install.err || true
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path('proof-output/malicious-gateway-install.json').read_text())
error = payload.get('error') if isinstance(payload, dict) else None
details = error.get('details') if isinstance(error, dict) else None
if payload.get('ok') is not False:
    raise SystemExit('Malicious Gateway install unexpectedly returned ok != false')
if not isinstance(details, dict) or details.get('clawhubTrustCode') != 'clawhub_download_blocked':
    raise SystemExit(f'Missing clawhub_download_blocked response: {payload!r}')
message = str(error.get('message') or '')
if 'install was not started' not in message:
    raise SystemExit(f'Missing explicit no-install message: {message!r}')
PY
assert_fixture_download_count "proof-malicious-skill" 0 "malicious-gateway-rejected"

python3 - <<'PY'
from pathlib import Path
checks = {
    '06-clawhub-results-ui.xml': ['Proof Clean Skill', 'Review'],
    '07-clawhub-review-dialog-ui.xml': ['Review ClawHub skill', 'Proof Clean Skill', 'Version', 'Publisher', 'Verify and install'],
    '08-clean-install-success-ui.xml': ['Installed proof-clean-skill@1.2.3'],
    '09-clean-post-install-refresh-ui.xml': ['Proof Clean Skill'],
    '10-review-required-dialog-ui.xml': ['Acknowledge Gateway warning and install'],
    '11-review-required-install-success-ui.xml': ['Installed proof-review-skill@1.2.3'],
    '12-review-required-post-install-refresh-ui.xml': ['Proof Review Skill'],
    '13-malicious-blocked-ui.xml': ['install was not started', 'Dismiss'],
    'gateway-skills-search.json': ['Proof Clean Skill', 'proof-clean-skill'],
    'clawhub-fixture.jsonl': ['/api/v1/search', '/api/v1/skills/-/security-verdicts'],
}
missing = []
for rel, needles in checks.items():
    text = Path('proof-output', rel).read_text(encoding='utf-8', errors='ignore')
    for needle in needles:
        if needle not in text:
            missing.append(f'{rel}: {needle}')
if missing:
    raise SystemExit('Missing expected proof evidence: ' + ', '.join(missing))

blocked = Path('proof-output/13-malicious-blocked-ui.xml').read_text(encoding='utf-8', errors='ignore')
if 'Acknowledge Gateway warning and install' in blocked or 'text="Verify and install"' in blocked:
    raise SystemExit('Malicious dialog exposed an install action')
PY

python3 - <<'PY'
import json
from pathlib import Path

events = [json.loads(line) for line in Path('proof-output/clawhub-fixture.jsonl').read_text().splitlines() if line.strip()]
summary = {}
for slug in ('proof-clean-skill', 'proof-review-skill', 'proof-malicious-skill'):
    summary[slug] = {
        'verdicts': sum(1 for event in events if event.get('event') == 'verdict' and event.get('slug') == slug),
        'downloads': sum(1 for event in events if event.get('event') == 'download' and event.get('slug') == slug),
    }
if summary['proof-clean-skill']['downloads'] != 1:
    raise SystemExit(f"clean download count was {summary['proof-clean-skill']['downloads']}, expected 1")
if summary['proof-review-skill']['downloads'] != 1:
    raise SystemExit(f"review download count was {summary['proof-review-skill']['downloads']}, expected 1")
if summary['proof-malicious-skill']['downloads'] != 0:
    raise SystemExit('malicious skill was downloaded')
Path('proof-output/fixture-events.json').write_text(json.dumps(summary, indent=2, sort_keys=True) + '\n')
Path('proof-output/gateway-proof-summary.json').write_text(json.dumps({
    'clean_install': True,
    'clean_post_install_refresh': True,
    'review_required_acknowledged_install': True,
    'malicious_blocked_without_download': True,
}, indent=2, sort_keys=True) + '\n')
PY

cat > proof-output/README.md <<EOF
# Android ClawHub Skills real media proof

- Repository head: $(git rev-parse HEAD)
- PR head expectation: $(sed -n 's/^expected_pr_head=//p' proof-output/latest-head.txt)
- Runner: GitHub-hosted ubuntu-24.04 + Android emulator API 35
- App launch mode: normal Android launcher; screenshot mode disabled
- Gateway path: Android Settings → Skills → clean install + refresh → review-required acknowledgement + install → malicious block
- RPC evidence: skills.search, skills.detail, skills.install via a temporary OpenClaw Gateway started from this checkout
- ClawHub fixture: local ClawHub-compatible HTTP service inside this Actions run, logged in clawhub-fixture.jsonl

Key media:
- 03-real-skills-entry.png
- 04-installed-filter-no-matches.png
- 06-real-clawhub-search-results.png
- 07-real-clawhub-review-dialog.png
- 08-clean-install-success.png
- 09-clean-post-install-refresh.png
- 10-review-required-dialog.png
- 11-review-required-install-success.png
- 12-review-required-post-install-refresh.png
- 13-malicious-blocked.png
- clawhub-results.mp4
- clawhub-review-dialog.mp4
- clean-install-and-refresh.mp4
- review-required-install-and-refresh.mp4
- malicious-blocked.mp4
EOF

python3 - <<'PY'
import hashlib
import json
import struct
import subprocess
from pathlib import Path

media = sorted(list(Path('proof-output').glob('*.png')) + list(Path('proof-output').glob('*.mp4')))
metadata = []
for path in media:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    item = {'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest}
    if path.suffix == '.png':
        with path.open('rb') as handle:
            header = handle.read(24)
        width, height = struct.unpack('>II', header[16:24])
        item.update({'kind': 'image', 'width': width, 'height': height})
    else:
        probe = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries',
            'format=duration:stream=codec_name,width,height,duration', '-of', 'json', str(path),
        ]))
        stream = probe.get('streams', [{}])[0]
        duration = probe.get('format', {}).get('duration') or stream.get('duration')
        item.update({
            'kind': 'video',
            'duration_seconds': float(duration) if duration is not None else None,
            'codec': stream.get('codec_name'),
            'width': stream.get('width'),
            'height': stream.get('height'),
        })
    metadata.append(item)
Path('proof-output/proof-media-metadata.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
Path('proof-output/proof-media-sha256.txt').write_text(''.join(f"{item['sha256']}  {item['name']}\n" for item in metadata))
PY

printf '%s\n' \
  latest-head.txt README.md artifact-manifest.txt proof-media-sha256.txt \
  proof-media-metadata.json fixture-events.json gateway-proof-summary.json fixture-startup.txt \
  capture.log clawhub-fixture.jsonl review-before-ack-download-count.txt \
  malicious-ui-blocked-download-count.txt malicious-gateway-rejected-download-count.txt \
  malicious-gateway-install.json malicious-gateway-install.err \
  > proof-output/artifact-manifest.txt
find proof-output -maxdepth 1 -type f \( -name '*.png' -o -name '*.mp4' -o -name '*-ui.xml' \) -printf '%f\n' \
  | sort >> proof-output/artifact-manifest.txt
