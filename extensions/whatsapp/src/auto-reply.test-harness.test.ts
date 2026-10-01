import { existsSync } from "node:fs";
import { createChannelTurnTestMocks } from "openclaw/plugin-sdk/channel-test-helpers";
import * as conversation from "openclaw/plugin-sdk/conversation-runtime";
import { expect, it, vi } from "vitest";
import { installWebAutoReplyUnitTestHooks } from "./auto-reply.test-harness.js";

const hooks = vi.hoisted(() => ({
  capture: false,
  before: [] as Array<() => Promise<void>>,
  after: [] as Array<() => Promise<void>>,
}));
vi.mock("vitest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vitest")>();
  return {
    ...actual,
    beforeEach: (...args: Parameters<typeof actual.beforeEach>) =>
      hooks.capture
        ? hooks.before.push(args[0] as () => Promise<void>)
        : actual.beforeEach(...args),
    afterEach: (...args: Parameters<typeof actual.afterEach>) =>
      hooks.capture ? hooks.after.push(args[0] as () => Promise<void>) : actual.afterEach(...args),
  };
});

it("releases failed setup state without restoring a borrowed owner or poisoning the next case", async () => {
  hooks.capture = true;
  try {
    installWebAutoReplyUnitTestHooks();
  } finally {
    hooks.capture = false;
  }
  expect(hooks.before).toHaveLength(1);
  expect(hooks.after).toHaveLength(1);
  const setup = hooks.before[0]!;
  const cleanup = hooks.after[0]!;
  const originalEnv = {
    home: process.env.HOME,
    state: process.env.OPENCLAW_STATE_DIR,
    config: process.env.OPENCLAW_CONFIG_PATH,
  };
  const originalRecord = conversation.recordInboundSession;
  const stateDirs: string[] = [];
  let borrowed: Awaited<ReturnType<typeof createChannelTurnTestMocks>> | undefined;
  const captureState = () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    expect(stateDir).toBeTypeOf("string");
    expect(stateDir).not.toBe(originalEnv.state);
    stateDirs.push(stateDir!);
    expect(existsSync(stateDir!)).toBe(true);
  };
  const expectReleased = () => {
    expect({
      home: process.env.HOME,
      state: process.env.OPENCLAW_STATE_DIR,
      config: process.env.OPENCLAW_CONFIG_PATH,
    }).toEqual(originalEnv);
    expect(stateDirs.every((stateDir) => !existsSync(stateDir))).toBe(true);
  };

  try {
    // A completed first case makes stale-handle restoration observable.
    await setup();
    captureState();
    await cleanup();
    expectReleased();
    expect(conversation.recordInboundSession).toBe(originalRecord);

    borrowed = await createChannelTurnTestMocks();
    const borrowedImplementation = async () => {};
    borrowed.recordInboundSessionMock.mockImplementation(borrowedImplementation);
    await expect(setup()).rejects.toThrow("Channel turn test owners are already mocked");
    captureState();
    await cleanup();
    expectReleased();
    expect(conversation.recordInboundSession).toBe(borrowed.recordInboundSessionMock);
    expect(borrowed.recordInboundSessionMock.getMockImplementation()).toBe(borrowedImplementation);
    borrowed.restore();
    borrowed = undefined;

    await setup();
    captureState();
    expect(new Set(stateDirs).size).toBe(3);
    await cleanup();
    expectReleased();
    expect(conversation.recordInboundSession).toBe(originalRecord);
  } finally {
    try {
      await cleanup();
    } finally {
      borrowed?.restore();
    }
  }
});
