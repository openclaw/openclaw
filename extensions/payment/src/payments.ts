import { randomUUID } from "node:crypto";
import type { PaymentConfig } from "./config.js";
import { canRail } from "./policy.js";
import type {
  CardSecrets,
  ExecuteMachinePaymentParams,
  IssueVirtualCardParams,
  ListFundingSourcesParams,
  PaymentProviderAdapter,
  PaymentProviderSetupStatus,
} from "./providers/base.js";
import { CardUnavailableError, UnsupportedRailError } from "./providers/base.js";
import { handleMap } from "./store.js";
import type {
  CredentialHandle,
  FundingSource,
  MachinePaymentResult,
  PaymentProviderId,
} from "./types.js";

export type PaymentManager = {
  getSetupStatus(providerId?: PaymentProviderId): Promise<PaymentProviderSetupStatus>;
  listFundingSources(
    params: ListFundingSourcesParams & { providerId?: PaymentProviderId },
  ): Promise<FundingSource[]>;
  issueVirtualCard(
    params: IssueVirtualCardParams & { providerId: PaymentProviderId },
  ): Promise<CredentialHandle>;
  executeMachinePayment(
    params: ExecuteMachinePaymentParams & { providerId: PaymentProviderId },
  ): Promise<MachinePaymentResult>;
  getStatus(handleId: string): Promise<CredentialHandle>;
  /**
   * Adapter-internal accessor. Used ONLY by the before_tool_call fill hook in U6.
   * Do not call from tool/CLI/RPC paths.
   *
   * SECURITY: The return value MUST NOT be persisted, logged, or included in any
   * tool result. Drop the reference immediately after substitution.
   */
  retrieveCardSecretsForHook(
    providerId: PaymentProviderId,
    spendRequestId: string,
  ): Promise<CardSecrets>;
};

export function createPaymentManager(opts: {
  adapters: readonly PaymentProviderAdapter[];
  config: PaymentConfig;
}): PaymentManager {
  // Index adapters by id; fail fast on duplicates.
  const registry = new Map<PaymentProviderId, PaymentProviderAdapter>();
  for (const adapter of opts.adapters) {
    if (registry.has(adapter.id)) {
      throw new Error(
        `PaymentManager: duplicate adapter id "${adapter.id}". Each provider id must be unique.`,
      );
    }
    registry.set(adapter.id, adapter);
  }

  function requireAdapter(providerId: PaymentProviderId): PaymentProviderAdapter {
    const adapter = registry.get(providerId);
    if (!adapter) {
      throw new Error(`PaymentManager: no adapter registered for provider "${providerId}"`);
    }
    return adapter;
  }

  return {
    async getSetupStatus(providerId?: PaymentProviderId): Promise<PaymentProviderSetupStatus> {
      if (providerId !== undefined) {
        return requireAdapter(providerId).getSetupStatus();
      }
      // Default: use the configured provider
      return requireAdapter(opts.config.provider).getSetupStatus();
    },

    async listFundingSources(
      params: ListFundingSourcesParams & { providerId?: PaymentProviderId },
    ): Promise<FundingSource[]> {
      const { providerId, ...adapterParams } = params;
      const id = providerId ?? opts.config.provider;
      return requireAdapter(id).listFundingSources(adapterParams);
    },

    async issueVirtualCard(
      params: IssueVirtualCardParams & { providerId: PaymentProviderId },
    ): Promise<CredentialHandle> {
      const { providerId, ...adapterParams } = params;
      const adapter = requireAdapter(providerId);

      // Rail check before dispatch — throws UnsupportedRailError without calling the adapter
      if (!canRail(adapter.rails, "virtual_card")) {
        throw new UnsupportedRailError(providerId, "virtual_card", "issueVirtualCard");
      }

      // Ensure idempotency key is always present
      const paramsWithKey: IssueVirtualCardParams = {
        ...adapterParams,
        idempotencyKey: adapterParams.idempotencyKey ?? randomUUID(),
      };

      return adapter.issueVirtualCard(paramsWithKey);
    },

    async executeMachinePayment(
      params: ExecuteMachinePaymentParams & { providerId: PaymentProviderId },
    ): Promise<MachinePaymentResult> {
      const { providerId, ...adapterParams } = params;
      const adapter = requireAdapter(providerId);

      // Rail check before dispatch — throws UnsupportedRailError without calling the adapter
      if (!canRail(adapter.rails, "machine_payment")) {
        throw new UnsupportedRailError(providerId, "machine_payment", "executeMachinePayment");
      }

      // Ensure idempotency key is always present
      const paramsWithKey: ExecuteMachinePaymentParams = {
        ...adapterParams,
        idempotencyKey: adapterParams.idempotencyKey ?? randomUUID(),
      };

      return adapter.executeMachinePayment(paramsWithKey);
    },

    async getStatus(handleId: string): Promise<CredentialHandle> {
      // Look up which provider owns this handle via handleMap
      const meta = handleMap.get(handleId);
      if (!meta) {
        throw new CardUnavailableError(handleId, "unknown handle", undefined);
      }

      // Determine provider from handleMap metadata — the spendRequestId prefix encodes the provider.
      // For V1 we iterate adapters to find one that can return status for this handle.
      // Simple approach: try the configured default provider first, then others.
      const defaultAdapter = registry.get(opts.config.provider);
      if (defaultAdapter) {
        try {
          return await defaultAdapter.getStatus(handleId);
        } catch {
          // Fall through to try other adapters
        }
      }

      for (const adapter of registry.values()) {
        if (adapter.id === opts.config.provider) {
          continue; // already tried
        }
        try {
          return await adapter.getStatus(handleId);
        } catch {
          // Try next
        }
      }

      throw new CardUnavailableError(handleId, "unknown handle", undefined);
    },

    /**
     * Adapter-internal accessor. Used ONLY by the before_tool_call fill hook in U6.
     * Do not call from tool/CLI/RPC paths.
     *
     * SECURITY: The return value MUST NOT be persisted, logged, or included in any
     * tool result. Drop the reference immediately after substitution.
     */
    async retrieveCardSecretsForHook(
      providerId: PaymentProviderId,
      spendRequestId: string,
    ): Promise<CardSecrets> {
      return requireAdapter(providerId).retrieveCardSecrets(spendRequestId);
    },
  };
}
