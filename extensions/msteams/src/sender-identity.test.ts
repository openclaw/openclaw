import { describe, expect, it } from "vitest";
import type { GraphUser } from "./graph.js";
import { buildSenderIdentityBlock, formatSenderIdentityContext } from "./sender-identity.js";

describe("buildSenderIdentityBlock", () => {
  it("returns structured block for a full profile", () => {
    const profile: GraphUser = {
      id: "aad-123",
      displayName: "Jane Doe",
      mail: "jane@contoso.com",
      userPrincipalName: "jane@contoso.onmicrosoft.com",
      department: "Engineering",
      jobTitle: "Staff Engineer",
    };
    const block = buildSenderIdentityBlock(profile);
    expect(block).toEqual({
      aadId: "aad-123",
      displayName: "Jane Doe",
      email: "jane@contoso.com",
      department: "Engineering",
      jobTitle: "Staff Engineer",
    });
  });

  it("falls back to userPrincipalName when mail is absent", () => {
    const profile: GraphUser = {
      id: "aad-456",
      displayName: "Bob",
      userPrincipalName: "bob@contoso.onmicrosoft.com",
    };
    const block = buildSenderIdentityBlock(profile);
    expect(block?.email).toBe("bob@contoso.onmicrosoft.com");
  });

  it("returns null fields for missing optional properties", () => {
    const profile: GraphUser = { id: "aad-789" };
    const block = buildSenderIdentityBlock(profile);
    expect(block).toEqual({
      aadId: "aad-789",
      displayName: null,
      email: null,
      department: null,
      jobTitle: null,
    });
  });

  it("returns null when profile has no id", () => {
    const profile: GraphUser = { displayName: "No ID" };
    expect(buildSenderIdentityBlock(profile)).toBeNull();
  });
});

describe("formatSenderIdentityContext", () => {
  it("produces a markdown block with JSON", () => {
    const identity = {
      aadId: "aad-123",
      displayName: "Jane Doe",
      email: "jane@contoso.com",
      department: "Engineering",
      jobTitle: "Staff Engineer",
    };
    const formatted = formatSenderIdentityContext(identity);
    expect(formatted).toContain("## Sender Identity");
    expect(formatted).toContain("Microsoft AAD");
    expect(formatted).toContain("```json");
    expect(formatted).toContain('"aadId": "aad-123"');
    expect(formatted).toContain('"department": "Engineering"');
  });
});
