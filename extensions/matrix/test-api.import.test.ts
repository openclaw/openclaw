import { expect, it, vi } from "vitest";

// mock-isolation: A real QA process cannot load Vitest-backed handler fixtures.
vi.mock("./src/matrix/monitor/handler.test-helpers.js", () => {
  throw new Error("QA runtime loaded Matrix handler test fixtures");
});
// mock-isolation: A real QA process cannot initialize the Vitest-only runtime.
vi.mock("./src/test-runtime.js", () => {
  throw new Error("QA runtime loaded Matrix test runtime");
});

it("loads the Matrix QA facade without test-runner fixtures", async () => {
  const runtime = await import("./test-api.js");
  expect(runtime.MatrixClient).toBeTypeOf("function");
  expect(runtime.setMatrixRuntime).toBeTypeOf("function");
});
