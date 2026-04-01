/**
 * Multi-company data isolation middleware.
 *
 * When multiCompany is enabled, every request is scoped to a companyId.
 * The company is resolved from: explicit header > agent config > 'default'.
 */

export interface CompanyScopeContext {
  /** HTTP request headers (optional — only for route-based resolution). */
  headers?: Record<string, string | undefined>;
  /** Agent configuration metadata. */
  agentMeta?: Record<string, unknown>;
  /** Explicit override. */
  companyId?: string;
}

/**
 * Resolve the active company ID for the current context.
 *
 * Resolution order:
 * 1. Explicit `companyId` parameter
 * 2. `X-Mabos-Company` header
 * 3. Agent metadata `companyId` field
 * 4. Fallback: `'default'`
 */
export function resolveCompanyId(ctx: CompanyScopeContext): string {
  if (ctx.companyId) return ctx.companyId;
  if (ctx.headers?.["x-mabos-company"]) return ctx.headers["x-mabos-company"];
  if (ctx.agentMeta?.companyId && typeof ctx.agentMeta.companyId === "string") {
    return ctx.agentMeta.companyId;
  }
  return "default";
}

/**
 * Validate that a companyId is well-formed (alphanumeric + hyphens, max 64 chars).
 */
export function validateCompanyId(companyId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(companyId);
}

/**
 * Middleware-style company scope guard.
 * Throws if multiCompany is enabled and companyId is invalid/missing.
 */
export function enforceCompanyScope(
  ctx: CompanyScopeContext,
  multiCompanyEnabled: boolean,
): string {
  const companyId = resolveCompanyId(ctx);

  if (multiCompanyEnabled && companyId !== "default") {
    if (!validateCompanyId(companyId)) {
      throw new Error(
        `Invalid company ID "${companyId}": must be 1-64 alphanumeric/hyphen/underscore characters`,
      );
    }
  }

  return companyId;
}
