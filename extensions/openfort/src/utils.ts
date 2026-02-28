import { isAddress, type Address } from "viem";

/**
 * Validates and converts a string to an Address type
 * Throws if invalid address
 */
export function toAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid Ethereum address: ${value}`);
  }
  return value;
}

/**
 * Safely converts Openfort address string to viem Address
 */
export function openfortAddressToViem(address: string): Address {
  return toAddress(address);
}
