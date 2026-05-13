// Direct verification of DingTalk QR device-auth flow.
// Mirrors the onboarding wizard path (see extensions/feishu pollAppRegistration
// and extensions/dingtalk-connector tryScanAuthorizeDingtalk):
//   1. init + begin → device_code + QR
//   2. render QR to the terminal
//   3. poll until SUCCESS / FAIL / EXPIRED / TIMEOUT
//   4. print (masked) credentials and elapsed time
//
// Credentials are NOT persisted — run `openclaw configure --section channels`
// to actually write them to disk.
import {
  beginDingtalkRegistration,
  renderQrCodeText,
  waitForDingtalkRegistrationSuccess,
} from "../dist/extensions/dingtalk-connector/api.js";

function mask(value) {
  if (!value) return "(none)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)} (len=${value.length})`;
}

const start = Date.now();
let progressTimer = null;
function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
    process.stdout.write("\n");
  }
}

try {
  console.log("[1/4] calling beginDingtalkRegistration() ...");
  const begin = await beginDingtalkRegistration();
  console.log("  ok in", Date.now() - start, "ms");
  console.log("  userCode:", begin.userCode ?? "(none)");
  console.log("  verificationUriComplete:", begin.verificationUriComplete);
  console.log(
    "  intervalSeconds:",
    begin.intervalSeconds,
    "expiresInSeconds:",
    begin.expiresInSeconds,
  );

  console.log("\n[2/4] rendering QR text ...");
  const qr = await renderQrCodeText(begin.verificationUriComplete);
  console.log(qr || "(QR rendering returned empty — open the URL above instead)");

  console.log(
    `[3/4] waiting for DingTalk mobile scan & authorization (Ctrl+C to abort, auto-timeout in ${begin.expiresInSeconds}s) ...`,
  );
  const pollStart = Date.now();
  progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    process.stdout.write(`  waiting... ${elapsed}s elapsed\r`);
  }, 2000);

  process.on("SIGINT", () => {
    stopProgress();
    console.log(
      `aborted by user. device_code will expire in ~${begin.expiresInSeconds}s; no credentials captured.`,
    );
    process.exit(130);
  });

  let result;
  try {
    result = await waitForDingtalkRegistrationSuccess({
      deviceCode: begin.deviceCode,
      intervalSeconds: begin.intervalSeconds,
      expiresInSeconds: begin.expiresInSeconds,
    });
  } finally {
    stopProgress();
  }

  const totalSec = Math.round((Date.now() - start) / 1000);
  console.log(`[4/4] authorized! total ${totalSec}s`);
  console.log("  clientId     :", mask(result.clientId));
  console.log("  clientSecret :", mask(result.clientSecret));
  console.log(
    "\nNOTE: this script does NOT persist credentials.\n" +
      "      Run `node openclaw.mjs configure --section channels` to finalize setup.",
  );
} catch (err) {
  stopProgress();
  console.error("\nFAIL:", err?.message || err);
  process.exit(1);
}
