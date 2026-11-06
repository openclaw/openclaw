import { vi } from "vitest";
import { handleCodexAccountUsage } from "./account-usage-runtime.js";
import * as request from "./app-server/request.js";

export function createCodexAccountUsageTestFixture() {
  return {
    handleCodexAccountUsage,
    readCodexAppServerUsage: vi.spyOn(request, "readCodexAppServerUsage"),
  };
}
