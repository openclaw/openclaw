import type {
  FeatureClient,
  FeatureInput,
  FeatureOutput,
  FeatureRequestOptions,
} from "openclaw/plugin-sdk/feature-contract";
import { browserContract } from "./browser-contract.js";
import type { contract } from "./contract.js";

type Client = FeatureClient<typeof contract>;
type Operation = keyof typeof contract.operations;

/** A feature client that reads (and, for operators, writes) as the agent
 * selected in the viewing selector. The default agent uses ordinary calls;
 * any other agent goes through the operator-only proxy operations, so model
 * tools never carry a store or agent selector. */
export function viewingClient(
  base: Client,
  viewing: () => { agent?: string; defaultAgent?: string },
): Client {
  const invoke = async <K extends Operation>(
    operation: K,
    input: FeatureInput<typeof contract, K>,
    options?: FeatureRequestOptions,
  ): Promise<FeatureOutput<typeof contract, K>> => {
    const { agent, defaultAgent } = viewing();
    if (
      !agent ||
      agent === defaultAgent ||
      operation.startsWith("stores_") ||
      operation.startsWith("agent_")
    ) {
      return base.invoke(operation, input, options);
    }
    const proxy =
      browserContract.operations[operation].kind === "query" ? "agent_query" : "agent_action";
    // SAFETY: the proxy validates the inner output against operation K's own output schema.
    return (await base.invoke(proxy, { agent, operation, input }, options)) as FeatureOutput<
      typeof contract,
      K
    >;
  };
  return { ...base, invoke };
}
