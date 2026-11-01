/** Opt-in browser diagnostics, sampled by the existing warm-reload frame loop. */
export function installPaneChromeProbe() {
  const selectors = {
    headerTrailing: ".chat-pane__header-trailing",
    headerIdentity: ".chat-pane__identity-actions",
    identity: ".chat-pane__crumbs",
    composerControls: ".chat-controls__session, .chat-controls__permission-picker",
    workspace: ".chat-pane__workspace-chip",
    details: ".chat-details",
    breadcrumb: ".chat-pane__parent-session",
    composerState: ".agent-chat__disabled-banner, .agent-chat__input",
  };
  type Region = keyof typeof selectors;
  type Signature = { nodes: number; hash: number; truncated: boolean };
  type Frame = {
    at: number;
    regions: Record<Region, Signature>;
    composerHeight: number;
    boxes: Record<Region, number[] | null>;
    paneFacts: { transcript: boolean; archivedFooter: boolean; genericComposer: boolean };
  };
  const frames: Frame[] = [];
  let connectionIndicatorFrames = 0;
  const detailsFrames: Array<{ at: number; sections: unknown[] }> = [];
  let detailsSignature = "";
  const sampleDetails = (at: number) => {
    const sections = Array.from(document.querySelectorAll(".chat-details[data-desktop]"))
      .filter((panel) => panel.getBoundingClientRect().width > 0 && !panel.closest("[inert]"))
      .flatMap((panel) =>
        Array.from(
          panel.querySelectorAll(
            "[data-details-group], [data-progress-card-placement='details'], [data-panel-skeleton]",
          ),
        ).map((section) => {
          const box = section.getBoundingClientRect();
          const panelBox = panel.getBoundingClientRect();
          return {
            section:
              section.getAttribute("data-details-group") ??
              section.getAttribute("data-progress-card-placement") ??
              "skeleton",
            top: Math.round(box.top - panelBox.top),
            left: Math.round(box.left - panelBox.left),
            width: Math.round(box.width),
            panelLeft: Math.round(panelBox.left),
            panelTop: Math.round(panelBox.top),
            panelWidth: Math.round(panelBox.width),
            height: Math.round(box.height),
            outputCount:
              section.querySelector(".chat-details-desktop-section__count")?.textContent?.trim() ??
              null,
            refresh: Boolean(section.querySelector(".task-progress-details__refresh")),
            titleMasks: Array.from(
              section.querySelectorAll(".chat-summary__automation-title"),
              (title) => getComputedStyle(title).maskImage,
            ),
            visible: box.height > 0 && box.top < panelBox.bottom && box.bottom > panelBox.top,
            nodes: section.querySelectorAll("*").length,
            images: Array.from(section.querySelectorAll("img")).map((image) => ({
              loaded: image.complete && image.naturalWidth > 0,
              src: image.getAttribute("src"),
            })),
          };
        }),
      );
    const nextSignature = JSON.stringify(sections);
    if (nextSignature !== detailsSignature && detailsFrames.length < 256) {
      detailsSignature = nextSignature;
      detailsFrames.push({ at, sections });
    }
  };
  const shifts: Array<{ at: number; value: number; regions: Region[] }> = [];
  const nodeRegions = new WeakMap<Node, Region>();
  const regions = Object.keys(selectors) as Region[];
  let dirty = true;
  let truncated = false;
  const observer = new MutationObserver(() => {
    dirty = true;
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  const signature = (region: Region): Signature => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const roots = (region === "details" ? document : pane)?.querySelectorAll(selectors[region]);
    let hash = 2166136261;
    let nodes = 0;
    let overflow = false;
    const add = (value: string) => {
      for (let index = 0; index < value.length; index++) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
      }
    };
    const visit = (element: Element) => {
      if (nodes >= 512) {
        overflow = true;
        return;
      }
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return;
      }
      nodes++;
      nodeRegions.set(element, region);
      add(`<${element.localName}:${element.classList.value}>`);
      if (element.matches(".chat-controls__inline-select-trigger")) {
        add(`${style.opacity}:${style.color}:${style.cursor}`);
      }
      if (element instanceof HTMLImageElement) {
        add(element.getAttribute("src") ?? "");
      }
      // SVG path count is implementation detail; the visible glyph is one node.
      if (element.localName === "svg") {
        add(element.innerHTML);
        return;
      }
      for (const node of element.childNodes) {
        if (node instanceof Element) {
          if (
            element instanceof HTMLDetailsElement &&
            !element.open &&
            node.localName !== "summary"
          ) {
            continue;
          }
          visit(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          add(node.textContent?.trim() ?? "");
        }
      }
      add("</>");
    };
    roots?.forEach(visit);
    return { nodes, hash, truncated: overflow };
  };
  const shiftObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & {
        hadRecentInput: boolean;
        value: number;
        sources: Array<{ node?: Node }>;
      };
      if (shift.hadRecentInput) {
        continue;
      }
      const affected = new Set<Region>();
      for (const { node } of shift.sources) {
        if (!node) {
          continue;
        }
        const element = node instanceof Element ? node : node.parentElement;
        const region =
          regions.find((key) => element?.closest(selectors[key])) ?? nodeRegions.get(node);
        if (region) {
          affected.add(region);
        }
      }
      if (affected.size) {
        shifts.push({ at: shift.startTime, value: shift.value, regions: [...affected] });
      }
    }
  });
  shiftObserver.observe({ type: "layout-shift", buffered: true });
  return {
    sample(at: number) {
      if (
        document
          .querySelector(".chat-pane-cache__pane--active .chat-pane__connection-state")
          ?.checkVisibility()
      ) {
        connectionIndicatorFrames++;
      }
      sampleDetails(at);
      const root = document.querySelector(".chat-pane-cache__pane--active");
      const boxes = Object.fromEntries(
        regions.map((region) => {
          const box = root?.querySelector(selectors[region])?.getBoundingClientRect();
          return [region, box ? [box.x, box.y, box.width, box.height] : null];
        }),
      ) as Frame["boxes"];
      const paneFacts = {
        transcript: Array.from(root?.querySelectorAll(".chat-virtual-row .chat-text") ?? []).some(
          (element) =>
            Boolean(element.textContent?.trim()) &&
            element.checkVisibility({ checkOpacity: true, visibilityProperty: true }),
        ),
        archivedFooter: Boolean(root?.querySelector(".agent-chat__disabled-banner--replacement")),
        genericComposer: Boolean(root?.querySelector(".agent-chat__input")),
      };
      const geometryChanged =
        JSON.stringify([boxes, paneFacts]) !==
        JSON.stringify([frames.at(-1)?.boxes, frames.at(-1)?.paneFacts]);
      if (!dirty && !geometryChanged) {
        return;
      }
      dirty = false;
      const next = Object.fromEntries(
        regions.map((region) => [region, signature(region)]),
      ) as Frame["regions"];
      if (
        !geometryChanged &&
        regions.every((region) => frames.at(-1)?.regions[region].hash === next[region].hash)
      ) {
        return;
      }
      if (frames.length >= 256) {
        truncated = true;
        return;
      }
      frames.push({
        at,
        regions: next,
        boxes,
        paneFacts,
        composerHeight:
          document
            .querySelector(".chat-pane-cache__pane--active .agent-chat__composer-shell")
            ?.getBoundingClientRect().height ?? 0,
      });
    },
    read(firstTranscriptPaint: number | null) {
      observer.disconnect();
      shiftObserver.disconnect();
      const changes = frames.flatMap((frame, index) => {
        const previous = frames[index - 1];
        if (!previous || firstTranscriptPaint === null || frame.at <= firstTranscriptPaint) {
          return [];
        }
        return [
          {
            at: frame.at,
            regions: regions.filter(
              (region) => previous.regions[region].hash !== frame.regions[region].hash,
            ),
          },
        ];
      });
      const afterContent = shifts.filter(
        (shift) => firstTranscriptPaint !== null && shift.at > firstTranscriptPaint,
      );
      return {
        connectionIndicatorFrames,
        firstTranscriptPaint,
        changesAfterContent: firstTranscriptPaint === null ? null : changes.length,
        changes,
        frames,
        detailsFrames,
        shifts,
        clsAfterContent: afterContent.reduce((sum, shift) => sum + shift.value, 0),
        byRegion: Object.fromEntries(
          regions.map((region) => [
            region,
            {
              changesAfterContent:
                firstTranscriptPaint === null
                  ? null
                  : changes.filter((change) => change.regions.includes(region)).length,
              clsAfterContent: afterContent
                .filter((shift) => shift.regions.includes(region))
                .reduce((sum, shift) => sum + shift.value, 0),
            },
          ]),
        ),
        truncated:
          truncated ||
          frames.some((frame) => regions.some((region) => frame.regions[region].truncated)),
      };
    },
  };
}
