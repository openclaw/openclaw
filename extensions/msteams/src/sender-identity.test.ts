import { describe, expect, it } from "vitest";
import type { GraphUser } from "./graph.js";
import { buildSenderIdentityContext, buildSenderIdentityPayload } from "./sender-identity.js";

describe("buildSenderIdentityPayload", () => {
  it("returns structured payload for a full profile", () => {
    const profile: GraphUser = {
      id: "aad-123",
      displayName: "Jane Doe",
      mail: "jane@contoso.com",
      userPrincipalName: "jane@contoso.onmicrosoft.com",
      department: "Engineering",
      jobTitle: "Staff Engineer",
    };
    const payload = buildSenderIdentityPayload(profile);
    expect(payload).toEqual({
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
    const payload = buildSenderIdentityPayload(profile);
    expect(payload?.email).toBe("bob@contoso.onmicrosoft.com");
  });

  it("returns null fields for missing optional properties", () => {
    const profile: GraphUser = { id: "aad-789" };
    const payload = buildSenderIdentityPayload(profile);
    expect(payload).toEqual({
      aadId: "aad-789",
      displayName: null,
      email: null,
      department: null,
      jobTitle: null,
    });
  });

  it("returns null when profile has no id", () => {
    const profile: GraphUser = { displayName: "No ID" };
    expect(buildSenderIdentityPayload(profile)).toBeNull();
  });
});

describe("buildSenderIdentityContext", () => {
  it("produces an untrusted structured context entry", () => {
    const identity = {
      aadId: "aad-123",
      displayName: "Jane Doe",
      email: "jane@contoso.com",
      department: "Engineering",
      jobTitle: "Staff Engineer",
    };
    const entry = buildSenderIdentityContext(identity);
    expect(entry.label).toBe("Microsoft Teams sender identity");
    expect(entry.source).toBe("msteams");
    expect(entry.type).toBe("sender_identity");
    expect(entry.payload).toEqual(identity);
  });
});
