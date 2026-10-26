import { expect, it } from "vitest";
import { validatePrivateKey } from "./nostr-key-utils.js";

it("rejects invalid nsec without including it in the error", () => {
  const badNsec = "nsec1not-a-real-secret";
  let error: unknown;
  try {
    validatePrivateKey(badNsec);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(badNsec);
});
