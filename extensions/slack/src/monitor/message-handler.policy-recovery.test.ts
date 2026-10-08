import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { createSlackMessageHandler } from "./message-handler.js";
import { createInboundSlackTestContext } from "./message-handler/prepare.test-helpers.js";

const { prepare, dispatch } = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ ctxPayload: {} })),
  dispatch: vi.fn(async () => {}),
}));

vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepare,
  dispatchPreparedSlackMessage: dispatch,
}));

afterEach(() => clearRuntimeConfigSnapshot());

it("settles rejected policy admission and dispatches after configuration is repaired", async () => {
  const cfg: OpenClawConfig = {
    channels: { slack: { dmPolicy: "allowlist", allowFrom: ["U12345678"] } },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const ctx = createInboundSlackTestContext({ cfg });
  ctx.installationIdentity = { kind: "enterprise", enterpriseId: "E12345678" };
  const onError = vi.fn();
  ctx.runtime.error = onError;
  const handler = createSlackMessageHandler({ ctx });
  const invalid: OpenClawConfig = {
    channels: { slack: { dmPolicy: "allowlist", allowFrom: ["@invalid-name"] } },
  };
  setRuntimeConfigSnapshot(invalid, invalid);
  const message = {
    type: "message" as const,
    channel: "D12345678",
    channel_type: "im" as const,
    user: "U12345678",
    ts: "300.001",
    text: "hello",
  };
  let failure: unknown;
  const rejected = handler(message, { source: "message", awaitDispatch: true }).catch(
    (error: unknown) => {
      failure = error;
    },
  );
  await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining("stable Slack IDs") }),
    ),
  );
  await rejected;
  expect(prepare).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();

  setRuntimeConfigSnapshot(cfg, cfg);
  await handler({ ...message, ts: "300.002" }, { source: "message", awaitDispatch: true });
  expect(prepare).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledOnce();
});
