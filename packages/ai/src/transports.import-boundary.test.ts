import { expect, it, vi } from "vitest";

vi.mock("@google/genai", () => {
  throw new Error("Generic transport helpers must not initialize the Google SDK");
});

// mock-isolation: importing the real partitioner would conceal an eager dependency.
vi.mock("./utils/reasoning-tag-text-partitioner.js", () => {
  throw new Error("Generic runtime helpers must not initialize provider reasoning parsing");
});

it("loads generic transports without initializing a provider SDK", async () => {
  await expect(import("./transports.js")).resolves.toHaveProperty(
    "createTransportAwareStreamFnForModel",
    expect.any(Function),
  );
});

it("loads generic runtime helpers without initializing provider reasoning parsing", async () => {
  await expect(import("./internal/runtime.js")).resolves.toHaveProperty(
    "stream",
    expect.any(Function),
  );
});
