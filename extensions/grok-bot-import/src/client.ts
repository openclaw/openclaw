import { resolveGrokBotAvatarDefaults } from "./avatar.js";
import { parseGrokBotRecipe, type GrokBotRecipe } from "./recipe.js";
import { readGrokResponse, resolveGrokShareId } from "./source.js";

type GrokReadMethod =
  | "GetGrokBotTemplateImportDetails"
  | "ListGrokBotAgents"
  | "ListGrokBotAgentSkills"
  | "ListGrokBotAgentAutomations"
  | "GetGrokBotAgentPlugins";

export type GrokHostedBot = {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  title?: string;
  avatarColor?: string;
  avatarShape?: string;
  avatarUrl?: string;
  harness?: string;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Grok returned an invalid ${label}.`);
  }
  // SAFETY: The guard excludes null, arrays, and primitives; property values remain unknown.
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Grok returned an invalid ${label}.`);
  }
  return value;
}
function rows(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Grok returned an invalid ${label} list.`);
  }
  return value.map((row) => object(row, label));
}

async function readAvatarImage(url: string): Promise<NonNullable<GrokBotRecipe["avatarImage"]>> {
  const { fetchRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
  const image = await fetchRemoteMedia({
    url,
    maxBytes: 1024 * 1024,
    requireHttps: true,
    maxRedirects: 0,
    timeoutMs: 30_000,
  });
  const bytes = image.buffer;
  switch (image.contentType) {
    case "image/png":
      return { bytes, extension: "png" };
    case "image/jpeg":
      return { bytes, extension: "jpg" };
    case "image/gif":
      return { bytes, extension: "gif" };
    case "image/webp":
      return { bytes, extension: "webp" };
    default:
      throw new Error("Grok avatar must be a PNG, JPEG, GIF, or WebP image no larger than 1 MiB.");
  }
}

/** Only documented-in-the-client read methods; never creates or shares templates. */
export class GrokBotClient {
  constructor(private readonly accessToken: string) {
    if (!accessToken.trim()) {
      throw new Error("A signed-in Grok Bot account is required.");
    }
  }

  private async request(
    method: GrokReadMethod,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const text = await readGrokResponse(
      `https://api2.cursor.sh/aiserver.v1.GrokBotService/${method}`,
      { token: this.accessToken, body },
    );
    return object(JSON.parse(text), method);
  }

  async readSharedBot(url: string): Promise<GrokBotRecipe> {
    const shareId = await resolveGrokShareId(url);
    const details = await this.request("GetGrokBotTemplateImportDetails", { shareId });
    const blobUrl = string(details.blobGetUrl, "template download URL");
    return parseGrokBotRecipe(await readGrokResponse(blobUrl));
  }

  async listBots(): Promise<GrokHostedBot[]> {
    const result = await this.request("ListGrokBotAgents", {});
    if (result.truncated === true || result.nextPageToken) {
      throw new Error(
        "Grok returned an incomplete bot roster; export selected recipes instead of importing a partial account.",
      );
    }
    return rows(result.agents, "agent")
      .filter(
        (agent) =>
          (agent.kind === 1 || agent.kind === "GROK_BOT_AGENT_KIND_AGENT") &&
          (agent.visibility === 1 || agent.visibility === "GROK_BOT_AGENT_VISIBILITY_OWNER") &&
          agent.viewerIsOwner !== false,
      )
      .map((agent) => {
        const bot: GrokHostedBot = {
          id: string(agent.id, "agent id"),
          agentId: string(agent.agentId, "hosted agent id"),
          name: string(agent.name, "agent name"),
        };
        for (const key of [
          "description",
          "title",
          "avatarColor",
          "avatarShape",
          "avatarUrl",
          "harness",
        ] as const) {
          if (agent[key] !== undefined) {
            bot[key] = string(agent[key], `agent ${key}`);
          }
        }
        return bot;
      });
  }

  async readBot(bot: GrokHostedBot): Promise<GrokBotRecipe> {
    const agentId = bot.agentId;
    const [skills, routines, plugins] = await Promise.all([
      this.request("ListGrokBotAgentSkills", { agentId }),
      this.request("ListGrokBotAgentAutomations", { agentId }),
      this.request("GetGrokBotAgentPlugins", { agentId, includeMcpConfig: false }),
    ]);
    // Preserve the full automation records until Grok's scheduler format is mapped.
    // Conversion never activates jobs or assumes the user's local timezone.
    const recipe = {
      profile: {
        name: bot.name,
        ...(bot.title ? { title: bot.title } : {}),
        description: bot.description ?? "",
        ...resolveGrokBotAvatarDefaults({
          id: bot.agentId,
          avatarColor: bot.avatarColor,
          avatarShape: bot.avatarShape,
        }),
      },
      // Grok's similarly named memory API is for team sharing, not owned bot memory.
      // Keep this missing source explicit below; an empty list does not mean no memories exist.
      memory: [],
      skills: rows(skills.skills, "skill").map((skill) => ({
        name: string(skill.name, "skill name"),
        description: string(skill.description ?? "", "skill description"),
        content: string(skill.body, "skill body"),
      })),
      routines: rows(routines.automations, "automation").map((routine) => ({
        name: string(routine.automationId, "automation id"),
        slug: string(routine.automationId, "automation id"),
        description:
          "Imported Grok automation; review the original schedule and content before enabling.",
        content: string(routine.recordJson, "automation record"),
      })),
      plugins: rows(plugins.plugins, "plugin").map((plugin) => ({
        name: string(plugin.displayName ?? plugin.name, "plugin name"),
        description: string(plugin.description ?? "", "plugin description"),
        pluginId: string(plugin.pluginId, "plugin id"),
      })),
    };
    const parsed = parseGrokBotRecipe(JSON.stringify(recipe));
    parsed.sourceLimitations = [
      {
        code: "source_memory_unavailable",
        message:
          "Grok does not expose this owned bot's complete memories through the available read APIs. No memories were imported; this does not mean the bot has none. Import a complete recipe to preserve them.",
      },
      {
        code: "source_integration_requirements_unavailable",
        message:
          "Available installed-plugin metadata was preserved, but Grok does not expose this owned bot's complete original integration requirements. Review its skills and connect the required integrations before use.",
      },
    ];
    if (bot.avatarUrl) {
      parsed.avatarImage = await readAvatarImage(bot.avatarUrl);
    }
    return parsed;
  }
}
