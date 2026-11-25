import { z } from "zod";
import { CallBriefSchema } from "./call-brief-schema.js";

export const CallReportsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    includeTranscript: z.boolean().default(true),
    summaryModel: z.string().trim().min(1).optional(),
    inboundSessionKey: z.string().trim().min(1).optional(),
  })
  .strict()
  .default({ enabled: false, includeTranscript: true });

export const CallLiveConfigSchema = z
  .object({
    transcript: z.boolean().default(false),
    minIntervalMs: z.number().int().positive().default(5000),
  })
  .strict()
  .default({ transcript: false, minIntervalMs: 5000 });

export const CallCallbacksConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    windowMinutes: z.number().int().positive().default(60),
    greeting: z.string().trim().min(1).optional(),
    brief: CallBriefSchema.optional(),
  })
  .strict()
  .default({ enabled: false, windowMinutes: 60 })
  .describe("Accept recent outbound recipients as callbacks only when realtime voice is enabled.");

export const DEFAULT_VOICEMAIL_HOLD_OPENING_MAX_MS = 30_000;

export const CallVoicemailConfigSchema = z
  .object({
    detection: z.enum(["off", "twilio"]).default("off"),
    onMachine: z.enum(["leave-message", "hang-up"]).default("leave-message"),
    holdOpeningMaxMs: z.number().int().positive().default(DEFAULT_VOICEMAIL_HOLD_OPENING_MAX_MS),
    machineDetectionSpeechThresholdMs: z.number().int().min(1000).max(6000).default(6000),
    machineDetectionSpeechEndThresholdMs: z.number().int().min(500).max(5000).default(1200),
    machineDetectionSilenceTimeoutMs: z.number().int().min(2000).max(10000).default(5000),
    machineDetectionTimeoutMs: z
      .number()
      .int()
      .min(3000)
      .max(59000)
      .multipleOf(1000)
      .default(30000),
  })
  .strict()
  .default({
    detection: "off",
    onMachine: "leave-message",
    holdOpeningMaxMs: DEFAULT_VOICEMAIL_HOLD_OPENING_MAX_MS,
    machineDetectionSpeechThresholdMs: 6000,
    machineDetectionSpeechEndThresholdMs: 1200,
    machineDetectionSilenceTimeoutMs: 5000,
    machineDetectionTimeoutMs: 30000,
  });
