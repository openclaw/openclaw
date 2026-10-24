import { expect, it, vi } from "vitest";

vi.mock("@google/genai", () => {
  throw new Error("Generic transport helpers must not initialize the Google SDK");
});

it("loads generic transports without initializing a provider SDK", async () => {
  await expect(import("./transports.js")).resolves.toHaveProperty(
    "createTransportAwareStreamFnForModel",
    expect.any(Function),
  );
});
