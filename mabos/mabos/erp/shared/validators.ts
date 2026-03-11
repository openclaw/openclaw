const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function validateUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function validateISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export function validateCurrency(value: string): boolean {
  return CURRENCY_RE.test(value);
}

export function validatePositiveAmount(value: number): boolean {
  return typeof value === "number" && !isNaN(value) && value > 0;
}

export function validateRequired(params: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    if (params[field] === undefined || params[field] === null || params[field] === "") {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}
