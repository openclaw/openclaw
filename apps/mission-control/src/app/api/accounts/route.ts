import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { createAccount, listAccounts } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { parseOrThrow, workspaceSchema } from "@/lib/schemas";
import { sanitizeInput } from "@/lib/validation";
import { isValidWorkspaceId } from "@/lib/workspaces-server";
import { z } from "zod";

const accountsListQuerySchema = z.object({
  workspace_id: workspaceSchema,
  service: z.string().trim().min(1).max(80).optional(),
});

const createAccountSchema = z.object({
  service: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  region: z.string().trim().max(40).optional().nullable(),
  notes: z.string().max(20000).optional(),
  workspace_id: workspaceSchema,
});

export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseOrThrow(accountsListQuerySchema, {
      workspace_id: searchParams.get("workspace_id") ?? undefined,
      service: searchParams.get("service") ?? undefined,
    });

    if (!isValidWorkspaceId(query.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const accounts = listAccounts({
      workspace_id: query.workspace_id,
      service: query.service,
    });

    return NextResponse.json({ accounts });
  } catch (error) {
    return handleApiError(error, "Failed to list accounts");
  }
}, ApiGuardPresets.read);

export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const payload = parseOrThrow(createAccountSchema, await request.json());

    if (!isValidWorkspaceId(payload.workspace_id)) {
      throw new UserError("workspace_id is invalid", 400);
    }

    const account = createAccount({
      id: uuidv4(),
      service: sanitizeInput(payload.service),
      label: sanitizeInput(payload.label),
      region: payload.region ? sanitizeInput(payload.region) : null,
      notes: payload.notes ? sanitizeInput(payload.notes) : "",
      workspace_id: payload.workspace_id,
    });

    return NextResponse.json({ ok: true, account }, { status: 201 });
  } catch (error) {
    return handleApiError(error, "Failed to create account");
  }
}, ApiGuardPresets.write);
