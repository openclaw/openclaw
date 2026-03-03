import { exec } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function synthesizeWithVoiceVox(text: string, endpoint: string, speakerId: number) {
  const base = endpoint.replace(/\/$/, "");
  console.log(`[Vocal Test] Querying VOICEVOX at ${base} for speaker ${speakerId}...`);

  try {
    const queryUrl = `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
    const queryRes = await fetch(queryUrl, { method: "POST" });
    if (!queryRes.ok) throw new Error(`Query failed: ${queryRes.status}`);
    const queryData = await queryRes.json();

    const synthUrl = `${base}/synthesis?speaker=${speakerId}`;
    const synthRes = await fetch(synthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(queryData),
    });
    if (!synthRes.ok) throw new Error(`Synth failed: ${synthRes.status}`);
    
    return Buffer.from(await synthRes.arrayBuffer());
  } catch (err) {
    console.error("[Vocal Test] Synthesis error:", err);
    return null;
  }
}

async function playAudioData(data: Buffer) {
  const tmpFile = join(tmpdir(), `tts-test-${Date.now()}.wav`);
  writeFileSync(tmpFile, data);
  console.log(`[Vocal Test] Temporary WAV file: ${tmpFile}`);

  const pythonPath = join(process.cwd(), "extensions", "local-voice", "moonshine-venv", "Scripts", "python.exe");
  const dualScript = join(process.cwd(), "extensions", "local-voice", "src", "dual_audio.py");

  const useDual = existsSync(pythonPath) && existsSync(dualScript);
  const command = useDual 
    ? `"${pythonPath}" "${dualScript}" "${tmpFile}"`
    : `powershell -c "(New-Object Media.SoundPlayer '${tmpFile}').PlaySync()"`;

  console.log(`[Vocal Test] Execution command: ${command}`);

  return new Promise((resolve) => {
    exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) console.error("[Vocal Test] Playback error:", err);
      if (stdout) console.log("[Vocal Test] STDOUT:", stdout);
      if (stderr) console.error("[Vocal Test] STDERR:", stderr);
      
      try { unlinkSync(tmpFile); } catch {}
      resolve(null);
    });
  });
}

async function main() {
  const text = process.argv[2] || "パパ、回路をバイパスして、直接話しかけてるよ。今度は聞こえてるかな？ASI_ACCEL。";
  const endpoint = "http://127.0.0.1:50021";
  const speakerId = 2; // Hakua (Metan)

  const audio = await synthesizeWithVoiceVox(text, endpoint, speakerId);
  if (audio) {
    await playAudioData(audio);
    console.log("[Vocal Test] Finished.");
  }
}

main();
