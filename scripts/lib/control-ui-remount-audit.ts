/** Harness-only DOM attachment census; serialize this function into the browser. */
export function createControlUiRemountAudit() {
  type Scope = { id: number; kind: string; label: string };
  type Snapshot = { id: number; label: string; elements: number; content: string; scopes: Scope[] };
  type Change = { added: boolean; node: Element; snapshot: Snapshot };
  const changes: Change[] = [];
  const identities = new WeakMap<Element, number>();
  const pending = new Map<Node, Snapshot>();
  const roots = new Set<Node>();
  const restore: Array<() => void> = [];
  let nextIdentity = 0;
  let active = false;
  let truncated = false;
  let addedSubtrees = 0;
  let removedSubtrees = 0;
  let addedElements = 0;
  let removedElements = 0;
  let attachments: Record<string, { added: number; removed: number }> = {};
  let before: Scope[] = [];
  const initialElements = new Set<number>();
  const identity = (element: Element) => {
    let value = identities.get(element);
    if (!value) {
      value = ++nextIdentity;
      identities.set(element, value);
    }
    return value;
  };
  const label = (element: Element) =>
    `${element.localName}${element.id ? `#${element.id}` : ""}${[...element.classList]
      .map((name) => `.${name}`)
      .join("")}`;
  const scope = (element: Element): Scope | undefined => {
    const kind = element.matches(".shell")
      ? "shell"
      : element.matches(".sidebar")
        ? "sidebar"
        : element.matches(".agent-chat__composer-shell")
          ? "composer"
          : element.matches(".chat-thread")
            ? "transcript"
            : /^openclaw-.*-page$/.test(element.localName) || element.matches(".settings-page")
              ? "page"
              : undefined;
    return kind ? { id: identity(element), kind, label: label(element) } : undefined;
  };
  const visit = (node: Node, callback: (element: Element) => void) => {
    if (node instanceof Element) {
      callback(node);
      if (node.shadowRoot) {
        visit(node.shadowRoot, callback);
      }
    }
    for (const child of node.childNodes) {
      visit(child, callback);
    }
  };
  const snapshot = (element: Element): Snapshot => {
    const scopes: Scope[] = [];
    let elements = 0;
    const detailed = changes.length < 512;
    let content = detailed ? element.outerHTML : "";
    visit(element, (child) => {
      elements++;
      const entry = scope(child);
      if (entry) {
        scopes.push(entry);
      }
      if (detailed && child.shadowRoot) {
        content += child.shadowRoot.innerHTML;
      }
    });
    // Content stays in-page and bounded; truncated snapshots never establish equality.
    if (content.length > 262_144) {
      truncated = true;
      content = "";
    }
    return { id: identity(element), label: label(element), elements, content, scopes };
  };
  const visibleScopes = () => {
    const result: Scope[] = [];
    visit(document, (element) => {
      const entry = scope(element);
      if (
        entry &&
        element.getClientRects().length &&
        !element.closest("[hidden], [inert]") &&
        (element.checkVisibility?.({ checkOpacity: true, visibilityProperty: true }) ?? true)
      ) {
        result.push(entry);
      }
    });
    return result;
  };
  const observe = (root: Node) => {
    if (!roots.has(root)) {
      roots.add(root);
      observer.observe(root, { childList: true, subtree: true });
    }
  };
  const discover = (node: Node) =>
    visit(node, (element) => {
      if (element.shadowRoot) {
        observe(element.shadowRoot);
      }
    });
  const collect = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const added of [false, true]) {
        for (const node of added ? record.addedNodes : record.removedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          if (added ? !node.isConnected : !pending.has(node) && !record.target.isConnected) {
            continue;
          }
          const captured = (!added && pending.get(node)) || snapshot(node);
          if (added) {
            addedSubtrees++;
            addedElements += captured.elements;
          } else {
            removedSubtrees++;
            removedElements += captured.elements;
          }
          for (const entry of captured.scopes) {
            const count = (attachments[entry.kind] ??= { added: 0, removed: 0 });
            count[added ? "added" : "removed"]++;
          }
          if (changes.length < 512) {
            changes.push({ added, node, snapshot: captured });
          } else {
            truncated = true;
          }
          if (added) {
            discover(node);
          }
        }
      }
    }
  };
  const observer = new MutationObserver(collect);
  // Flush before and after each operation: callbacks otherwise see already-emptied
  // removed subtrees, and an add/remove in one task loses its transient content.
  const intercept = (
    prototype: object,
    name: string,
    removals: (receiver: Node, args: unknown[]) => Node[],
    setter = false,
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    // oxlint-disable-next-line typescript/unbound-method -- The wrapper forwards the original native receiver.
    const original = setter ? descriptor?.set : descriptor?.value;
    if (typeof original !== "function") {
      return;
    }
    const wrapped = function (this: Node, ...args: unknown[]) {
      if (!active) {
        return original.apply(this, args);
      }
      collect(observer.takeRecords());
      for (const node of removals(this, args)) {
        if (node instanceof Element && node.isConnected) {
          pending.set(node, snapshot(node));
        }
      }
      try {
        return original.apply(this, args);
      } finally {
        collect(observer.takeRecords());
        pending.clear();
      }
    };
    Object.defineProperty(prototype, name, { ...descriptor, [setter ? "set" : "value"]: wrapped });
    restore.push(() => Object.defineProperty(prototype, name, descriptor!));
  };
  return {
    start() {
      if (active) {
        throw new Error("Remount audit is already active");
      }
      changes.length = 0;
      truncated = false;
      addedSubtrees = removedSubtrees = addedElements = removedElements = 0;
      attachments = {};
      roots.clear();
      initialElements.clear();
      visit(document, (element) => initialElements.add(identity(element)));
      before = visibleScopes();
      active = true;
      observe(document);
      discover(document);
      const argumentsAsNodes = (_receiver: Node, args: unknown[]) =>
        args.filter((value): value is Node => value instanceof Node);
      const children = (receiver: Node) => [...receiver.childNodes];
      for (const name of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
        intercept(Node.prototype, name, argumentsAsNodes);
      }
      for (const name of ["before", "after"]) {
        intercept(Element.prototype, name, argumentsAsNodes);
      }
      for (const prototype of [Element.prototype, DocumentFragment.prototype, Document.prototype]) {
        for (const name of ["append", "prepend"]) {
          intercept(prototype, name, argumentsAsNodes);
        }
        intercept(prototype, "replaceChildren", (receiver, args) => [
          ...children(receiver),
          ...argumentsAsNodes(receiver, args),
        ]);
      }
      for (const name of ["remove", "replaceWith"]) {
        intercept(Element.prototype, name, (receiver, args) => [
          receiver,
          ...argumentsAsNodes(receiver, args),
        ]);
      }
      intercept(Node.prototype, "textContent", children, true);
      intercept(Element.prototype, "innerHTML", children, true);
      intercept(Element.prototype, "outerHTML", (receiver) => [receiver], true);
      intercept(ShadowRoot.prototype, "innerHTML", children, true);
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow")!;
      Object.defineProperty(Element.prototype, "attachShadow", {
        ...descriptor,
        value(this: Element, options: ShadowRootInit) {
          const root: ShadowRoot = descriptor.value.call(this, options);
          if (options.mode === "open") {
            observe(root);
          }
          return root;
        },
      });
      restore.push(() => Object.defineProperty(Element.prototype, "attachShadow", descriptor));
    },
    finish() {
      collect(observer.takeRecords());
      observer.disconnect();
      active = false;
      for (const undo of restore.splice(0).toReversed()) {
        undo();
      }
      const after = visibleScopes();
      const matched = new Set<Change>();
      const pairs: Array<{ kind: "move" | "rebuild"; label: string; elements: number }> = [];
      for (const [index, removed] of changes.entries()) {
        if (removed.added) {
          continue;
        }
        const following = changes.slice(index + 1);
        const added =
          following.find(
            (change) =>
              change.added && !matched.has(change) && change.snapshot.id === removed.snapshot.id,
          ) ??
          changes.find(
            (change) =>
              change.added &&
              !matched.has(change) &&
              change.snapshot.id !== removed.snapshot.id &&
              removed.snapshot.content &&
              change.snapshot.content === removed.snapshot.content,
          );
        if (added) {
          matched.add(added);
          pairs.push({
            kind: added.snapshot.id === removed.snapshot.id ? "move" : "rebuild",
            label: removed.snapshot.label,
            elements: removed.snapshot.elements,
          });
        }
      }
      const final = new Set(after.map((entry) => entry.id));
      const transient = changes.filter(
        (change) =>
          change.added && !initialElements.has(change.snapshot.id) && !change.node.isConnected,
      );
      const result = {
        semantics:
          "Physical DOM attachment only; Solid owner mounts/disposals require lifecycle evidence.",
        attachments,
        before,
        after,
        retainedVisible: before.filter((entry) => final.has(entry.id)),
        pairs,
        transient: transient.map(({ snapshot: { label: name, elements, scopes } }) => ({
          label: name,
          elements,
          scopes,
        })),
        addedSubtrees,
        removedSubtrees,
        addedElements,
        removedElements,
        truncated,
      };
      changes.length = 0;
      initialElements.clear();
      return result;
    },
  };
}

export type ControlUiRemountAudit = ReturnType<
  ReturnType<typeof createControlUiRemountAudit>["finish"]
>;

declare global {
  interface Window {
    openclawRemountAudit?: ReturnType<typeof createControlUiRemountAudit>;
    openclawCreateRemountAudit?: typeof createControlUiRemountAudit;
  }
}
