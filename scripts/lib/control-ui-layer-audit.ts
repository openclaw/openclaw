import type { Page } from "playwright";

type Layer = {
  layerId: string;
  parentLayerId?: string;
  backendNodeId?: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  transform?: number[];
  paintCount: number;
  drawsContent: boolean;
};
type Rect = { x: number; y: number; width: number; height: number };
type Paint = { layerId: string; clip: Rect };
type AuditedLayer = Layer & {
  rgbaEstimateBytes: number;
  compositingReasons?: string[];
  compositingReasonIds?: string[];
  reasonsUnavailable?: "layer-removed-during-capture";
  element?: {
    tagName: string;
    className: string;
    styles: Record<string, string>;
  };
  elementUnavailable?: "node-removed-during-capture" | "non-element-node";
};
type ControlUiLayerSnapshot = {
  capturedAt: string;
  layerCount: number;
  contentLayerCount: number;
  rgbaEstimateBytes: number;
  layers: AuditedLayer[];
};
export type ControlUiLayerAudit = {
  before: ControlUiLayerSnapshot;
  after: ControlUiLayerSnapshot;
  paints: {
    eventStatus: "observed" | "none-observed";
    count: number;
    paintCountIncreaseOnRetainedLayers: number;
    summedDirtyArea: number;
    layers: Array<{
      layerId: string;
      count: number;
      summedDirtyArea: number;
      bounds: Rect;
      rects: Rect[];
    }>;
  };
  notes: string[];
};

/** Diagnostic collection only: metadata queries run outside the action window. */
export async function createControlUiLayerAudit(page: Page) {
  if (page.context().browser()?.browserType().name() !== "chromium") {
    throw new Error("Layer audit requires Chromium's CDP LayerTree domain");
  }
  const session = await page.context().newCDPSession(page);
  let latest: Layer[] | undefined;
  let paints: Paint[] | undefined;
  let before: ControlUiLayerSnapshot | undefined;
  let disposed = false;
  const initialInventory = Promise.withResolvers<void>();
  const collectLayers = ({ layers }: { layers?: Layer[] }) => {
    latest = layers;
    if (layers) {
      initialInventory.resolve();
    }
  };
  const collectPaint = (event: Paint) => paints?.push(event);
  session.on("LayerTree.layerTreeDidChange", collectLayers);
  session.on("LayerTree.layerPainted", collectPaint);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    await session.send("LayerTree.enable");
    // LayerTree has no getLayers command. Wait for its initial asynchronous event.
    if (!latest) {
      // Headless Chromium may not commit an idle document until a surface is requested.
      await page.screenshot({ animations: "allow", timeout: 5_000 });
    }
    if (!latest) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("LayerTree did not provide an initial layer inventory"));
        }, 5_000);
        void initialInventory.promise.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } catch (error) {
    await session.detach();
    throw error;
  }

  async function snapshot(): Promise<ControlUiLayerSnapshot> {
    if (disposed || !latest) {
      throw new Error("Layer audit has no active composited layer inventory");
    }
    const layers = latest;
    const capturedAt = new Date().toISOString();
    // Establish frontend node ids for this document, including after navigation.
    await session.send("DOM.getDocument");
    const backendIds = [...new Set(layers.flatMap((layer) => layer.backendNodeId ?? []))];
    const { nodeIds } = await session.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: backendIds,
    });
    const frontendIds = new Map(backendIds.map((id, index) => [id, nodeIds[index]]));
    const audited: AuditedLayer[] = [];
    // Keep CDP fan-out bounded on routes with many promoted elements.
    for (let start = 0; start < layers.length; start += 4) {
      const batch = await Promise.all(
        layers.slice(start, start + 4).map(async (layer): Promise<AuditedLayer> => {
          const row: AuditedLayer = Object.assign({}, layer, {
            rgbaEstimateBytes: layer.drawsContent ? layer.width * layer.height * 4 : 0,
          });
          try {
            const reasons = await session.send("LayerTree.compositingReasons", {
              layerId: layer.layerId,
            });
            row.compositingReasons = reasons.compositingReasons;
            row.compositingReasonIds = reasons.compositingReasonIds;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes("No layer matching given id")
            ) {
              throw error;
            }
            // Preserve the inventory entry: animation/navigation can retire it while queried.
            row.reasonsUnavailable = "layer-removed-during-capture";
          }
          if (layer.backendNodeId === undefined) {
            return row;
          }
          const nodeId = frontendIds.get(layer.backendNodeId);
          if (!nodeId) {
            row.elementUnavailable = "node-removed-during-capture";
            return row;
          }
          try {
            const { node } = await session.send("DOM.describeNode", { nodeId });
            if (node.nodeType !== 1) {
              row.elementUnavailable = "non-element-node";
              return row;
            }
            const { computedStyle } = await session.send("CSS.getComputedStyleForNode", { nodeId });
            const classIndex =
              node.attributes?.findIndex((name, index) => index % 2 === 0 && name === "class") ??
              -1;
            row.element = {
              tagName: node.localName,
              className: classIndex >= 0 ? (node.attributes?.[classIndex + 1] ?? "") : "",
              styles: Object.fromEntries(
                computedStyle
                  .filter(({ name }) =>
                    [
                      "will-change",
                      "transform",
                      "backdrop-filter",
                      "position",
                      "contain",
                      "opacity",
                    ].includes(name),
                  )
                  .map(({ name, value }) => [name, value]),
              ),
            };
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/No node with given id|Could not find node with given id/u.test(error.message)
            ) {
              throw error;
            }
            row.elementUnavailable = "node-removed-during-capture";
          }
          return row;
        }),
      );
      audited.push(...batch);
    }
    return {
      capturedAt,
      layerCount: audited.length,
      contentLayerCount: audited.filter((layer) => layer.drawsContent).length,
      rgbaEstimateBytes: audited.reduce((sum, layer) => sum + layer.rgbaEstimateBytes, 0),
      layers: audited,
    };
  }

  return {
    async capture() {
      before = await snapshot();
      paints = [];
      return before;
    },
    async finish(): Promise<ControlUiLayerAudit> {
      if (!before || !paints) {
        throw new Error("Call layer audit capture before the action and finish after it settles");
      }
      const events = paints;
      paints = undefined;
      const beforePaintCounts = new Map(
        before.layers.map((layer) => [layer.layerId, layer.paintCount]),
      );
      const after = await snapshot();
      const perLayer = new Map<string, ControlUiLayerAudit["paints"]["layers"][number]>();
      for (const { layerId, clip } of events) {
        const area = clip.width * clip.height;
        const entry = perLayer.get(layerId);
        if (entry) {
          const x = Math.min(entry.bounds.x, clip.x);
          const y = Math.min(entry.bounds.y, clip.y);
          const right = Math.max(entry.bounds.x + entry.bounds.width, clip.x + clip.width);
          const bottom = Math.max(entry.bounds.y + entry.bounds.height, clip.y + clip.height);
          entry.bounds = { x, y, width: right - x, height: bottom - y };
          entry.count++;
          entry.summedDirtyArea += area;
          entry.rects.push(clip);
        } else {
          perLayer.set(layerId, {
            layerId,
            count: 1,
            summedDirtyArea: area,
            bounds: { ...clip },
            rects: [clip],
          });
        }
      }
      return {
        before,
        after,
        paints: {
          eventStatus: events.length ? "observed" : "none-observed",
          count: events.length,
          paintCountIncreaseOnRetainedLayers: after.layers.reduce((sum, layer) => {
            const previous = beforePaintCounts.get(layer.layerId);
            return sum + (previous === undefined ? 0 : Math.max(0, layer.paintCount - previous));
          }, 0),
          summedDirtyArea: events.reduce((sum, { clip }) => sum + clip.width * clip.height, 0),
          layers: [...perLayer.values()],
        },
        notes: [
          "RGBA estimate is drawsContent width × height × 4 in reported layer units; excludes device scale, tiling, buffers and GPU allocation overhead. It is not measured GPU memory.",
          "Paint clips and per-layer bounds use layer-local coordinates. Summed area includes repeated/overlapping paints and is not viewport coverage or a union across layers.",
          "Metadata queries run before/after paint collection and may race layer/node removal; unavailable entries retain their reported geometry. Caller must settle the action before finish.",
          "LayerTree/CSS instrumentation is diagnostic overhead. Use a separate uninstrumented run for timing claims.",
          "A discarded screenshot requests the initial compositor inventory on an idle headless page before the action window.",
          "Some Chromium builds update paintCount without emitting layerPainted events. Zero recorded events does not prove no paint; compare retained-layer paintCount and trace Paint events. Newly created/removed layers are excluded from the paintCount delta.",
        ],
      };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      paints = undefined;
      session.off("LayerTree.layerTreeDidChange", collectLayers);
      session.off("LayerTree.layerPainted", collectPaint);
      await session.detach();
    },
  };
}
