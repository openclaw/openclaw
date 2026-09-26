type SourceTerm = { text: string; index: number; reference: boolean };

class SourceTermNode {
  readonly next = new Map<number, SourceTermNode>();
  readonly outputs: SourceTerm[] = [];
  failure: SourceTermNode = this;
}

function isReferenceCharacter(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 46 ||
    code === 64 ||
    code === 43 ||
    code === 47 ||
    code === 45
  );
}

/** Match literal terms and complete source tokens without rescanning once per term. */
export function createSourceTermMatcher(terms: readonly string[]) {
  const root = new SourceTermNode();
  const unique = new Map<string, SourceTerm>();
  let referenceCount = 0;
  const requested = terms.map((text) => {
    const existing = unique.get(text);
    if (existing) {
      return existing;
    }
    const term = {
      text,
      index: unique.size,
      reference: /^[A-Za-z0-9_.@+/-]{4,}$/u.test(text),
    };
    unique.set(text, term);
    referenceCount += Number(term.reference);
    let node = root;
    // String.includes and the source-token contract operate on UTF-16 code units.
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      let next = node.next.get(code);
      if (!next) {
        next = new SourceTermNode();
        node.next.set(code, next);
      }
      node = next;
    }
    if (text.length > 0) {
      node.outputs.push(term);
    }
    return term;
  });
  const queue = [...root.next.values()];
  for (const node of queue) {
    node.failure = root;
  }
  for (const node of queue) {
    for (const [code, child] of node.next) {
      let fallback = node.failure;
      let next = fallback.next.get(code);
      while (!next && fallback !== root) {
        fallback = fallback.failure;
        next = fallback.next.get(code);
      }
      child.failure = next ?? root;
      child.outputs.push(...child.failure.outputs);
      queue.push(child);
    }
  }
  const empty = unique.get("");
  return (source: string) => {
    const matches = new Uint8Array(unique.size);
    const references = new Uint8Array(unique.size);
    let matched = 0;
    let referenced = 0;
    if (empty) {
      matches[empty.index] = 1;
      matched++;
    }
    let node = root;
    for (let index = 0; index < source.length; index++) {
      if (matched === unique.size && referenced === referenceCount) {
        break;
      }
      const code = source.charCodeAt(index);
      let next = node.next.get(code);
      while (!next && node !== root) {
        node = node.failure;
        next = node.next.get(code);
      }
      node = next ?? root;
      for (const term of node.outputs) {
        if (!matches[term.index]) {
          matches[term.index] = 1;
          matched++;
        }
        if (
          term.reference &&
          !references[term.index] &&
          !isReferenceCharacter(source.charCodeAt(index - term.text.length)) &&
          !isReferenceCharacter(source.charCodeAt(index + 1))
        ) {
          references[term.index] = 1;
          referenced++;
        }
      }
    }
    return {
      matches: requested.filter((term) => matches[term.index]).map((term) => term.text),
      references: requested.filter((term) => references[term.index]).map((term) => term.text),
    };
  };
}
