import { vi } from "vitest";

// Opt in from the six service suites, not generic memory-store/inbound fixture imports.
vi.mock("../http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http-client.js")>();
  const { withDiscussionTestTransport } = await import("./service-http-transport.test-support.js");
  return {
    ...actual,
    createClickClackClient: (options: Parameters<typeof actual.createClickClackClient>[0]) =>
      actual.createClickClackClient(withDiscussionTestTransport(options)),
  };
});
