import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { record } from "./protocol.js";
import type { SubscriptionBinding } from "./state.js";

type PreparedEventSource = Awaited<
  ReturnType<NonNullable<OpenClawPluginServiceContext["mcpEvents"]>["prepareSource"]>
>;
export type SourceBinding = {
  facts: SubscriptionBinding;
  source?: PreparedEventSource;
  live: boolean;
};
export class SourceRevokedError extends Error {}

export function isAuthorityUnavailable(error: unknown): boolean {
  return record(error)?.code === "MCP_AUTHORIZATION_UNAVAILABLE";
}
function isAuthorityRetired(error: unknown): boolean {
  return record(error)?.code === "MCP_AUTHORIZATION_RETIRED";
}

/** Holds no credential state: observations and lifetime identity belong to native credential owners. */
export class McpEventsSourceAuthority {
  constructor(
    private readonly prepareSource: NonNullable<
      OpenClawPluginServiceContext["mcpEvents"]
    >["prepareSource"],
    private readonly assertService: () => void,
  ) {}

  guard(binding: SourceBinding): () => void {
    const source = binding.source;
    return () => {
      this.assertService();
      if (!binding.live || binding.facts.status === "revoked" || !source) {
        throw new SourceRevokedError("MCP event source revoked");
      }
      try {
        source.assertCurrent();
      } catch (error) {
        if (isAuthorityRetired(error)) {
          throw new SourceRevokedError("MCP authorization retired", { cause: error });
        }
        throw error;
      }
    };
  }

  async refresh(binding: SourceBinding): Promise<void> {
    this.assertService();
    if (!binding.live) {
      throw new SourceRevokedError("MCP event source revoked");
    }
    let prepared: PreparedEventSource | undefined;
    try {
      if (!binding.source) {
        prepared = await this.prepareSource(binding.facts);
        if (
          prepared.accountId !== binding.facts.accountId ||
          prepared.principalId !== binding.facts.principalId
        ) {
          throw new SourceRevokedError("MCP event authorization changed");
        }
        this.assertService();
        if (!binding.live) {
          throw new SourceRevokedError("MCP event source revoked");
        }
        prepared.assertCurrent();
        binding.source ??= prepared;
      }
      await binding.source.revalidate();
      this.guard(binding)();
    } catch (error) {
      if (isAuthorityUnavailable(error)) {
        throw error;
      }
      throw new SourceRevokedError("MCP event source is no longer authorized", { cause: error });
    } finally {
      if (prepared !== binding.source) {
        prepared?.dispose();
      }
    }
  }
}
