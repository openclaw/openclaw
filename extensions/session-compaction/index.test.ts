import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";

it("omits unsupported runtimes and requests rather than claiming completed compaction", async () => {
  const register = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register?.(createTestPluginApi({ id: "session-compaction", registerTool: register }));
  const factory = register.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("expected a context-bound factory");
  }
  expect(factory({})).toBeNull();
  const request = vi.fn(() => ({ status: "requested" as const }));
  const tool = factory({ sessionCompaction: { request } });
  if (!tool || Array.isArray(tool)) {
    throw new Error("expected a supported tool");
  }
  const result = await tool.execute("compact", { focus: "Preserve the unfinished migration" });
  expect(result.details).toMatchObject({ status: "requested" });
  expect(request).toHaveBeenCalledExactlyOnceWith({ focus: "Preserve the unfinished migration" });
  await expect(tool.execute("invalid", { focus: 2 })).rejects.toThrow("focus string");
  const aborted = AbortSignal.abort(new Error("cancelled"));
  await expect(tool.execute("cancelled", {}, aborted)).rejects.toThrow("cancelled");
  expect(request).toHaveBeenCalledTimes(1);
});
