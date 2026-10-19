import path from "node:path";
import { TextDecoder } from "node:util";
import {
  assertNoSymlinkParentsSync,
  readRegularFileSync,
} from "openclaw/plugin-sdk/file-access-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
type Placement = "prepend" | "append";

function invalid(detail: string): Error {
  return new Error(`agent-guidance: ${detail}`);
}

function parseConfig(value: unknown) {
  if (!isRecord(value)) {
    throw invalid("configuration must be an object");
  }
  if (
    Object.keys(value).some((key) => !["directory", "agents", "prepend", "append"].includes(key))
  ) {
    throw invalid("unknown configuration field");
  }
  if (
    typeof value.directory !== "string" ||
    !path.isAbsolute(value.directory) ||
    value.directory.includes("\0")
  ) {
    throw invalid("directory must be an absolute operator-controlled path");
  }
  if (
    !Array.isArray(value.agents) ||
    value.agents.length === 0 ||
    value.agents.length > 64 ||
    !value.agents.every(
      (id): id is string =>
        typeof id === "string" && Boolean(id.trim()) && id === id.trim() && id.length <= 128,
    ) ||
    new Set(value.agents).size !== value.agents.length
  ) {
    throw invalid("agents must contain 1 to 64 distinct explicit agent IDs");
  }
  const files: { name: string; placement: Placement }[] = [];
  for (const placement of ["prepend", "append"] as const) {
    const names = value[placement] === undefined ? [] : value[placement];
    if (
      !Array.isArray(names) ||
      !names.every(
        (name): name is string =>
          typeof name === "string" &&
          name.length <= 256 &&
          /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) &&
          name.split("/").every((part) => part && part !== "." && part !== ".."),
      )
    ) {
      throw invalid(`${placement} must contain relative file names without traversal`);
    }
    for (const name of names) {
      files.push({ name, placement });
    }
  }
  if (files.length === 0 || files.length > MAX_FILES) {
    throw invalid(`configure 1 to ${MAX_FILES} instruction files in total`);
  }
  if (new Set(files.map(({ name }) => name)).size !== files.length) {
    throw invalid("instruction file names must not repeat across either placement");
  }
  return { directory: path.normalize(value.directory), agents: value.agents, files };
}

export function loadGuidance(rawConfig: unknown) {
  const config = parseConfig(rawConfig);
  const chunks: Record<Placement, string[]> = { prepend: [], append: [] };
  let bytes = 0;
  for (const [index, file] of config.files.entries()) {
    let text: string;
    try {
      const filePath = path.join(config.directory, file.name);
      // Check the full ancestry, including the configured directory itself.
      assertNoSymlinkParentsSync({
        rootDir: path.parse(filePath).root,
        targetPath: path.dirname(filePath),
        allowMissing: false,
        requireDirectories: true,
      });
      const { buffer, stat } = readRegularFileSync({ filePath, maxBytes: MAX_FILE_BYTES });
      if (stat.nlink !== 1 || buffer.length > MAX_FILE_BYTES) {
        throw invalid("unsafe file");
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (!text.trim() || text.includes("\0")) {
        throw invalid("invalid instruction text");
      }
    } catch {
      // Native filesystem errors may expose operator paths or instruction content.
      throw invalid(
        `instruction file ${index + 1} could not be loaded; require a readable, nonempty UTF-8 regular file of at most ${MAX_FILE_BYTES} bytes with no symbolic or hard links`,
      );
    }
    bytes += Buffer.byteLength(text) + (chunks[file.placement].length ? 2 : 0);
    if (bytes > MAX_TOTAL_BYTES) {
      throw invalid(`combined instructions exceed ${MAX_TOTAL_BYTES} bytes`);
    }
    chunks[file.placement].push(text);
  }
  const contribution: { prependSystemContext?: string; appendSystemContext?: string } = {};
  if (chunks.prepend.length) {
    contribution.prependSystemContext = chunks.prepend.join("\n\n");
  }
  if (chunks.append.length) {
    contribution.appendSystemContext = chunks.append.join("\n\n");
  }
  const agents = new Set(config.agents);
  return (_event: unknown, ctx: { agentId?: string }) =>
    ctx.agentId && agents.has(ctx.agentId) ? contribution : undefined;
}
