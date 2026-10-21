// Discord Activity shell tests execute the generated browser script against controlled fetches.
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { DISCORD_ACTIVITY_SHELL_JS } from "./shell.js";

class TestElement {
  className = "";
  textContent = "";
  readonly children: TestElement[] = [];

  set innerHTML(value: string) {
    if (value === "") {
      this.children.length = 0;
    }
  }

  append(...children: TestElement[]) {
    this.children.push(...children);
  }
}

it.each([
  { request: "token", phase: "fetch", timeoutMs: 35_000 },
  { request: "widget", phase: "body", timeoutMs: 20_000 },
] as const)(
  "Discord Activity shell bounds a hung $request $phase",
  async ({ request, phase, timeoutMs }) => {
    const app = new TestElement();
    class DiscordSDK {
      customId = "widget-1";
      instanceId = "instance-1";
      commands = {
        authorize: async () => ({ code: "discord-code" }),
        authenticate: async () => ({}),
      };

      async ready() {}
    }

    let timeoutCallback: (() => void) | undefined;
    const clearTimeoutMock = vi.fn(() => {
      timeoutCallback = undefined;
    });
    const setTimeoutMock = vi.fn((callback: () => void) => {
      timeoutCallback = callback;
      return 1;
    });
    const stallUntilAbort = (signal: AbortSignal | null | undefined, message: string) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error(message)), { once: true });
      });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (request === "widget" && input === "./api/token") {
        return Response.json({ access_token: "access", session_token: "session" });
      }
      const signal = init?.signal;
      if (phase === "fetch") {
        return await stallUntilAbort(signal, "request aborted");
      }
      const response = Response.json({});
      response.json = async () => await stallUntilAbort(signal, "body aborted");
      return response;
    });

    runInNewContext(
      DISCORD_ACTIVITY_SHELL_JS.replace(
        'import { DiscordSDK } from "./vendor/embedded-app-sdk.mjs";\n\n',
        "",
      ),
      {
        AbortController,
        // Discord mobile/web clients may not expose the Baseline 2024 static helper.
        AbortSignal: {},
        DiscordSDK,
        Response,
        URL,
        URLSearchParams,
        clearTimeout: clearTimeoutMock,
        document: {
          querySelector: (selector: string) => (selector === "#app" ? app : null),
          createElement: () => new TestElement(),
        },
        fetch: fetchMock,
        setTimeout: setTimeoutMock,
        window: {
          location: {
            hostname: "123456.discordsays.com",
            origin: "https://123456.discordsays.com",
          },
        },
      },
    );

    const expectedRequestCount = request === "token" ? 1 : 2;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(expectedRequestCount));
    expect(timeoutCallback).toBeTypeOf("function");
    timeoutCallback?.();
    await vi.waitFor(() =>
      expect(app.children[0]?.children[0]?.textContent).toBe("Gateway offline"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(expectedRequestCount);
    expect(setTimeoutMock).toHaveBeenCalledTimes(expectedRequestCount);
    expect(setTimeoutMock).toHaveBeenLastCalledWith(expect.any(Function), timeoutMs);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(expectedRequestCount);
  },
);
