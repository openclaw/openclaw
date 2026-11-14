import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { button, el } from "./page-dom.js";
import { icon as glyph, type IconName } from "./ui-icons.js";

type Ontology = FeatureOutput<typeof contract, "ontology"> & {
  definitions: NonNullable<FeatureOutput<typeof contract, "ontology">["definitions"]>;
};
type Definition = Ontology["definitions"][number];
type Category = { id: string; label: string; subtitle: string; icon: IconName };
const categories: Category[] = [
  {
    id: "entity",
    label: "People & things",
    subtitle: "The people and organizations that make up your world.",
    icon: "users",
  },
  {
    id: "concept",
    label: "Ideas & projects",
    subtitle: "What you’re thinking about, learning, and working toward.",
    icon: "spark",
  },
  {
    id: "media",
    label: "Sources & writing",
    subtitle: "What you read, watch, create, and draw knowledge from.",
    icon: "fileText",
  },
  {
    id: "temporal",
    label: "Events & conversations",
    subtitle: "What happened, what was said, and how things unfold.",
    icon: "calendarClock",
  },
  {
    id: "annotation",
    label: "Annotations",
    subtitle: "Small observations that add context to the bigger picture.",
    icon: "pencil",
  },
];
const relationshipGroups: (Category & { names: string[] })[] = [
  {
    id: "people",
    label: "People & responsibility",
    subtitle: "How people and organizations work together.",
    icon: "users",
    names: ["partner_of", "founded", "works_at", "invested_in", "advises", "leads", "supports"],
  },
  {
    id: "references",
    label: "Connections & references",
    subtitle: "What a page connects to, mentions, or discusses.",
    icon: "link",
    names: ["relates_to", "mentions", "discusses"],
  },
  {
    id: "origins",
    label: "Sources & authorship",
    subtitle: "Where knowledge comes from and who contributed it.",
    icon: "fileText",
    names: ["sourced_from", "derived_from", "authored", "attributed_to"],
  },
  {
    id: "participation",
    label: "Participation & follow-up",
    subtitle: "Who was there, what is owed, and who you’re waiting on.",
    icon: "calendarClock",
    names: ["attended", "owes_to", "awaiting_reply_from"],
  },
  {
    id: "history",
    label: "Changes over time",
    subtitle: "How pages replace or point toward one another.",
    icon: "clock",
    names: ["supersedes", "redirects_to"],
  },
  {
    id: "other",
    label: "Other connections",
    subtitle: "Additional relationships in your vocabulary.",
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
      el("h2", "Your ontology is unavailable"),
      el(
        "p",
        "Your records are still readable, but their types can’t be checked until the ontology is fixed.",
      ),
      button("Review issues", browseIssues, ""),
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
        `${data.totalIssues} ${data.totalIssues === 1 ? "issue needs" : "issues need"} attention in this vault.`,
      ),
      button("Review issues", browseIssues, ""),
    );
    root.append(notice);
  }
  const controls = el("div", undefined, "knowledge-ontology-controls"),
    switcher = el("div", undefined, "knowledge-ontology-switch");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", "Ontology vocabulary");
  let mode: "page" | "relationship" = "page",
    selected = "all";
  const pageButton = button("Page types", () => switchMode("page"), ""),
    relationshipButton = button("Relationships", () => switchMode("relationship"), "");
  switcher.append(pageButton, relationshipButton);
  controls.append(switcher);
  const layout = el("div", undefined, "knowledge-ontology-layout"),
    navigation = el("nav", undefined, "knowledge-category-nav"),
    body = el("div", undefined, "knowledge-ontology-body");
  navigation.setAttribute("aria-label", "Ontology categories");
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
    details.append(el("summary", "Explore type"));
    if (d.kind === "relationship") {
      const label = (names: string[]) =>
        names.length
          ? names
              .map((name) => data.definitions.find((x) => x.name === name)?.label ?? name)
              .join(" or ")
          : "Any page";
      const endpoints = el("div", undefined, "knowledge-endpoints");
      endpoints.append(
        el("span", label(d.fromTypes ?? [])),
        el("span", "→"),
        el("span", label(d.toTypes ?? [])),
      );
      details.append(endpoints);
    }
    if (d.fields?.length) {
      details.append(el("h5", "Details you can add"));
      const fields = el("ul", undefined, "knowledge-type-fields");
      for (const field of d.fields) {
        const item = el("li");
        item.append(
          el("strong", field.label),
          el("span", field.required ? "Required" : "Optional", "knowledge-field-presence"),
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
        el("h5", "Search terms"),
        el(
          "p",
          "These terms also find this type. They aren’t separate types or roles.",
          "knowledge-alias-help",
        ),
      );
      const tags = el("div", undefined, "knowledge-type-tags");
      for (const alias of d.aliases) {
        tags.append(el("span", alias.replaceAll("-", " ")));
      }
      details.append(tags);
    }
    details.append(el("h5", "In your vault"));
    if (d.recordCount) {
      const records = el("div", undefined, "knowledge-type-records");
      for (const record of d.records ?? []) {
        records.append(button(record.title, () => openRecord(record.id), ""));
      }
      if (d.recordsTruncated) {
        records.append(
          el("p", "Showing the first 20 records. Filter Records by this type to browse all."),
        );
      }
      details.append(records);
    } else {
      details.append(el("p", "No records of this type yet."));
    }
    const count = d.recordCount;
    const footer = el("div", undefined, "knowledge-type-footer");
    footer.append(
      el(
        "span",
        `${count} ${count === 1 ? "record" : "records"}`,
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
    for (const group of [
      { id: "all", label: "All categories", icon: "book" as const },
      ...groups,
    ]) {
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
        el("span", group.label),
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
      title.append(el("h3", group.label), el("p", group.subtitle));
      heading.append(icon, title, el("span", String(items.length), "knowledge-group-count"));
      const grid = el("div", undefined, "knowledge-type-grid");
      for (const d of items) {
        grid.append(card(d));
      }
      section.append(heading, grid);
      body.append(section);
    }
    matchStatus.textContent = `${shown} ${mode === "page" ? "page types" : "relationships"} shown`;
    if (!shown) {
      const empty = el("div", undefined, "knowledge-ontology-empty");
      empty.append(el("h3", "No types available"), el("p", "There are no types in this category."));
      body.append(empty);
    }
  }
  render();
  return root;
}
