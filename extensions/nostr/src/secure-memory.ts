/**
 * Secure memory utilities for handling sensitive data
 * Provides functions to clear sensitive data from memory
 */

/**
 * Securely clear a Uint8Array by overwriting with zeros
 * This helps prevent sensitive data from being recovered from memory
 * @param buffer - The buffer to clear
 */
export function secureMemoryClear(buffer: Uint8Array): void {
  buffer.fill(0);
}

/**
 * Execute a function with a temporary decrypted key, clearing it after use
 * Ensures the plaintext key is never stored in a variable for longer than needed
 * @param encryptedKey - The encrypted private key in hex format
 * @param passphrase - The passphrase to decrypt the key
 * @param fn - Function to execute with the decrypted key
 * @returns The result of the function
 */
export async function withDecryptedKey<T>(
  encryptedKey: string | null,
  passphrase: string | undefined,
  fn: (sk: Uint8Array) => T | Promise<T>,
): Promise<T> {
  if (!encryptedKey || !passphrase) {
    throw new Error("Encrypted key and passphrase are required for just-in-time decryption");
  }

  // Convert hex string to Uint8Array
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sk[i] = parseInt(encryptedKey.slice(i * 2, i * 2 + 2), 16);
  }

  try {
    // Execute the function with the decrypted key
    return await fn(sk);
  } finally {
    // Always clear the key from memory after use
    secureMemoryClear(sk);
  }
}

/**
 * Synchronous version of withDecryptedKey for operations that can't be async
 * @param encryptedKey - The encrypted private key in hex format
 * @param passphrase - The passphrase to decrypt the key
 * @param fn - Function to execute with the decrypted key
 * @returns The result of the function
 */
export function withDecryptedKeySync<T>(
  encryptedKey: string | null,
  passphrase: string | undefined,
  fn: (sk: Uint8Array) => T,
): T {
  if (!encryptedKey || !passphrase) {
    throw new Error("Encrypted key and passphrase are required for just-in-time decryption");
  }

  // Convert hex string to Uint8Array
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sk[i] = parseInt(encryptedKey.slice(i * 2, i * 2 + 2), 16);
  }

  try {
    // Execute the function with the decrypted key
    return fn(sk);
  } finally {
    // Always clear the key from memory after use
    secureMemoryClear(sk);
  }
}
