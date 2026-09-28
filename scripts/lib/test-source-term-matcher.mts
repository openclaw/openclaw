type SourceTerm = { text: string; index: number; reference: boolean };

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
  // String.includes and the source-token contract operate on UTF-16 code units.
  // Rows index the code units terms use; every other unit returns to the root.
  const symbols = new Uint32Array(65_536);
  let width = 1;
  for (const text of terms) {
    for (let index = 0; index < text.length; index++) {
      symbols[text.charCodeAt(index)] ||= width++;
    }
  }
  let transitions = new Int32Array(width * 64);
  const outputs: SourceTerm[][] = [[]];
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
    let node = 0;
    for (let index = 0; index < text.length; index++) {
      const slot = node * width + symbols[text.charCodeAt(index)]!;
      if (transitions[slot] === 0) {
        if ((outputs.length + 1) * width > transitions.length) {
          const grown = new Int32Array(transitions.length * 2);
          grown.set(transitions);
          transitions = grown;
        }
        transitions[slot] = outputs.length;
        outputs.push([]);
      }
      node = transitions[slot]!;
    }
    if (text.length > 0) {
      outputs[node]!.push(term);
    }
    return term;
  });
  // Breadth-first order completes each failure row before its children use it,
  // so the scan below takes exactly one transition per code unit.
  const failures = new Int32Array(outputs.length);
  const queue = [0];
  for (const node of queue) {
    for (let symbol = 1; symbol < width; symbol++) {
      const slot = node * width + symbol;
      const fallback = node === 0 ? 0 : transitions[failures[node]! * width + symbol]!;
      const child = transitions[slot]!;
      if (child === 0) {
        transitions[slot] = fallback;
        continue;
      }
      failures[child] = fallback;
      outputs[child]!.push(...outputs[fallback]!);
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
    let node = 0;
    for (let index = 0; index < source.length; index++) {
      if (matched === unique.size && referenced === referenceCount) {
        break;
      }
      node = transitions[node * width + symbols[source.charCodeAt(index)]!]!;
      for (const term of outputs[node]!) {
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
    // Most scanned files match nothing; skip projecting every requested term.
    if (matched === 0) {
      return { matches: [], references: [] };
    }
    return {
      matches: requested.filter((term) => matches[term.index]).map((term) => term.text),
      references: requested.filter((term) => references[term.index]).map((term) => term.text),
    };
  };
}
