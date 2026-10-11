import { JSDOM } from "jsdom";
import type {
  BrowserAnnotationApi,
  BrowserAnnotationCommand,
  BrowserAnnotationState,
  BrowserAnnotationTarget,
} from "openclaw/plugin-sdk/browser-annotations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserAnnotationBootstrapSource } from "./annotation-bootstrap.js";

type AnnotationDocument = Document & {
  openclaw: { annotation: BrowserAnnotationApi<Element> };
  oai: { annotation: BrowserAnnotationApi<Element> };
  __openclawAnnotationHost(command: BrowserAnnotationCommand): Promise<BrowserAnnotationState>;
};

const documents: JSDOM[] = [];
afterEach(() => {
  for (const dom of documents.splice(0)) {
    dom.window.close();
  }
});

function setup() {
  const dom = new JSDOM("<!doctype html><canvas aria-label='Game'></canvas>", {
    url: "https://example.test/",
    runScripts: "outside-only",
  });
  documents.push(dom);
  dom.window.eval(browserAnnotationBootstrapSource);
  const document = dom.window.document as AnnotationDocument;
  const canvas = document.querySelector("canvas")!;
  const activation = { isActive: true };
  Object.defineProperty(dom.window.navigator, "userActivation", { value: activation });
  canvas.getBoundingClientRect = () => new dom.window.DOMRect(10, 20, 160, 144);
  document.elementFromPoint = () => canvas;
  const dispatch = (command: BrowserAnnotationCommand) =>
    document.__openclawAnnotationHost(command);
  return { dom, document, canvas, activation, dispatch };
}

const target: BrowserAnnotationTarget = {
  id: "frame-1:sprite-2",
  name: "Player",
  role: "game-sprite",
  rect: { x: 20, y: 30, width: 8, height: 8 },
  metadata: { romSha256: "a".repeat(64), frame: 1, tile: 2 },
};

describe("page annotation SDK", () => {
  it.each(["openclaw", "oai"] as const)(
    "selects a virtual target and previews color through the %s API",
    async (namespace) => {
      const { document, canvas, dispatch } = setup();
      const api = document[namespace].annotation;
      const modeChanged = vi.fn();
      const controlChanged = vi.fn();
      document.addEventListener(`${namespace}annotationmodechange`, modeChanged);
      canvas.addEventListener(`${namespace}annotationcontrolchange`, controlChanged);
      const controls = api.registerControls({ targets: canvas, controls: [] });
      const renderSelection = vi.fn(({ selectedId }) => {
        controls.update({
          controlsHeading: "Player palette",
          controls: selectedId
            ? [{ type: "color", callback: "palette-0", currentValue: "#123456" }]
            : [],
        });
      });
      api.registerSurface({ element: canvas, hitTest: () => target, renderSelection });
      expect(api.toggle(true)).toEqual({ accepted: true });
      expect(modeChanged).toHaveBeenCalledOnce();
      expect(modeChanged.mock.calls[0]?.[0].target).toBe(document);
      const { documentId } = await dispatch({ action: "state" });
      const selected = await dispatch({ action: "select", documentId, clientX: 25, clientY: 35 });
      expect(selected.selection).toEqual({ ...target, surfaceId: "surface-1" });
      expect(selected.controls).toEqual([
        { type: "color", callback: "palette-0", currentValue: "#123456" },
      ]);
      await dispatch({
        action: "control",
        documentId,
        change: "preview",
        callback: "palette-0",
        value: "#fedcba",
        virtualTarget: { surfaceId: "surface-1", targetId: target.id },
      });
      expect(controlChanged).toHaveBeenCalledOnce();
      expect(controlChanged.mock.calls[0]?.[0].target).toBe(canvas);
      expect(controlChanged.mock.calls[0]?.[0].detail).toEqual({
        action: "preview",
        callback: "palette-0",
        value: "#fedcba",
        virtualTarget: { surfaceId: "surface-1", targetId: target.id },
      });
      expect(await dispatch({ action: "stop", documentId })).toMatchObject({
        active: false,
        selection: null,
        controls: [],
      });
      expect(renderSelection).toHaveBeenLastCalledWith({ selectedId: null, hoveredId: null });
      expect(modeChanged.mock.calls.at(-1)?.[0].detail).toEqual({ active: false });
    },
  );

  it("requires page user activation for entry, not exit, and keeps bootstrap idempotent", async () => {
    const { dom, document, canvas, activation, dispatch } = setup();
    activation.isActive = false;
    expect(document.openclaw.annotation.toggle(true)).toEqual({ accepted: false });
    expect(document.oai.annotation.request(canvas, { enterAnnotationMode: true })).toEqual({
      accepted: false,
    });
    activation.isActive = true;
    expect(
      document.oai.annotation.request(canvas, { metadata: { diagnostic: "example" } }),
    ).toEqual({
      accepted: true,
    });
    const before = await dispatch({ action: "state" });
    dom.window.eval(browserAnnotationBootstrapSource);
    expect(await dispatch({ action: "state" })).toEqual(before);
    activation.isActive = false;
    expect(document.oai.annotation.toggle(false)).toEqual({ accepted: true });
  });

  it.each(["invalidate", "dispose", "stop"] as const)(
    "cancels in-flight hit testing on %s and ignores its late answer",
    async (action) => {
      const { document, canvas, dispatch } = setup();
      let resolve!: (value: BrowserAnnotationTarget) => void;
      let signal!: AbortSignal;
      const renderSelection = vi.fn();
      const handle = document.openclaw.annotation.registerSurface({
        element: canvas,
        hitTest(point) {
          signal = point.signal;
          return new Promise((settle) => {
            resolve = settle;
          });
        },
        renderSelection,
      });
      document.openclaw.annotation.toggle(true);
      const { documentId } = await dispatch({ action: "state" });
      const pending = dispatch({ action: "select", documentId, clientX: 25, clientY: 35 });
      if (action === "stop") {
        await dispatch({ action, documentId });
      } else {
        handle[action]();
      }
      expect(signal.aborted).toBe(true);
      expect((await pending).selection).toBeNull();
      resolve(target);
      expect((await dispatch({ action: "state" })).selection).toBeNull();
      expect(renderSelection).not.toHaveBeenCalled();
    },
  );

  it("rejects stale document/target controls and clears detached selection", async () => {
    const { document, canvas, dispatch } = setup();
    const api = document.openclaw.annotation;
    api.registerSurface({ element: canvas, hitTest: () => target, renderSelection() {} });
    api.registerControls({
      targets: canvas,
      controls: [{ type: "color", callback: "palette-0", currentValue: "#123456" }],
    });
    api.toggle(true);
    const { documentId } = await dispatch({ action: "state" });
    await dispatch({ action: "select", documentId, clientX: 25, clientY: 35 });
    await expect(dispatch({ action: "stop", documentId: "old-document" })).rejects.toThrow(
      "document changed",
    );
    await expect(
      dispatch({
        action: "control",
        documentId,
        change: "preview",
        callback: "palette-0",
        value: "#fedcba",
        virtualTarget: { surfaceId: "surface-1", targetId: "old-frame:sprite-2" },
      }),
    ).rejects.toThrow("selection or control changed");
    canvas.remove();
    expect(await dispatch({ action: "state" })).toMatchObject({ selection: null, surfaceCount: 0 });
  });

  it("bounds page metadata and controls and survives throwing rendering callbacks", async () => {
    const { document, canvas, dispatch } = setup();
    document.openclaw.annotation.registerSurface({
      element: canvas,
      hitTest: () => ({ ...target, name: "x".repeat(1000), metadata: "x".repeat(5000) }),
      renderSelection() {
        throw new Error("page callback failed");
      },
    });
    document.openclaw.annotation.registerControls({
      targets: canvas,
      controls: Array.from({ length: 10 }, (_, index) => ({
        type: "color" as const,
        callback: `palette-${index}`,
        currentValue: index === 0 ? "not-a-color" : "#123456",
      })),
    });
    document.openclaw.annotation.toggle(true);
    const { documentId } = await dispatch({ action: "state" });
    const selected = await dispatch({ action: "select", documentId, clientX: 25, clientY: 35 });
    expect(selected.selection?.name).toHaveLength(160);
    expect(selected.selection?.metadata).toBeUndefined();
    expect(selected.controls).toHaveLength(4);
    expect(selected.controls[0]?.callback).toBe("palette-1");
    expect((await dispatch({ action: "stop", documentId })).active).toBe(false);
  });
});
