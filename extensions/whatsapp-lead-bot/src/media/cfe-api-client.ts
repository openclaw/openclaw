/**
 * CFE Bill Parser API Client
 *
 * Calls external API to parse CFE receipts and return structured data
 */

import * as fs from "node:fs";
import * as path from "node:path";

// API response structure (new format)
interface CFEAPIResponse {
  success: boolean;
  cached?: boolean;
  data?: {
    billId: string;
    tariffType: string;
    customerName?: string;
    serviceNumber?: string;
    serviceAddress?: string;
    city?: string;
    maxDemandKw?: number | null;
    billingFrequency: string;
    historicalConsumption: Array<{
      period: string;
      kWh: number;
      amount: number;
    }>;
    annualConsumption: number;
  };
  error?: string;
}

// Internal format (for save-receipt-data.mjs)
export interface CFEBillData {
  billId?: string;
  tarifa?: string;
  consumo_periodo_kwh?: number;
  monto_pagar_mxn?: number;
  periodo_inicio?: string;
  periodo_fin?: string;
  historial_mensual?: Array<{ periodo: string; kwh: number }>;
  calculado?: {
    promedio_anual_kwh?: number;
    consumo_pico_kwh?: number;
    consumo_valle_kwh?: number;
    es_estacional?: boolean;
  };
  recibo_parcial?: boolean;
  pagina_faltante?: string;
  mensaje_para_lead?: string;
  confianza?: string | null;
  error?: string;
  motivo?: string;
}

export async function parseCFEBill(
  filePaths: string | string[],
  apiKey: string,
  apiUrl: string,
): Promise<CFEBillData> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  if (paths.length === 0) {
    throw new Error("No files provided");
  }

  if (paths.length > 3) {
    throw new Error("Maximum 3 files allowed");
  }

  // Verify all files exist and get types
  const files: Array<{ path: string; type: "pdf" | "image" }> = [];

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    if (stats.size > 10 * 1024 * 1024) {
      throw new Error(`File too large: ${stats.size} bytes (max 10MB)`);
    }

    // Detect file type
    const buffer = fs.readFileSync(filePath);
    let fileType: "pdf" | "image";
    let contentType: string;

    if (buffer.toString("utf-8", 0, 4).startsWith("%PDF")) {
      fileType = "pdf";
      contentType = "application/pdf";
    } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      fileType = "image";
      contentType = "image/jpeg";
    } else if (buffer.toString("utf-8", 0, 4).startsWith("\x89PNG")) {
      fileType = "image";
      contentType = "image/png";
    } else if (buffer.toString("utf-8", 8, 12) === "WEBP") {
      fileType = "image";
      contentType = "image/webp";
    } else {
      throw new Error(`Unsupported file type: ${filePath}`);
    }

    files.push({ path: filePath, type: fileType });
  }

  // Cannot mix PDFs and images
  const types = new Set(files.map((f) => f.type));
  if (types.size > 1) {
    throw new Error("Cannot mix PDFs and images in the same request");
  }

  // Create native FormData (compatible with native fetch)
  const form = new FormData();

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const ext = file.type === "pdf" ? "pdf" : "jpg";
    const contentType = file.type === "pdf" ? "application/pdf" : "image/jpeg";
    const buffer = fs.readFileSync(file.path);
    const blob = new Blob([buffer], { type: contentType });
    form.append("files", blob, `page${index + 1}.${ext}`);
  }

  // Call API
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  const apiResponse = (await response.json()) as CFEAPIResponse;

  // Handle API errors
  if (!apiResponse.success || apiResponse.error) {
    return {
      error: "api_error",
      motivo: apiResponse.error || "Unknown error",
      mensaje_para_lead:
        apiResponse.error || "No se pudo procesar el recibo. Por favor intente de nuevo.",
    };
  }

  // Map API response to internal format
  return mapAPIResponseToInternalFormat(apiResponse);
}

function mapAPIResponseToInternalFormat(apiResponse: CFEAPIResponse): CFEBillData {
  if (!apiResponse.data) {
    return {
      error: "no_data",
      mensaje_para_lead: "No se pudieron extraer datos del recibo.",
    };
  }

  const { data } = apiResponse;

  // Map historical consumption
  const historial_mensual = data.historicalConsumption.map((h) => ({
    periodo: h.period,
    kwh: h.kWh,
  }));

  // Calculate peak/valley
  const consumos = data.historicalConsumption.map((h) => h.kWh);
  const consumo_pico_kwh = Math.max(...consumos);
  const consumo_valle_kwh = Math.min(...consumos);
  const es_estacional = consumo_pico_kwh / consumo_valle_kwh > 1.5;

  // Get bill ID from API response
  const billId = data.billId;

  // Get current period (first in history = most recent)
  const currentPeriod = data.historicalConsumption[0];

  // Check if incomplete (less than 6 months of data)
  const is_partial = data.historicalConsumption.length < 6;

  return {
    billId,
    tarifa: data.tariffType,
    consumo_periodo_kwh: currentPeriod?.kWh,
    monto_pagar_mxn: currentPeriod?.amount,
    periodo_inicio: currentPeriod?.period.split(" al ")[0]?.replace("del ", ""),
    periodo_fin: currentPeriod?.period.split(" al ")[1],
    historial_mensual,
    calculado: {
      promedio_anual_kwh: data.annualConsumption,
      consumo_pico_kwh,
      consumo_valle_kwh,
      es_estacional,
    },
    recibo_parcial: is_partial,
    pagina_faltante: is_partial ? "Necesito más datos históricos" : undefined,
    mensaje_para_lead: is_partial
      ? "Gracias por el recibo. Veo que necesito más páginas para tener el historial completo de consumo. ¿Puede enviar la otra página?"
      : "Perfecto, recibí su recibo. Procedamos con la cotización.",
    confianza: "alta",
  };
}

/**
 * Find recently created PDF files in media directory
 * Returns files created in the last `maxAgeSeconds`
 */
export function findRecentPDFs(mediaDir: string, maxAgeSeconds: number = 10): string[] {
  const now = Date.now();
  const cutoff = now - maxAgeSeconds * 1000;

  try {
    const files = fs.readdirSync(mediaDir);
    const recentPDFs: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".pdf")) continue;

      const fullPath = `${mediaDir}/${file}`;
      const stats = fs.statSync(fullPath);
      const mtime = stats.mtimeMs;

      if (mtime >= cutoff) {
        recentPDFs.push(fullPath);
      }
    }

    // Sort by modification time (newest first)
    recentPDFs.sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    });

    return recentPDFs;
  } catch (error) {
    console.error("[cfe-api] Error reading media directory:", error);
    return [];
  }
}
