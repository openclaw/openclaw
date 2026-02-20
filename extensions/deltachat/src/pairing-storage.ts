import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "./utils.js";

/**
 * Manages storage of the Delta.Chat pairing QR code.
 * This allows the gateway to generate the QR code on startup
 * and the pairing command to retrieve it without starting its own RPC server.
 */
export class PairingQrCodeStorage {
  private static readonly STORAGE_FILE = "pairing-qr-code.txt";

  /**
   * Get the path to the QR code storage file.
   */
  private static getStoragePath(dataDir: string): string {
    const expandedDir = ensureDataDir(dataDir);
    return join(expandedDir, this.STORAGE_FILE);
  }

  /**
   * Store a QR code for later retrieval.
   */
  static storeQrCode(dataDir: string, qrCodeData: string): void {
    const storagePath = this.getStoragePath(dataDir);
    writeFileSync(storagePath, qrCodeData, "utf8");
  }

  /**
   * Retrieve a stored QR code.
   * Returns null if no QR code is stored.
   */
  static retrieveQrCode(dataDir: string): string | null {
    const storagePath = this.getStoragePath(dataDir);
    console.log(`[deltachat] Checking for QR code at: ${storagePath}`);
    if (!existsSync(storagePath)) {
      console.log(`[deltachat] No QR code file found`);
      return null;
    }
    try {
      const qrCodeData = readFileSync(storagePath, "utf8");
      console.log(`[deltachat] Retrieved QR code URL: ${qrCodeData}`);
      return qrCodeData;
    } catch (err) {
      console.log(`[deltachat] Error reading QR code file: ${err}`);
      return null;
    }
  }

  /**
   * Check if a QR code is stored.
   */
  static hasQrCode(dataDir: string): boolean {
    const storagePath = this.getStoragePath(dataDir);
    return existsSync(storagePath);
  }

  /**
   * Clear the stored QR code.
   */
  static clearQrCode(dataDir: string): void {
    const storagePath = this.getStoragePath(dataDir);
    if (existsSync(storagePath)) {
      // We don't delete the file to avoid race conditions
      // Instead, we overwrite it with an empty string
      writeFileSync(storagePath, "", "utf8");
    }
  }
}
