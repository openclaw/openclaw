import type { Command } from "commander";
import type { CambClientWrapper } from "./client.js";
import type { CambAiConfig } from "./config.js";

export interface CambAiCliParams {
  program: Command;
  config: CambAiConfig;
  ensureClient: () => CambClientWrapper;
}

// SpeechModel string literal type matching the SDK
type SpeechModel = "auto" | "mars-pro" | "mars-flash" | "mars-instruct";

/**
 * Map model parameter to SpeechModel enum
 */
function mapSpeechModel(modelParam: string): SpeechModel | undefined {
  switch (modelParam) {
    case "mars-flash":
      return "mars-flash";
    case "mars-pro":
      return "mars-pro";
    case "mars-instruct":
      return "mars-instruct";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

/**
 * Register Camb AI CLI commands
 */
export function registerCambAiCli(params: CambAiCliParams) {
  const { program, config, ensureClient } = params;

  const root = program
    .command("camb")
    .description("Camb AI audio tools")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/extensions/camb-ai\n`);

  // Status command
  root
    .command("status")
    .description("Check Camb AI configuration and connectivity")
    .action(async () => {
      console.log("Camb AI Status");
      console.log("==============");
      console.log();

      console.log(`Enabled: ${config.enabled ? "Yes" : "No"}`);
      console.log(`API Key: ${config.apiKey ? "Configured" : "Not configured"}`);
      console.log();

      console.log("TTS Settings:");
      console.log(`  Model: ${config.tts.model}`);
      console.log(`  Default Language: ${config.tts.defaultLanguage}`);
      console.log(`  Default Voice ID: ${config.tts.defaultVoiceId ?? "Not set"}`);
      console.log(`  Output Format: ${config.tts.outputFormat}`);
      console.log();

      console.log("Feature Flags:");
      console.log(`  Voice Cloning: ${config.voiceCloning.enabled ? "Enabled" : "Disabled"}`);
      console.log(`  Sound Generation: ${config.soundGeneration.enabled ? "Enabled" : "Disabled"}`);
      console.log();

      if (!config.apiKey) {
        console.log(
          "Warning: No API key configured. Set CAMB_API_KEY or configure in openclaw.yml",
        );
        return;
      }

      // Test connectivity
      console.log("Testing connectivity...");
      try {
        const client = ensureClient();
        const voices = await client.getClient().voiceCloning.listVoices();
        console.log(`Connected successfully. ${voices.length} voices available.`);
      } catch (err) {
        console.log(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // List voices command
  root
    .command("voices")
    .description("List available TTS voices")
    .option("-l, --language <code>", "Filter by language code (e.g., en-us)")
    .option("-g, --gender <gender>", "Filter by gender (male, female)")
    .option("--json", "Output as JSON")
    .action(async (options: { language?: string; gender?: string; json?: boolean }) => {
      try {
        const client = ensureClient();
        let voices = await client.getClient().voiceCloning.listVoices();

        // Apply filters - note: gender and language are numbers in the SDK
        if (options.gender) {
          const genderNum = options.gender.toLowerCase() === "male" ? 1 : 2;
          voices = voices.filter((v) => v.gender === genderNum);
        }

        if (options.json) {
          console.log(JSON.stringify(voices, null, 2));
          return;
        }

        console.log(`Available Voices (${voices.length}):`);
        console.log();
        console.log("ID\tName\t\t\tGender\tLanguage");
        console.log("-".repeat(60));
        for (const voice of voices) {
          const voiceId = String(voice.id);
          const name = (voice.voice_name || "").padEnd(20).slice(0, 20);
          const genderStr = voice.gender === 1 ? "male" : voice.gender === 2 ? "female" : "-";
          const langStr = typeof voice.language === "number" ? String(voice.language) : "-";
          console.log(`${voiceId}\t${name}\t${genderStr}\t${langStr}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // List languages command
  root
    .command("languages")
    .description("List available languages")
    .option("-t, --type <type>", "Language type: source or target", "source")
    .option("--json", "Output as JSON")
    .action(async (options: { type?: string; json?: boolean }) => {
      try {
        const client = ensureClient();
        let languages;

        if (options.type === "target") {
          languages = await client.getClient().languages.getTargetLanguages();
        } else {
          languages = await client.getClient().languages.getSourceLanguages();
        }

        if (options.json) {
          console.log(JSON.stringify(languages, null, 2));
          return;
        }

        const typeLabel = options.type === "target" ? "Target" : "Source";
        console.log(`Available ${typeLabel} Languages (${languages.length}):`);
        console.log();
        console.log("ID\tCode\tName");
        console.log("-".repeat(50));
        for (const lang of languages) {
          console.log(`${lang.id}\t${lang.shortName || "-"}\t${lang.language}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // TTS command
  root
    .command("tts")
    .description("Convert text to speech")
    .argument("<text>", "Text to convert to speech")
    .option("-v, --voice <id>", "Voice ID", parseInt)
    .option("-l, --language <code>", "Language code (e.g., en-us)")
    .option("-m, --model <model>", "MARS model (mars-pro, mars-flash, mars-instruct)")
    .option("-o, --output <file>", "Output file path (default: output.mp3)")
    .action(
      async (
        text: string,
        options: { voice?: number; language?: string; model?: string; output?: string },
      ) => {
        try {
          const client = ensureClient();

          const voiceId = options.voice ?? config.tts.defaultVoiceId;
          if (!voiceId) {
            console.error("Error: Voice ID required. Use --voice or configure tts.defaultVoiceId");
            process.exit(1);
          }

          const language = options.language ?? config.tts.defaultLanguage;
          const modelParam = options.model ?? config.tts.model;
          const speechModel = mapSpeechModel(modelParam);

          console.log(`Generating speech...`);
          console.log(`  Text: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
          console.log(`  Voice ID: ${voiceId}`);
          console.log(`  Language: ${language}`);
          console.log(`  Model: ${speechModel ?? "default"}`);

          const response = await client.getClient().textToSpeech.tts({
            text,
            language,
            voice_id: voiceId,
            speech_model: speechModel,
            output_configuration: {
              format: config.tts.outputFormat,
            },
          });

          // Save to file
          const outputPath = options.output ?? `output.${config.tts.outputFormat}`;
          const audioBuffer = Buffer.from(await response.arrayBuffer());

          const fs = await import("node:fs/promises");
          await fs.writeFile(outputPath, audioBuffer);

          console.log();
          console.log(`Audio saved to: ${outputPath}`);
          console.log(`Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );

  // Transcribe command
  root
    .command("transcribe")
    .description("Transcribe audio file to text")
    .argument("<file>", "Audio file path or URL to transcribe")
    .option(
      "-l, --language <id>",
      "Source language ID (use 'camb languages' to see options)",
      parseInt,
    )
    .option("--json", "Output as JSON")
    .action(async (file: string, options: { language?: number; json?: boolean }) => {
      try {
        const client = ensureClient();
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        let requestParams: { language: number; media_url?: string; media_file?: File };

        // Check if it's a URL or local file
        if (file.startsWith("http://") || file.startsWith("https://")) {
          console.log(`Transcribing URL: ${file}`);
          requestParams = {
            language: options.language ?? 1,
            media_url: file,
          };
        } else {
          // For local files, upload as a File object
          const audioBuffer = await fs.readFile(file);
          const fileName = path.basename(file);
          const mimeType = file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";

          console.log(`Transcribing: ${fileName}`);
          console.log(`Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);

          const audioFile = new File([audioBuffer], fileName, { type: mimeType });
          requestParams = {
            language: options.language ?? 1,
            media_file: audioFile,
          };
        }
        console.log();
        console.log("Starting transcription task...");

        // Start transcription task
        const result = await client.getClient().transcription.createTranscription(requestParams);

        const taskId = result.task_id;
        console.log(`Task ID: ${taskId}`);

        // Poll for completion
        let status = result;
        while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
          await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
          status = await client
            .getClient()
            .transcription.getTranscriptionTaskStatus({ task_id: taskId });
          console.log(`Status: ${status.status}`);
        }

        if (status.status === "FAILURE") {
          console.error("Transcription failed");
          process.exit(1);
        }

        // Get the result
        if (status.run_id) {
          const transcriptResult = await client.getClient().transcription.getTranscriptionResult({
            run_id: status.run_id,
          });

          if (options.json) {
            console.log(JSON.stringify(transcriptResult, null, 2));
          } else {
            console.log();
            console.log("Transcription:");
            console.log("-".repeat(40));
            const result = transcriptResult as {
              transcript?: { text: string; speaker?: string }[];
              text?: string;
            };
            if (result.transcript && Array.isArray(result.transcript)) {
              for (const segment of result.transcript) {
                const speaker = segment.speaker ? `[${segment.speaker}] ` : "";
                console.log(`${speaker}${segment.text}`);
              }
            } else if (result.text) {
              console.log(result.text);
            } else {
              console.log("(no text)");
            }
          }
        } else {
          console.log("No run_id returned - check task status");
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Translate command
  root
    .command("translate")
    .description("Translate text to another language")
    .argument("<text>", "Text to translate")
    .option(
      "-t, --to <lang>",
      "Target language ID (use 'camb languages --type target' to see options)",
    )
    .option("-f, --from <lang>", "Source language ID (use 'camb languages' to see options)", "1")
    .option("--json", "Output as JSON")
    .action(async (text: string, options: { to?: string; from?: string; json?: boolean }) => {
      try {
        const client = ensureClient();

        if (!options.to) {
          console.error("Error: Target language required. Use --to <lang_id>");
          console.error("Run 'openclaw camb languages --type target' to see available languages");
          process.exit(1);
        }

        console.log(`Translating...`);
        console.log(`  Text: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
        console.log(`  From: ${options.from} → To: ${options.to}`);
        console.log();
        console.log("Starting translation task...");

        // Start translation task
        const result = await client.getClient().translation.createTranslation({
          texts: [text],
          source_language: Number(options.from),
          target_language: Number(options.to),
        });

        const taskId = (result as { task_id?: string }).task_id;
        if (!taskId) {
          // Might be a direct result
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log("Translation result:");
            console.log(JSON.stringify(result, null, 2));
          }
          return;
        }

        console.log(`Task ID: ${taskId}`);

        // Poll for completion
        let status = result as { status?: string; run_id?: number };
        while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
          await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
          status = await client
            .getClient()
            .translation.getTranslationTaskStatus({ task_id: taskId });
          console.log(`Status: ${status.status}`);
        }

        if (status.status === "FAILURE") {
          console.error("Translation failed");
          process.exit(1);
        }

        // Get the result
        if (status.run_id) {
          const translationResult = await client.getClient().translation.getTranslationResult({
            run_id: status.run_id,
          });

          if (options.json) {
            console.log(JSON.stringify(translationResult, null, 2));
          } else {
            console.log();
            console.log("Translation:");
            console.log("-".repeat(40));
            const result = translationResult as { texts?: string[]; translations?: string[] };
            const texts = result.texts ?? result.translations;
            if (Array.isArray(texts) && texts.length > 0) {
              console.log(texts[0]);
            } else {
              console.log(JSON.stringify(translationResult, null, 2));
            }
          }
        } else {
          console.log("No run_id returned - check task status");
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Sound generate command
  root
    .command("sound-generate")
    .description("Generate sound or music from a text prompt")
    .argument("<prompt>", "Description of the sound to generate")
    .option("-d, --duration <seconds>", "Duration in seconds (default: 10)", parseInt)
    .option("-o, --output <file>", "Output file path (default: sound.wav)")
    .action(async (prompt: string, options: { duration?: number; output?: string }) => {
      try {
        if (!config.soundGeneration.enabled) {
          console.error("Error: Sound generation is disabled in config");
          console.error(
            "Enable with: openclaw config set plugins.entries.camb-ai.config.soundGeneration.enabled true",
          );
          process.exit(1);
        }

        const client = ensureClient();
        const duration = options.duration ?? 10;

        console.log(`Generating sound...`);
        console.log(`  Prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}"`);
        console.log(`  Duration: ${duration}s`);
        console.log();
        console.log("This may take a while...");

        // Start sound generation task
        const result = await client.getClient().textToAudio.createTextToAudio({
          prompt,
          duration,
        });

        const taskId = result.task_id;
        console.log(`Task ID: ${taskId}`);

        // Poll for completion
        let status = result as { status?: string; run_id?: number };
        while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
          await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
          status = await client.getClient().textToAudio.getTextToAudioStatus({ task_id: taskId });
          console.log(`Status: ${status.status}`);
        }

        if (status.status === "FAILURE") {
          console.error("Sound generation failed");
          process.exit(1);
        }

        // Get the audio result
        if (status.run_id) {
          const audioResponse = await client.getClient().textToAudio.getTextToAudioResult({
            run_id: status.run_id,
          });
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
          const outputPath = options.output ?? "sound.wav";

          const fs = await import("node:fs/promises");
          await fs.writeFile(outputPath, audioBuffer);

          console.log();
          console.log(`Audio saved to: ${outputPath}`);
          console.log(`Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
        } else {
          console.log("No run_id returned - check task status");
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Voice clone command
  root
    .command("voice-clone")
    .description("Clone a voice from an audio sample")
    .argument("<file>", "Audio file with voice sample (2+ seconds)")
    .option("-n, --name <name>", "Name for the cloned voice", "cloned-voice")
    .option("-g, --gender <gender>", "Gender: male or female", "male")
    .action(async (file: string, options: { name: string; gender: string }) => {
      try {
        if (!config.voiceCloning.enabled) {
          console.error("Error: Voice cloning is disabled in config");
          console.error(
            "Enable with: openclaw config set plugins.entries.camb-ai.config.voiceCloning.enabled true",
          );
          process.exit(1);
        }

        const client = ensureClient();
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const audioBuffer = await fs.readFile(file);
        const fileName = path.basename(file);
        const mimeType = file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
        const audioFile = new File([audioBuffer], fileName, { type: mimeType });

        const genderNum = options.gender.toLowerCase() === "female" ? 2 : 1;

        console.log(`Cloning voice from: ${fileName}`);
        console.log(`  Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
        console.log(`  Name: ${options.name}`);
        console.log(`  Gender: ${options.gender}`);
        console.log();

        const result = await client.getClient().voiceCloning.createCustomVoice({
          file: audioFile,
          voice_name: options.name,
          gender: genderNum,
        });

        console.log("Voice cloned successfully!");
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Create voice from description
  root
    .command("create-voice")
    .description("Create a new voice from a text description")
    .argument(
      "<description>",
      "Description of the voice (e.g., 'young female with British accent')",
    )
    .option(
      "-t, --text <text>",
      "Sample text to speak (min 100 chars)",
      "Hello, this is a test of my new voice. I can speak clearly and naturally, conveying emotions and ideas with precision and warmth.",
    )
    .option("-o, --output <file>", "Output audio file path")
    .action(async (description: string, options: { text: string; output?: string }) => {
      try {
        const client = ensureClient();

        if (options.text.length < 100) {
          console.error("Error: Sample text must be at least 100 characters");
          process.exit(1);
        }

        console.log(`Creating voice...`);
        console.log(
          `  Description: "${description.slice(0, 50)}${description.length > 50 ? "..." : ""}"`,
        );
        console.log(`  Sample text: "${options.text.slice(0, 30)}..."`);
        console.log();
        console.log("This may take a while...");

        const result = await client.getClient().textToVoice.createTextToVoice({
          text: options.text,
          voice_description: description,
        });

        const taskId = result.task_id;
        console.log(`Task ID: ${taskId}`);

        // Poll for completion
        let status = result as { status?: string; run_id?: number };
        while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
          await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
          status = await client.getClient().textToVoice.getTextToVoiceStatus({ task_id: taskId });
          console.log(`Status: ${status.status}`);
        }

        if (status.status === "FAILURE") {
          console.error("Voice creation failed");
          process.exit(1);
        }

        if (status.run_id) {
          const voiceResult = await client.getClient().textToVoice.getTextToVoiceResult({
            run_id: status.run_id,
          });

          console.log();
          console.log("Voice created successfully!");
          console.log(JSON.stringify(voiceResult, null, 2));
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  // Translated TTS command
  root
    .command("translated-tts")
    .description("Translate text and speak it in another language")
    .argument("<text>", "Text to translate and speak")
    .option("-v, --voice <id>", "Voice ID", parseInt)
    .option("-f, --from <lang>", "Source language ID", "1")
    .option("-t, --to <lang>", "Target language ID")
    .option("-o, --output <file>", "Output audio file path")
    .action(
      async (
        text: string,
        options: { voice?: number; from: string; to?: string; output?: string },
      ) => {
        try {
          const client = ensureClient();

          const voiceId = options.voice ?? config.tts.defaultVoiceId;
          if (!voiceId) {
            console.error("Error: Voice ID required. Use --voice or configure tts.defaultVoiceId");
            process.exit(1);
          }

          if (!options.to) {
            console.error("Error: Target language required. Use --to <lang_id>");
            process.exit(1);
          }

          console.log(`Translated TTS...`);
          console.log(`  Text: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
          console.log(`  From: ${options.from} → To: ${options.to}`);
          console.log(`  Voice ID: ${voiceId}`);
          console.log();

          // Create translated TTS task
          const response = await client.getClient().translatedTts.createTranslatedTts({
            text,
            voice_id: voiceId,
            source_language: Number(options.from),
            target_language: Number(options.to),
          });

          const taskId = response.task_id;
          console.log(`Task ID: ${taskId}`);

          // Poll for completion
          let status: { status?: string; run_id?: number } = { status: "PENDING" };
          while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
            await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
            status = await client
              .getClient()
              .translatedTts.getTranslatedTtsTaskStatus({ task_id: taskId });
            console.log(`Status: ${status.status}`);
          }

          if (status.status === "FAILURE") {
            console.error("Translated TTS failed");
            process.exit(1);
          }

          // Small delay to ensure result is available in backend
          await new Promise((r) => setTimeout(r, 1000));

          // Get the audio URL using TTS run info
          if (status.run_id) {
            const result = await client.getClient().textToSpeech.getTtsRunInfo({
              run_id: status.run_id,
              output_type: "file_url",
            });

            const resultData = result as { output_url?: string };
            if (resultData.output_url) {
              const audioResponse = await fetch(resultData.output_url);
              const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
              const outputPath = options.output ?? "translated.wav";

              const fs = await import("node:fs/promises");
              await fs.writeFile(outputPath, audioBuffer);

              console.log();
              console.log(`Audio saved to: ${outputPath}`);
              console.log(`Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
            } else {
              console.log("No output URL in result:");
              console.log(JSON.stringify(result, null, 2));
            }
          } else {
            console.error("No run_id returned");
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      },
    );

  // Audio separation command
  root
    .command("audio-separate")
    .description("Separate vocals from background audio")
    .argument("<file>", "Audio file to separate")
    .option("-o, --output-dir <dir>", "Output directory for separated tracks", ".")
    .action(async (file: string, options: { outputDir: string }) => {
      try {
        const client = ensureClient();
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const audioBuffer = await fs.readFile(file);
        const fileName = path.basename(file);
        const mimeType = file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
        const audioFile = new File([audioBuffer], fileName, { type: mimeType });

        console.log(`Separating audio: ${fileName}`);
        console.log(`  Size: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
        console.log();
        console.log("This may take a while...");

        const result = await client.getClient().audioSeparation.createAudioSeparation({
          media_file: audioFile,
        });

        const taskId = result.task_id;
        console.log(`Task ID: ${taskId}`);

        // Poll for completion
        let status = result as { status?: string; run_id?: number };
        while (status.status !== "SUCCESS" && status.status !== "FAILURE") {
          await new Promise((r) => setTimeout(r, config.pollingIntervalMs));
          status = await client
            .getClient()
            .audioSeparation.getAudioSeparationStatus({ task_id: taskId });
          console.log(`Status: ${status.status}`);
        }

        if (status.status === "FAILURE") {
          console.error("Audio separation failed");
          process.exit(1);
        }

        if (status.run_id) {
          const separationResult = await client
            .getClient()
            .audioSeparation.getAudioSeparationRunInfo({
              run_id: status.run_id,
            });

          console.log();
          console.log("Audio separation complete!");
          console.log(JSON.stringify(separationResult, null, 2));

          // Download the separated tracks if URLs are available
          const resultData = separationResult as {
            foreground_audio_url?: string;
            background_audio_url?: string;
          };
          if (resultData.foreground_audio_url) {
            const fgResponse = await fetch(resultData.foreground_audio_url);
            const fgBuffer = Buffer.from(await fgResponse.arrayBuffer());
            const fgPath = path.join(options.outputDir, "vocals.flac");
            await fs.writeFile(fgPath, fgBuffer);
            console.log(`Vocals saved to: ${fgPath} (${(fgBuffer.length / 1024).toFixed(1)} KB)`);
          }
          if (resultData.background_audio_url) {
            const bgResponse = await fetch(resultData.background_audio_url);
            const bgBuffer = Buffer.from(await bgResponse.arrayBuffer());
            const bgPath = path.join(options.outputDir, "background.flac");
            await fs.writeFile(bgPath, bgBuffer);
            console.log(
              `Background saved to: ${bgPath} (${(bgBuffer.length / 1024).toFixed(1)} KB)`,
            );
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  return root;
}
