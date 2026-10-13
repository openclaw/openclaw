import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";

const REQUEST_TIMEOUT_MS = 500;

describe("nextcloud talk room info fetch timeout", () => {
  it("bounds hanging room info GET requests", async () => {
    let received = false;
    const runtime = createRuntimeSpies();

    await withServer(
      (request) => {
        received = true;
        expect(request.method).toBe("GET");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v4/room/abc123");
        request.resume();
      },
      async (baseUrl) => {
        const lookup = resolveNextcloudTalkRoomKind({
          account: {
            accountId: "acct-hanging-room-info",
            baseUrl,
            config: {
              apiUser: "bot",
              apiPassword: "secret",
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          } as never,
          roomToken: "abc123",
          runtime,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });

        await expect(lookup).rejects.toThrow();
      },
    );

    expect(received).toBe(true);
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
