import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { t } from "./i18n/index.js";
import { button, el } from "./page-dom.js";
import { icon as glyph, type IconName } from "./ui-icons.js";

type Ontology = FeatureOutput<typeof contract, "ontology"> & {
  definitions: NonNullable<FeatureOutput<typeof contract, "ontology">["definitions"]>;
};
type Definition = Ontology["definitions"][number];
type Category = { id: string; icon: IconName };
const categories: Category[] = [
  {
    id: "entity",
    icon: "users",
  },
  {
    id: "concept",
    icon: "spark",
  },
  {
    id: "media",
    icon: "fileText",
  },
  {
    id: "temporal",
    icon: "calendarClock",
  },
  {
    id: "annotation",
    icon: "pencil",
  },
];
const relationshipGroups: (Category & { names: string[] })[] = [
  {
    id: "people",
    icon: "users",
    names: ["partner_of", "founded", "works_at", "invested_in", "advises", "leads", "supports"],
  },
  {
    id: "references",
    icon: "link",
    names: ["relates_to", "mentions", "discusses"],
  },
  {
    id: "origins",
    icon: "fileText",
    names: ["sourced_from", "derived_from", "authored", "attributed_to"],
  },
  {
    id: "participation",
    icon: "calendarClock",
    names: ["attended", "owes_to", "awaiting_reply_from"],
  },
  {
    id: "history",
    icon: "clock",
    names: ["supersedes", "redirects_to"],
  },
  {
    id: "other",
    icon: "spark",
    names: [],
  },
];

/** A human-facing projection of the shared contract; diagnostics remain in agent operations. */
export function ontologyView(
  data: Ontology,
  openRecord: (id: string) => void,
  browseIssues: () => void,
) {
  const root = el("div", undefined, "knowledge-ontology");
  if (!data.available) {
    root.append(
      el("h2", t("knowledge.ontology.unavailable")),
      el("p", t("knowledge.ontology.unavailableBody")),
      button(t("knowledge.ontology.reviewIssues"), browseIssues, ""),
    );
    return root;
  }
  const pages = data.definitions.filter((d) => d.kind === "page"),
    relationships = data.definitions.filter((d) => d.kind === "relationship");
  if (data.totalIssues) {
    const notice = el("div", undefined, "knowledge-ontology-notice");
    notice.append(
      el(
        "span",
        t(data.totalIssues === 1 ? "knowledge.ontology.issueOne" : "knowledge.ontology.issues", {
          count: String(data.totalIssues),
        }),
      ),
      button(t("knowledge.ontology.reviewIssues"), browseIssues, ""),
    );
    root.append(notice);
  }
  const controls = el("div", undefined, "knowledge-ontology-controls"),
    switcher = el("div", undefined, "knowledge-ontology-switch");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", t("knowledge.ontology.vocabulary"));
  let mode: "page" | "relationship" = "page",
    selected = "all";
  const pageButton = button(t("knowledge.ontology.pageTypes"), () => switchMode("page"), ""),
    relationshipButton = button(
      t("knowledge.ontology.relationships"),
      () => switchMode("relationship"),
      "",
    );
  switcher.append(pageButton, relationshipButton);
  controls.append(switcher);
  const layout = el("div", undefined, "knowledge-ontology-layout"),
    navigation = el("nav", undefined, "knowledge-category-nav"),
    body = el("div", undefined, "knowledge-ontology-body");
  navigation.setAttribute("aria-label", t("knowledge.ontology.categories"));
  const matchStatus = el("p", undefined, "knowledge-sr-only");
  matchStatus.setAttribute("role", "status");
  matchStatus.setAttribute("aria-live", "polite");
  layout.append(navigation, body);
  root.append(controls, matchStatus, layout);
  function switchMode(next: typeof mode) {
    mode = next;
    selected = "all";
    render();
  }
  function categoryOf(d: Definition) {
    return d.kind === "page"
      ? d.primitive
      : (relationshipGroups.find((g) => g.names.includes(d.name))?.id ?? "other");
  }
  function card(d: Definition) {
    const article = el("article", undefined, "knowledge-type-card");
    article.append(el("h4", d.label), el("p", d.description, "knowledge-type-description"));
    const details = el("details", undefined, "knowledge-type-details");
    details.append(el("summary", t("knowledge.ontology.explore")));
    if (d.kind === "relationship") {
      const label = (names: string[]) =>
        names.length
          ? names
              .map((name) => data.definitions.find((x) => x.name === name)?.label ?? name)
              .join(` ${t("knowledge.ontology.or")} `)
          : t("knowledge.ontology.anyPage");
      const endpoints = el("div", undefined, "knowledge-endpoints");
      endpoints.append(
        el("span", label(d.fromTypes ?? [])),
        el("span", "→"),
        el("span", label(d.toTypes ?? [])),
      );
      details.append(endpoints);
    }
    if (d.fields?.length) {
      details.append(el("h5", t("knowledge.ontology.fields")));
      const fields = el("ul", undefined, "knowledge-type-fields");
      for (const field of d.fields) {
        const item = el("li");
        item.append(
          el("strong", field.label),
          el(
            "span",
            t(field.required ? "knowledge.ontology.required" : "knowledge.ontology.optional"),
            "knowledge-field-presence",
          ),
        );
        if (field.values?.length) {
          item.append(el("p", field.values.join(" · ")));
        }
        fields.append(item);
      }
      details.append(fields);
    }
    if (d.aliases.length) {
      details.append(
        el("h5", t("knowledge.ontology.aliases")),
        el("p", t("knowledge.ontology.aliasesHelp"), "knowledge-alias-help"),
      );
      const tags = el("div", undefined, "knowledge-type-tags");
      for (const alias of d.aliases) {
        tags.append(el("span", alias.replaceAll("-", " ")));
      }
      details.append(tags);
    }
    details.append(el("h5", t("knowledge.ontology.inVault")));
    if (d.recordCount) {
      const records = el("div", undefined, "knowledge-type-records");
      for (const record of d.records ?? []) {
        records.append(button(record.title, () => openRecord(record.id), ""));
      }
      if (d.recordsTruncated) {
        records.append(el("p", t("knowledge.ontology.recordsLimit")));
      }
      details.append(records);
    } else {
      details.append(el("p", t("knowledge.ontology.noRecords")));
    }
    const count = d.recordCount;
    const footer = el("div", undefined, "knowledge-type-footer");
    footer.append(
      el(
        "span",
        t(count === 1 ? "knowledge.stores.recordOne" : "knowledge.stores.records", {
          count: count.toLocaleString(),
        }),
        count ? "knowledge-count-used" : "",
      ),
    );
    article.append(footer, details);
    return article;
  }
  function render() {
    pageButton.setAttribute("aria-pressed", String(mode === "page"));
    relationshipButton.setAttribute("aria-pressed", String(mode === "relationship"));
    const definitions = mode === "page" ? pages : relationships;
    const groups = (mode === "page" ? categories : relationshipGroups).filter((g) =>
      definitions.some((d) => categoryOf(d) === g.id),
    );
    const focused = document.activeElement;
    const activeNavigation =
      focused instanceof HTMLElement && navigation.contains(focused)
        ? focused.dataset.category
        : undefined;
    navigation.replaceChildren();
    body.replaceChildren();
    for (const group of [{ id: "all", icon: "book" as const }, ...groups]) {
      const count = definitions.filter(
        (d) => group.id === "all" || categoryOf(d) === group.id,
      ).length;
      const control = button(
        "",
        () => {
          selected = group.id;
          render();
        },
        "",
      );
      control.dataset.category = group.id;
      control.setAttribute("aria-pressed", String(selected === group.id));
      const icon = el("span", undefined, "knowledge-category-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.append(glyph(group.icon));
      control.append(
        icon,
        el(
          "span",
          group.id === "all"
            ? t("knowledge.ontology.allCategories")
            : t(`knowledge.ontology.${mode}.${group.id}.label`),
        ),
        el("span", String(count), "knowledge-category-count"),
      );
      navigation.append(control);
      if (activeNavigation === group.id) {
        control.focus();
      }
    }
    let shown = 0;
    for (const group of groups) {
      if (selected !== "all" && selected !== group.id) {
        continue;
      }
      const items = definitions.filter((d) => categoryOf(d) === group.id);
      if (!items.length) {
        continue;
      }
      shown += items.length;
      const section = el(
          "section",
          undefined,
          `knowledge-type-group knowledge-category-${group.id}`,
        ),
        heading = el("header", undefined, "knowledge-type-group-heading"),
        title = el("div");
      const icon = el("span", undefined, "knowledge-group-icon");
      icon.setAttribute("aria-hidden", "true");
      icon.append(glyph(group.icon));
      title.append(
        el("h3", t(`knowledge.ontology.${mode}.${group.id}.label`)),
        el("p", t(`knowledge.ontology.${mode}.${group.id}.subtitle`)),
      );
      heading.append(icon, title, el("span", String(items.length), "knowledge-group-count"));
      const grid = el("div", undefined, "knowledge-type-grid");
      for (const d of items) {
        grid.append(card(d));
      }
      section.append(heading, grid);
      body.append(section);
    }
    matchStatus.textContent = t(
      mode === "page"
        ? "knowledge.ontology.pageTypesShown"
        : "knowledge.ontology.relationshipsShown",
      { count: String(shown) },
    );
    if (!shown) {
      const empty = el("div", undefined, "knowledge-ontology-empty");
      empty.append(
        el("h3", t("knowledge.ontology.emptyTitle")),
        el("p", t("knowledge.ontology.emptyBody")),
      );
      body.append(empty);
    }
  }
  render();
  return root;
}
