import { expect, it } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { createClientFactory } from "./bounded-turn.test-fixtures.js";

it.each(["stdio", "websocket", "unix"] as const)(
  "fences owned-local isolated turns before %s client startup",
  async (transport) => {
    const fake = createClientFactory();
    const input = {
      model: { mode: "required" as const, id: "gpt-5.4" },
      timeoutMs: 5000,
      options: {
        clientFactory: fake.factory,
        pluginConfig: {
          appServer:
            transport === "stdio"
              ? { transport }
              : transport === "unix"
                ? { transport, homeScope: "user", url: "unix:///fixture/native.sock" }
                : { transport, url: "ws://127.0.0.1:19400", authToken: "fixture-token" },
        },
      },
      taskLabel: "isolated completion",
      developerInstructions: "Answer only.",
      input: [{ type: "text" as const, text: "Name this conversation.", text_elements: [] }],
      requiredModalities: ["text"],
      isolation: "configured-transport" as const,
      ownedLocalProcessRequired: true as const,
    };
    if (transport === "stdio") {
      await runBoundedCodexAppServerTurn(input);
      expect(fake.factory).toHaveBeenCalledOnce();
    } else {
      await expect(runBoundedCodexAppServerTurn(input)).rejects.toThrow(/owned local.*stdio/);
      expect(fake.factory).not.toHaveBeenCalled();
    }
  },
);
