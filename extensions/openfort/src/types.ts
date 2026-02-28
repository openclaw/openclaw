import type { Address, Hex } from "viem";

export interface OpenfortConfig {
  secretKey: string;
  walletSecret: string;
  network?: "base" | "base-sepolia" | "solana";
}

export interface OpenfortAccountRaw {
  id: string;
  address: string; // Openfort returns string, not Address
  custody?: string;
  delegatedAccount?: {
    id: string;
    implementationType: string;
    chainId: number;
  };
  // Signing methods
  sign: (params: { hash: string }) => Promise<string>;
  signMessage: (params: { message: string }) => Promise<string>;
  signTransaction: (tx: any) => Promise<string>;
  signTypedData: (typedData: any) => Promise<string>;
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

export interface EIP7702Authorization {
  chainId: number;
  address: Hex;
  nonce: number;
  r?: Hex;
  s?: Hex;
  yParity?: number;
}
