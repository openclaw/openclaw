import { hashHex } from "./random.js";
import type { WigForgeRarity, WigForgeSlot, WigForgeWish } from "./types.js";

export type WigForgeWishInput = {
  title?: string;
  slot?: WigForgeSlot;
  desiredRarity?: WigForgeRarity | "any";
  styleTags?: string[];
  note?: string;
  requestedBy?: string;
};

export function createWigForgeWish(input: WigForgeWishInput): WigForgeWish {
  const title = sanitizeWishText(input.title, 80);
  if (!title) {
    throw new Error("wish title is required");
  }
  if (!input.slot) {
    throw new Error("wish slot is required");
  }
  const createdAt = new Date().toISOString();
  const hashSeed = `${createdAt}:${input.slot}:${title}:${Math.random()}`;
  return {
    id: `wig_wish_${hashHex(hashSeed).slice(0, 12)}`,
    title,
    slot: input.slot,
    desiredRarity:
      input.desiredRarity && input.desiredRarity !== "any" ? input.desiredRarity : undefined,
    styleTags: normalizeWishStyleTags(input.styleTags),
    note: sanitizeWishText(input.note, 220) || undefined,
    requestedBy: sanitizeWishText(input.requestedBy, 60) || undefined,
    status: "active",
    createdAt,
  };
}

export function normalizeWishStyleTags(styleTags?: string[]): string[] {
  if (!Array.isArray(styleTags)) {
    return [];
  }
  return Array.from(
    new Set(
      styleTags
        .map((tag) => sanitizeWishText(tag, 32).toLowerCase())
        .filter(Boolean)
        .slice(0, 8),
    ),
  );
}

export function sanitizeWishText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.slice(0, maxLength);
}
