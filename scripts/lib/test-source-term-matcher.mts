type SourceTerm = { text: string; index: number; reference: boolean };

// Out-of-range reads are NaN, which String.fromCharCode maps to NUL.
const isReferenceCharacter = (code: number) => /[\w.@+/-]/u.test(String.fromCharCode(code));

/** Match literal terms and complete source tokens without rescanning once per term. */
export function createSourceTermMatcher(terms: readonly string[]) {
  // String.includes and the source-token contract operate on UTF-16 code units.
  // Dense rows cover only the ASCII units terms use, so each node costs at most
  // 129 columns however diverse the paths are. Other units take sparse edges.
  const symbols = new Uint8Array(128);
  let width = 1;
  let maxNodes = 1;
  for (const text of terms) {
    maxNodes += text.length;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 128) {
        symbols[code] ||= width++;
      }
    }
  }
  // Each code unit adds at most one node; rows past the last node stay untouched.
  const transitions = new Int32Array(maxNodes * width);
  const wide: (Map<number, number> | undefined)[] = [];
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
      const code = text.charCodeAt(index);
      if (code >= 128) {
        const edges = (wide[node] ??= new Map());
        const next = edges.get(code) ?? outputs.push([]) - 1;
        edges.set(code, next);
        node = next;
        continue;
      }
      const slot = node * width + symbols[code]!;
      transitions[slot] ||= outputs.push([]) - 1;
      node = transitions[slot]!;
    }
    if (text.length > 0) {
      outputs[node]!.push(term);
    }
    return term;
  });
  const failures = new Int32Array(outputs.length);
  const wideStep = (from: number, code: number): number => {
    for (let node = from; ; node = failures[node]!) {
      const next = wide[node]?.get(code);
      if (next !== undefined || node === 0) {
        return next ?? 0;
      }
    }
  };
  // Breadth-first order completes each failure row before its children use it,
  // so the scan below takes one table load per ASCII code unit.
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
    for (const [code, child] of wide[node] ?? []) {
      failures[child] = node === 0 ? 0 : wideStep(failures[node]!, code);
      outputs[child]!.push(...outputs[failures[child]!]!);
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
      const code = source.charCodeAt(index);
      node = code < 128 ? transitions[node * width + symbols[code]!]! : wideStep(node, code);
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
