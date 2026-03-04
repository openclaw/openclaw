import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface ServiceListing {
  id: string;
  /** Agent session ID (seller) */
  agentId: string;
  /** Human-readable service name */
  name: string;
  /** Service description */
  description: string;
  /** Price in CLAW tokens */
  price: string;
  /** Service category */
  category: ServiceCategory;
  /** Seller wallet address */
  sellerAddress: string;
  /** Status */
  status: "active" | "paused" | "sold";
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp */
  updatedAt: string;
}

export type ServiceCategory =
  | "code-analysis"
  | "code-generation"
  | "translation"
  | "data-analysis"
  | "image-generation"
  | "research"
  | "automation"
  | "other";

export interface MarketplaceQuery {
  category?: ServiceCategory;
  maxPrice?: string;
  agentId?: string;
  status?: ServiceListing["status"];
}

// ── Marketplace Registry ────────────────────────────────────────────

export class MarketplaceRegistry {
  private readonly storePath: string;

  constructor(stateDir: string) {
    const dir = join(stateDir, "agent-commerce");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.storePath = join(dir, "marketplace.json");
  }

  // ── CRUD ────────────────────────────────────────────────────────

  /**
   * Publish a new service listing.
   */
  publish(
    listing: Omit<ServiceListing, "id" | "status" | "createdAt" | "updatedAt">,
  ): ServiceListing {
    const listings = this.loadListings();
    const now = new Date().toISOString();

    const newListing: ServiceListing = {
      ...listing,
      id: this.generateId(),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    listings.push(newListing);
    this.saveListings(listings);
    return newListing;
  }

  /**
   * Search listings with optional filters.
   */
  search(query: MarketplaceQuery = {}): ServiceListing[] {
    const listings = this.loadListings();

    return listings.filter((l) => {
      if (query.status && l.status !== query.status) return false;
      if (query.category && l.category !== query.category) return false;
      if (query.agentId && l.agentId !== query.agentId) return false;
      if (query.maxPrice && parseFloat(l.price) > parseFloat(query.maxPrice)) return false;
      return true;
    });
  }

  /**
   * Get a listing by ID.
   */
  get(id: string): ServiceListing | null {
    const listings = this.loadListings();
    return listings.find((l) => l.id === id) ?? null;
  }

  /**
   * Update a listing (partial update).
   */
  update(
    id: string,
    patch: Partial<Pick<ServiceListing, "name" | "description" | "price" | "status" | "category">>,
  ): ServiceListing | null {
    const listings = this.loadListings();
    const index = listings.findIndex((l) => l.id === id);
    if (index === -1) return null;

    listings[index] = {
      ...listings[index],
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    this.saveListings(listings);
    return listings[index];
  }

  /**
   * Remove a listing.
   */
  remove(id: string): boolean {
    const listings = this.loadListings();
    const filtered = listings.filter((l) => l.id !== id);
    if (filtered.length === listings.length) return false;

    this.saveListings(filtered);
    return true;
  }

  /**
   * Get all active listings (convenience).
   */
  getActive(): ServiceListing[] {
    return this.search({ status: "active" });
  }

  /**
   * Get available categories with counts.
   */
  getCategories(): Record<ServiceCategory, number> {
    const listings = this.getActive();
    const counts = {} as Record<ServiceCategory, number>;

    for (const l of listings) {
      counts[l.category] = (counts[l.category] ?? 0) + 1;
    }

    return counts;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadListings(): ServiceListing[] {
    try {
      if (!existsSync(this.storePath)) return [];
      const raw = readFileSync(this.storePath, "utf-8");
      return JSON.parse(raw) as ServiceListing[];
    } catch {
      return [];
    }
  }

  private saveListings(listings: ServiceListing[]): void {
    writeFileSync(this.storePath, JSON.stringify(listings, null, 2), "utf-8");
  }

  private generateId(): string {
    return `svc_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  }
}
