/** One-shot diagnostic: serialize into the browser; DOM updates never prove speech. */
export function createControlUiLiveRegionAudit() {
  type Changes = { textMutations: number; addedNodes: number };
  type Aria = Record<"live" | "atomic" | "relevant" | "busy", string | null>;
  const samples: Array<
    Changes & {
      atMs: number;
      regionId: number;
      region: string;
      role: string | null;
      raw: Aria;
      effective: Aria;
      ancestorLiveOff: boolean;
      hiddenByAttribute: boolean;
      textLength: number;
      textSample: string;
    }
  > = [];
  const counts = {
    mutationRecords: 0,
    textMutations: 0,
    addedNodes: 0,
    removedNodes: 0,
    unscopedChanges: 0,
    regionDeliveries: 0,
    regionsSeen: 0,
  };
  const identities = new WeakMap<Element, number>();
  let phase: "ready" | "active" | "finished" = "ready";
  let startedAt = 0;
  const implicitLive = (element: Element) => {
    const role = element.getAttribute("role")?.split(/\s+/u)[0];
    return role === "alert" ? "assertive" : role === "status" || role === "log" ? "polite" : null;
  };
  const inherited = (element: Element | null, attribute: string): string | null => {
    for (let current = element; current; current = current.parentElement) {
      const value = current.getAttribute(attribute);
      if (value !== null) {
        return value;
      }
    }
    return null;
  };
  const nearestRegion = (node: Node): Element | null => {
    for (
      let element = node instanceof Element ? node : node.parentElement;
      element;
      element = element.parentElement
    ) {
      if (element.hasAttribute("aria-live") || implicitLive(element)) {
        return element;
      }
    }
    return null;
  };
  const collect = (records: MutationRecord[]) => {
    const changed = new Map<Element, Changes>();
    const remember = (region: Element | null, textMutations: number, addedNodes: number) => {
      if (!region) {
        counts.unscopedChanges++;
        return;
      }
      const entry = changed.get(region) ?? { textMutations: 0, addedNodes: 0 };
      entry.textMutations += textMutations;
      entry.addedNodes += addedNodes;
      changed.set(region, entry);
    };
    for (const record of records.toReversed()) {
      counts.mutationRecords++;
      if (record.type === "characterData") {
        if (record.target.nodeType !== Node.TEXT_NODE) {
          continue;
        }
        counts.textMutations++;
        remember(nearestRegion(record.target), 1, 0);
        continue;
      }
      counts.addedNodes += record.addedNodes.length;
      counts.removedNodes += record.removedNodes.length;
      const additions = [...record.addedNodes].filter(
        (node) =>
          node instanceof Element ||
          (node.nodeType === Node.TEXT_NODE && Boolean(node.textContent)),
      );
      if (!additions.length) {
        continue;
      }
      const regions = new Set<Element>();
      for (const node of additions) {
        const region = nearestRegion(node) ?? nearestRegion(record.target);
        if (region) {
          regions.add(region);
        }
        if (node instanceof Element) {
          for (const child of node.querySelectorAll("[aria-live], [role]")) {
            if (child.hasAttribute("aria-live") || implicitLive(child)) {
              regions.add(child);
            }
          }
        }
      }
      if (!regions.size) {
        counts.unscopedChanges++;
      }
      for (const region of regions) {
        remember(region, 0, additions.length);
      }
    }
    const atMs = performance.now() - startedAt;
    for (const [element, change] of changed) {
      const read = (inherit: boolean): Aria => {
        const attr = (name: string) =>
          inherit ? inherited(element, name) : element.getAttribute(name);
        return {
          live: attr("aria-live") ?? (inherit ? implicitLive(element) : null),
          atomic: attr("aria-atomic"),
          relevant: attr("aria-relevant"),
          busy: attr("aria-busy"),
        };
      };
      let regionId = identities.get(element);
      if (regionId === undefined) {
        regionId = ++counts.regionsSeen;
        identities.set(element, regionId);
      }
      const region = [element.localName, element.id, element.getAttribute("class")]
        .filter(Boolean)
        .join(" ")
        .slice(0, 240);
      const text = element.textContent ?? "";
      counts.regionDeliveries++;
      // Keep the beginning and completion of a long stream within 200 records.
      if (samples.length === 200) {
        samples.splice(100, 1);
      }
      samples.push({
        ...change,
        atMs,
        regionId,
        region,
        role: element.getAttribute("role"),
        raw: read(false),
        effective: read(true),
        ancestorLiveOff: inherited(element.parentElement, "aria-live") === "off",
        hiddenByAttribute: Boolean(element.closest('[hidden], [inert], [aria-hidden="true"]')),
        textLength: text.length,
        textSample: text.slice(0, /[\uD800-\uDBFF]/u.test(text.charAt(499)) ? 499 : 500),
      });
    }
  };
  const observer = new MutationObserver(collect);
  return {
    start() {
      if (phase !== "ready") {
        throw new Error("Live-region audit is one-shot");
      }
      phase = "active";
      startedAt = performance.now();
      observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    },
    finish() {
      if (phase !== "active") {
        throw new Error("Live-region audit is not active");
      }
      collect(observer.takeRecords());
      observer.disconnect();
      phase = "finished";
      return {
        semantics:
          "Raw DOM updates, not spoken announcements. ARIA metadata is read at mutation delivery; effective values use the nearest explicit ancestor, then basic role live defaults. No CSS, shadow-root, or assistive-technology simulation.",
        elapsedMs: performance.now() - startedAt,
        counts,
        samples,
        omittedSamples: Math.max(0, counts.regionDeliveries - samples.length),
      };
    },
  };
}

export type ControlUiLiveRegionAudit = ReturnType<
  ReturnType<typeof createControlUiLiveRegionAudit>["finish"]
>;
