import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const id = "goal24-audio";
const channel = "goal24audio";
const digest = (data) => createHash("sha256").update(data).digest("hex");
const sends = [];
export default definePluginEntry({
  id,
  name: "Synthetic audio package boundary",
  description: "No network transport or speech service",
  register(api) {
    api.registerSpeechProvider({
      id,
      label: "Synthetic committed tone bytes",
      isConfigured: () => true,
      synthesize: async (request) => {
        assert.equal(request.target, "audio-file");
        return {
          audioBuffer: await fs.readFile(path.join(import.meta.dirname, "fixture.mp3")),
          fileExtension: ".mp3",
          outputFormat: "mp3",
          voiceCompatible: false,
        };
      },
    });
    api.registerChannel({
      plugin: {
        id: channel,
        meta: {
          id: channel,
          label: "Synthetic recording adapter",
          selectionLabel: "Synthetic recording adapter",
          docsPath: "/channels/goal24audio",
          blurb: "Records adapter input only; never Messages delivery",
        },
        capabilities: {
          chatTypes: ["direct"],
          media: true,
          tts: {
            voice: {
              synthesisTarget: "audio-file",
              audioFileFormats: ["mp3", "caf"],
              preferAudioFileFormat: "caf",
            },
          },
        },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
        },
        messaging: {
          normalizeTarget: (target) => target,
          targetResolver: { looksLikeId: () => true, hint: "synthetic" },
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to }) => ({ ok: true, to }),
          sendText: async () => {
            throw new Error("Attachment must reach sendMedia, not sendText");
          },
          sendMedia: async ({ mediaUrl, to }) => {
            assert.equal(to, "synthetic-receiver");
            assert.equal(typeof mediaUrl, "string");
            const bytes = await fs.readFile(mediaUrl);
            const receipt = {
              sha256: digest(bytes),
              bytes: bytes.length,
              extension: path.extname(mediaUrl),
              target: to,
              boundary: "recording-adapter-input-not-device",
            };
            sends.push(receipt);
            return { channel, messageId: "synthetic-" + sends.length };
          },
        },
      },
    });
    api.registerGatewayMethod(
      "goal24.audio",
      async ({ params, respond }) => {
        try {
          if (params?.action === "receipts") {
            respond(true, { sends });
            return;
          }
          const result = await api.runtime.tts.textToSpeech({
            text: "Synthetic mathematical tones for package proof.",
            cfg: api.config,
            channel,
            disableFallback: true,
          });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(typeof result.audioPath, "string");
          const bytes = await fs.readFile(result.audioPath);
          respond(true, {
            audioPath: result.audioPath,
            sha256: digest(bytes),
            bytes: bytes.length,
            extension: path.extname(result.audioPath),
            audioAsVoice: result.audioAsVoice,
            provider: result.provider,
          });
        } catch (error) {
          respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
        }
      },
      { scope: "operator.admin" },
    );
  },
});
