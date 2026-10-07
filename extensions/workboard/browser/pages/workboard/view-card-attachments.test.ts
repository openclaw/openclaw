import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderCardDetailsPanel } from "./view-card-details.ts";
import type { WorkboardProps } from "./view-helpers.ts";

const attachment = (id: string, fileName: string, mimeType: string) => ({
  id,
  cardId: "card-1",
  createdAt: 1,
  fileName,
  byteSize: 4,
  mimeType,
});

describe("Workboard image attachments", () => {
  it("shows image attachments as thumbnails that open full size", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shot");
    const request = vi.fn(async () => ({ contentBase64: btoa("\x89PNG") }));
    const client = { request } as unknown as GatewayBrowserClient;
    const card = createWorkboardCard({
      metadata: {
        attachments: [
          attachment("a-png", "shot.png", "image/png"),
          attachment("a-log", "build.log", "text/plain"),
        ],
      },
    });
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [card];
    state.detailCardId = card.id;
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => {
      render(nothing, container);
      container.remove();
    });
    workboardTestHost().connection.connected = true;
    const props: WorkboardProps = {
      host,
      client,
      connected: true,
      canWrite: true,
      agentsList: null,
      sessions: [],
      onOpenSession: vi.fn(),
      onRequestUpdate: () => render(renderCardDetailsPanel(props), container),
    };
    props.onRequestUpdate?.();

    expect(container.querySelectorAll(".workboard-attachment-thumb")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("workboard.cards.attachments.get", { id: "a-png" });
    const thumb = await waitForFast(() =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Open shot.png"]:not([disabled])',
        ),
        "loaded thumbnail",
      ),
    );
    expect(thumb.querySelector("img")?.getAttribute("src")).toBe("blob:shot");

    thumb.click();
    const preview = expectDefined(
      container.querySelector(".workboard-image-preview img"),
      "full-size preview",
    );
    expect(preview.getAttribute("src")).toBe("blob:shot");
    // The cached image is reused for the preview and later renders.
    expect(request).toHaveBeenCalledTimes(1);
  });
});
