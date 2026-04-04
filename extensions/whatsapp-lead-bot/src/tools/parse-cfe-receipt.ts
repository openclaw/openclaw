/**
 * Tool: parse_cfe_receipt
 *
 * Parses CFE electricity bill using external API and saves to database
 * Includes quick validation for PDFs before calling API
 */

import { z } from "zod";
import type { ExtractionStore, LeadRepository } from "../database.js";
import { parseCFEBill } from "../media/cfe-api-client.js";
import { quickValidateCFE } from "../media/pdf-validator.js";

const ParseCFEReceiptInputSchema = z.object({
  leadId: z.number().describe("Lead ID from database"),
  filePath: z
    .union([z.string(), z.array(z.string()).max(3)])
    .describe(
      "Path(s) to CFE receipt file(s). Can be a single PDF or 1-3 images (JPG/PNG/WebP). If multiple pages, send as array.",
    ),
});

const inputJsonSchema = {
  type: "object" as const,
  properties: {
    leadId: { type: "number" as const, description: "Lead ID from database" },
    filePath: { type: "string" as const, description: "Path to CFE receipt PDF file" },
  },
  required: ["leadId", "filePath"],
};

export const parseCFEReceiptTool = {
  name: "parse_cfe_receipt",
  description:
    "Parse a CFE (Mexican electricity company) receipt PDF and extract structured data including tariff, consumption, historical data, and annual average. The parsed data is automatically saved to the lead's database record.",
  inputSchema: inputJsonSchema,
  execute: async (
    input: { leadId: number; filePath: string | string[] },
    context: {
      apiKey: string;
      apiUrl: string;
      db: ExtractionStore & Pick<LeadRepository, "updateReceiptData">;
      maxAttempts: number;
    },
  ) => {
    const { leadId, filePath } = input;
    const { apiKey, apiUrl, db, maxAttempts } = context;

    if (!apiKey) {
      return {
        success: false,
        error: "CFE API key not configured. Contact admin to enable receipt parsing.",
      };
    }

    // Check attempt limit (prevent spam)
    if (db && maxAttempts) {
      try {
        const attempts = await db.getExtractionAttempts(leadId);
        const successfulAttempts = attempts.filter((a) => a.status === "success");

        // If already successful, allow re-processing (in case they send a different receipt)
        // But limit total attempts to maxAttempts
        if (attempts.length >= maxAttempts && successfulAttempts.length === 0) {
          return {
            success: false,
            error: `Ha alcanzado el límite de ${maxAttempts} intentos para procesar recibos. Por favor contacte a un agente para continuar.`,
          };
        }
      } catch (error) {
        console.error("[parse-cfe-receipt] Error checking attempts:", error);
        // Continue anyway - don't block on DB errors
      }
    }

    // Create extraction record
    let extractionId: number | null = null;
    if (db) {
      try {
        const pathStr = Array.isArray(filePath) ? filePath[0] : filePath;
        extractionId = await db.createExtractionRecord(leadId, null, pathStr);
      } catch (error) {
        console.error("[parse-cfe-receipt] Error creating extraction record:", error);
      }
    }

    try {
      // Quick validation for PDFs (check for CFE RFC before expensive API call)
      const filePaths = Array.isArray(filePath) ? filePath : [filePath];

      for (const path of filePaths) {
        // Detect mime type from extension
        const ext = path.toLowerCase().split(".").pop() || "";
        const mimeType =
          ext === "pdf"
            ? "application/pdf"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "png"
                ? "image/png"
                : ext === "webp"
                  ? "image/webp"
                  : "application/octet-stream";

        const validation = quickValidateCFE(path, mimeType);

        if (!validation.isValid) {
          return {
            success: false,
            error:
              validation.reason === "not_cfe_receipt"
                ? "Este archivo no parece ser un recibo de CFE. Por favor envíe su recibo oficial de la Comisión Federal de Electricidad."
                : `No se pudo leer el archivo: ${validation.reason}`,
          };
        }
      }

      // Call CFE parsing API
      const billData = await parseCFEBill(filePath, apiKey, apiUrl);

      // Save receipt data directly via DB
      try {
        await db.updateReceiptData(leadId, {
          receipt_data: JSON.stringify(billData),
          tariff: billData.tarifa,
          annual_kwh: billData.calculado?.promedio_anual_kwh,
        });
      } catch (saveErr) {
        console.error("[parse-cfe-receipt] Error saving receipt data:", saveErr);

        if (extractionId) {
          try {
            await db.updateExtractionStatus(extractionId, "failed", "Failed to save to database");
          } catch (e) {
            console.error("[parse-cfe-receipt] Error updating extraction status:", e);
          }
        }

        return {
          success: false,
          error: "Failed to save receipt data to database",
        };
      }

      // Mark extraction as success
      if (db && extractionId) {
        try {
          await db.updateExtractionStatus(extractionId, "success");
        } catch (e) {
          console.error("[parse-cfe-receipt] Error updating extraction status:", e);
        }
      }

      // Return structured response
      return {
        billId: billData.billId,
        success: true,
        data: {
          tariff: billData.tarifa,
          annual_kwh: billData.calculado?.promedio_anual_kwh,
          monthly_consumption: billData.consumo_periodo_kwh,
          amount: billData.monto_pagar_mxn,
          is_partial: billData.recibo_parcial || false,
          missing_page: billData.pagina_faltante,
          confidence: billData.confianza,
          error: billData.error,
        },
        message: billData.mensaje_para_lead,
      };
    } catch (error) {
      // Mark extraction as failed
      if (db && extractionId) {
        try {
          const errorMsg = error instanceof Error ? error.message : String(error);
          await db.updateExtractionStatus(extractionId, "failed", errorMsg);
        } catch (e) {
          console.error("[parse-cfe-receipt] Error updating extraction status:", e);
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
