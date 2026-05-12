import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCodexAppServerClientFactory,
  resetCodexAppServerClientFactoryForTests,
  resolveCodexAppServerClientFactory,
  setCodexAppServerClientFactoryForTests,
  type CodexAppServerClientFactory,
} from "./client-factory.js";

describe("Codex app-server client factory", () => {
  afterEach(() => {
    resetCodexAppServerClientFactoryForTests();
  });

  it("resolves the default factory when no test override is active", () => {
    expect(resolveCodexAppServerClientFactory()).toBe(defaultCodexAppServerClientFactory);
  });

  it("resolves the AsyncLocalStorage test override when active", () => {
    const factory: CodexAppServerClientFactory = async () => {
      throw new Error("test factory should not be invoked");
    };

    setCodexAppServerClientFactoryForTests(factory);

    expect(resolveCodexAppServerClientFactory()).toBe(factory);
  });
});
