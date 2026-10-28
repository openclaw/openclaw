import type { Page } from "./page-context.js";
import { button, chip, date, el, type Detail, type RecordDetail } from "./page-dom.js";

/** Load a claim's supersedes chain into `versions`, newest first, numbered from the original. */
export function claimVersions(ui: Page, r: RecordDetail, n: number, versions: HTMLElement) {
  const { feature, live, failure, open } = ui;
  return (async () => {
    type Version = NonNullable<Detail["record"]>;
    const found = new Map<string, Version>(),
      queue = [r.id];
    while (queue.length && found.size < 10) {
      const nextId = queue.shift()!;
      if (found.has(nextId)) {
        continue;
      }
      const version =
        nextId === r.id
          ? r
          : (
              await feature.invoke("record", {
                id: nextId,
                metadataView: "compact",
                maxChars: 4000,
              })
            ).record;
      if (!live(n)) {
        return;
      }
      if (!version) {
        continue;
      }
      found.set(nextId, version);
      for (const linked of [version.metadata?.supersedes, version.metadata?.superseded_by]) {
        if (linked && !found.has(linked)) {
          queue.push(linked);
        }
      }
    }
    // Walk forward from the oldest loaded version; anything off the chain follows.
    const oldest =
        [...found.values()].find(
          (v) => !v.metadata?.supersedes || !found.has(v.metadata.supersedes),
        ) ?? r,
      chain: Version[] = [];
    for (
      let v: Version | undefined = oldest;
      v && !chain.includes(v);
      v = v.metadata?.superseded_by ? found.get(v.metadata.superseded_by) : undefined
    ) {
      chain.push(v);
    }
    for (const v of found.values()) {
      if (!chain.includes(v)) {
        chain.push(v);
      }
    }
    // Numbers are only meaningful when the chain reaches the original.
    const numbered = !oldest.metadata?.supersedes;
    for (const [index, version] of [...chain.entries()].toReversed()) {
      const item = el("div", undefined, "knowledge-version"),
        number = el("code", numbered ? `v${index + 1}` : "·");
      number.title = `Record revision ${version.revision}`;
      item.append(
        number,
        button(version.body || version.title, () => open(version.id), "knowledge-quiet"),
        el(
          "small",
          `${version.lifecycle === "active" ? "Current · saved" : version.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"} ${version.metadata?.lifecycle_change?.at ? date(version.metadata.lifecycle_change.at) : version.recordedAt ? date(version.recordedAt) : "time not recorded"}`,
        ),
      );
      if (version.id === r.id) {
        item.classList.add("knowledge-version-viewing");
        item.append(chip("Viewing"));
      }
      versions.append(item);
    }
    if (queue.length) {
      versions.append(el("p", "Showing 10 linked versions. Open a version to continue."));
    }
  })().catch((error: unknown) => {
    if (live(n)) {
      versions.append(failure(error));
    }
  });
}
