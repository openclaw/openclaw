/** Diagnostic only: serialized into the production page by the engines harness. */
export function createControlUiMutationAudit() {
  let active = false;
  let attributes = 0;
  let unchangedAttributes = 0;
  let text = 0;
  let unchangedText = 0;
  let childLists = 0;
  let removedNodes = 0;
  let addedNodes = 0;
  const targets = new Map<string, { writes: number; unchanged: number }>();
  const removed = new Map<Node, string[]>();
  const added = new Map<Node, string[]>();
  const roots = new Set<Node>();
  const formatters: Record<string, number> = {};
  const restore: Array<() => void> = [];
  const signature = (node: Node) =>
    node instanceof Element ? node.outerHTML : `${node.nodeType}:${node.textContent}`;
  const label = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return element
      ? `${element.localName}${[...element.classList].map((name) => `.${name}`).join("")}`
      : node.nodeName;
  };
  const remember = (map: Map<Node, string[]>, node: Node) => {
    // Empty text and framework anchor comments have identical bytes without
    // representing a recreated row. Count their operations, not their identity.
    if (
      !(node instanceof Element) &&
      !(node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    ) {
      return;
    }
    const entries = map.get(node) ?? [];
    entries.push(signature(node));
    map.set(node, entries);
  };
  const observe = (root: Node) => {
    if (roots.has(root)) {
      return;
    }
    roots.add(root);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
    });
  };
  const discover = (node: Node) => {
    if (node instanceof Element && node.shadowRoot) {
      observe(node.shadowRoot);
      discover(node.shadowRoot);
    }
    for (const child of node.childNodes) {
      discover(child);
    }
  };
  const collect = (records: MutationRecord[]) => {
    // A later record's oldValue is the earlier write's new value. Comparing
    // every record with the final DOM would misclassify A -> B -> A as a no-op.
    const nextValues = new Map<Node, Map<string, string | null>>();
    for (const record of records.toReversed()) {
      if (record.type === "childList") {
        childLists++;
        removedNodes += record.removedNodes.length;
        addedNodes += record.addedNodes.length;
        for (const node of record.removedNodes) {
          remember(removed, node);
        }
        for (const node of record.addedNodes) {
          remember(added, node);
          discover(node);
        }
        continue;
      }
      const key =
        record.type === "attributes"
          ? `${record.attributeNamespace ?? ""}:${record.attributeName}`
          : "#text";
      const values = nextValues.get(record.target) ?? new Map<string, string | null>();
      const current = values.has(key)
        ? values.get(key)
        : record.type === "attributes"
          ? // SAFETY: Attribute mutation records always target an Element.
            (record.target as Element).getAttributeNS(
              record.attributeNamespace,
              record.attributeName!,
            )
          : record.target.nodeValue;
      values.set(key, record.oldValue);
      nextValues.set(record.target, values);
      const unchanged = current === record.oldValue;
      if (record.type === "attributes") {
        attributes++;
        unchangedAttributes += Number(unchanged);
      } else {
        text++;
        unchangedText += Number(unchanged);
      }
      const name = `${label(record.target)}@${key}`;
      const target = targets.get(name) ?? { writes: 0, unchanged: 0 };
      target.writes++;
      target.unchanged += Number(unchanged);
      targets.set(name, target);
    }
  };
  const observer = new MutationObserver(collect);
  // oxlint-disable-next-line typescript/unbound-method -- The wrapper forwards the original Element receiver.
  const nativeAttachShadow = Element.prototype.attachShadow;
  const attachShadow: typeof nativeAttachShadow = function (this: Element, options) {
    const root = nativeAttachShadow.call(this, options);
    if (active && options.mode === "open") {
      observe(root);
    }
    return root;
  };
  const countFormatter = (name: string) => {
    if (active) {
      formatters[name] = (formatters[name] ?? 0) + 1;
    }
  };
  const wrap = (prototype: object, name: string, category: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor) {
      return;
    }
    if (descriptor.get) {
      // oxlint-disable-next-line typescript/unbound-method -- Preserve the formatter receiver when invoking the native getter.
      const get = descriptor.get;
      const bound = new WeakMap<Function, Function>();
      Object.defineProperty(prototype, name, {
        ...descriptor,
        get() {
          const original: (...args: unknown[]) => unknown = get.call(this);
          let wrapper = bound.get(original);
          if (!wrapper) {
            wrapper = (...args: unknown[]) => {
              countFormatter(category);
              return original(...args);
            };
            bound.set(original, wrapper);
          }
          return wrapper;
        },
      });
    } else if (typeof descriptor.value === "function") {
      const original = descriptor.value;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value(this: unknown, ...args: unknown[]) {
          countFormatter(category);
          return original.apply(this, args);
        },
      });
    }
    restore.push(() => Object.defineProperty(prototype, name, descriptor));
  };
  // Install before application imports can retain a bound Intl.format function;
  // start() only opens the measured action window.
  for (const [name, prototype] of [
    ["DateTimeFormat", Intl.DateTimeFormat.prototype],
    ["NumberFormat", Intl.NumberFormat.prototype],
    ["RelativeTimeFormat", Intl.RelativeTimeFormat.prototype],
  ] as const) {
    for (const method of ["format", "formatToParts", "formatRange", "formatRangeToParts"]) {
      wrap(prototype, method, `Intl.${name}.${method}`);
    }
  }
  for (const method of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    wrap(Date.prototype, method, `Date.${method}`);
  }
  wrap(Number.prototype, "toLocaleString", "Number.toLocaleString");
  wrap(String.prototype, "localeCompare", "String.localeCompare");
  return {
    start() {
      active = true;
      Element.prototype.attachShadow = attachShadow;
      observe(document);
      discover(document);
    },
    finish() {
      collect(observer.takeRecords());
      observer.disconnect();
      active = false;
      Element.prototype.attachShadow = nativeAttachShadow;
      for (const undo of restore) {
        undo();
      }
      let movedIdentical = 0;
      const removedContent = new Map<string, number>();
      const addedContent = new Map<string, number>();
      const accumulate = (map: Map<string, number>, entries: string[]) => {
        for (const value of entries) {
          map.set(value, (map.get(value) ?? 0) + 1);
        }
      };
      for (const [node, entries] of removed) {
        const insertions = added.get(node) ?? [];
        for (const value of entries) {
          const index = insertions.indexOf(value);
          if (index < 0) {
            accumulate(removedContent, [value]);
          } else {
            movedIdentical++;
            insertions.splice(index, 1);
          }
        }
      }
      for (const entries of added.values()) {
        accumulate(addedContent, entries);
      }
      const recreatedIdentical = [...removedContent].reduce(
        (total, [value, count]) => total + Math.min(count, addedContent.get(value) ?? 0),
        0,
      );
      return {
        attributes,
        unchangedAttributes,
        text,
        unchangedText,
        childLists,
        removedNodes,
        addedNodes,
        movedIdentical,
        recreatedIdentical,
        valueNoopRatio:
          attributes + text ? (unchangedAttributes + unchangedText) / (attributes + text) : 0,
        noopOperationRatio:
          attributes + text + removedNodes + addedNodes
            ? (unchangedAttributes + unchangedText + recreatedIdentical * 2) /
              (attributes + text + removedNodes + addedNodes)
            : 0,
        observedRoots: roots.size,
        formatters,
        targets: [...targets]
          .map(([target, counts]) => ({
            target,
            writes: counts.writes,
            unchanged: counts.unchanged,
          }))
          .toSorted((a, b) => b.unchanged - a.unchanged)
          .slice(0, 30),
      };
    },
  };
}

export type ControlUiMutationAudit = ReturnType<
  ReturnType<typeof createControlUiMutationAudit>["finish"]
>;

declare global {
  interface Window {
    openclawMutationAudit?: ReturnType<typeof createControlUiMutationAudit>;
  }
}

/** Runs outside the measured action; includes caret/animation changes, not just application pixels. */
export async function compareControlUiScreenshots(input: { before: string; after: string }) {
  const pixels = await Promise.all(
    [input.before, input.after].map(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    }),
  );
  const [before, after] = pixels;
  if (before!.width !== after!.width || before!.height !== after!.height) {
    throw new Error("Mutation audit screenshots must have the same viewport");
  }
  let changedPixels = 0;
  for (let index = 0; index < before!.data.length; index += 4) {
    if (
      [0, 1, 2, 3].some(
        (channel) => Math.abs(before!.data[index + channel]! - after!.data[index + channel]!) > 8,
      )
    ) {
      changedPixels++;
    }
  }
  const totalPixels = before!.width * before!.height;
  return { changedPixels, totalPixels, changedPixelRatio: changedPixels / totalPixels };
}
