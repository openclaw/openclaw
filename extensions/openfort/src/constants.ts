import type { Address, Hex } from "viem";

export const CHAIN_IDS = {
  BASE: 8453,
  BASE_SEPOLIA: 84532,
} as const;

export const USDC_ADDRESSES: Record<string, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

// Calibur EIP-7702 implementation address
export const CALIBUR_IMPLEMENTATION: Hex = "0x000000009b1d0af20d8c6d0a44e162d11f9b8f00";
