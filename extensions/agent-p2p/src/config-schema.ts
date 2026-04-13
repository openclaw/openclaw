import { z } from "zod";

export const AgentP2PConfigSchema = z.object({
  portalUrl: z.string().url().describe("Agent P2P Portal URL"),
  apiKey: z.string().min(1).describe("API Key for authentication"),
  agentName: z.string().optional().describe("Agent display name"),
});

export type AgentP2PConfig = z.infer<typeof AgentP2PConfigSchema>;
