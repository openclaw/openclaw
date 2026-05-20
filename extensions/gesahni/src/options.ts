export type OptionRight = "call" | "put";

export type ParsedOptionContract = {
  symbol: string;
  expiry: string;
  strike: number;
  right: OptionRight;
  occSymbol: string;
};

export type ParsedOptionTradeContext = {
  quantity: number;
  entryPrice?: number;
  posture: "sold" | "bought" | "unknown";
};

const MONTH_DAY_YEAR_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/;

export function normalizeSymbol(value: string): string {
  return value.trim().replace(/^\$/, "").toUpperCase();
}

function normalizeExpiry(value: string, now: Date = new Date()): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const match = MONTH_DAY_YEAR_RE.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  const rawYear = match[3];
  let year = rawYear
    ? Number.parseInt(rawYear.length === 2 ? `20${rawYear}` : rawYear, 10)
    : now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    !rawYear &&
    candidate.getTime() < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  ) {
    year += 1;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

export function toOccOptionSymbol(contract: {
  symbol: string;
  expiry: string;
  strike: number;
  right: OptionRight;
}): string {
  const [year, month, day] = contract.expiry.split("-");
  const date = `${year.slice(2)}${month}${day}`;
  const right = contract.right === "call" ? "C" : "P";
  const strike = Math.round(contract.strike * 1000)
    .toString()
    .padStart(8, "0");
  return `${normalizeSymbol(contract.symbol)}${date}${right}${strike}`;
}

export function parseOptionContract(
  input: string,
  now: Date = new Date(),
): ParsedOptionContract | null {
  const trimmed = input.trim();
  const compact =
    /\b([A-Za-z]{1,6})\s+(\d+(?:\.\d+)?)\s*([CP])\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i.exec(
      trimmed,
    );
  const verbose =
    compact ??
    /\b([A-Za-z]{1,6})\s+\$?(\d+(?:\.\d+)?)\s+(call|put)\s+(?:exp(?:iring)?\s+)?(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i.exec(
      trimmed,
    );
  if (!verbose) {
    return null;
  }
  const symbol = normalizeSymbol(verbose[1]);
  const strike = Number.parseFloat(verbose[2]);
  const rightToken = verbose[3].toLowerCase();
  const right: OptionRight = rightToken === "p" || rightToken === "put" ? "put" : "call";
  const expiry = normalizeExpiry(verbose[4], now);
  if (!symbol || !Number.isFinite(strike) || strike <= 0 || !expiry) {
    return null;
  }
  const normalized = { symbol, expiry, strike, right };
  return {
    ...normalized,
    occSymbol: toOccOptionSymbol(normalized),
  };
}

export function parseEntryPrice(input: string): number | undefined {
  const match =
    /(?:for|at|@)\s+\$?(\d+(?:\.\d+)?)/i.exec(input) ?? /\bentry\s+\$?(\d+(?:\.\d+)?)/i.exec(input);
  if (!match) {
    return undefined;
  }
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseOptionTradeContext(input: string): ParsedOptionTradeContext {
  const quantityMatch =
    /\b(?:sold|bought|bot|buy|closed|trimmed|have|holding)?\s*(\d{1,4})\s+[A-Za-z]{1,6}\b/i.exec(
      input,
    );
  const quantity = quantityMatch ? Number.parseInt(quantityMatch[1], 10) : 1;
  const posture = /\b(sold|sold-to-close|closed|trimmed)\b/i.test(input)
    ? "sold"
    : /\b(bought|bot|buy|holding|held|have)\b/i.test(input)
      ? "bought"
      : "unknown";
  return {
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    entryPrice: parseEntryPrice(input),
    posture,
  };
}
