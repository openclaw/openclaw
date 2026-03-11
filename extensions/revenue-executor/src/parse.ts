import type { ParsedRevenueCommand, RevenueCommandInput } from "./types.js";

const PRICE_REGEX = /(?:\$\s*|USD\s*)(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(?:USD|dollars?)\b/i;
const EMAIL_REGEX = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const PHONE_REGEX = /(?:\+?\d[\d\s().-]{6,}\d)/;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function stripTrailingContactDetails(value: string): string {
  return normalizeWhitespace(
    value
      .replace(EMAIL_REGEX, " ")
      .replace(PHONE_REGEX, " ")
      .replace(/\s+/g, " "),
  );
}

function extractPrice(raw: string, fallback?: number): number {
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) {
    return Number(fallback.toFixed(2));
  }
  const match = raw.match(PRICE_REGEX);
  const fromText = match?.[1] ?? match?.[2];
  if (!fromText) {
    return 0;
  }
  const value = Number.parseFloat(fromText);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Number(value.toFixed(2));
}

function extractContactName(command: string, explicit?: string): string {
  if (explicit?.trim()) {
    return normalizeWhitespace(explicit);
  }

  const tailMatch = command.match(/(?:for|to|lead|contact)\s+(.+)$/i);
  if (tailMatch?.[1]) {
    const cleaned = stripTrailingContactDetails(tailMatch[1]);
    if (cleaned) {
      return titleCase(cleaned);
    }
  }

  const beforePrice = command.split(PRICE_REGEX)[0] ?? command;
  const match = beforePrice.match(/(?:for|to|lead|contact)\s+(.+)$/i);
  if (match?.[1]) {
    const cleaned = stripTrailingContactDetails(match[1]);
    if (cleaned) {
      return titleCase(cleaned);
    }
  }

  const twoWordName = beforePrice.match(/\b([A-Za-z]{2,})\s+([A-Za-z]{2,})\b/);
  if (twoWordName) {
    return titleCase(`${twoWordName[1]} ${twoWordName[2]}`);
  }

  return "AI Lead";
}

function extractProductType(command: string, explicit?: string): string {
  if (explicit?.trim()) {
    return normalizeWhitespace(explicit);
  }

  const withoutPrice = command.replace(PRICE_REGEX, "");
  const cleaned = withoutPrice
    .replace(/(?:for|to|lead|contact)\s+.+$/i, "")
    .replace(/(?:create|sell|charge|book|offer)\s*/gi, "")
    .replace(/[,:-]+/g, " ")
    .trim();

  if (!cleaned) {
    return "Offer";
  }
  return titleCase(normalizeWhitespace(cleaned));
}

export function parseRevenueCommand(input: RevenueCommandInput): ParsedRevenueCommand {
  const command = normalizeWhitespace(input.command ?? "");
  if (!command) {
    throw new Error("command is required");
  }

  const price = extractPrice(command, input.price);
  const contactName = extractContactName(command, input.contactName);
  const productType = extractProductType(command, input.productType);
  const opportunityName = `${productType} - $${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}`;

  return {
    contactName,
    productType,
    price,
    opportunityName,
    email: input.email?.trim() || command.match(EMAIL_REGEX)?.[0],
    phone: input.phone?.trim() || command.match(PHONE_REGEX)?.[0]?.trim(),
  };
}
