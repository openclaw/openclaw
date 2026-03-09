import { z } from "zod";

export const LiveKitVoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  livekit: z
    .object({
      url: z.string().default("ws://localhost:7880"),
      apiKey: z.string().optional(),
      apiSecret: z.string().optional(),
    })
    .default({}),
  agent: z
    .object({
      model: z.string().default("gemini-live-2.5-flash-native-audio"),
      voice: z.string().default("Kore"),
      vertexai: z.boolean().default(true),
      project: z.string().default("shiftmindlab"),
      location: z.string().default("us-west1"),
    })
    .default({}),
  owner: z
    .object({
      name: z.string().default("Anson"),
      identity: z.string().default("anson"),
      sessionKey: z.string().default("agent:main:whatsapp:dm:85297603778"),
      roomPrefix: z.string().default("ada-voice"),
    })
    .default({}),
  frontend: z
    .object({
      publicUrl: z.string().optional(),
    })
    .default({}),
});

export type LiveKitVoiceConfig = z.infer<typeof LiveKitVoiceConfigSchema>;
