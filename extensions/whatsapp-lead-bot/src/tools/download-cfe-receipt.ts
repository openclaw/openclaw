/**
 * Tool: download_cfe_receipt
 *
 * Downloads CFE electricity bill PDFs from Mi Espacio portal (app.cfe.mx).
 * Wraps the Python CLI script with round-robin account rotation.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT_PATH = path.join(os.homedir(), ".agents/skills/cfe-recibo/scripts/cfe_download.py");

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), ".openclaw/workspace-solayre/data/recibos");

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    serviceNumber: {
      type: "string" as const,
      description: "12-digit CFE service number (número de servicio)",
    },
    serviceName: {
      type: "string" as const,
      description:
        "Full name of the account holder exactly as it appears on the CFE bill (uppercase, with all last names)",
    },
    totalToPay: {
      type: "string" as const,
      description: "Total amount to pay as integer string, no decimals, no $ sign (e.g. '1645')",
    },
    outputDir: {
      type: "string" as const,
      description: `Directory to save the PDF. Defaults to ${DEFAULT_OUTPUT_DIR}`,
    },
  },
  required: ["serviceNumber", "serviceName", "totalToPay"],
};

export const downloadCFEReceiptTool = {
  name: "download_cfe_receipt",
  description:
    "Download the most recent CFE electricity bill PDF from the Mi Espacio portal (app.cfe.mx). " +
    "Requires the 12-digit service number, the account holder's full name (exactly as on the bill), " +
    "and the total amount to pay (integer, no decimals). Returns the local file path of the downloaded PDF.",
  inputSchema: inputJsonSchema,
  execute: async (
    input: {
      serviceNumber: string;
      serviceName: string;
      totalToPay: string;
      outputDir?: string;
    },
    _context: Record<string, never>,
  ): Promise<{
    success: boolean;
    path?: string;
    account?: string;
    error?: string;
  }> => {
    const { serviceNumber, serviceName, totalToPay } = input;
    const outputDir = input.outputDir || DEFAULT_OUTPUT_DIR;

    // Basic validation
    if (!/^\d{12}$/.test(serviceNumber.replace(/\s/g, ""))) {
      return {
        success: false,
        error:
          "El número de servicio debe tener exactamente 12 dígitos. Verifique el dato en el recibo.",
      };
    }

    if (!serviceName.trim()) {
      return {
        success: false,
        error: "El nombre del titular es requerido, exactamente como aparece en el recibo de CFE.",
      };
    }

    if (!/^\d+$/.test(totalToPay.trim())) {
      return {
        success: false,
        error:
          "El total a pagar debe ser un número entero sin centavos ni signo de pesos (ej. '1645').",
      };
    }

    return new Promise((resolve) => {
      const cleanServiceNumber = serviceNumber.replace(/\s/g, "");
      const args = [
        SCRIPT_PATH,
        cleanServiceNumber,
        serviceName.trim(),
        totalToPay.trim(),
        outputDir,
      ];

      execFile(
        "python3",
        args,
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          // Log stderr for debugging (timing info, account selection)
          if (stderr) {
            console.log(`[download-cfe-receipt] ${stderr.trim()}`);
          }

          // The script outputs JSON on stdout
          try {
            const result = JSON.parse(stdout.trim());
            if (result.ok) {
              resolve({
                success: true,
                path: result.path,
                account: result.account,
              });
            } else {
              resolve({
                success: false,
                error: result.message || "Download failed",
              });
            }
          } catch {
            // If JSON parsing fails, use the error message
            const msg = error?.message || stdout || "Unknown error";
            resolve({
              success: false,
              error: msg,
            });
          }
        },
      );
    });
  },
};
