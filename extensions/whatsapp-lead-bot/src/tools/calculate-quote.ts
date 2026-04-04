/**
 * Tool: calculate_quote
 *
 * Calls Supabase edge function to calculate a solar panel quote from a processed CFE bill.
 *
 * IMPORTANTE: billId es OBLIGATORIO
 * - NO se puede cotizar sin recibo CFE parseado
 * - El billId se obtiene después de parsear el PDF con parse_cfe_receipt
 * - Si falta billId, el agente debe solicitar el recibo al cliente
 */

export interface CalculateQuoteInput {
  billId: string;
  panelWattage?: number;
}

export interface CalculateQuoteContext {
  apiKey: string;
  apiUrl: string;
}

export const calculateQuoteTool = {
  name: "calculate_quote",
  description:
    "Calculate a solar panel quote from a previously parsed CFE bill. Returns system size, pricing (cash and financed), annual savings, ROI, and optional PDF URL. Requires a billId from a successfully parsed receipt (via parse_cfe_receipt).",
  inputSchema: {
    type: "object" as const,
    properties: {
      billId: {
        type: "string" as const,
        description:
          "UUID of the CFE bill record (from parse_cfe_receipt result or cfe_bills table)",
      },
      panelWattage: {
        type: "number" as const,
        description: "Panel wattage to use for calculation. Defaults to 620W if not specified.",
      },
    },
    required: ["billId"],
  },

  async execute(
    input: CalculateQuoteInput,
    context: CalculateQuoteContext,
  ): Promise<Record<string, unknown>> {
    const { billId, panelWattage = 620 } = input;
    const { apiKey, apiUrl } = context;

    // Validación estricta: billId es obligatorio
    if (!billId || typeof billId !== "string") {
      return {
        success: false,
        error: "NO_BILL_ID",
        message: "No se puede cotizar sin recibo CFE parseado",
        action_required: "Solicitar al cliente que envíe foto de su recibo de CFE",
        reason:
          "El consumo varía dramáticamente entre bimestres. La foto del recibo solo muestra 1 bimestre, pero el PDF oficial tiene historial de 6 bimestres = consumo anual real. Sin datos reales del recibo, la cotización sería incorrecta.",
        workflow: [
          "1. Cliente envía foto del recibo CFE",
          "2. Delegar al coworker para procesar: sessions_send con [COTIZAR]",
          "3. Coworker descarga PDF, parsea, obtiene billId",
          "4. Coworker ejecuta calculate_quote(billId)",
          "5. Coworker devuelve datos para presentar al cliente",
        ],
      };
    }

    // Validar formato UUID básico
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(billId)) {
      return {
        success: false,
        error: "INVALID_BILL_ID",
        message: `billId inválido: "${billId}"`,
        expected: "UUID del recibo parseado (ejemplo: a1b2c3d4-e5f6-7890-abcd-ef1234567890)",
        hint: "El billId se obtiene después de parsear el recibo CFE con parse_cfe_receipt",
        action_required:
          "Si el cliente NO ha enviado recibo CFE, solicítalo antes de intentar cotizar",
      };
    }

    if (!apiKey) {
      return {
        success: false,
        error: "Supabase API key not configured. Contact admin.",
      };
    }

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ billId, panelWattage }),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `API error ${response.status}: ${body}`,
          hint:
            response.status === 404
              ? "El recibo no existe en la base de datos. Verifica que fue parseado correctamente."
              : undefined,
        };
      }

      const result = await response.json();

      if (!result.success) {
        return {
          success: false,
          error: result.error || "API returned error",
          hint: result.error?.includes("not found")
            ? "El billId no existe en la base de datos. Verifica que el recibo fue parseado correctamente."
            : undefined,
        };
      }

      return {
        success: true,
        pdfUrl: result.pdfUrl || result.pdf_url || result.url || null,
        bill: result.bill,
        quote: result.quote,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
