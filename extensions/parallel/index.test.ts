import { describe, expect, it } from "vitest";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import parallelPlugin from "./index.js";

describe("parallel plugin", () => {
  it("registers a web search provider with id 'parallel'", () => {
    const captured = createCapturedPluginRegistration();
    parallelPlugin.register(captured.api);
    expect(captured.webSearchProviders).toHaveLength(1);
    expect(captured.webSearchProviders[0]!.id).toBe("parallel");
  });

  it("has correct plugin metadata", () => {
    expect(parallelPlugin.id).toBe("parallel");
    expect(parallelPlugin.name).toBe("Parallel Plugin");
  });
});
