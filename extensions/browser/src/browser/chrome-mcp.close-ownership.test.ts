import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  closeChromeMcpTab,
  evaluateChromeMcpScript,
  listChromeMcpTabs,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";
import { createPageSession, installChromeMcpSessionTestHooks } from "./chrome-mcp.test-support.js";

installChromeMcpSessionTestHooks();
it("rechecks the tab owner after waiting for the MCP operation lock", async () => {
  const entered = createDeferred<void>();
  const proceed = createDeferred<void>();
  const closePage = vi.fn();
  let claimed = false;
  const session = createPageSession({
    pid: 131,
    pages: [
      { id: 1, url: "https://a.example" },
      { id: 2, url: "https://b.example" },
    ],
    onTool: async (call) => {
      if (call.name === "evaluate_script") {
        entered.resolve();
        await proceed.promise;
      }
      if (call.name === "close_page") {
        closePage();
        return { content: [{ type: "text", text: "closed" }] };
      }
      return undefined;
    },
  });
  setChromeMcpSessionFactoryForTest(async () => session);
  const targetId = (await listChromeMcpTabs("chrome-live"))[1]?.targetId;
  if (!targetId) {
    throw new Error("Target fixture missing");
  }
  const busy = evaluateChromeMcpScript({
    profileName: "chrome-live",
    targetId,
    fn: "() => null",
  });
  await entered.promise;
  const closing = closeChromeMcpTab("chrome-live", targetId, undefined, {
    assertTabCanClose: async () => {
      if (claimed) {
        throw new Error("Tab ownership changed");
      }
    },
  });
  const denied = expect(closing).rejects.toThrow("Tab ownership changed");
  claimed = true;
  proceed.resolve();
  await busy;
  await denied;
  expect(closePage).not.toHaveBeenCalled();
  expect((await listChromeMcpTabs("chrome-live")).some((tab) => tab.targetId === targetId)).toBe(
    true,
  );
});
