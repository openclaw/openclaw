/**
 * Type definitions for Openfort SDK responses
 * These extend the base SDK types with proper typing
 */

export interface OpenfortListResponse<T> {
  data?: T[];
  accounts?: T[];
  total?: number;
  hasMore?: boolean;
}

export interface OpenfortBackendAccount {
  id: string;
  address: string;
  custody?: string;
  accountType?: string;
  chainType?: string;
  chainId?: number;
  delegatedAccount?: {
    id: string;
    implementationType: string;
    chainId: number;
  };
  // Signing methods from Openfort SDK
  sign(params: { hash: string }): Promise<string>;
  signMessage(params: { message: string }): Promise<string>;
  signTransaction(tx: unknown): Promise<string>;
  signTypedData(typedData: unknown): Promise<string>;
}

export interface OpenfortContract {
  id: string;
  name?: string;
  address: string;
  chainId: number;
  abi?: unknown;
}

export interface OpenfortPolicy {
  id: string;
  scope: string;
  description?: string;
  rules: Array<{
    action: "accept" | "reject";
    operation: string;
    criteria: Array<{
      type: string;
      operator: string;
      [key: string]: unknown;
    }>;
  }>;
}

export interface OpenfortFeeSponsorship {
  id: string;
  enabled: boolean;
  name?: string;
  strategy: {
    sponsorSchema: "pay_for_user" | "charge_custom_tokens" | "fixed_rate";
    tokenContract?: string;
    tokenContractAmount?: string | null;
    dynamicExchangeRate?: boolean;
  };
  policyId: string;
}

export interface OpenfortTransactionIntent {
  id: string;
  status?: string;
  nextAction?: {
    type: string;
    payload?: {
      signableHash?: string;
      userOperationHash?: string;
      [key: string]: unknown;
    };
  };
  response?: {
    transactionHash?: string;
    [key: string]: unknown;
  };
}

// Helper type guards
export function isListResponse<T>(obj: unknown): obj is OpenfortListResponse<T> {
  return typeof obj === "object" && obj !== null && ("data" in obj || "accounts" in obj);
}

export function extractListData<T>(response: unknown): T[] {
  if (!isListResponse<T>(response)) {
    return [];
  }
  return response.data || response.accounts || [];
}
