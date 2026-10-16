import path from "node:path";
import { z } from "zod";

export const agentsApiExecutorBindingSchema = z.object({
  workspaceDirectory: z
    .string()
    .min(1)
    .refine((value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
  sessionKey: z.string().min(1),
  agentId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  environmentId: z.string().min(1),
  remoteUrl: z.string().min(1),
});

export type AgentsApiExecutorBinding = z.infer<typeof agentsApiExecutorBindingSchema>;
