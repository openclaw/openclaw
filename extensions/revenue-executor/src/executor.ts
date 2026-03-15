import { parseRevenueCommand } from "./parse.js";
import type {
  GhlClient,
  ParsedRevenueCommand,
  RevenueCommandInput,
  RevenueExecutionResult,
  StripeClient,
} from "./types.js";

type ExecuteDeps = {
  ghl: GhlClient;
  stripe: StripeClient;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  logger?: { warn: (...args: unknown[]) => void };
};

function newRunId(): string {
  return crypto.randomUUID();
}

function resolveLocationId(env: NodeJS.ProcessEnv): string {
  const value = env.OPENCLAW_REVENUE_GHL_LOCATION_ID?.trim();
  if (!value) {
    throw new Error("OPENCLAW_REVENUE_GHL_LOCATION_ID is required");
  }
  return value;
}

function resolveCurrency(env: NodeJS.ProcessEnv): string {
  return env.OPENCLAW_REVENUE_DEFAULT_CURRENCY?.trim() || "usd";
}

export async function executeRevenueCommand(
  input: RevenueCommandInput,
  deps: ExecuteDeps,
): Promise<RevenueExecutionResult> {
  const env = deps.env ?? process.env;
  const runId = deps.runId ?? newRunId();
  const parsed: ParsedRevenueCommand = parseRevenueCommand(input);

  const locationId = resolveLocationId(env);
  const currency = resolveCurrency(env);

  const contactLookup = await deps.ghl.checkContact({
    name: parsed.contactName,
    email: parsed.email,
    phone: parsed.phone,
  });

  const contact =
    contactLookup ??
      (deps.logger?.warn(
        `[debug] createContact payload: ${JSON.stringify({
          name: parsed.contactName,
          email: parsed.email,
          phone: parsed.phone,
          locationId,
        })}`,
      ),
    await deps.ghl.createContact({
      name: parsed.contactName,
      email: parsed.email,
      phone: parsed.phone,
      locationId,
    }));

    let opportunityId: string | undefined;
    let opportunityError: string | undefined;
    try {
        deps.logger?.warn(
          `[debug] createOpportunity payload: ${JSON.stringify({
            contactId: contact.id,
            name: parsed.opportunityName,
            amount: parsed.price,
            locationId,
          })}`,
        );
      const opp = await deps.ghl.createOpportunity({
        contactId: contact.id,
        name: parsed.opportunityName,
        amount: parsed.price,
        locationId,
      });
      opportunityId = opp.id;
    } catch (error) {
      opportunityError = error instanceof Error ? error.message : String(error);
    }

  let paymentUrl: string | undefined;
  let paymentError: string | undefined;
  if (parsed.price > 0) {
    try {
      const payment = await deps.stripe.createPaymentLink({
        amount: parsed.price,
        currency,
        productName: parsed.productType,
        metadata: {
          contactId: contact.id,
          productType: parsed.productType,
          opportunityName: parsed.opportunityName,
        },
      });
      paymentUrl = payment.url;
    } catch (error) {
      paymentError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ok: Boolean(opportunityId) && (parsed.price <= 0 || Boolean(paymentUrl)),
    runId,
    price: parsed.price,
    productType: parsed.productType,
    opportunityName: parsed.opportunityName,
    contactName: parsed.contactName,
    paymentUrl,
    result: {
      price: parsed.price,
      productType: parsed.productType,
      opportunityName: parsed.opportunityName,
      contactName: parsed.contactName,
      contact: {
        exists: Boolean(contactLookup),
        contactId: contact.id,
      },
      opportunity: {
        success: Boolean(opportunityId),
        opportunityId,
        error: opportunityError,
      },
      payment: {
        success: parsed.price <= 0 ? true : Boolean(paymentUrl),
        url: paymentUrl,
        error: paymentError,
      },
    },
    error: opportunityError || paymentError,
  };
}
