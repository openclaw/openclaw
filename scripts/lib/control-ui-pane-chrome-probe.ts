/** Opt-in browser diagnostics, sampled by the existing warm-reload frame loop. */
export function installPaneChromeProbe() {
  const selectors = {
    headerTrailing: ".chat-pane__header-trailing",
    composerControls: ".chat-controls__session, .chat-controls__permission-picker",
    workspace: ".chat-pane__workspace-chip",
    details: ".chat-details",
  };
  type Region = keyof typeof selectors;
  type Signature = { nodes: number; hash: number; truncated: boolean };
  type Frame = { at: number; regions: Record<Region, Signature> };
  const frames: Frame[] = [];
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
      add(
        `<${element.localName}:${[...element.classList].filter((name) => !name.endsWith("--disabled")).join(".")}>`,
      );
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
      if (!dirty) {
        return;
      }
      dirty = false;
      const next = Object.fromEntries(
        regions.map((region) => [region, signature(region)]),
      ) as Frame["regions"];
      if (regions.every((region) => frames.at(-1)?.regions[region].hash === next[region].hash)) {
        return;
      }
      if (frames.length >= 256) {
        truncated = true;
        return;
      }
      frames.push({ at, regions: next });
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
        firstTranscriptPaint,
        changesAfterContent: firstTranscriptPaint === null ? null : changes.length,
        changes,
        frames,
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
