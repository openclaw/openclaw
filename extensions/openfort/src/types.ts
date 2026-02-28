import type { Address, Hex } from "viem";

export interface OpenfortConfig {
  secretKey: string;
  walletSecret: string;
  network?: "base" | "base-sepolia";
  usdcContractId?: string; // Optional: Openfort USDC contract ID (auto-created if not provided)
  enableFeeSponsorship?: boolean; // Default: true (set to false to disable)
}

export interface AccountInfo {
  id: string;
  address: Address;
  custody?: string;
  delegatedAccount?: {
    id: string;
    implementationType: string;
    chainId: number;
  };
}

export interface TransactionResult {
  hash: Hex;
  from: Address;
  to: Address;
  amount: string;
  network: string;
}

export interface BalanceResult {
  address: Address;
  network: string;
  eth: string;
  usdc: string;
}
