import { vi } from "vitest";

// mock-isolation: Inject fixture HTTP transport while retaining the real client and its exports.
vi.mock("../http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http-client.js")>();
  const { withDiscussionTestTransport } = await import("./service-http-transport.test-support.js");
  return {
    ...actual,
    createClickClackClient: (options: Parameters<typeof actual.createClickClackClient>[0]) =>
      actual.createClickClackClient(withDiscussionTestTransport(options)),
  };
});
