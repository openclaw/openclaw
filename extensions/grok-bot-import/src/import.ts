import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  callGatewayFromCli,
  isImplicitLocalGatewayTargetFromCli,
  type GatewayRpcOpts,
} from "openclaw/plugin-sdk/gateway-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { GrokBotClient } from "./client.js";
import { convertGrokBotRecipe, type GrokBotConversionResult } from "./convert.js";
import type { GrokBotRecipe } from "./recipe.js";
import { parseGrokBotUrl, readGrokRecipeFile } from "./source.js";

export type GrokImportResult = {
  source: string;
  name?: string;
  status: "converted" | "installed" | "failed";
  conversion?: GrokBotConversionResult;
  agentId?: string;
  error?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Claws gateway response.");
  }
  // SAFETY: The guard excludes null, arrays, and primitives; property values remain unknown.
  return value as Record<string, unknown>;
}

export async function installConvertedPackage(
  packageRoot: string,
  gateway: GatewayRpcOpts,
): Promise<string> {
  if (!(await isImplicitLocalGatewayTargetFromCli(gateway))) {
    throw new Error(
      "Local Claw packages must be installed on the gateway machine. Transfer the converted package there and run grok-bot install <directory> using its local gateway configuration.",
    );
  }
  const source = { localPath: resolve(packageRoot) };
  const options = { ...gateway, json: true };
  const plan = record(await callGatewayFromCli("claws.add.plan", options, { source }));
  if (Array.isArray(plan.blockers) && plan.blockers.length > 0) {
    throw new Error(
      `Claw installation is blocked: ${JSON.stringify(plan.blockers)}. Converted package remains at ${packageRoot}.`,
    );
  }
  if (typeof plan.planIntegrity !== "string") {
    throw new Error("Claws gateway did not return an installation plan.");
  }
  const applied = record(
    await callGatewayFromCli("claws.add.apply", options, {
      source,
      planIntegrity: plan.planIntegrity,
    }),
  );
  if (applied.status !== "complete" || typeof applied.agentId !== "string") {
    const failure = applied.error === undefined ? undefined : record(applied.error);
    const detail = typeof failure?.message === "string" ? ` ${failure.message}` : "";
    throw new Error(
      `Claw installation did not complete.${detail} Inspect the agent list before retrying; converted package remains at ${packageRoot}.`,
    );
  }
  return applied.agentId;
}

export async function importGrokBots(options: {
  source?: string;
  all?: boolean;
  out: string;
  install?: boolean;
  resolveAccessToken: () => Promise<string>;
  gateway?: GatewayRpcOpts;
}): Promise<GrokImportResult[]> {
  if (Boolean(options.source) === Boolean(options.all)) {
    throw new Error("Choose one Grok recipe/URL, or --all for the signed-in account.");
  }
  const results: GrokImportResult[] = [];
  const perform = async (
    source: string,
    destination: string,
    read: () => Promise<GrokBotRecipe>,
    identitySuffix?: string,
    knownName?: string,
  ) => {
    const result: GrokImportResult = { source, name: knownName, status: "failed" };
    results.push(result);
    try {
      const recipe = await read();
      result.name = recipe.profile.name;
      result.conversion = await convertGrokBotRecipe({ recipe, destination, identitySuffix });
      result.status = "converted";
      if (options.install) {
        result.agentId = await installConvertedPackage(
          result.conversion.packageRoot,
          options.gateway ?? {},
        );
        result.status = "installed";
      }
    } catch (error) {
      result.status = "failed";
      result.error = redactSensitiveText(
        error instanceof Error ? error.message : "Grok import failed.",
      );
    }
  };
  const root = resolve(options.out);
  if (options.all) {
    const client = new GrokBotClient(await options.resolveAccessToken());
    const bots = await client.listBots();
    if (bots.length === 0) {
      throw new Error("The signed-in Grok account has no bots to import.");
    }
    for (const bot of bots) {
      // Stable identity suffix disambiguates equal display names without using source paths.
      const id = createHash("sha256").update(bot.id).digest("hex").slice(0, 12);
      await perform(
        `grok-agent:${bot.id}`,
        join(root, `bot-${id}`),
        () => client.readBot(bot),
        id,
        bot.name,
      );
    }
  } else {
    const source = options.source!;
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
      parseGrokBotUrl(source);
      const client = new GrokBotClient(await options.resolveAccessToken());
      await perform(source, root, () => client.readSharedBot(source));
    } else {
      await perform(source, root, () => readGrokRecipeFile(source));
    }
  }
  return results;
}
