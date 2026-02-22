import { NextResponse } from "next/server";
import { setCsrfCookie } from "@/lib/csrf";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";

export const GET = withApiGuard(async () => {
  const response = NextResponse.json({ ok: true });
  return setCsrfCookie(response);
}, ApiGuardPresets.read);
