import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { listCredits, upsertCredit } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";

/**
 * GET /api/settings/credits
 *
 * List all tracked provider credit balances.
 */
export const GET = withApiGuard(async () => {
    try {
        const credits = listCredits();
        return NextResponse.json({ credits });
    } catch (error) {
        return handleApiError(error, "Failed to list credits");
    }
}, ApiGuardPresets.read);

/**
 * POST /api/settings/credits
 *
 * Set or update credit balance for a provider.
 * Body: { provider, balance?, currency?, limit_total?, usage_total? }
 */
export const POST = withApiGuard(async (request: NextRequest) => {
    try {
        const body = await request.json();
        const provider = body?.provider?.trim();
        if (!provider) {throw new UserError("provider is required", 400);}

        const credit = upsertCredit({
            id: uuidv4(),
            provider,
            balance: body.balance ?? null,
            currency: body.currency ?? "USD",
            limit_total: body.limit_total ?? null,
            usage_total: body.usage_total ?? null,
        });

        return NextResponse.json({ ok: true, credit });
    } catch (error) {
        return handleApiError(error, "Failed to update credits");
    }
}, ApiGuardPresets.write);
