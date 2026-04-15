// Facade that lazy-loads @whiskeysockets/baileys at runtime.
// This file is the intentional seam for testing (mockable via vi.mock)
// and for production code that needs lazy Baileys initialization.
// Do NOT use top-level `export ... from "@whiskeysockets/baileys"` — that
// creates a static re-export barrel that gets included in root dist.
export async function loadBaileysRuntime() {
  return import("@whiskeysockets/baileys");
}
