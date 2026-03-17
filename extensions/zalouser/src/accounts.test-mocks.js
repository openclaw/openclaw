import { vi } from "vitest";
import { createDefaultResolvedZalouserAccount } from "./test-helpers.js";
vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveZalouserAccountSync: () => createDefaultResolvedZalouserAccount()
  };
});
