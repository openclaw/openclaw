/**
 * Run only in the disposable, credentialless macOS proof job, from the audio checkout:
 *   node --import tsx scripts/goal24-audio-native-proof.mts
 * The driver owns dependency provisioning, job isolation, and stdout artifact retention.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const audioSha = "a9a084486e3df10193dfa9ac5ab9faa9f53a4619";
const commandTimeoutMs = 10_000;
const conversionTimeoutMs = 5_000;
const tinyTimeoutMs = 0.001;
let stage = "preflight";
let workspace: string | undefined;
const evidence: Record<string, unknown> = { proof: "goal24-audio-native", audioSha };

function command(binary: string, args: string[]): Buffer {
  return execFileSync(binary, args, {
    timeout: commandTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

async function transcodeLeftovers(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith("tts-transcode-")) {
      count++;
    } else if (entry.isDirectory()) {
      count += await transcodeLeftovers(path.join(root, entry.name));
    }
  }
  return count;
}

// A stuck native subprocess must fail the job rather than produce a pass receipt.
const watchdog = setTimeout(() => {
  process.stdout.write(
    JSON.stringify({ ...evidence, ok: false, stage, failure: "watchdog" }) + "\n",
  );
  process.exit(1);
}, 90_000);
watchdog.unref();

try {
  assert.equal(process.platform, "darwin", "native macOS is required");
  assert.equal(
    await realpath(process.cwd()),
    await realpath(fileURLToPath(new URL("..", import.meta.url))),
  );
  assert.equal(command("/usr/bin/git", ["rev-parse", "HEAD"]).toString().trim(), audioSha);
  command("/usr/bin/git", [
    "diff",
    "--exit-code",
    audioSha,
    "--",
    "src",
    "packages",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ]);
  const suppliedTmp = process.env.TMPDIR;
  assert.ok(suppliedTmp && path.isAbsolute(suppliedTmp), "driver must supply an isolated TMPDIR");
  workspace = await mkdtemp(path.join(await realpath(suppliedTmp), "goal24-audio-"));
  process.env.TMPDIR = workspace;
  process.env.TMP = workspace;
  process.env.TEMP = workspace;
  process.env.HOME = path.join(workspace, "home");
  process.env.OPENCLAW_STATE_DIR = path.join(workspace, "state");
  await mkdir(process.env.HOME, { mode: 0o700 });
  await mkdir(process.env.OPENCLAW_STATE_DIR, { mode: 0o700 });

  // Load the real source only after OS, checkout, and disposable state checks.
  const { transcodeAudioBuffer } = await import("../src/media/audio-transcode.js");
  const { resolveFfmpegBin } = await import("../src/media/ffmpeg-exec.js");
  const { resolvePreferredOpenClawTmpDir } = await import("../src/infra/tmp-openclaw-dir.js");
  const ffmpeg = resolveFfmpegBin();
  const productTmp = await realpath(resolvePreferredOpenClawTmpDir());
  const isolatedTmp = workspace;
  // The production resolver may prefer /tmp/openclaw over TMPDIR. Inspect both,
  // without replacing the resolver or silently claiming TMPDIR contains it.
  evidence.productTmpInsideIsolatedTmp =
    productTmp === isolatedTmp || productTmp.startsWith(isolatedTmp + path.sep);
  assert.equal(await transcodeLeftovers(productTmp), 0, "product temp root must start clean");
  const checkCleanup = async () => {
    assert.equal(await transcodeLeftovers(productTmp), 0, "product left a transcode workspace");
    assert.equal(
      await transcodeLeftovers(isolatedTmp),
      0,
      "isolated TMPDIR has a transcode workspace",
    );
  };

  evidence.node = process.version;
  evidence.arch = process.arch;
  evidence.darwinRelease = os.release();
  evidence.macosVersion = command("/usr/bin/sw_vers", ["-productVersion"]).toString().trim();
  evidence.ffmpegVersion = command(ffmpeg, ["-version"])
    .toString()
    .match(/^ffmpeg version (\S+)/)?.[1];
  assert.ok(evidence.ffmpegVersion, "ffmpeg must report its version");
  evidence.nativeToolSha256 = Object.fromEntries(
    await Promise.all(
      ["afconvert", "afinfo"].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(`/usr/bin/${name}`))
          .digest("hex"),
      ]),
    ),
  );

  stage = "synthetic-fixture";
  const input = path.join(workspace, "synthetic.mp3");
  const output = path.join(workspace, "converted.caf");
  command(ffmpeg, [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=2",
    "-ac",
    "2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    input,
  ]);
  const fixture = await readFile(input);
  assert.ok(fixture.length > 0);
  const pcm = command(ffmpeg, [
    "-nostdin",
    "-v",
    "error",
    "-i",
    input,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    "24000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "-",
  ]);
  assert.ok(pcm.length > 0 && pcm.length % 2 === 0);
  const expectedFrames = pcm.length / 2;
  assert.ok(
    expectedFrames >= 47_000 && expectedFrames <= 49_000,
    "fixture must decode to about two seconds",
  );

  stage = "production-conversion";
  const started = performance.now();
  const result = await transcodeAudioBuffer({
    audioBuffer: fixture,
    sourceExtension: "mp3",
    targetExtension: "caf",
    timeoutMs: conversionTimeoutMs,
  });
  evidence.conversionElapsedMs = Math.round(performance.now() - started);
  await checkCleanup();
  assert.ok(result.ok, "production MP3-to-CAF conversion must succeed");
  assert.ok(result.buffer.length > 0, "production CAF must be nonempty");
  await writeFile(output, result.buffer, { mode: 0o600 });

  stage = "independent-afinfo";
  const info = command("/usr/bin/afinfo", [output]).toString();
  assert.match(info, /Data format:\s+1 ch,\s+24000 Hz/);
  const actualFrames = Number(info.match(/audio (\d+) valid frames/)?.[1]);
  const toleranceFrames = Math.max(2, Math.ceil(expectedFrames * 0.001));
  assert.ok(Number.isSafeInteger(actualFrames) && actualFrames > 0);
  assert.ok(
    Math.abs(actualFrames - expectedFrames) <= toleranceFrames,
    "CAF exceeds production frame tolerance",
  );
  Object.assign(evidence, {
    inputBytes: fixture.length,
    outputBytes: result.buffer.length,
    expectedFrames,
    actualFrames,
    toleranceFrames,
    channels: 1,
    sampleRateHz: 24_000,
  });

  stage = "tiny-timeout";
  // Sub-millisecond budget deterministically exercises the production deadline
  // failure and finally cleanup, not a mocked clock or subprocess-kill proof.
  const timedOut = await transcodeAudioBuffer({
    audioBuffer: fixture,
    sourceExtension: "mp3",
    targetExtension: "caf",
    timeoutMs: tinyTimeoutMs,
  });
  await checkCleanup();
  assert.equal(timedOut.ok, false);
  assert.ok(!timedOut.ok && timedOut.reason === "transcoder-failed");
  assert.match(timedOut.detail ?? "", /timeout budget exhausted/);
  Object.assign(evidence, {
    tinyTimeoutMs,
    tinyTimeoutReason: timedOut.reason,
    cleanupVerified: true,
  });
  stage = "cleanup";
  await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
  process.stdout.write(JSON.stringify({ ...evidence, ok: true }) + "\n");
} catch {
  // No exception strings, command output, filesystem paths, audio, or environment
  // contents enter retained evidence. Stage identifies the failed proof boundary.
  process.stdout.write(
    JSON.stringify({ ...evidence, ok: false, stage, failure: "assertion-or-command-failed" }) +
      "\n",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (workspace) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch {
      process.stdout.write(
        JSON.stringify({
          proof: evidence.proof,
          audioSha,
          ok: false,
          stage: "cleanup",
          failure: "cleanup-failed",
        }) + "\n",
      );
      process.exitCode = 1;
    }
  }
}
