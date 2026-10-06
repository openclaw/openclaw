import path from "node:path";
import { z } from "zod";

const workspaceSchema = z.object({
  workspaceDirectory: z
    .string()
    .min(1)
    .refine((value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
});

export const agentsApiExecutorBindingSchema = workspaceSchema.extend({
  sessionKey: z.string().min(1),
  agentId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  environmentId: z.string().min(1),
  remoteUrl: z.string().min(1),
});

export type AgentsApiExecutorBinding = z.infer<typeof agentsApiExecutorBindingSchema>;
