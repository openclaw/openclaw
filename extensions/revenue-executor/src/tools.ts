import type { AnyAgentTool, OpenClawPluginApi } from "../../../src/plugins/types.js";
import { createGhlClient } from "./clients/ghl.js";
import { createStripeClient } from "./clients/stripe.js";
import { executeRevenueCommand } from "./executor.js";
import { parseRevenueCommand } from "./parse.js";
import type { RevenueCommandInput } from "./types.js";

function asTextJson(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: { json: value },
  };
}

function parseInput(params: Record<string, unknown>): RevenueCommandInput {
  const command = typeof params.command === "string" ? params.command : "";
  if (!command.trim()) {
    throw new Error("command is required");
  }

  return {
    command,
    contactName: typeof params.contactName === "string" ? params.contactName : undefined,
    productType: typeof params.productType === "string" ? params.productType : undefined,
    price: typeof params.price === "number" ? params.price : undefined,
    email: typeof params.email === "string" ? params.email : undefined,
    phone: typeof params.phone === "string" ? params.phone : undefined,
  };
}

const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string", description: "Natural language revenue command text." },
    contactName: { type: "string" },
    productType: { type: "string" },
    price: { type: "number" },
    email: { type: "string" },
    phone: { type: "string" },
  },
} as const;

function buildRuntimeEnv(api: OpenClawPluginApi): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

  const set = (name: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      env[name] = value.trim();
    }
  };

  set("OPENCLAW_REVENUE_GHL_API_KEY", cfg.ghlApiKey);
  set("OPENCLAW_REVENUE_GHL_BASE_URL", cfg.ghlBaseUrl);
  set("OPENCLAW_REVENUE_GHL_LOCATION_ID", cfg.ghlLocationId);
  set("OPENCLAW_REVENUE_STRIPE_API_KEY", cfg.stripeSecretKey);
  set("OPENCLAW_REVENUE_STRIPE_SUCCESS_URL", cfg.stripeSuccessUrl);
  set("OPENCLAW_REVENUE_DEFAULT_CURRENCY", cfg.defaultCurrency);

  return env;
}

export function createRevenueTools(api: OpenClawPluginApi): AnyAgentTool[] {
  const runtimeEnv = buildRuntimeEnv(api);
  const ghl = createGhlClient(runtimeEnv);
  const stripe = createStripeClient(runtimeEnv);

  return [
    {
      name: "parse_revenue_command",
      label: "Parse Revenue Command",
      description: "Parse a revenue command into structured contact/product/price fields.",
      parameters: commandSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const parsed = parseRevenueCommand(parseInput(params));
        return asTextJson(parsed);
      },
    },
    {
      name: "ghl_check_contact",
      label: "GHL Check Contact",
      description: "Check whether a contact already exists in GHL.",
      parameters: commandSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const parsed = parseRevenueCommand(parseInput(params));
        const found = await ghl.checkContact({
          name: parsed.contactName,
          email: parsed.email,
          phone: parsed.phone,
        });
        return asTextJson({ exists: Boolean(found), contactId: found?.id });
      },
    },
    {
      name: "ghl_create_contact",
      label: "GHL Create Contact",
      description: "Create a new contact in GHL.",
      parameters: commandSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const parsed = parseRevenueCommand(parseInput(params));
        const created = await ghl.createContact({
          name: parsed.contactName,
          email: parsed.email,
          phone: parsed.phone,
        });
        return asTextJson({ success: true, contactId: created.id });
      },
    },
    {
      name: "ghl_create_opportunity",
      label: "GHL Create Opportunity",
      description: "Create an opportunity in GHL tied to a contact and amount.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command", "contactId"],
        properties: {
          ...commandSchema.properties,
          contactId: { type: "string" },
        },
      } as const,
      async execute(_id: string, params: Record<string, unknown>) {
        const contactId = typeof params.contactId === "string" ? params.contactId.trim() : "";
        if (!contactId) {
          throw new Error("contactId is required");
        }
        const parsed = parseRevenueCommand(parseInput(params));
        const locationId = runtimeEnv.OPENCLAW_REVENUE_GHL_LOCATION_ID?.trim();
        if (!locationId) {
          throw new Error("OPENCLAW_REVENUE_GHL_LOCATION_ID is required");
        }
        const opportunity = await ghl.createOpportunity({
          contactId,
          name: parsed.opportunityName,
          amount: parsed.price,
          locationId,
        });
        return asTextJson({ success: true, opportunityId: opportunity.id });
      },
    },
    {
      name: "stripe_create_payment_link",
      label: "Stripe Create Payment Link",
      description: "Create a Stripe payment link for a parsed revenue command.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command", "contactId"],
        properties: {
          ...commandSchema.properties,
          contactId: { type: "string" },
        },
      } as const,
      async execute(_id: string, params: Record<string, unknown>) {
        const contactId = typeof params.contactId === "string" ? params.contactId.trim() : "";
        if (!contactId) {
          throw new Error("contactId is required");
        }
        const parsed = parseRevenueCommand(parseInput(params));
        const currency = runtimeEnv.OPENCLAW_REVENUE_DEFAULT_CURRENCY?.trim() || "usd";
        const link = await stripe.createPaymentLink({
          amount: parsed.price,
          currency,
          productName: parsed.productType,
          metadata: {
            contactId,
            productType: parsed.productType,
            opportunityName: parsed.opportunityName,
          },
        });
        return asTextJson({ success: true, url: link.url });
      },
    },
    {
      name: "execute_revenue_command",
      label: "Execute Revenue Command",
      description:
        "End-to-end revenue flow: parse command, dedupe/create contact, create opportunity, and create Stripe payment link.",
      parameters: commandSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const result = await executeRevenueCommand(parseInput(params), {
          ghl,
          stripe,
        });

        const callbackUrl =
          typeof api.pluginConfig?.callbackUrl === "string"
            ? api.pluginConfig.callbackUrl.trim()
            : "";

        if (callbackUrl) {
          try {
            await fetch(callbackUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(result),
            });
          } catch (error) {
            api.logger.warn(
              `revenue-executor callback failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        return asTextJson(result);
      },
    },
  ];
}
