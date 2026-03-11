import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { AgentCoreRuntimeConfig } from "./types.js";

const DEFAULT_REGION = "us-west-2";
const DEFAULT_MEMORY_NAMESPACE_PREFIX = "tenant_";
const DEFAULT_MODEL = "anthropic.claude-sonnet-4-20250514";

export type AgentCoreConfigSource = {
  /** SSM parameter path prefix (e.g. "/hyperion/beta/agentcore"). */
  ssmPrefix: string;
  /** AWS region for SSM and AgentCore. */
  region?: string;
  /** Override for local development (skip SSM, use provided config). */
  localOverride?: Partial<AgentCoreRuntimeConfig>;
};

/**
 * Load AgentCore config from SSM parameters written by CDK (AgentCoreConstruct):
 *
 *   /hyperion/{stage}/agentcore/runtime-arns   — JSON array of Runtime ARNs
 *   /hyperion/{stage}/agentcore/memory-config   — JSON { memoryEnabled, memoryNamespacePrefix }
 *   /hyperion/{stage}/agentcore/default-model   — model ID string
 */
export async function loadAgentCoreConfig(
  source: AgentCoreConfigSource,
): Promise<AgentCoreRuntimeConfig> {
  const region = source.region || DEFAULT_REGION;

  if (source.localOverride) {
    return {
      region,
      runtimeArns: source.localOverride.runtimeArns ?? [],
      memoryNamespacePrefix:
        source.localOverride.memoryNamespacePrefix ?? DEFAULT_MEMORY_NAMESPACE_PREFIX,
      defaultModel: source.localOverride.defaultModel ?? DEFAULT_MODEL,
      endpoint: source.localOverride.endpoint,
      invokeTimeoutMs: source.localOverride.invokeTimeoutMs,
    };
  }

  const ssm = new SSMClient({ region });

  const [runtimeArnsParam, memoryConfigParam, defaultModelParam] = await Promise.all([
    ssmGet(ssm, `${source.ssmPrefix}/runtime-arns`),
    ssmGet(ssm, `${source.ssmPrefix}/memory-config`),
    ssmGet(ssm, `${source.ssmPrefix}/default-model`),
  ]);

  let runtimeArns: string[] = [];
  try {
    const parsed = JSON.parse(runtimeArnsParam ?? "[]");
    if (Array.isArray(parsed)) {
      runtimeArns = parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
    }
  } catch {
    // Fall through to empty array
  }

  let memoryNamespacePrefix = DEFAULT_MEMORY_NAMESPACE_PREFIX;
  try {
    const parsed = JSON.parse(memoryConfigParam ?? "{}");
    if (parsed && typeof parsed.memoryNamespacePrefix === "string") {
      memoryNamespacePrefix = parsed.memoryNamespacePrefix;
    }
  } catch {
    // Fall through to default
  }

  const defaultModel = defaultModelParam?.trim() || DEFAULT_MODEL;

  return {
    region,
    runtimeArns,
    memoryNamespacePrefix,
    defaultModel,
  };
}

async function ssmGet(ssm: SSMClient, name: string): Promise<string | null> {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: name }));
    return resp.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}
