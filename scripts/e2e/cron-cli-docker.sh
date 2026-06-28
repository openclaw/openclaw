#!/usr/bin/env bash
# Starts a packaged Gateway in Docker and verifies public cron CLI CRUD/run flows.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-cron-cli-e2e" OPENCLAW_IMAGE)"
PORT="18789"
TOKEN="cron-cli-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-cron-cli-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-cron-cli-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" cron-cli
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 cron-cli empty)"

echo "Running in-container Gateway + cron CLI smoke..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  -i \
  "$IMAGE_NAME" \
  bash -s >"$CLIENT_LOG" 2>&1 <<'INNER'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

entry="$(openclaw_e2e_resolve_entrypoint)"
gateway_pid=

cleanup_inner() {
  openclaw_e2e_stop_process "${gateway_pid:-}"
}

dump_logs_on_error() {
  status=$?
  if [ "$status" -ne 0 ]; then
    openclaw_e2e_dump_logs \
      /tmp/cron-cli-gateway.log \
      /tmp/cron-cli-device-seed.json \
      /tmp/cron-cli-status.json \
      /tmp/cron-cli-add.json \
      /tmp/cron-cli-list.json \
      /tmp/cron-cli-show.json \
      /tmp/cron-cli-disable.json \
      /tmp/cron-cli-enable.json \
      /tmp/cron-cli-run.json \
      /tmp/cron-cli-runs.json \
      /tmp/cron-cli-remove.json
  fi
  cleanup_inner
  exit "$status"
}

trap cleanup_inner EXIT
trap dump_logs_on_error ERR

cron_cli() {
  node "$entry" cron "$@" --token "${GW_TOKEN:?missing GW_TOKEN}"
}

seed_paired_cli_device() {
  node --input-type=module <<'NODE'
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function importDistChunk(prefix, marker) {
  const distDir = join(process.cwd(), "dist");
  const entries = await readdir(distDir);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".js")) {
      continue;
    }
    const fullPath = join(distDir, entry);
    if ((await readFile(fullPath, "utf8")).includes(marker)) {
      return await import(pathToFileURL(fullPath).href);
    }
  }
  throw new Error(`missing dist chunk ${prefix} containing ${marker}`);
}

const identityModule = await importDistChunk("device-identity-", "loadOrCreateDeviceIdentity");
const pairingModule = await importDistChunk("device-pairing-", "requestDevicePairing");
const loadOrCreateDeviceIdentity =
  identityModule.loadOrCreateDeviceIdentity ?? identityModule.r;
const publicKeyRawBase64UrlFromPem =
  identityModule.publicKeyRawBase64UrlFromPem ?? identityModule.a;
const approveDevicePairing = pairingModule.approveDevicePairing ?? pairingModule.n;
const getPairedDevice = pairingModule.getPairedDevice ?? pairingModule.a;
const requestDevicePairing = pairingModule.requestDevicePairing ?? pairingModule.m;

if (
  typeof loadOrCreateDeviceIdentity !== "function" ||
  typeof publicKeyRawBase64UrlFromPem !== "function" ||
  typeof approveDevicePairing !== "function" ||
  typeof getPairedDevice !== "function" ||
  typeof requestDevicePairing !== "function"
) {
  throw new Error("missing device pairing exports in dist chunks");
}

const identity = loadOrCreateDeviceIdentity();
const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
const requiredScopes = ["operator.admin"];
const paired = await getPairedDevice(identity.deviceId);
const pairedScopes = Array.isArray(paired?.approvedScopes)
  ? paired.approvedScopes
  : Array.isArray(paired?.scopes)
    ? paired.scopes
    : [];

if (paired?.publicKey !== publicKey || !requiredScopes.every((scope) => pairedScopes.includes(scope))) {
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey,
    displayName: "cron cli docker smoke",
    platform: process.platform,
    clientId: "cli",
    clientMode: "cli",
    role: "operator",
    scopes: requiredScopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: requiredScopes,
  });
  if (approved?.status !== "approved") {
    throw new Error(`failed to seed paired CLI device: ${approved?.status ?? "missing-result"}`);
  }
}

process.stdout.write(JSON.stringify({ ok: true, deviceId: identity.deviceId }) + "\n");
NODE
}

read_json_field() {
  local file="$1"
  local field="$2"
  node --input-type=module -e '
    const fs = await import("node:fs/promises");
    const [file, field] = process.argv.slice(1);
    const value = JSON.parse(await fs.readFile(file, "utf8"))[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing string field ${field} in ${file}`);
    }
    process.stdout.write(value);
  ' "$file" "$field"
}

seed_paired_cli_device > /tmp/cron-cli-device-seed.json
gateway_pid="$(openclaw_e2e_start_gateway "$entry" 18789 /tmp/cron-cli-gateway.log)"
openclaw_e2e_wait_gateway_ready "$gateway_pid" /tmp/cron-cli-gateway.log 300 18789

cron_cli status --json > /tmp/cron-cli-status.json
cron_add_args=(
  "cli cron smoke"
  --every 1m
  --command "printf openclaw-cli-cron-ok"
  --no-deliver
  --timeout-seconds 15
  --json
)
cron_cli add "${cron_add_args[@]}" > /tmp/cron-cli-add.json

job_id="$(read_json_field /tmp/cron-cli-add.json id)"

cron_cli list --all --json > /tmp/cron-cli-list.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const jobId = process.argv[1];
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-list.json", "utf8"));
  if (!Array.isArray(value.jobs) || !value.jobs.some((job) => job.id === jobId && job.name === "cli cron smoke")) {
    throw new Error("created job missing from cron list");
  }
' "$job_id"

cron_cli show "$job_id" --json > /tmp/cron-cli-show.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const jobId = process.argv[1];
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-show.json", "utf8"));
  if (value.id !== jobId || value.name !== "cli cron smoke") {
    throw new Error("cron show returned the wrong job");
  }
' "$job_id"

cron_cli disable "$job_id" > /tmp/cron-cli-disable.json
cron_cli enable "$job_id" > /tmp/cron-cli-enable.json

cron_cli run "$job_id" --wait --wait-timeout 120s --poll-interval 500ms > /tmp/cron-cli-run.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-run.json", "utf8"));
  if (value.completed !== true || value.status !== "ok") {
    throw new Error(`cron run did not complete ok: ${JSON.stringify(value)}`);
  }
'

cron_cli runs --id "$job_id" --limit 5 > /tmp/cron-cli-runs.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-runs.json", "utf8"));
  const matching = Array.isArray(value.entries)
    ? value.entries.find((entry) => entry.status === "ok" && entry.summary === "openclaw-cli-cron-ok")
    : undefined;
  if (!matching) {
    throw new Error("cron runs missing successful command summary");
  }
'

cron_cli rm "$job_id" --json > /tmp/cron-cli-remove.json
node --input-type=module -e '
  const fs = await import("node:fs/promises");
  const value = JSON.parse(await fs.readFile("/tmp/cron-cli-remove.json", "utf8"));
  if (value.ok !== true) {
    throw new Error("cron remove failed");
  }
'

node --input-type=module -e '
  process.stdout.write(JSON.stringify({ ok: true, jobId: process.argv[1] }) + "\n");
' "$job_id"
INNER
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker cron CLI smoke failed"
  docker_e2e_print_log "$CLIENT_LOG"
  exit "$status"
fi

docker_e2e_print_log "$CLIENT_LOG"
echo "OK"
