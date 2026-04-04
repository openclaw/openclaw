/**
 * Auto-scoring logic for leads.
 *
 * Score is a COMPUTED value derived from location, bimonthly_bill, and ownership.
 * The LLM agent never sets scores directly — the system computes them from data.
 */

/** Cities and municipalities in Sinaloa (service area). */
const SINALOA_CITIES = new Set([
  "culiacan",
  "culiacán",
  "mazatlan",
  "mazatlán",
  "los mochis",
  "guasave",
  "navolato",
  "cosala",
  "cosalá",
  "el rosario",
  "escuinapa",
  "angostura",
  "badiraguato",
  "choix",
  "concordia",
  "elota",
  "el fuerte",
  "mocorito",
  "salvador alvarado",
  "san ignacio",
  "sinaloa de leyva",
  "ahome",
  "rosario",
]);

function isInSinaloa(location: string): boolean {
  const normalized = location.toLowerCase().trim();
  if (normalized.includes("sinaloa")) return true;
  return SINALOA_CITIES.has(normalized);
}

export type LeadScore = "HOT" | "WARM" | "COLD" | "OUT";

export interface ScoreInput {
  location: string | null;
  bimonthly_bill: number | null;
  ownership: string | null;
}

/**
 * Compute a lead score from qualifying data.
 * Returns null if insufficient data (missing location or bimonthly_bill).
 */
export function computeScore(input: ScoreInput): LeadScore | null {
  if (!input.location || input.bimonthly_bill == null) {
    return null;
  }

  // Outside service area
  if (!isInSinaloa(input.location)) return "OUT";

  // Renters can't install panels
  if (input.ownership?.toLowerCase() === "rentada") return "OUT";

  // Score by bill amount
  if (input.bimonthly_bill < 500) return "OUT";
  if (input.bimonthly_bill < 1000) return "COLD";
  if (input.bimonthly_bill < 2000) return "WARM";
  return "HOT";
}
