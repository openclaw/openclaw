import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import postcss, { type Declaration, type Root, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import type { IconFixture } from "./control-ui-icon-fixtures.mts";

type IconGridFinding = {
  file: string;
  line: number;
  selector: string;
  kind: "overflow" | "native-padding";
  control: string;
  axis: "width" | "height";
  size: number;
  padding: number | null;
  border: number;
  icon: number;
  available: number | null;
};
const geometry =
  /^(?:display|box-sizing|(?:min-|max-)?(?:width|height)|padding(?:-.+)?|border(?:-.+)?|(?:place|align|justify)-(?:items|content|self)|grid(?:-.+)?|gap|position|transform|margin(?:-.+)?)$/u;

function px(value: string): number | undefined {
  if (value === "0" || value === "0px") {
    return 0;
  }
  return /^\d+(?:\.\d+)?px$/u.test(value) ? Number.parseFloat(value) : undefined;
}

const relevantGeometry =
  /^(?:all|display|box-sizing|(?:min-|max-)?(?:width|height|inline-size|block-size)|padding(?:-.+)?|border(?:-(?:width|style|top|right|bottom|left|inline.*|block.*)(?:-(?:width|style))?)?|(?:place|align|justify)-(?:items|content|self)|grid(?:-.+)?|position|transform|translate|scale|rotate|zoom|writing-mode|direction|margin(?:-.+)?|content)$/u;

type GeometryRule = {
  selectors: string[];
  potentialSelectors: string[];
  classes: Set<string>;
  attributes: Set<string>;
  ids: boolean;
  tags: Set<string>;
  universal: boolean;
  conditional: boolean;
  declarations: Declaration[];
};

function geometryRules(root: Root): GeometryRule[] {
  const rules = new Map<Rule, GeometryRule>();
  root.walkDecls((declaration) => {
    if (!relevantGeometry.test(declaration.prop)) {
      return;
    }
    let ancestor = declaration.parent;
    while (ancestor && ancestor.type !== "root") {
      if (ancestor.type === "atrule" && ancestor.name.endsWith("keyframes")) {
        return;
      }
      ancestor = ancestor.parent;
    }
    let owner = declaration.parent;
    while (owner && owner.type !== "rule" && owner.type !== "root") {
      owner = owner.parent;
    }
    if (!owner || owner.type !== "rule") {
      return;
    }
    let fact = rules.get(owner);
    if (!fact) {
      fact = {
        selectors: owner.selectors,
        potentialSelectors: [],
        classes: new Set(),
        attributes: new Set(),
        ids: false,
        tags: new Set(),
        universal: false,
        conditional: owner.parent?.type !== "root",
        declarations: [],
      };
      let contextSelectors = [...owner.selectors];
      let parent = owner.parent;
      while (parent && parent.type !== "root") {
        if (parent.type === "rule") {
          contextSelectors = parent.selectors.flatMap((prefix) =>
            contextSelectors.map((child) => {
              let nested = false;
              const parsed = selectorParser((tree) =>
                tree.walkNesting((node) => {
                  nested = true;
                  node.replaceWith(
                    ...selectorParser()
                      .astSync(prefix)
                      .nodes[0]!.nodes.map((part) => part.clone()),
                  );
                }),
              ).processSync(child);
              return nested ? parsed : prefix + " " + child;
            }),
          );
        }
        parent = parent.parent;
      }
      fact.selectors = contextSelectors;
      for (const selector of contextSelectors) {
        const parsed = selectorParser().astSync(selector);
        parsed.walkClasses((node) => {
          fact!.classes.add(node.value);
        });
        parsed.walkIds(() => {
          fact!.ids = true;
        });
        parsed.walkTags((node) => {
          fact!.tags.add(node.value.toLowerCase());
        });
        parsed.walkUniversals(() => {
          fact!.universal = true;
        });
        parsed.walkAttributes((node) => {
          fact!.attributes.add(node.attribute.toLowerCase());
        });
        const potential = parsed.clone();
        potential.walkPseudos((node) => {
          const state = (value: string) =>
            !value.startsWith("::") && ![":root", ":is", ":where", ":not"].includes(value);
          let nestedState = false;
          if (node.value === ":not") {
            node.walkPseudos((child) => {
              if (state(child.value)) {
                nestedState = true;
              }
            });
          }
          if (state(node.value) || nestedState) {
            node.remove();
          }
        });
        fact.potentialSelectors.push(potential.toString().trim() || "*");
        parsed.walkPseudos((node) => {
          if (![":root", ":is", ":where", ":not"].includes(node.value)) {
            fact!.conditional = true;
          }
          if ([":enabled", ":disabled"].includes(node.value)) {
            fact!.attributes.add("disabled");
          }
          if (node.value === ":checked") {
            fact!.attributes.add("checked");
          }
        });
      }
      rules.set(owner, fact);
    }
    if (declaration.parent !== owner) {
      fact.conditional = true;
    }
    fact.declarations.push(declaration);
  });
  return [...rules.values()];
}

function matchesRule(
  element: Element,
  rule: GeometryRule,
  potential = false,
  dynamicAttributes: ReadonlySet<string> = new Set(),
): boolean {
  return (potential ? rule.potentialSelectors : rule.selectors).some((selector) => {
    try {
      let candidate = selector;
      if (
        potential &&
        ((rule.ids && dynamicAttributes.has("id")) ||
          [...rule.attributes].some((name) => dynamicAttributes.has(name)))
      ) {
        const tree = selectorParser().astSync(selector);
        const removeUnknown = (node: selectorParser.Node) => {
          const previous = node.prev(),
            next = node.next();
          if (
            (!previous || previous.type === "combinator") &&
            (!next || next.type === "combinator")
          ) {
            node.replaceWith(selectorParser.universal({ value: "*" }));
          } else {
            node.remove();
          }
        };
        tree.walkPseudos((node) => {
          if (node.value !== ":not") {
            return;
          }
          let unknown = false;
          node.walkAttributes((attribute) => {
            if (dynamicAttributes.has(attribute.attribute.toLowerCase())) {
              unknown = true;
            }
          });
          node.walkIds(() => {
            if (dynamicAttributes.has("id")) {
              unknown = true;
            }
          });
          if (unknown) {
            removeUnknown(node);
          }
        });
        tree.walkAttributes((node) => {
          if (dynamicAttributes.has(node.attribute.toLowerCase())) {
            removeUnknown(node);
          }
        });
        if (dynamicAttributes.has("id")) {
          tree.walkIds(removeUnknown);
        }
        candidate = tree.toString();
      }
      return element.matches(candidate);
    } catch {
      return false;
    }
  });
}

function knownDeclaration(declaration: Declaration): boolean {
  const { prop, value, important } = declaration;
  if (important) {
    return false;
  }
  if (
    /^(?:all|.*(?:inline|block)-size|border-(?:inline|block)|padding-(?:inline|block)|margin-(?:inline|block)|writing-mode|direction|zoom|translate|scale|rotate)/u.test(
      prop,
    )
  ) {
    return false;
  }
  if (prop === "box-sizing") {
    return value === "border-box";
  }
  if (/^(?:min-|max-)?(?:width|height)$/u.test(prop)) {
    return (
      px(value) !== undefined ||
      (prop.startsWith("min-") && value === "auto") ||
      (prop.startsWith("max-") && value === "none")
    );
  }
  if (
    /^(?:padding|margin)(?:-|$)/u.test(prop) ||
    /^border(?:-(?:top|right|bottom|left))?-width$/u.test(prop)
  ) {
    return value
      .trim()
      .split(/\s+/u)
      .every((part) => px(part) !== undefined || (prop.startsWith("margin") && part === "auto"));
  }
  if (/^border(?:-(?:top|right|bottom|left))?$/u.test(prop)) {
    return (
      /^(?:0|none)$/u.test(value) ||
      /^(?:\d+(?:\.\d+)?px|0)\s+(?:solid|dashed|dotted|double|groove|ridge|inset|outset)(?:\s|$)/u.test(
        value,
      )
    );
  }
  return !/var\(|inherit|initial|unset|revert/u.test(value);
}

function witnessIsUnresolved(
  control: Element,
  icon: Element,
  rules: GeometryRule[],
  otherRules: readonly GeometryRule[],
): boolean {
  if (control.hasAttribute("style") || icon.hasAttribute("style")) {
    return true;
  }
  const contextClasses = new Set([...control.classList, ...icon.classList]);
  const dynamicAttributes = new Set(
    control.getAttribute("data-icon-grid-dynamic")?.split(" ") ?? [],
  );
  const externalRule = otherRules.find(
    (rule) =>
      matchesRule(control, rule, true, dynamicAttributes) ||
      matchesRule(icon, rule, true, dynamicAttributes) ||
      [...rule.classes].some((name) => contextClasses.has(name)) ||
      (rule.conditional &&
        rule.classes.size === 0 &&
        (rule.universal || rule.tags.has(control.tagName.toLowerCase()) || rule.tags.has("svg"))),
  );
  if (externalRule) {
    return true;
  }
  for (const rule of rules) {
    const matches = matchesRule(control, rule) || matchesRule(icon, rule);
    const potential =
      matches ||
      matchesRule(control, rule, true, dynamicAttributes) ||
      matchesRule(icon, rule, true, dynamicAttributes) ||
      [...control.classList].some((name) => rule.classes.has(name)) ||
      (rule.classes.size === 0 &&
        (rule.universal || rule.tags.has(control.tagName.toLowerCase()) || rule.tags.has("svg")));
    if (!potential) {
      continue;
    }
    if (rule.conditional) {
      return true;
    }
    if (
      (rule.ids && dynamicAttributes.has("id")) ||
      [...rule.attributes].some((name) => dynamicAttributes.has(name))
    ) {
      return true;
    }
    if (matches && rule.declarations.some((declaration) => !knownDeclaration(declaration))) {
      return true;
    }
    if (
      rule.declarations.some(
        (declaration) =>
          declaration.prop === "content" && !["none", "normal"].includes(declaration.value),
      )
    ) {
      return true;
    }
  }
  return false;
}

function constrainedPx(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
  axis: "width" | "height",
): number | undefined {
  const size = px(style.getPropertyValue(axis));
  const minimum = style.getPropertyValue("min-" + axis);
  const maximum = style.getPropertyValue("max-" + axis);
  if (
    size === undefined ||
    (minimum && minimum !== "auto" && px(minimum) === undefined) ||
    (maximum && maximum !== "none" && px(maximum) === undefined)
  ) {
    return undefined;
  }
  return Math.max(px(minimum) ?? 0, Math.min(size, px(maximum) ?? Infinity));
}

function baselineCss(root: Root): string {
  const copy = root.clone();
  // A static witness cannot prove responsive/container/state conditions. Those need browser proof.
  copy.walkAtRules((rule) => {
    rule.remove();
  });
  copy.walkDecls((declaration) => {
    if (!geometry.test(declaration.prop)) {
      declaration.remove();
      return;
    }
    // jsdom does not resolve custom-property colors in border shorthands.
    // Preserve the authored geometric tokens, never its erroneous default width.
    if (/^border(?:-(?:top|right|bottom|left))?$/u.test(declaration.prop)) {
      const border =
        /^(\d+(?:\.\d+)?px|0)\s+(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/u.exec(
          declaration.value,
        );
      if (border) {
        declaration.value = border[1] + " " + border[2] + " transparent";
      }
    }
  });
  return copy.toString();
}

export function scanIconGridFit(
  css: string,
  fixtures: IconFixture[],
  baseCss = "",
  options: { trailingCss?: string; otherRules?: readonly GeometryRule[] } = {},
) {
  const root = postcss.parse(css);
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    virtualConsole: new VirtualConsole(),
  });
  const { document } = dom.window;
  const style = document.createElement("style");
  const sheets = [postcss.parse(baseCss), root, postcss.parse(options.trailingCss ?? "")];
  const rules = sheets.flatMap(geometryRules);
  style.textContent = sheets.map(baselineCss).join("\n");
  document.head.append(style);
  const findings: IconGridFinding[] = [];
  let checked = 0;
  let unresolved = 0;
  const selectors: string[] = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "root") {
      selectors.push(...rule.selectors);
    }
  });
  try {
    for (const fixture of fixtures) {
      document.body.innerHTML = fixture.html;
      for (const control of document.querySelectorAll<HTMLElement>("[data-icon-grid-control]")) {
        // Only the owning sheet participates; a global .btn rule alone is not a target.
        const matched = selectors.filter((selector) => {
          try {
            return control.matches(selector);
          } catch {
            return false;
          }
        });
        if (matched.length === 0) {
          continue;
        }
        const icon = control.querySelector("svg");
        if (!icon) {
          continue;
        }
        const box = dom.window.getComputedStyle(control);
        if (!/^(?:inline-)?grid$/u.test(box.display) || box.boxSizing !== "border-box") {
          continue;
        }
        if (
          box.position === "absolute" ||
          box.position === "fixed" ||
          (box.transform && box.transform !== "none")
        ) {
          unresolved += 2;
          continue;
        }
        if (witnessIsUnresolved(control, icon, rules, options.otherRules ?? [])) {
          unresolved += 2;
          continue;
        }
        const glyph = dom.window.getComputedStyle(icon);
        if (
          glyph.display === "none" ||
          glyph.display === "contents" ||
          glyph.position === "absolute" ||
          glyph.position === "fixed" ||
          !["", "auto", "normal", "center"].includes(glyph.alignSelf) ||
          !["", "auto", "normal", "center"].includes(glyph.justifySelf) ||
          (glyph.transform && glyph.transform !== "none") ||
          ["left", "right", "top", "bottom"].some((side) => {
            const margin = glyph.getPropertyValue("margin-" + side);
            return margin !== "" && px(margin) !== 0;
          })
        ) {
          unresolved += 2;
          continue;
        }
        const centered = box.placeItems === "center";
        const paddingProperties = new Set(
          rules
            .filter((rule) => !rule.conditional && matchesRule(control, rule))
            .flatMap((rule) =>
              rule.declarations
                .filter((declaration) => /^padding(?:-|$)/u.test(declaration.prop))
                .map((declaration) => declaration.prop),
            ),
        );
        for (const axis of ["width", "height"] as const) {
          const horizontal = axis === "width";
          const sides = horizontal ? ["left", "right"] : ["top", "bottom"];
          const tracks = horizontal ? box.gridTemplateColumns : box.gridTemplateRows;
          const autoTracks = horizontal ? box.gridAutoColumns : box.gridAutoRows;
          const content = horizontal ? box.justifyContent : box.alignContent;
          const items = horizontal ? box.justifyItems : box.alignItems;
          if (
            (!centered && items !== "center") ||
            (tracks && tracks !== "none") ||
            (autoTracks && autoTracks !== "auto") ||
            !["", "normal", "stretch", "start"].includes(content)
          ) {
            continue;
          }
          const size = constrainedPx(box, axis);
          const padding = sides.map((side) => px(box.getPropertyValue("padding-" + side)));
          const border = sides.map((side) => {
            const borderStyle = box.getPropertyValue("border-" + side + "-style");
            return !borderStyle || borderStyle === "none" || borderStyle === "hidden"
              ? 0
              : px(box.getPropertyValue("border-" + side + "-width"));
          });
          const iconSize = constrainedPx(glyph, axis);
          if (
            size === undefined ||
            iconSize === undefined ||
            padding.some((v) => v === undefined) ||
            border.some((v) => v === undefined)
          ) {
            unresolved++;
            continue;
          }
          const pad = padding.reduce<number>((sum, value) => sum + (value ?? 0), 0);
          const edge = border.reduce<number>((sum, value) => sum + (value ?? 0), 0);
          checked++;
          const available = size - pad - edge;
          const nativePadding =
            control.tagName === "BUTTON" &&
            !paddingProperties.has("padding") &&
            !sides.every((side) => paddingProperties.has("padding-" + side));
          if (nativePadding || iconSize > available + 0.01) {
            findings.push({
              file: fixture.file,
              line: fixture.line,
              selector: matched.at(-1)!,
              kind: nativePadding ? "native-padding" : "overflow",
              control: control.className || control.tagName.toLowerCase(),
              axis,
              size,
              padding: nativePadding ? null : pad,
              border: edge,
              icon: iconSize,
              available: nativePadding ? null : available,
            });
          }
        }
      }
    }
  } finally {
    dom.window.close();
  }
  return { findings, checked, unresolved };
}

export function selectIconFixtures(css: string, fixtures: IconFixture[]): IconFixture[] {
  if (!/display:\s*(?:inline-)?grid/u.test(css)) {
    return [];
  }
  const classes = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.([-_a-zA-Z][-_a-zA-Z0-9]*)/gu)) {
      classes.add(match[1]!);
    }
  });
  return fixtures.filter(
    (fixture) => classes.size === 0 || [...classes].some((name) => fixture.html.includes(name)),
  );
}

/** Preserve global order and conservatively defer controls with geometry owned by another sheet. */
export function createIconStyleContext(rootDir: string) {
  const cache = new Map<string, { source: string; rules: GeometryRule[] }>();
  return (target: string) => {
    const sourceRoot = path.join(rootDir, "ui/src");
    const baseFile = path.join(sourceRoot, "styles/base.css");
    const componentFile = path.join(sourceRoot, "styles/components.css");
    const base = fs.readFileSync(baseFile, "utf8");
    const components = fs.readFileSync(componentFile, "utf8");
    const file = path.resolve(target);
    const otherRules: GeometryRule[] = [];
    const seen = new Set<string>();
    for (const relative of fs.readdirSync(sourceRoot, { recursive: true }).map(String)) {
      if (!relative.endsWith(".css")) {
        continue;
      }
      const sibling = path.join(sourceRoot, relative);
      seen.add(sibling);
      if ([file, baseFile, componentFile].includes(sibling)) {
        continue;
      }
      const source = fs.readFileSync(sibling, "utf8");
      let entry = cache.get(sibling);
      if (entry?.source !== source) {
        entry = { source, rules: geometryRules(postcss.parse(source)) };
        cache.set(sibling, entry);
      }
      otherRules.push(...entry.rules);
    }
    for (const sibling of cache.keys()) {
      if (!seen.has(sibling)) {
        cache.delete(sibling);
      }
    }
    return {
      baseCss: file === baseFile ? "" : file === componentFile ? base : base + "\n" + components,
      trailingCss: file === baseFile ? components : "",
      otherRules,
    };
  };
}
