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
const baselineSha = "e80a6dd9fdb4c7ce724472dd5d1b216afb4e70a7";
const baselineModuleSha256 = "867e5fd7ad1b477b1f4ab1023e15d440873c6f9d3d98253bfa6ac4240f6b370d";
const variant = process.env.GOAL24_AUDIO_CASE;
assert.ok(variant === "baseline" || variant === "fixed", "explicit native case required");
let stage = "preflight";
let workspace: string | undefined;
const evidence: Record<string, unknown> = {
  proof: "goal24-audio-native",
  audioSha,
  variant,
  baselineSha,
};

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
  const modulePath =
    variant === "baseline"
      ? "../src/media/goal24-audio-baseline.js"
      : "../src/media/audio-transcode.js";
  if (variant === "baseline") {
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL("../src/media/goal24-audio-baseline.ts", import.meta.url)))
        .digest("hex"),
      baselineModuleSha256,
    );
  }
  const { transcodeAudioBuffer }: typeof import("../src/media/audio-transcode.js") = await import(
    modulePath
  );
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

  stage = "ten-segment-fixture";
  const input = path.join(workspace, "synthetic.mp3");
  const output = path.join(workspace, "converted.caf");
  const fixture = await readFile(
    new URL("../src/media/fixtures/tts-ten-segment.mp3", import.meta.url),
  );
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  assert.equal(fixtureSha256, "7b2d8a3b1244383a4cfc3beaa57ba756c0d76c7d485fa80f927a458bdb60c0f0");
  assert.equal(fixture.length, 166176);
  await writeFile(input, fixture, { mode: 0o600 });
  const decode = (file: string): Buffer =>
    command(ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
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
  const pcm = decode(input);
  assert.ok(pcm.length > 0 && pcm.length % 2 === 0);
  const expectedFrames = pcm.length / 2;
  assert.equal(expectedFrames, 1_153_775, "canonical fixture decoded frame count");
  Object.assign(evidence, { fixtureSha256, inputBytes: fixture.length, expectedFrames });

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
  const validFrames = Number(info.match(/audio (\d+) valid frames/)?.[1]);
  const decoded = decode(output);
  const actualFrames = decoded.length / 2;
  Object.assign(evidence, {
    outputBytes: result.buffer.length,
    actualFrames,
    validFrames,
    expectedSeconds: expectedFrames / 24000,
    actualSeconds: actualFrames / 24000,
    toleranceFrames: 480,
    channels: 1,
    sampleRateHz: 24_000,
    cleanupVerified: true,
  });
  stage = "frame-preservation";
  assert.ok(Number.isSafeInteger(validFrames) && validFrames > 0);
  assert.ok(Math.abs(actualFrames - expectedFrames) <= 480, "decoded PCM lost frames");
  assert.ok(
    Math.abs(validFrames - expectedFrames) <= Math.max(2, Math.ceil(expectedFrames * 0.001)),
  );

  // Independently check the center of every synthetic segment. Duration alone
  // could pass with silence, repeated first-segment audio, or shifted content.
  stage = "segment-signal";
  const durations = [3.3, 5.3, 5.475, 5.2, 4.9, 4.075, 6.55, 4.125, 4.025, 4.375];
  const frequencies = durations.map((_, index) => 440 + 37 * index);
  function peak(buffer: Buffer, seconds: number): number {
    const start = Math.floor((seconds - 0.125) * 24000);
    assert.ok((start + 6000) * 2 <= buffer.length);
    const powers = frequencies.map((frequency) => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / 24000);
      let previous = 0;
      let beforePrevious = 0;
      let energy = 0;
      for (let index = 0; index < 6000; index++) {
        const sample = buffer.readInt16LE((start + index) * 2);
        energy += sample * sample;
        const current = sample + coefficient * previous - beforePrevious;
        beforePrevious = previous;
        previous = current;
      }
      assert.ok(Math.sqrt(energy / 6000) > 100, "silent segment");
      return (
        previous * previous +
        beforePrevious * beforePrevious -
        coefficient * previous * beforePrevious
      );
    });
    const frequency = frequencies[powers.indexOf(Math.max(...powers))];
    assert.ok(frequency !== undefined);
    return frequency;
  }
  let elapsed = 0;
  const segments = durations.map((duration, index) => {
    const center = elapsed + duration / 2;
    elapsed += duration;
    const sourceHz = peak(pcm, center);
    const outputHz = peak(decoded, center);
    assert.equal(sourceHz, frequencies[index], "source segment identity");
    assert.equal(outputHz, sourceHz, "converted segment identity");
    return { segment: index + 1, sourceHz, outputHz };
  });
  evidence.segments = segments;
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
