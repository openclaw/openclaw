import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";

const setup = createQaGatewaySetupHarness();
afterEach(() => setup.cleanup());

describe("configured QA runtime selection", () => {
  it("keeps Codex out of the force-runtime environment", async () => {
    const child = await setup.prepare({
      forcedRuntime: "codex",
      runtimeSelection: "configured",
      providerMode: "live-frontier",
    });

    expect(child.env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(child.env.OPENCLAW_CODEX_APP_SERVER_ARGS).toEqual(expect.any(String));
    expect("OPENCLAW_QA_FORCE_RUNTIME" in child.env).toBe(false);

    vi.stubEnv(
      "OPENCLAW_CODEX_APP_SERVER_ARGS",
      "app-server --listen stdio:// -c features.synthetic=true",
    );
    vi.stubEnv("OPENCLAW_QA_CODEX_API_KEY_HANDOFF", "  replacement-synthetic-key  ");
    const replacement = await child.prepareAttempt();
    expect(replacement.env.OPENCLAW_CODEX_APP_SERVER_ARGS).toBe(
      "app-server --listen stdio:// -c features.synthetic=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.exclude_slash_tmp=true",
    );
    expect(replacement.env.CODEX_API_KEY).toBe("replacement-synthetic-key");
    expect("OPENCLAW_QA_CODEX_API_KEY_HANDOFF" in replacement.env).toBe(false);
    expect("OPENCLAW_QA_FORCE_RUNTIME" in replacement.env).toBe(false);
    expect(child.env.CODEX_API_KEY).toBeUndefined();
  });
});
