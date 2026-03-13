import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("zulip channel lazy imports", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("./zulip/directory.js");
    vi.doUnmock("./zulip/monitor.js");
    vi.doUnmock("./zulip/probe.js");
    vi.doUnmock("./zulip/send-components.js");
    vi.doUnmock("./zulip/send.js");
  });

  it("does not eagerly import heavy runtime modules on channel load", async () => {
    vi.doMock("./zulip/directory.js", () => {
      throw new Error("directory imported eagerly");
    });
    vi.doMock("./zulip/monitor.js", () => {
      throw new Error("monitor imported eagerly");
    });
    vi.doMock("./zulip/probe.js", () => {
      throw new Error("probe imported eagerly");
    });
    vi.doMock("./zulip/send-components.js", () => {
      throw new Error("send-components imported eagerly");
    });
    vi.doMock("./zulip/send.js", () => {
      throw new Error("send imported eagerly");
    });

    const { zulipPlugin } = await import("./channel.js");
    expect(zulipPlugin.id).toBe("zulip");
    expect(zulipPlugin.gateway?.startAccount).toBeTypeOf("function");
    expect(zulipPlugin.outbound?.sendText).toBeTypeOf("function");
  });
});
