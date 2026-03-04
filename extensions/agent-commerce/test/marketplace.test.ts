import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { MarketplaceRegistry } from "../src/marketplace.js";

describe("MarketplaceRegistry", () => {
  let stateDir: string;
  let marketplace: MarketplaceRegistry;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "commerce-test-"));
    marketplace = new MarketplaceRegistry(stateDir);
  });

  it("should publish a service listing", () => {
    const listing = marketplace.publish({
      agentId: "agent-1",
      name: "Code Analysis",
      description: "Deep analysis of TypeScript codebases",
      price: "50",
      category: "code-analysis",
      sellerAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });

    expect(listing.id).toMatch(/^svc_/);
    expect(listing.name).toBe("Code Analysis");
    expect(listing.price).toBe("50");
    expect(listing.status).toBe("active");
  });

  it("should search listings by category", () => {
    marketplace.publish({
      agentId: "agent-1",
      name: "Code Analysis",
      description: "Analyzes code",
      price: "50",
      category: "code-analysis",
      sellerAddress: "0xAAA",
    });
    marketplace.publish({
      agentId: "agent-2",
      name: "Translate Doc",
      description: "Translates documents",
      price: "30",
      category: "translation",
      sellerAddress: "0xBBB",
    });

    const codeResults = marketplace.search({ category: "code-analysis" });
    expect(codeResults).toHaveLength(1);
    expect(codeResults[0].name).toBe("Code Analysis");

    const all = marketplace.search();
    expect(all).toHaveLength(2);
  });

  it("should filter by max price", () => {
    marketplace.publish({
      agentId: "agent-1",
      name: "Cheap Service",
      description: "Affordable",
      price: "10",
      category: "other",
      sellerAddress: "0xAAA",
    });
    marketplace.publish({
      agentId: "agent-2",
      name: "Expensive Service",
      description: "Premium",
      price: "100",
      category: "other",
      sellerAddress: "0xBBB",
    });

    const cheap = marketplace.search({ maxPrice: "50" });
    expect(cheap).toHaveLength(1);
    expect(cheap[0].name).toBe("Cheap Service");
  });

  it("should update a listing", () => {
    const listing = marketplace.publish({
      agentId: "agent-1",
      name: "Old Name",
      description: "Old desc",
      price: "25",
      category: "research",
      sellerAddress: "0xAAA",
    });

    const updated = marketplace.update(listing.id, {
      name: "New Name",
      price: "35",
    });

    expect(updated?.name).toBe("New Name");
    expect(updated?.price).toBe("35");
  });

  it("should remove a listing", () => {
    const listing = marketplace.publish({
      agentId: "agent-1",
      name: "To Remove",
      description: "Will be removed",
      price: "10",
      category: "other",
      sellerAddress: "0xAAA",
    });

    expect(marketplace.remove(listing.id)).toBe(true);
    expect(marketplace.get(listing.id)).toBeNull();
    expect(marketplace.remove("nonexistent")).toBe(false);
  });

  it("should count categories", () => {
    marketplace.publish({
      agentId: "a1",
      name: "S1",
      description: "D1",
      price: "10",
      category: "code-analysis",
      sellerAddress: "0xA",
    });
    marketplace.publish({
      agentId: "a2",
      name: "S2",
      description: "D2",
      price: "20",
      category: "code-analysis",
      sellerAddress: "0xB",
    });
    marketplace.publish({
      agentId: "a3",
      name: "S3",
      description: "D3",
      price: "30",
      category: "translation",
      sellerAddress: "0xC",
    });

    const cats = marketplace.getCategories();
    expect(cats["code-analysis"]).toBe(2);
    expect(cats["translation"]).toBe(1);
  });
});
