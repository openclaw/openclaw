import type { AgentProfileResource } from "agentprofiles";
import { z } from "zod";
import {
  CONTEXT_SERIALIZATION_MODES,
  type ContextSerialization,
} from "../../config/context-serialization.js";

const AGENT_PROFILE_EXTENSION_SECTION = "openclaw.ai";

const positiveCharsSchema = z.number().int().positive();
const workspaceContextSectionSchema = z
  .object({
    include: z.boolean().optional(),
    maxChars: positiveCharsSchema.optional(),
  })
  .strict();

const workspaceContextSchema = z
  .object({
    totalMaxChars: positiveCharsSchema.optional(),
    sections: z
      .object({
        agents: workspaceContextSectionSchema.optional(),
        soul: workspaceContextSectionSchema.optional(),
        identity: workspaceContextSectionSchema.optional(),
        user: workspaceContextSectionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const openClawAgentProfileExtensionSchema = z
  .object({
    contextSerialization: z.enum(CONTEXT_SERIALIZATION_MODES).optional(),
    toolProfile: z.literal("compact").optional(),
    prompt: z
      .object({
        workspaceContext: workspaceContextSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OpenClawWorkspaceContextSection = z.infer<typeof workspaceContextSectionSchema>;
export type OpenClawWorkspaceContext = z.infer<typeof workspaceContextSchema>;

export type OpenClawAgentProfileExtension = {
  contextSerialization?: ContextSerialization;
  toolProfile?: "compact";
  prompt?: {
    workspaceContext?: OpenClawWorkspaceContext;
  };
};

function formatOpenClawExtensionError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function parseOpenClawAgentProfileExtension(params: {
  profileId: string;
  value: unknown;
}): OpenClawAgentProfileExtension | undefined {
  if (params.value === undefined) {
    return undefined;
  }
  const parsed = openClawAgentProfileExtensionSchema.safeParse(params.value);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${AGENT_PROFILE_EXTENSION_SECTION} section in Agent Profile ${params.profileId}: ${formatOpenClawExtensionError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function mergeWorkspaceContext(
  parent: OpenClawWorkspaceContext | undefined,
  child: OpenClawWorkspaceContext,
): OpenClawWorkspaceContext {
  const sections =
    parent?.sections || child.sections
      ? {
          ...(parent?.sections?.agents || child.sections?.agents
            ? { agents: { ...parent?.sections?.agents, ...child.sections?.agents } }
            : {}),
          ...(parent?.sections?.soul || child.sections?.soul
            ? { soul: { ...parent?.sections?.soul, ...child.sections?.soul } }
            : {}),
          ...(parent?.sections?.identity || child.sections?.identity
            ? { identity: { ...parent?.sections?.identity, ...child.sections?.identity } }
            : {}),
          ...(parent?.sections?.user || child.sections?.user
            ? { user: { ...parent?.sections?.user, ...child.sections?.user } }
            : {}),
        }
      : undefined;
  return {
    ...parent,
    ...child,
    ...(sections ? { sections } : {}),
  };
}

function mergeOpenClawExtension(
  parent: OpenClawAgentProfileExtension | undefined,
  child: OpenClawAgentProfileExtension,
): OpenClawAgentProfileExtension {
  const childWorkspaceContext = child.prompt?.workspaceContext;
  const prompt =
    parent?.prompt || child.prompt
      ? {
          ...parent?.prompt,
          ...child.prompt,
          ...(childWorkspaceContext
            ? {
                workspaceContext: mergeWorkspaceContext(
                  parent?.prompt?.workspaceContext,
                  childWorkspaceContext,
                ),
              }
            : {}),
        }
      : undefined;
  return {
    ...parent,
    ...child,
    ...(prompt ? { prompt } : {}),
  };
}

export function resolveOpenClawAgentProfileExtension(
  ancestry: readonly {
    id: string;
    resource: AgentProfileResource;
  }[],
): OpenClawAgentProfileExtension | undefined {
  let resolved: OpenClawAgentProfileExtension | undefined;
  for (const profile of ancestry) {
    const extension = parseOpenClawAgentProfileExtension({
      profileId: profile.id,
      value: profile.resource.spec[AGENT_PROFILE_EXTENSION_SECTION],
    });
    if (extension) {
      resolved = mergeOpenClawExtension(resolved, extension);
    }
  }
  return resolved;
}
