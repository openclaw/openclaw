import { createHash } from "node:crypto";
import path from "node:path";
import selectorParser from "postcss-selector-parser";
import stylelint from "stylelint";

const ruleName = "openclaw/no-unindexed-selector-list";
const messages = stylelint.utils.ruleMessages(ruleName, {
  /**
   * @param {string} selector
   * @param {string} id
   */
  rejected: (selector, id) =>
    `Split the unkeyed rightmost selector list in "${selector}" into separately indexed selectors (id=${id})`,
  /**
   * @param {string} id
   * @param {number} observed
   * @param {number} allowed
   */
  stale: (id, observed, allowed) =>
    `Prune selector allowance ${id}: found ${observed}, recorded ${allowed}`,
});

const canonical = (selector) => selectorParser().processSync(selector, { lossless: false });

function subjectNodes(selector) {
  return selector.nodes.slice(
    selector.nodes.findLastIndex((node) => node.type === "combinator") + 1,
  );
}

function hasSubjectKey(nodes) {
  return nodes.some((node) => {
    if (["class", "id", "tag", "attribute", "nesting"].includes(node.type)) {
      return true;
    }
    return (
      node.type === "pseudo" &&
      [":is", ":where"].includes(node.value.toLowerCase()) &&
      node.nodes?.length === 1 &&
      hasSubjectKey(subjectNodes(node.nodes[0]))
    );
  });
}

// Plain, unescaped identifiers exclude malformed forgiving-list members and
// namespace syntax. Escaped identifiers remain untouched rather than guessed.
const identifier = /^(?:--|-?[_a-zA-Z\u0080-\uFFFF])[_a-zA-Z0-9\u0080-\uFFFF-]*$/u;
function simpleArm(arm) {
  // Keep this intervention on class/ID buckets; type and universal subjects
  // need their own byte/performance qualification.
  const nodes = arm.nodes.filter((node) => node.type !== "comment");
  if (!nodes.length || nodes.some((node) => !["class", "id"].includes(node.type))) {
    return false;
  }
  return nodes.every((node) => {
    if (!identifier.test(node.value)) {
      return false;
    }
    const prefix = node.type === "class" ? "." : "#";
    return node.toString().trim() === `${prefix}${node.value}`;
  });
}

function specificity(arm) {
  const value = [0, 0];
  for (const node of arm.nodes) {
    if (node.type === "id") {
      value[0]++;
    }
    if (node.type === "class") {
      value[1]++;
    }
  }
  return value.join(",");
}

function unindexedSelectorLists(text) {
  return selectorParser()
    .astSync(text)
    .nodes.filter((selector) => {
      const subject = subjectNodes(selector);
      if (hasSubjectKey(subject)) {
        return false;
      }
      return subject.some(
        (node) =>
          node.type === "pseudo" &&
          [":is", ":where"].includes(node.value.toLowerCase()) &&
          node.nodes?.length > 1 &&
          node.nodes.every(simpleArm) &&
          (node.value.toLowerCase() === ":where" ||
            node.nodes.every((arm) => specificity(arm) === specificity(node.nodes[0]))),
      );
    })
    .map((selector) => selector.toString());
}

const rule =
  (enabled, options = {}) =>
  (root, result) => {
    if (!stylelint.utils.validateOptions(result, ruleName, { actual: enabled, possible: [true] })) {
      return;
    }
    const filename = root.source?.input.file;
    const file = filename ? path.relative(process.cwd(), filename).split(path.sep).join("/") : "";
    const allowances = options.allowances?.[file] ?? {};
    const observed = new Map();
    root.walkRules((node) => {
      for (const selector of unindexedSelectorLists(node.selector)) {
        const context = [canonical(selector)];
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.type === "rule") {
            context.unshift(canonical(parent.selector));
          }
        }
        const id = createHash("sha256").update(JSON.stringify(context)).digest("hex");
        const count = (observed.get(id) ?? 0) + 1;
        observed.set(id, count);
        if (count <= (allowances[id] ?? 0)) {
          continue;
        }
        stylelint.utils.report({
          ruleName,
          result,
          node,
          message: messages.rejected(context.join(" / "), id),
          word: selector,
        });
      }
    });
    // Deletions reduce the allowance in the same change; an old count cannot be
    // reused by a later duplicate of the same selector. New selectors never borrow
    // another selector's or another file's allowance.
    for (const [id, count] of Object.entries(allowances)) {
      if ((observed.get(id) ?? 0) >= count) {
        continue;
      }
      stylelint.utils.report({
        ruleName,
        result,
        node: root,
        message: messages.stale(id, observed.get(id) ?? 0, count),
      });
    }
  };
rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = { url: "https://github.com/openclaw/openclaw/tree/main/config" };
export default stylelint.createPlugin(ruleName, rule);
