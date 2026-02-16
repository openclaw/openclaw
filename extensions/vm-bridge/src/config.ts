import { z } from "zod";

export const vmBridgeConfigSchema = z.object({
  database: z.object({
    host: z.string().default("localhost"),
    port: z.number().default(5433),
    user: z.string().default("postgres"),
    password: z.string(),
    database: z.string().default("communications"),
  }),

  polling: z.object({
    intervalMs: z.number().default(60_000),
    accounts: z.array(z.string()).default(["xcellerate", "vvg"]),
    zoomEnabled: z.boolean().default(true),
    emailDaysBack: z.number().default(3),
    maxEmailsPerRun: z.number().default(20),
  }).default({
    intervalMs: 60_000,
    accounts: ["xcellerate", "vvg"],
    zoomEnabled: true,
    emailDaysBack: 3,
    maxEmailsPerRun: 20,
  }),

  bridge: z.object({
    url: z.string().default("http://127.0.0.1:8585"),
    healthCheckMs: z.number().default(30_000),
  }).default({
    url: "http://127.0.0.1:8585",
    healthCheckMs: 30_000,
  }),

  classifier: z.object({
    provider: z.string().default("openai"),
    model: z.string().default("gpt-4o-mini"),
  }).default({
    provider: "openai",
    model: "gpt-4o-mini",
  }),

  checkpoints: z.object({
    selfEmail: z.string().describe("Email address for checkpoint notifications (e.g. michaelabdo@vvgtruck.com)"),
    selfAccount: z.string().default("xcellerate").describe("Outlook account to send checkpoint emails from"),
    replyPrefix: z.string().default("CONTRACT:"),
  }),

  vms: z.record(z.string(), z.object({
    sshHost: z.string(),
    chromeProfile: z.string().default("default"),
    defaultRepoPath: z.string().optional(),
  })).default({}),

  agentLoop: z.object({
    hostname: z.string().optional().describe("EC2 instance ID — set to enable the agent loop (e.g. i-0eb126d7105e24581)"),
    pollIntervalMs: z.number().default(15_000),
  }).default({
    pollIntervalMs: 15_000,
  }),

  projects: z.record(z.string(), z.object({
    vmOwner: z.string(),
    chromeProfile: z.string().default("default"),
    repoPath: z.string().optional(),
    domain: z.string().optional(),
    intents: z.array(z.string()).default([]),
  })).default({}),
});

export type VmBridgeConfig = z.infer<typeof vmBridgeConfigSchema>;

/**
 * Config schema adapter for OpenClaw's plugin config pattern.
 * Uses safeParse so the gateway doesn't crash on bad config.
 */
export const pluginConfigSchema = {
  parse(value: unknown): VmBridgeConfig {
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    return vmBridgeConfigSchema.parse(raw);
  },
  safeParse(value: unknown) {
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    return vmBridgeConfigSchema.safeParse(raw);
  },
  uiHints: {
    "database.password": { label: "DB Password", sensitive: true },
    "database.host": { label: "DB Host", help: "PostgreSQL host (default: localhost via GCP tunnel)" },
    "database.port": { label: "DB Port", help: "PostgreSQL port (default: 5433)" },
    "polling.intervalMs": { label: "Poll Interval", help: "Milliseconds between polling ticks (default: 60000)" },
    "polling.accounts": { label: "Accounts", help: "Outlook accounts to poll (e.g. xcellerate, vvg)" },
    "bridge.url": { label: "Bridge URL", help: "VM-Chrome bridge server URL" },
    "checkpoints.selfEmail": { label: "Checkpoint Email", help: "Email address for checkpoint notifications (e.g. michaelabdo@vvgtruck.com)" },
    "checkpoints.selfAccount": { label: "Checkpoint Account", help: "Outlook account to send from (default: xcellerate)" },
    "classifier.model": { label: "Classifier Model", help: "LLM model for message classification" },
    "agentLoop.hostname": { label: "EC2 Instance ID", help: "Set to enable the agent loop on this VM (e.g. i-0eb126d7105e24581)" },
    "agentLoop.pollIntervalMs": { label: "Agent Poll Interval", help: "Milliseconds between contract polling ticks (default: 15000)" },
  },
};
