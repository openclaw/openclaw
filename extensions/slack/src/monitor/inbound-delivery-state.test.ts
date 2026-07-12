// Slack tests cover inbound delivery state plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSlackRuntime, setSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import {
  buildSlackInboundContentVersion,
  hasNewSlackInboundDeliverableMedia,
  withSlackInboundContentVersion,
} from "./inbound-delivery-identity.js";
import {
  clearSlackInboundDeliveryStateForTest,
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";

describe("slack inbound delivery state", () => {
  afterEach(() => {
    clearSlackInboundDeliveryStateForTest();
    clearSlackRuntime();
    vi.restoreAllMocks();
  });

  function message(channel: string, ts: string): SlackMessageEvent {
    return { type: "message", channel, ts, text: "hello" };
  }

  it("records every delivered debounced source message", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => ({
          register,
          lookup: vi.fn(),
          consume: vi.fn(),
          delete: vi.fn(),
          entries: vi.fn(),
          clear: vi.fn(),
        })),
      },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    await recordSlackInboundMessageDeliveries({
      accountId: "A1",
      messages: [message("C1", "100.001"), message("C1", "100.002")],
    });

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith("A1:C1:100.001", {
      deliveredAt: expect.any(Number),
    });
    expect(register).toHaveBeenCalledWith("A1:C1:100.002", {
      deliveredAt: expect.any(Number),
    });
  });

  it("scopes duplicate checks by account", async () => {
    await recordSlackInboundMessageDeliveries({
      accountId: "A1",
      messages: [message("C1", "100.001")],
    });

    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A1",
        message: message("C1", "100.001"),
      }),
    ).resolves.toBe(true);
    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A2",
        message: message("C1", "100.001"),
      }),
    ).resolves.toBe(false);
  });

  it("keys a same-timestamp finalization by its stable content version", async () => {
    const initial = { ...message("C1", "100.001"), files: [{ id: "F1" }] };
    const finalized = withSlackInboundContentVersion({
      ...initial,
      files: [
        { id: "F1", name: "one.pdf" },
        { id: "F2", name: "two.pdf" },
      ],
    });
    await recordSlackInboundMessageDeliveries({ accountId: "A1", messages: [initial] });

    await expect(
      hasSlackInboundMessageDelivery({ accountId: "A1", message: finalized }),
    ).resolves.toBe(false);

    await recordSlackInboundMessageDeliveries({ accountId: "A1", messages: [finalized] });
    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A1",
        message: withSlackInboundContentVersion({
          ...initial,
          files: [
            { name: "renamed-one.pdf", id: "F1" },
            { name: "renamed-two.pdf", id: "F2" },
          ],
        }),
      }),
    ).resolves.toBe(true);
    await expect(
      hasSlackInboundMessageDelivery({
        accountId: "A1",
        message: withSlackInboundContentVersion({
          ...initial,
          files: [{ id: "F1" }, { id: "F2" }, { id: "F3" }],
        }),
      }),
    ).resolves.toBe(false);
  });

  it("keeps Slack Connect placeholders stable across metadata hydration", () => {
    const pending = {
      files: [{ id: "F1", mode: "file_access", file_access: "check_file_info" }],
    };
    const available = {
      files: [{ id: "F1", url_private: "https://files.slack.com/first" }],
    };
    const refreshed = {
      files: [
        {
          id: "F1",
          name: "renamed.pdf",
          thumb_64: "https://files.slack.com/new-preview",
          url_private_download: "https://files.slack.com/refreshed",
        },
      ],
    };

    expect(buildSlackInboundContentVersion(pending)).toBe(
      buildSlackInboundContentVersion(available),
    );
    expect(buildSlackInboundContentVersion(available)).toBe(
      buildSlackInboundContentVersion(refreshed),
    );
    expect(hasNewSlackInboundDeliverableMedia(available, pending)).toBe(false);
    expect(hasNewSlackInboundDeliverableMedia(refreshed, available)).toBe(false);
  });

  it("distinguishes added deliverable media from removals", () => {
    const files = [{ id: "F1" }, { id: "F2" }];
    expect(hasNewSlackInboundDeliverableMedia({ files }, { files: files.slice(0, 1) })).toBe(true);
    expect(hasNewSlackInboundDeliverableMedia({ files: files.slice(0, 1) }, { files })).toBe(false);
  });

  it("detects new shared-attachment media without re-delivering removals", () => {
    const first = {
      is_share: true,
      ts: "100.001",
      files: [{ id: "F1" }],
    };
    const second = {
      is_share: true,
      ts: "100.002",
      image_url: "https://files.slack.com/preview",
    };
    expect(
      hasNewSlackInboundDeliverableMedia(
        { attachments: [first, second] },
        { attachments: [first] },
      ),
    ).toBe(true);
    expect(
      hasNewSlackInboundDeliverableMedia(
        { attachments: [first] },
        { attachments: [first, second] },
      ),
    ).toBe(false);
  });
});
