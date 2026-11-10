import { expectDefined } from "@openclaw/normalization-core";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

let capturedContext: MsgContext | undefined;

// mock-isolation: Preserve the real inbound runner while isolating model dispatch and session recording.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  return signalInboundTestModule(
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>(),
    async () => {},
    async (plan) => {
      capturedContext = plan.ctxPayload;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
    false,
  );
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

beforeEach(() => {
  capturedContext = undefined;
});

async function receive(viewOnce: boolean | null | undefined, ignoreAttachments = false) {
  const fetchAttachment = vi.fn<SignalEventHandlerDeps["fetchAttachment"]>(
    async ({ attachment }) => ({
      path: `/synthetic/${attachment.id}.dat`,
      contentType: attachment.contentType ?? undefined,
    }),
  );
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: {
        messages: { inbound: { debounceMs: 0 } },
        channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
      },
      ignoreAttachments,
      fetchAttachment,
    }),
  );
  const dataMessage = {
    message: "",
    viewOnce,
    attachments: [
      { id: "photo", contentType: "image/png" },
      { id: "video", contentType: "video/mp4" },
    ],
  };
  await handler(createSignalReceiveEvent({ dataMessage }));
  return { fetchAttachment, context: expectDefined(capturedContext, "Signal inbound context") };
}

it.each([false, true])(
  "withholds view-once media (ignoreAttachments=%s)",
  async (ignoreAttachments) => {
    const { fetchAttachment, context } = await receive(true, ignoreAttachments);
    expect(fetchAttachment).not.toHaveBeenCalled();
    expect(context.media?.some((media) => media.path || media.url)).not.toBe(true);
    expect(context.BodyForAgent).toBe("[signal view-once media not shown]");
  },
);

it.each([undefined, false, null])("preserves ordinary media (viewOnce=%s)", async (viewOnce) => {
  const { fetchAttachment, context } = await receive(viewOnce);
  expect(fetchAttachment).toHaveBeenCalledTimes(2);
  expect(context.media).toEqual([
    expect.objectContaining({ path: "/synthetic/photo.dat", contentType: "image/png" }),
    expect.objectContaining({ path: "/synthetic/video.dat", contentType: "video/mp4" }),
  ]);
});
