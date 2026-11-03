function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid-json-object");
  }
  return value;
}

// XCTest identifies class/test(); the UI bundle ancestry supplies the target.
export function requireExactTestResults(value, expectedIds) {
  const cases = [];
  const visit = (entry, bundle) => {
    const node = object(entry);
    const owner =
      node.nodeType === "UI test bundle"
        ? typeof node.name === "string"
          ? node.name
          : undefined
        : node.nodeType === "Unit test bundle"
          ? undefined
          : bundle;
    if (node.nodeType === "Test Case") {
      cases.push({ node, bundle: owner });
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) {
        throw new Error("invalid-test-children");
      }
      node.children.forEach((child) => visit(child, owner));
    }
  };
  const roots = object(value).testNodes;
  if (!Array.isArray(roots)) {
    throw new Error("missing-test-nodes");
  }
  roots.forEach((node) => visit(node));
  if (cases.some(({ node }) => node.result === "Skipped")) {
    throw new Error("test-skipped");
  }
  if (cases.length !== expectedIds.length) {
    throw new Error("test-identity-or-result");
  }
  const remaining = new Set(expectedIds.map((identifier) => `${identifier}()`));
  for (const { node, bundle } of cases) {
    if (!remaining.delete(`${bundle}/${node.nodeIdentifier}`) || node.result !== "Passed") {
      throw new Error("test-identity-or-result");
    }
  }
  for (const { node } of cases) {
    let repetitions = 0;
    let runs = 0;
    const checkRuns = (entry) => {
      if (entry.nodeType === "Repetition") {
        repetitions++;
      }
      if (entry.nodeType === "Test Case Run") {
        runs++;
      }
      if (entry.result !== undefined && entry.result !== "Passed") {
        throw new Error("failed-test-child");
      }
      entry.children?.forEach(checkRuns);
    };
    checkRuns(node);
    if (repetitions > 1 || runs > 1) {
      throw new Error("repeated-test");
    }
  }
  return expectedIds.map((testIdentifier) => ({ testIdentifier, testResult: "Passed" }));
}
