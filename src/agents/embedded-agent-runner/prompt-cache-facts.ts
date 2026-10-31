import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

// These are renderer-owned labels, never names read from user-controlled text.
const RUNTIME_FIELDS = new Set([
  "name",
  "agent",
  "session",
  "sessionUrl",
  "host",
  "repo",
  "os",
  "arch",
  "node",
  "active_node",
  "active_node_identity",
  "model",
  "default_model",
  "shell",
  "channel",
  "channel_capabilities",
]);
const ROUTING_FACTS = [
  ["- Explicit requests to start/create", "session creation"],
  ["- Actual delegated helpers use", "hidden delegation"],
  ["- `sessions_spawn` with `visible=true`", "visible delegation"],
  ["- Proactive, unrequested follow-up proposals", "task suggestions"],
] as const;
const COMPUTER_FACTS = [
  ["Control ", "target scope"],
  ["For an attached or cloud session desktop", "takeover"],
  ["`screenshot` and `wait`", "desktop observation"],
  ["Use `list_windows`", "window discovery"],
  ["Observe first with `get_window_state`", "window observation"],
  ["Use `get_accessibility_tree`", "accessibility discovery"],
  ["Target order:", "target order"],
  ["Window inputs follow", "coordinate space"],
  ["For window input,", "delivery mode"],
  ["Use `hold_key`", "keyboard hold"],
  ["This computer supports key taps", "keyboard hold"],
  ["Result precedence", "mutation guidance"],
  ["Window actions return", "observation refresh"],
  ["`background_unavailable`", "background refusals"],
  ["Stale observationId", "stale reference recovery"],
  ["A stale frameId", "stale frame recovery"],
] as const;
const MAX_FACTS = 32;
const MAX_CHANGES = 8;

function fingerprintFacts(text: string, section: string): Map<string, string> {
  const facts = new Map<string, string>();
  const add = (name: string, value: string) => {
    const key = facts.has(name) || facts.size < MAX_FACTS ? name : "remaining";
    facts.set(key, sha256Hex(`${facts.get(key) ?? ""}${value}`));
  };
  const lines = section === "computer" ? text.split(/\.\s+(?=[A-Z`])/u) : text.split("\n");
  const toolNames: string[] = [];
  const summaries: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (section === "Tooling" && /^- [^:]+(?:: |$)/u.test(line)) {
      const separator = line.indexOf(": ");
      toolNames.push(line.slice(2, separator < 0 ? undefined : separator));
      summaries.push(line);
      continue;
    }
    if (section === "Runtime" && line.includes("Runtime: ")) {
      for (const field of line.slice(line.indexOf("Runtime: ") + 9).split(" | ")) {
        const separator = field.indexOf("=");
        const key = field.slice(0, separator);
        add(RUNTIME_FIELDS.has(key) ? key : "other runtime text", field);
      }
      continue;
    }
    const named =
      section === "Session routing"
        ? ROUTING_FACTS.find(([prefix]) => line.startsWith(prefix))?.[1]
        : section === "computer"
          ? COMPUTER_FACTS.find(([prefix]) => line.startsWith(prefix))?.[1]
          : section === "Runtime" && line.startsWith("Current model identity:")
            ? "model identity"
            : section === "Runtime" && line.startsWith("Reasoning=")
              ? "reasoning"
              : undefined;
    add(named ?? `line[${index + 1}]`, line);
  }
  if (section === "Tooling") {
    add("tool list membership", JSON.stringify(toolNames.toSorted()));
    add("tool list order", JSON.stringify(toolNames));
    add("tool summaries", JSON.stringify(summaries.toSorted()));
  }
  return facts;
}

/** Called only for an already-reported drop; neither values nor their hashes escape. */
export function describePromptCacheFactChanges(
  before: string,
  after: string,
  section: string,
): string[] {
  const prior = fingerprintFacts(before, section);
  const next = fingerprintFacts(after, section);
  const changed = [...new Set([...prior.keys(), ...next.keys()])].filter(
    (key) => prior.get(key) !== next.get(key),
  );
  // Membership changes inherently change order too; report the narrower useful cause.
  if (changed.includes("tool list membership")) {
    const order = changed.indexOf("tool list order");
    if (order >= 0) {
      changed.splice(order, 1);
    }
  }
  return changed.slice(0, MAX_CHANGES).concat(changed.length > MAX_CHANGES ? ["remaining"] : []);
}

const PROMPT_SECTION_NAMES = [
  "Skills",
  "Tooling",
  "Project Context",
  "Memory Recall",
  "Temporal Context",
  "Runtime",
  "Runtime Context",
  "Conversation Context",
  "Subagent Context",
  "Model Aliases",
  "Session routing",
  "Knowledge Index",
  "Silent Replies",
  "Control UI Embed",
  "Other",
] as const;
// Only renderer-owned heading names may appear in diagnostics.
export type PromptSectionDigests = Record<string, string>;
const promptSectionHeadings = new Map<string, string>(
  PROMPT_SECTION_NAMES.map((name) => [`${name === "Project Context" ? "#" : "##"} ${name}`, name]),
);
const MAX_PROMPT_SECTION_KEYS = 48;
const MAX_NAMED_SECTION_CHANGES = 8;

function resolvePromptSectionKey(heading: string, index: number): string {
  const line = heading.trimEnd();
  const known = promptSectionHeadings.get(line);
  if (known) {
    return known;
  }
  return index < MAX_PROMPT_SECTION_KEYS ? `section[${index + 1}]` : "Other";
}

export function formatChangedPromptSections(
  before?: PromptSectionDigests,
  after?: PromptSectionDigests,
) {
  const changed = [...new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])].filter(
    (key) => before?.[key] !== after?.[key],
  );
  const named = changed.slice(0, MAX_NAMED_SECTION_CHANGES).join(", ") || "Other";
  const hidden = changed.length - MAX_NAMED_SECTION_CHANGES;
  return hidden > 0 ? `${named}, +${hidden} more` : named;
}

export function fingerprintPromptSections(
  prompt: string,
  digest: string,
  previousDigest?: string,
  previousSections?: PromptSectionDigests,
): PromptSectionDigests | undefined {
  if (digest === previousDigest) {
    return previousSections;
  }
  if (!/^#{1,2} /m.test(prompt)) {
    return undefined;
  }
  const sections: PromptSectionDigests = {};
  let name = "Other";
  let start = 0;
  const append = (end: number) => {
    if (end > start) {
      sections[name] = sha256Hex(`${sections[name] ?? ""}${prompt.slice(start, end)}`);
    }
  };
  let index = 0;
  for (const heading of prompt.matchAll(/^#{1,2} [^\n]*(?:\n|$)/gm)) {
    append(heading.index);
    start = heading.index;
    name = resolvePromptSectionKey(heading[0], index++);
    // Injected files own the rest of the stable prefix, including their headings.
    if (name === "Project Context") {
      break;
    }
  }
  append(prompt.length);
  return sections;
}

export function describePromptCacheSectionChanges(
  beforeSource: string,
  afterSource: string,
): string[] {
  const facts: string[] = [];
  const sections = (source: string) => {
    const suffix = source;
    const result = new Map<string, string>();
    let key = "Other";
    let start = 0;
    let index = 0;
    for (const heading of suffix.matchAll(/^#{1,2} [^\n]*(?:\n|$)/gm)) {
      result.set(key, (result.get(key) ?? "") + suffix.slice(start, heading.index));
      key = resolvePromptSectionKey(heading[0], index++);
      start = heading.index + heading[0].length;
    }
    result.set(key, (result.get(key) ?? "") + suffix.slice(start));
    return result;
  };
  const before = sections(beforeSource);
  const after = sections(afterSource);
  for (const section of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(section) !== after.get(section)) {
      facts.push(
        ...describePromptCacheFactChanges(
          before.get(section) ?? "",
          after.get(section) ?? "",
          section,
        ).map((fact) => `${section}.${fact} changed`),
      );
    }
    if (facts.length > MAX_NAMED_SECTION_CHANGES) {
      break;
    }
  }

  return facts;
}

export type PromptCacheToolSnapshot = {
  name: string;
  descriptionDigest?: string;
  schemaDigest?: string;
};

export function describeToolChanges(
  previous: { tools: readonly PromptCacheToolSnapshot[]; toolCount: number },
  next: { tools: readonly PromptCacheToolSnapshot[]; toolCount: number },
): string {
  const before = new Map(previous.tools.map((tool) => [tool.name, tool]));
  const after = new Map(next.tools.map((tool) => [tool.name, tool]));
  const changed: Record<"added" | "removed" | "description" | "schema", string[]> = {
    added: [],
    removed: [],
    description: [],
    schema: [],
  };
  for (const tool of next.tools) {
    const prior = before.get(tool.name);
    if (!prior) {
      changed.added.push(tool.name);
    } else {
      if (prior.descriptionDigest !== tool.descriptionDigest) {
        changed.description.push(tool.name);
      }
      if (prior.schemaDigest !== tool.schemaDigest) {
        changed.schema.push(tool.name);
      }
    }
  }
  for (const tool of previous.tools) {
    if (!after.has(tool.name)) {
      changed.removed.push(tool.name);
    }
  }
  const details = [`${previous.toolCount} -> ${next.toolCount} tools`];
  for (const [kind, names] of Object.entries(changed)) {
    if (names.length > 0) {
      const sample = names
        .slice(0, 5)
        .map((name) =>
          name === "computer"
            ? JSON.stringify(name)
            : `tool[${(kind === "removed" ? previous.tools : next.tools).findIndex((tool) => tool.name === name) + 1}]`,
        )
        .join(", ");
      details.push(`${kind}: ${sample}${names.length > 5 ? ` (+${names.length - 5} more)` : ""}`);
    }
  }
  return details.join("; ");
}
